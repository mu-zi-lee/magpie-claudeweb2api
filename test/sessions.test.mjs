import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { fork } from 'node:child_process';

test('stock host plugin reuses conversations, rejects account/proxy switches and cleans on owner exit', { timeout: 20_000 }, async t => {
  let creates = 0, deleted = 0;
  const turns = [];
  const deletionWaiters = [];
  const waitDeleted = count => deleted >= count ? Promise.resolve() : new Promise(resolve => deletionWaiters.push({ count, resolve }));
  const server = http.createServer((req, res) => {
    if (req.url === '/api/organizations') return res.end('[{"uuid":"org"}]');
    if (req.method === 'DELETE') { deleted++; for (const waiter of deletionWaiters) if (deleted >= waiter.count) waiter.resolve(); res.writeHead(204); return res.end(); }
    if (!req.url.endsWith('/completion')) return res.end(JSON.stringify({ uuid: 'conv-' + ++creates }));
    let body = '';
    req.on('data', part => { body += part; });
    req.on('end', () => {
      turns.push({ path: req.url, cookie: req.headers.cookie, body: JSON.parse(body) });
      res.setHeader('content-type', 'text/event-stream');
      res.end('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"reply"}}\n\ndata: {"type":"message_stop"}\n\n');
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const host = fork(new URL('./fixtures/plugin-host.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  let sequence = 0;
  const pending = new Map();
  host.on('message', ({ id, result, error }) => {
    const task = pending.get(id);
    if (!task) return;
    pending.delete(id);
    if (error) task.reject(new Error(error));
    else task.resolve(result);
  });
  const fail = error => { for (const task of pending.values()) task.reject(error); pending.clear(); };
  host.on('error', fail);
  host.on('exit', () => fail(new Error('Test plugin host exited')));
  const rpc = (action, value) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    host.send({ id, action, value }, error => { if (error) { pending.delete(id); reject(error); } });
  });
  const stop = async () => {
    if (host.exitCode !== null || host.signalCode !== null) return;
    const exited = once(host, 'exit');
    host.send({ action: 'exit' });
    await exited;
  };
  t.after(async () => { await stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const hookNames = await rpc('load', { origin: `http://127.0.0.1:${server.address().port}` });
  assert.equal(hookNames.some(name => name.startsWith('magpie.')), false);
  let proxy;
  let auth = { type: 'api', key: 'account-one' };
  const loader = { async fetch(url, init) {
    const result = await rpc('fetch', { url, init, auth, proxy });
    return new Response(result.body, { status: result.status, headers: result.headers });
  } };
  const header = await rpc('headers', { sessionID: 'my-session', model: { providerID: 'claude-web' } });
  assert.match(header.headers['x-claudeweb-conversation'], /^[a-f0-9]{64}$/);
  const other = await rpc('headers', { sessionID: 'my-session', model: { providerID: 'other' } });
  assert.deepEqual(other.headers, {});
  const messages = [{ role: 'user', content: 'first' }];
  const ask = extra => loader.fetch('https://claude-web.invalid/v1/messages', { method: 'POST', headers: header.headers, body: JSON.stringify({ model: 'model', max_tokens: 100, messages, ...extra }) });
  assert.equal((await (await ask()).json()).content[0].text, 'reply');
  messages.push({ role: 'assistant', content: 'reply' }, { role: 'user', content: 'second' });
  assert.equal((await (await ask()).json()).content[0].text, 'reply');
  assert.equal(creates, 1);
  assert.equal(deleted, 0);
  assert.equal(turns[1].path, turns[0].path);
  assert.equal(turns[1].body.parent_message_uuid, turns[0].body.turn_message_uuids.assistant_message_uuid);
  const duplicate = await ask(); assert.equal(duplicate.status, 409); await duplicate.body.cancel();
  auth = { type: 'api', key: 'account-two' };
  const switched = await ask(); assert.equal(switched.status, 409); await switched.body.cancel();
  assert.equal(turns.length, 2);
  const newAccount = await ask({ conversation_id: 'account-two-dialogue' }); assert.equal(newAccount.status, 200); await newAccount.json();
  assert.equal(creates, 2);
  proxy = 'http://127.0.0.1:9';
  const moved = await ask({ conversation_id: 'account-two-dialogue' }); assert.equal(moved.status, 409); await moved.body.cancel();
  assert.equal(creates, 2);
  proxy = 'direct';
  const capped = await ask({ conversation_id: 'capped-dialogue', max_tokens: 1 });
  assert.equal((await capped.json()).stop_reason, 'max_tokens');
  await waitDeleted(1);
  const restarted = await ask({ conversation_id: 'capped-dialogue' });
  assert.equal(restarted.status, 200); await restarted.json();
  assert.equal(creates, 4, 'a locally truncated response must not keep an unseen upstream tail');
  await stop();
  assert.equal(host.exitCode, 0);
  await waitDeleted(4);
  assert.equal(deleted, 4);
});
