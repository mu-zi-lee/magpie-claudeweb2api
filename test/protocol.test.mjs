import test from 'node:test';
import assert from 'node:assert/strict';
import { prepare, ToolParser, response } from '../src/protocol.mjs';
import plugin from '../src/index.mjs';

const tool = { name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: false } };
const request = (extra = {}) => JSON.stringify({ model: 'test-model', max_tokens: 1000, messages: [{ role: 'user', content: 'hello' }], ...extra });
function source(texts, { stop = true, error } = {}) {
  let closed = false;
  return {
    async *[Symbol.asyncIterator]() {
      for (const text of texts) yield { event: 'data', data: { type: 'content_block_delta', delta: { type: 'text_delta', text } } };
      if (error) yield { event: 'data', data: { type: 'error', error: { type: error } } };
      if (stop) yield { event: 'data', data: { type: 'message_stop' } };
    },
    close() { closed = true; },
    get closed() { return closed; },
  };
}

test('tool parser handles every delimiter boundary and markers inside JSON strings', () => {
  const p = prepare(request({ tools: [tool] }));
  const parser = new ToolParser(p);
  const path = '目录/' + p.end + '.txt';
  const text = `你好 ${p.start}${JSON.stringify({ name: 'Read', input: { file_path: path } })}${p.end} 后续`;
  const items = [...text].flatMap(char => parser.feed(char));
  items.push(...parser.feed('', true));
  assert.equal(items.filter(x => x.text).map(x => x.text).join(''), '你好  后续');
  assert.equal(items.filter(x => x.tool).length, 1);
  assert.deepEqual(items.find(x => x.tool).tool.input, { file_path: path });
});

test('malformed calls and unknown tools fail instead of executing or losing text silently', () => {
  const p = prepare(request({ tools: [tool] }));
  for (const call of [{ name: 'Bash', input: { command: 'touch /tmp/never-run' } }, { name: 'Read', input: {} }, { name: 'Read', input: { file_path: 2 } }]) {
    assert.throws(() => new ToolParser(p).feed(p.start + JSON.stringify(call) + p.end, true));
  }
  assert.throws(() => new ToolParser(p).feed(p.start + '{"name":', true), /incomplete/);
});

test('tool results retain ids, errors and content in the next model prompt', () => {
  const p = prepare(request({ messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_123', name: 'Read', input: { file_path: 'file.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_123', is_error: true, content: [{ type: 'text', text: 'missing file' }] }] },
  ] }));
  assert.match(p.completion.prompt, /toolu_123/);
  assert.match(p.completion.prompt, /missing file/);
  assert.match(p.completion.prompt, /"is_error":true/);
});

test('unsupported modalities and signed thinking history fail clearly', () => {
  assert.throws(() => prepare(request({ messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] })), /Unsupported content/);
  assert.throws(() => prepare(request({ messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'private reasoning', signature: 'signed' }] }] })), /Unsupported content/);
  assert.throws(() => prepare(request({ tools: [tool, tool] })), /unique/);
  assert.throws(() => prepare(request({ tool_choice: { type: 'tool', name: 'Read' } })), /undefined/);
});

test('invalid thinking settings fail and thinking mode changes invalidate conversation fingerprints', () => {
  for (const thinking of [null, 'adaptive', {}, { type: 'unknown' }, { type: 'enabled', budget_tokens: 0 }]) {
    assert.throws(() => prepare(request({ thinking })), /thinking/);
  }
  const disabled = prepare(request({ thinking: { type: 'disabled' } }));
  const adaptive = prepare(request({ thinking: { type: 'adaptive' } }));
  assert.notEqual(disabled.completion.context_key, adaptive.completion.context_key);
  assert.notEqual(disabled.completion.request_key, adaptive.completion.request_key);
});

test('nonstreaming tool response hands execution to the caller and uses tool_use stop reason', async () => {
  const p = prepare(request({ tools: [tool] }));
  const s = source(['说明', p.start + JSON.stringify({ name: 'Read', input: { file_path: 'hello.txt' } }) + p.end]);
  const res = await response(s, p);
  const body = await res.json();
  assert.equal(body.stop_reason, 'tool_use');
  assert.equal(body.content[0].text, '说明');
  assert.deepEqual(body.content[1].input, { file_path: 'hello.txt' });
  assert.equal(body.content.some(x => x.type === 'tool_result'), false);
  assert.equal(s.closed, true);
});

test('streaming output is incremental and truncated streams have no successful message_stop', async () => {
  const p = prepare(request({ stream: true }));
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const s = { async *[Symbol.asyncIterator]() {
    yield { event: 'data', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'first' } } };
    await wait;
    yield { event: 'data', data: { type: 'message_stop' } };
  }, close() {} };
  const res = await response(s, p), reader = res.body.getReader(), decoder = new TextDecoder();
  let text = '';
  while (!text.includes('first')) text += decoder.decode((await reader.read()).value);
  assert.equal(text.includes('message_stop'), false);
  release();
  for (;;) { const item = await reader.read(); if (item.done) break; text += decoder.decode(item.value); }
  assert.match(text, /event: message_stop/);
  const failed = await response(source(['partial'], { stop: false }), p);
  const failure = await failed.text();
  assert.match(failure, /event: error/);
  assert.equal(failure.includes('event: message_stop'), false);
});

test('upstream stream errors retain their rate-limit semantics', async () => {
  const res = await response(source([], { stop: false, error: 'rate_limit_error' }), prepare(request({ stream: true })));
  assert.match(await res.text(), /rate_limit_error/);
});

test('required tool choice cannot end successfully without a call', async () => {
  const p = prepare(request({ tools: [tool], tool_choice: { type: 'any' } }));
  await assert.rejects(response(source(['I did not use a tool']), p), /required tool/);
});

test('invalid plugin options are rejected before starting the backend', async () => {
  await assert.rejects(plugin.server({}, { proxy: 1 }), /proxy/);
  await assert.rejects(plugin.server({}, { origin: 'http://example.com' }), /origin/);
});

test('byte request bodies and estimated output budgets preserve Unicode and stop early', async () => {
  const p = prepare(new TextEncoder().encode(request({ max_tokens: 1 })));
  const s = source(['你😀好世界', 'this must never be consumed']);
  const body = await (await response(s, p)).json();
  assert.equal(body.content[0].text, '你😀好世');
  assert.equal(body.stop_reason, 'max_tokens');
  assert.equal(body.usage.output_tokens, 1);
  assert.equal(s.closed, true);
});

test('cancelling a streaming response closes a waiting upstream promptly', async () => {
  let closed = false;
  const s = { async *[Symbol.asyncIterator]() { yield { event: 'data', data: { type: 'message_stop' } }; }, close() { closed = true; } };
  const res = await response(s, prepare(request({ stream: true })));
  await res.body.cancel();
  assert.equal(closed, true);
});

test('custom stop sequences survive every chunk boundary and exclude the marker', async () => {
  for (const stream of [false, true]) {
    for (let split = 0; split <= 7; split++) {
      const text = '开始😀结束不要输出';
      const p = prepare(request({ stream, stop_sequences: ['😀结束', '结束'] }));
      const s = source([text.slice(0, split), text.slice(split), 'never']);
      const res = await response(s, p);
      if (stream) {
        const wire = await res.text();
        const events = wire.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
        assert.equal(events.filter(e => e.delta?.type === 'text_delta').map(e => e.delta.text).join(''), '开始');
        assert.equal(events.find(e => e.type === 'message_delta').delta.stop_sequence, '😀结束');
        assert.equal(events.at(-1).type, 'message_stop');
      } else {
        const body = await res.json();
        assert.equal(body.content[0].text, '开始');
        assert.equal(body.stop_reason, 'stop_sequence');
        assert.equal(body.stop_sequence, '😀结束');
      }
      assert.equal(s.closed, true);
    }
  }
});

test('unmatched stop prefixes flush at EOF and markers inside tool arguments remain intact', async () => {
  const p = prepare(request({ tools: [tool], stop_sequences: ['STOP'] }));
  const call = p.start + JSON.stringify({ name: 'Read', input: { file_path: 'STOP.txt' } }) + p.end;
  const body = await (await response(source(['prefix ST', call, ' tail ST']), p)).json();
  assert.equal(body.content[0].text, 'prefix ST');
  assert.equal(body.content[1].input.file_path, 'STOP.txt');
  assert.equal(body.content[2].text, ' tail ST');
  assert.equal(body.stop_reason, 'tool_use');
  for (const stop_sequences of [null, 'stop', [''], [1], ['x'.repeat(8193)]]) {
    assert.throws(() => prepare(request({ stop_sequences })), /stop_sequences/);
  }
});

test('upstream refusal and length-limit stop reasons are preserved', async () => {
  for (const reason of ['refusal', 'max_tokens']) {
    const s = { async *[Symbol.asyncIterator]() {
      yield { event: 'data', data: { type: 'content_block_start', content_block: { type: 'text', text: 'initial' } } };
      yield { event: 'data', data: { type: 'message_delta', delta: { stop_reason: reason } } };
      yield { event: 'data', data: { type: 'message_stop' } };
    }, close() {} };
    const body = await (await response(s, prepare(request()))).json();
    assert.equal(body.content[0].text, 'initial');
    assert.equal(body.stop_reason, reason);
  }
});

test('tool schemas enforce local references, combinations, bounds and structural equality', () => {
  const schema = {
    type: 'object', $defs: { count: { type: 'integer', minimum: 1, maximum: 3 } },
    properties: {
      count: { $ref: '#/$defs/count' },
      label: { type: 'string', minLength: 2, maxLength: 3 },
      mode: { oneOf: [{ const: 'read' }, { const: 'write' }] },
      metadata: { enum: [{ a: 1, b: 2 }] },
      tags: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'string' } },
      value: { allOf: [{ type: 'number' }, { anyOf: [{ maximum: 0 }, { minimum: 10 }] }] },
      blocked: false,
    }, additionalProperties: false,
  };
  const p = prepare(request({ tools: [{ name: 'check', input_schema: schema }] }));
  const parse = input => new ToolParser(p).feed(p.start + JSON.stringify({ name: 'check', input }) + p.end, true);
  assert.equal(parse({ count: 2, label: '你😀', mode: 'read', metadata: { b: 2, a: 1 }, tags: ['a'], value: 10 }).length, 1);
  for (const input of [{ count: 0 }, { count: 4 }, { label: '😀' }, { mode: 'other' }, { tags: [] }, { tags: ['a', 'a'] }, { value: 5 }, { blocked: 'no' }]) {
    assert.throws(() => parse(input), /schema|enum|required|property/);
  }
});

test('stopping visible text avoids parsing an invalid tool call later in the same delta', async () => {
  const p = prepare(request({ tools: [tool], stop_sequences: ['STOP'] }));
  const body = await (await response(source(['answerSTOP' + p.start + '{broken}' + p.end]), p)).json();
  assert.equal(body.content[0].text, 'answer');
  assert.equal(body.stop_reason, 'stop_sequence');
});

test('repetitive stop prefixes and output-budget precedence stay correct', async () => {
  const marker = 'a'.repeat(8191) + 'b';
  const p = prepare(request({ max_tokens: 10000, stop_sequences: [marker] }));
  const body = await (await response(source(['keep' + 'a'.repeat(8190), 'ab', 'never']), p)).json();
  assert.equal(body.content[0].text, 'keep');
  assert.equal(body.stop_sequence, marker);
  const capped = await (await response(source(['1234STOP']), prepare(request({ max_tokens: 1, stop_sequences: ['STOP'] })))).json();
  assert.equal(capped.stop_reason, 'max_tokens');
  assert.equal(capped.stop_sequence, null);
});

test('invalid schema references fail before contacting upstream and recursive schemas are bounded', () => {
  for (const $ref of ['https://example.invalid/schema.json', '#/$defs/missing']) {
    assert.throws(() => prepare(request({ tools: [{ name: 'check', input_schema: { $ref } }] })), error => error.status === 400 && /reference/.test(error.message));
  }
  const p = prepare(request({ tools: [{ name: 'check', input_schema: { $ref: '#' } }] }));
  assert.throws(() => new ToolParser(p).feed(p.start + '{"name":"check","input":{}}' + p.end), /complexity limit/);
});

test('the tool size limit excludes ordinary text following a valid call', () => {
  const p = prepare(request({ tools: [tool] }));
  const tail = 'x'.repeat(1024 * 1024 + 1);
  const items = new ToolParser(p).feed(p.start + '{"name":"Read","input":{"file_path":"a.txt"}}' + p.end + tail, true);
  assert.equal(items[0].tool.name, 'Read');
  assert.equal(items[1].text, tail);
  assert.throws(() => new ToolParser(p).feed(p.start + JSON.stringify({ name: 'Read', input: { file_path: tail } }) + p.end), /size limit/);
});

test('conversation IDs are validated and history fingerprints exclude random tool delimiters', () => {
  for (const conversation_id of ['', 42, 'x'.repeat(257), 'bad\nvalue']) assert.throws(() => prepare(request({ conversation_id })), /conversation_id/);
  const a = prepare(request({ conversation_id: ' dialogue ', tools: [tool] }));
  const b = prepare(request({ conversation_id: ' dialogue ', tools: [tool] }));
  assert.equal(a.completion.conversation_id, 'dialogue');
  assert.deepEqual(a.completion.history, b.completion.history);
  assert.equal(a.completion.request_key, b.completion.request_key);
  assert.notEqual(a.completion.prompt, b.completion.prompt);
});
