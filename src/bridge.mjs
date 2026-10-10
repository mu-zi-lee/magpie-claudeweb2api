import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, basename } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export class BackendError extends Error {
  constructor(message, status = 502, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
    if (status === 401) this.signIn = 'expired';
  }
}

const MAX_QUEUE = 8 * 1024 * 1024;
const MAX_LINE = 4 * 1024 * 1024;
const MAX_COMMAND = 16 * 1024 * 1024 - 1;

class Inbox {
  queue = [];
  bytes = 0;
  waiter = null;
  ended = false;
  error = null;
  push(value) {
    if (this.ended) return;
    const size = Buffer.byteLength(JSON.stringify(value));
    if (this.bytes + size > MAX_QUEUE) throw new BackendError('Backend stream consumer is too slow');
    if (this.waiter) { const resolve = this.waiter; this.waiter = null; resolve({ value, done: false }); }
    else { this.queue.push({ value, size }); this.bytes += size; }
  }
  end(error) {
    if (this.ended) return;
    this.ended = true;
    this.error = error;
    if (error) { this.queue.length = 0; this.bytes = 0; }
    if (this.waiter) { const resolve = this.waiter; this.waiter = null; resolve(null); }
  }
  async next() {
    if (this.queue.length) { const { value, size } = this.queue.shift(); this.bytes -= size; return { value, done: false }; }
    if (!this.ended) {
      const next = await new Promise(resolve => { this.waiter = resolve; });
      if (next) return next;
    }
    if (this.error) throw this.error;
    return { done: true };
  }
  [Symbol.asyncIterator]() { return this; }
}

export class Bridge {
  #child;
  #starting;
  #pending = new Map();
  #closed = false;
  #binary;
  #spawn;
  #stopping;

  constructor({ binary, spawnProcess = spawn } = {}) {
    const suffix = process.platform === 'win32' ? '.exe' : '';
    this.#binary = binary ?? fileURLToPath(new URL(`../bin/claudeweb-${process.platform}-${process.arch}${suffix}`, import.meta.url));
    this.#spawn = spawnProcess;
  }

  async start() {
    if (this.#closed) throw new BackendError('Plugin backend is stopped');
    if (this.#starting) return this.#starting;
    this.#starting = this.#launch().catch(error => { this.#starting = null; throw error; });
    return this.#starting;
  }

  async #launch() {
    try { await access(this.#binary, process.platform === 'win32' ? constants.F_OK : constants.X_OK); }
    catch { throw new BackendError(`No packaged backend for ${process.platform}/${process.arch}. Build with npm run build or install a release package.`, 503); }
    try {
      const hashes = JSON.parse(await readFile(new URL('../bin/checksums.json', import.meta.url), 'utf8'));
      const hash = createHash('sha256').update(await readFile(this.#binary)).digest('hex');
      if (hash !== hashes[basename(this.#binary)]) throw new Error('checksum mismatch');
    } catch { throw new BackendError('Packaged backend checksum is missing or invalid. Rebuild or reinstall the release package.', 503); }
    if (this.#closed) throw new BackendError('Plugin backend is stopped');
    // Credentials travel only through the pipe. Do not inherit CLI secrets or install tools at runtime.
    const env = {};
    for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
      if (process.env[name]) env[name] = process.env[name];
    }
    const child = this.#spawn(this.#binary, [], { cwd: dirname(this.#binary), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
    this.#child = child;
    // Backend stderr is never forwarded: transport diagnostics could include upstream credentials.
    child.stderr.resume();
    let buffer = '';
    child.stdout.setEncoding('utf8');
    await new Promise((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(() => { child.kill(); reject(new BackendError('Backend startup timed out')); }, 10_000);
      const fail = error => {
        clearTimeout(timer);
        if (!ready) reject(error);
        if (this.#child !== child) return;
        for (const inbox of this.#pending.values()) inbox.end(error);
        this.#pending.clear();
        if (this.#child === child) { this.#child = null; this.#starting = null; }
      };
      child.once('error', () => fail(new BackendError('Could not start plugin backend')));
      child.once('exit', () => fail(new BackendError('Plugin backend exited')));
      child.stdin.on('error', () => { fail(new BackendError('Plugin backend pipe closed')); child.kill(); });
      child.stdout.on('data', chunk => {
        buffer += chunk;
        try {
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            if (newline > MAX_LINE) throw new BackendError('Backend frame is too large');
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            if (Buffer.byteLength(line) > MAX_LINE) throw new BackendError('Backend frame is too large');
            const msg = JSON.parse(line);
            if (msg.event === 'ready') {
              if (msg.protocol !== 1) throw new BackendError('Backend protocol mismatch');
              ready = true; clearTimeout(timer); resolve(); continue;
            }
            const inbox = this.#pending.get(msg.id);
            if (!inbox) continue;
            if (msg.error) inbox.end(new BackendError(msg.error.message, msg.error.status, msg.error.retryAfter));
            else if (msg.event === 'done') inbox.end();
            else {
              try { inbox.push(msg); }
              catch (error) {
                // Backpressure belongs to this request; preserve other accounts
                // and the transport's stable browser identities.
                inbox.end(error);
                if (child.stdin.writable) child.stdin.write(JSON.stringify({ id: msg.id, method: 'abort' }) + '\n');
                continue;
              }
              if ('result' in msg) inbox.end();
            }
          }
          if (Buffer.byteLength(buffer) > MAX_LINE) throw new BackendError('Backend frame is too large');
        } catch (error) { fail(error instanceof BackendError ? error : new BackendError('Invalid backend frame')); child.kill(); }
      });
    });
  }

  async open(command, signal) {
    signal?.throwIfAborted();
    await this.start();
    if (this.#closed) throw new BackendError('Plugin backend is stopped');
    signal?.throwIfAborted();
    const id = randomUUID();
    const frame = JSON.stringify({ ...command, id }) + '\n';
    if (Buffer.byteLength(frame) > MAX_COMMAND) throw new BackendError('Backend request is too large', 413);
    if (this.#pending.size >= 64) throw new BackendError('Backend request capacity is busy', 429, '1');
    const inbox = new Inbox();
    this.#pending.set(id, inbox);
    const child = this.#child;
    const abort = () => {
      if (child?.stdin.writable) child.stdin.write(JSON.stringify({ id, method: 'abort' }) + '\n');
      inbox.end(signal?.reason instanceof Error ? signal.reason : new DOMException('Request aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    const finish = (cancel = false) => {
      if (cancel && !inbox.ended) abort();
      signal?.removeEventListener('abort', abort);
      this.#pending.delete(id);
    };
    try {
      if (!child?.stdin.writable) throw new BackendError('Backend pipe is unavailable');
      await new Promise((resolve, reject) => child.stdin.write(frame, error => error ? reject(new BackendError('Backend write failed')) : resolve()));
    } catch (error) { finish(); throw error; }
    if (signal?.aborted) abort();
    return {
      next: () => inbox.next(),
      return: async () => { finish(true); return { done: true }; },
      close: () => finish(true),
      [Symbol.asyncIterator]() { return this; },
    };
  }

  async call(command, signal) {
    const stream = await this.open(command, signal);
    try { const item = await stream.next(); if (item.done || !('result' in item.value)) throw new BackendError('Backend returned no result'); return item.value.result; }
    finally { stream.close(); }
  }

  dispose() {
    this.#stopping ??= this.#dispose();
    return this.#stopping;
  }

  async #dispose() {
    this.#closed = true;
    for (const inbox of this.#pending.values()) inbox.end(new BackendError('Plugin was removed', 503));
    this.#pending.clear();
    if (this.#starting) await this.#starting.catch(() => {});
    const child = this.#child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(timer);
  }
}
