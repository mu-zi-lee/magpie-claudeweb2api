import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Bridge } from '../src/bridge.mjs';
import { prepare, response } from '../src/protocol.mjs';

const binary = fileURLToPath(new URL(`../bin/claudeweb-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));

test('real Go backend: model discovery, streaming, account isolation, cancellation and clean shutdown', { timeout: 15_000 }, async t => {
  const cookies = [];
  let deleted = 0;
  const deletionWaiters = [];
  const waitDeleted = count => deleted >= count ? Promise.resolve() : new Promise(resolve => deletionWaiters.push({ count, resolve }));
  let waiting;
  const started = new Promise(resolve => { waiting = resolve; });
  const server = http.createServer((req, res) => {
    cookies.push(req.headers.cookie);
    if (req.headers.cookie?.includes('sessionKey=expired')) { res.writeHead(401); res.end('do-not-leak'); return; }
    if (req.headers.cookie?.includes('sessionKey=limited')) { res.writeHead(429, { 'retry-after': '3' }); res.end(); return; }
    if (req.url === '/api/organizations') { res.end('[{"uuid":"org"}]'); return; }
    if (req.url.startsWith('/edge-api/')) { res.end('{"claude_ai_available_models":{"models":[{"model_id":"model-a"}]}}'); return; }
    if (req.method === 'DELETE') { deleted++; for (const w of deletionWaiters) if (deleted >= w.count) w.resolve(); res.writeHead(204); res.end(); return; }
    if (req.url.endsWith('/completion')) {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        assert.deepEqual(parsed.tools, []);
        if (parsed.prompt === 'wait') { waiting(); return; }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}\n\n');
        setTimeout(() => res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n'), 10);
      });
      return;
    }
    res.end('{"uuid":"conversation"}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let child;
  const bridge = new Bridge({ binary, spawnProcess: (...args) => { child = spawn(...args); return child; } });
  t.after(async () => { await bridge.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const command = (method, key, extra = {}) => ({ method, origin, auth: { key }, ...extra });
  assert.deepEqual(await bridge.call(command('models', 'account-one')), ['model-a']);
  await assert.rejects(bridge.call(command('models', 'account-one', { extra: 'x'.repeat(16 * 1024 * 1024) })), error => error.status === 413);
  // Rejected oversized input must leave the shared backend usable.
  assert.deepEqual(await bridge.call(command('models', 'account-two')), ['model-a']);
  await assert.rejects(bridge.call(command('models', 'expired')), error => error.status === 401 && error.signIn === 'expired' && !error.message.includes('do-not-leak'));
  await assert.rejects(bridge.call(command('models', 'limited')), error => error.status === 429 && error.retryAfter === '3');
  const p = prepare(JSON.stringify({ model: 'model-a', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], stream: true }));
  const stream = await bridge.open(command('complete', 'account-one', { completion: p.completion }));
  assert.equal((await stream.next()).value.event, 'head');
  const result = await response(stream, p);
  assert.match(await result.text(), /你好/);
  await waitDeleted(1);
  assert.equal(deleted, 1);
  const controller = new AbortController();
  const pending = await bridge.open(command('complete', 'account-two', { completion: { model: 'model-a', prompt: 'wait' } }), controller.signal);
  await started;
  controller.abort();
  await assert.rejects(pending.next(), /abort/i);
  pending.close();
  await bridge.dispose();
  assert.equal(child.exitCode, 0);
  assert.equal(deleted, 2);
  assert.equal(cookies.some(cookie => cookie.includes('account-one') && cookie.includes('account-two')), false);
});

test('disposal during startup is idempotent and prevents a backend from escaping', async () => {
  let spawned = false;
  const bridge = new Bridge({ binary, spawnProcess: (...args) => { spawned = true; return spawn(...args); } });
  const starting = assert.rejects(bridge.start(), /stopped/);
  const first = bridge.dispose();
  assert.equal(bridge.dispose(), first);
  await Promise.all([starting, first]);
  assert.equal(spawned, false);
  await assert.rejects(bridge.start(), /stopped/);
});

test('a slow stream is cancelled without killing other accounts or the shared backend', { timeout: 20_000 }, async t => {
  let deleted;
  const cleaned = new Promise(resolve => { deleted = resolve; });
  let flood;
  const server = http.createServer((req, res) => {
    if (req.url === '/api/organizations') return res.end('[{"uuid":"org"}]');
    if (req.url.startsWith('/edge-api/')) return res.end('{"claude_ai_available_models":{"models":[{"model_id":"model"}]}}');
    if (req.method === 'DELETE') { deleted(); res.writeHead(204); return res.end(); }
    if (!req.url.endsWith('/completion')) return res.end('{"uuid":"conversation"}');
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      const frame = 'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x'.repeat(600_000) } }) + '\n\n';
      flood = () => {
        for (let i = 0; i < 18; i++) res.write(frame);
        res.end('data: {"type":"message_stop"}\n\n');
      };
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let spawned = 0;
  const bridge = new Bridge({ binary, spawnProcess: (...args) => { spawned++; return spawn(...args); } });
  t.after(async () => { await bridge.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const s = await bridge.open({ method: 'complete', origin, auth: { key: 'slow' }, completion: { model: 'model', prompt: 'overflow' } });
  assert.equal((await s.next()).value.event, 'head');
  flood();
  await cleaned;
  await assert.rejects(s.next(), /too slow/);
  assert.deepEqual(await bridge.call({ method: 'models', origin, auth: { key: 'other-account' } }), ['model']);
  assert.equal(spawned, 1, 'healthy requests must keep using the original backend');
  s.close();
});

test('backend exits when its owner is killed, without a detached service', { timeout: 10_000, skip: process.platform === 'win32' }, async () => {
  const bridgeURL = new URL('../src/bridge.mjs', import.meta.url).href;
  const code = `import { Bridge } from ${JSON.stringify(bridgeURL)}; import { spawn } from 'node:child_process';
    const bridge = new Bridge({ binary: ${JSON.stringify(binary)}, spawnProcess: (...args) => { const p = spawn(...args); console.log(p.pid); return p; } });
    await bridge.start(); console.log('ready'); setInterval(() => {}, 1000);`;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  await new Promise((resolve, reject) => {
    owner.stdout.on('data', chunk => { output += chunk; if (output.includes('ready')) resolve(); });
    owner.once('error', reject);
    owner.once('exit', () => { if (!output.includes('ready')) reject(new Error('owner failed to start')); });
  });
  const pid = Number(output.split('\n')[0]);
  owner.kill('SIGKILL'); await once(owner, 'exit');
  let alive = true;
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { alive = false; break; }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(alive, false, 'backend must exit after pipe EOF');
});
