import { randomUUID, createHash } from 'node:crypto';
import { BackendError } from './bridge.mjs';
import { checkSchema, validateInput } from './schema.mjs';

const MAX_BODY = 12 * 1024 * 1024;
const MAX_TOOL = 1024 * 1024;
const fail = message => { throw new BackendError(message, 400); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const charCount = text => { let count = 0; for (const char of text) count++; return count; };
const estimate = text => Math.ceil(charCount(text) / 4);
const digest = text => createHash('sha256').update(text).digest('hex');

function contentText(content, allowTools = true) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) fail('Message content must be text or content blocks');
  return content.map(block => {
    if (!object(block)) fail('Invalid content block');
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
    if (allowTools && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && object(block.input)) {
      return `[Previous tool call]\n${JSON.stringify({ id: block.id, name: block.name, input: block.input })}`;
    }
    if (allowTools && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      return `[Tool result]\n${JSON.stringify({ tool_use_id: block.tool_use_id, is_error: !!block.is_error, content: typeof block.content === 'string' ? block.content : contentText(block.content ?? [], false) })}`;
    }
    fail(`Unsupported content block: ${String(block.type)}. This provider accepts text and client tool calls.`);
  }).join('\n');
}

export function prepare(body, options = {}) {
  if (typeof body !== 'string' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) fail('Expected a JSON request body');
  if (Buffer.byteLength(body) > MAX_BODY) fail('Request body is too large');
  let req;
  try { req = JSON.parse(typeof body === 'string' ? body : Buffer.from(body).toString('utf8')); } catch { fail('Invalid request JSON'); }
  if (!object(req) || typeof req.model !== 'string' || !req.model.trim()) fail('model is required');
  if (!Array.isArray(req.messages) || !req.messages.length) fail('messages must not be empty');
  if (req.messages.length > 8192) fail('Too many messages');
  if (!Number.isSafeInteger(req.max_tokens) || req.max_tokens < 1) fail('max_tokens must be a positive integer');
  if (req.stream !== undefined && typeof req.stream !== 'boolean') fail('stream must be a boolean');
  if (req.conversation_id !== undefined && (typeof req.conversation_id !== 'string' || !req.conversation_id.trim() || req.conversation_id.length > 256 || /[\r\n\0]/.test(req.conversation_id))) fail('conversation_id must be a nonempty string of at most 256 characters');
  if (req.thinking && req.thinking.type !== 'disabled') fail('Signed extended thinking is not supported by this web adapter');
  const sequences = req.stop_sequences === undefined ? [] : req.stop_sequences;
  if (!Array.isArray(sequences) || sequences.length > 64 || sequences.some(s => typeof s !== 'string' || !s.length || s.length > 8192)) fail('stop_sequences must contain at most 64 nonempty strings of at most 8192 characters');
  const tools = req.tools ?? [];
  if (!Array.isArray(tools) || tools.some(t => !object(t) || typeof t.name !== 'string' || !t.name || !object(t.input_schema))) fail('Invalid tool definitions');
  if (new Set(tools.map(t => t.name)).size !== tools.length) fail('Tool names must be unique');
  for (const tool of tools) checkSchema(tool.input_schema);
  let choice = req.tool_choice ?? { type: 'auto' };
  if (!object(choice) || !['auto', 'any', 'tool', 'none'].includes(choice.type)) fail('Unsupported tool_choice');
  if (choice.disable_parallel_tool_use !== undefined && typeof choice.disable_parallel_tool_use !== 'boolean') fail('disable_parallel_tool_use must be a boolean');
  if (choice.type === 'tool' && !tools.some(t => t.name === choice.name)) fail('tool_choice names an undefined tool');
  if (['tool', 'any'].includes(choice.type) && !tools.length) fail('tool_choice requires tools');
  const active = choice.type === 'none' ? [] : tools;
  const nonce = randomUUID().replaceAll('-', '');
  const start = `[MAGPIE_TOOL_${nonce}]`, end = `[/MAGPIE_TOOL_${nonce}]`;
  const parts = [];
  const history = [];
  if (req.system !== undefined) parts.push('[System]\n' + contentText(req.system, false));
  for (const m of req.messages) {
    if (!object(m) || !['user', 'assistant'].includes(m.role)) fail('Only user and assistant message roles are accepted');
    const text = contentText(m.content);
    history.push(digest(m.role + '\0' + text));
    parts.push(`[${m.role === 'user' ? 'Human' : 'Assistant'}]\n${text}`);
  }
  if (active.length) {
    parts.push(`[Tool protocol]\nTools are executed by the client. To request a tool, emit ${start}{"name":"tool_name","input":{...}}${end}. Use only these delimiters for new calls; previous calls in the transcript are historical. Do not invent tool results. Stop after emitting the requested calls. You may include normal text outside calls. Match each input_schema.\nTool definitions: ${JSON.stringify(active)}\nTool choice: ${JSON.stringify(choice)}`);
  }
  parts.push('[Assistant]\n');
  const prompt = parts.join('\n\n');
  const effort = req.output_config?.effort ?? options.effort ?? 'medium';
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) fail('Unsupported effort level');
  return {
    req, tools: active, choice, start, end, sequences, inputTokens: estimate(prompt), maxOutputChars: Math.min(req.max_tokens * 4, 4 * 1024 * 1024),
    completion: { conversation_id: req.conversation_id?.trim() ?? '', turn_key: randomUUID(), history, context_key: digest(JSON.stringify([req.system ?? '', tools, choice])), request_key: digest(JSON.stringify([history, req.model, req.system ?? '', tools, choice, effort, req.max_tokens, sequences])), model: req.model, prompt, effort, thinking: 'off', locale: options.locale ?? 'en-US', timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC' },
  };
}

// Incremental framing survives delimiter splits and JSON strings containing closing markers.
export class ToolParser {
  buffer = '';
  inside = false;
  scanned = 0;
  nesting = 0;
  quoted = false;
  escaped = false;
  jsonEnd = -1;
  constructor(prepared) { this.p = prepared; }
  feed(text, final = false) { return Array.from(this.items(text, final)); }
  *items(text, final = false) {
    this.buffer += text;
    while (this.buffer.length) {
      if (!this.inside) {
        const index = this.buffer.indexOf(this.p.start);
        if (index >= 0) {
          if (index) yield { text: this.buffer.slice(0, index) };
          this.buffer = this.buffer.slice(index + this.p.start.length); this.inside = true; continue;
        }
        let keep = 0;
        if (!final) for (let n = Math.min(this.buffer.length, this.p.start.length - 1); n > 0; n--) {
          if (this.buffer.endsWith(this.p.start.slice(0, n))) { keep = n; break; }
        }
        const ready = this.buffer.slice(0, this.buffer.length - keep);
        if (ready) yield { text: ready };
        this.buffer = this.buffer.slice(this.buffer.length - keep); break;
      }
      // Find a complete JSON object first; the delimiter may appear inside a string.
      if (this.jsonEnd < 0 && this.buffer.trimStart() && !this.buffer.trimStart().startsWith('{')) throw new BackendError('Tool call must be a JSON object');
      for (let i = this.scanned; this.jsonEnd < 0 && i < this.buffer.length; i++) {
        const char = this.buffer[i];
        this.scanned = i + 1;
        if (this.quoted) { if (this.escaped) this.escaped = false; else if (char === '\\') this.escaped = true; else if (char === '"') this.quoted = false; continue; }
        if (char === '"') this.quoted = true;
        else if (char === '{' || char === '[') this.nesting++;
        else if (char === '}' || char === ']') { if (--this.nesting === 0) this.jsonEnd = i + 1; }
      }
      const jsonEnd = this.jsonEnd;
      if (Buffer.byteLength(jsonEnd < 0 ? this.buffer : this.buffer.slice(0, jsonEnd)) > MAX_TOOL) throw new BackendError('Tool call exceeds size limit');
      if (jsonEnd < 0) break;
      const rest = this.buffer.slice(jsonEnd).trimStart();
      if (!rest.startsWith(this.p.end)) {
        if (!final && (this.p.end.startsWith(rest) || !rest)) break;
        throw new BackendError('Malformed tool call delimiter');
      }
      let call;
      try { call = JSON.parse(this.buffer.slice(0, jsonEnd)); } catch { throw new BackendError('Invalid tool call JSON'); }
      const tool = this.p.tools.find(t => t.name === call.name);
      if (!tool || !object(call.input)) throw new BackendError('Model requested an undefined tool or invalid arguments');
      if (this.p.choice.type === 'tool' && tool.name !== this.p.choice.name) throw new BackendError('Model did not follow tool_choice');
      validateInput(call.input, tool.input_schema);
      yield { tool: { type: 'tool_use', id: 'toolu_' + randomUUID().replaceAll('-', ''), name: call.name, input: call.input } };
      this.buffer = rest.slice(this.p.end.length); this.inside = false;
      this.scanned = this.nesting = 0; this.quoted = this.escaped = false; this.jsonEnd = -1;
    }
    if (final && this.inside) throw new BackendError('Claude stream ended in an incomplete tool call');
  }
}

// Hold only a suffix that could become a stop sequence on the next delta.
// Scan visible text, so strings inside tool input JSON never end a response.
class StopMatcher {
  buffer = '';
  matched = null;
  constructor(sequences) {
    this.sequences = sequences.map(text => {
      const prefix = new Uint32Array(text.length);
      for (let i = 1, n = 0; i < text.length; i++) {
        while (n && text[i] !== text[n]) n = prefix[n - 1];
        if (text[i] === text[n]) n++;
        prefix[i] = n;
      }
      return { text, prefix };
    });
  }
  feed(text, final = false) {
    this.buffer += text;
    let index = -1, sequence = null;
    for (const { text: s } of this.sequences) {
      const at = this.buffer.indexOf(s);
      if (at >= 0 && (index < 0 || at < index)) { index = at; sequence = s; }
    }
    if (index >= 0) {
      const ready = this.buffer.slice(0, index);
      this.buffer = ''; this.matched = sequence;
      return ready;
    }
    let keep = 0;
    if (!final) for (const { text: s, prefix } of this.sequences) {
      // KMP avoids quadratic suffix checks for long, repetitive markers.
      let n = 0;
      for (let i = Math.max(0, this.buffer.length - s.length + 1); i < this.buffer.length; i++) {
        while (n && this.buffer[i] !== s[n]) n = prefix[n - 1];
        if (this.buffer[i] === s[n]) n++;
      }
      keep = Math.max(keep, n);
    }
    const ready = this.buffer.slice(0, this.buffer.length - keep);
    this.buffer = this.buffer.slice(this.buffer.length - keep);
    return ready;
  }
}

export async function* translate(source, p) {
  const id = 'msg_' + randomUUID().replaceAll('-', '');
  yield { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: p.req.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: p.inputTokens, output_tokens: 0 } } };
  const parser = p.tools.length ? new ToolParser(p) : null;
  const matcher = new StopMatcher(p.sequences);
  let index = 0, textOpen = false, calls = 0, outputChars = 0, stopped = false, limited = false;
  let upstreamReason = 'end_turn';
  const emitText = function* (text) {
    if (!text) return;
    const left = p.maxOutputChars - outputChars;
    let count = 0, end = 0;
    for (const char of text) {
      if (count >= left) break;
      count++; end += char.length;
    }
    if (count >= left) limited = true;
    text = text.slice(0, end);
    if (!text) return;
    if (!textOpen) { yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }; textOpen = true; }
    outputChars += count;
    yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text } };
  };
  const emit = function* (items) {
    for (const item of items) {
      if (item.text) {
        yield* emitText(matcher.feed(item.text));
        if (limited || matcher.matched) return;
      } else if (item.tool) {
        yield* emitText(matcher.feed('', true));
        if (limited || matcher.matched) return;
        if (textOpen) { yield { type: 'content_block_stop', index: index++ }; textOpen = false; }
        calls++;
        if (p.choice.disable_parallel_tool_use && calls > 1) throw new BackendError('Model emitted parallel tool calls when disabled');
        const { input, ...block } = item.tool;
        const json = JSON.stringify(input);
        const size = charCount(json);
        if (outputChars + size > p.maxOutputChars) throw new BackendError('Tool call exceeds the estimated output budget; increase max_tokens');
        outputChars += size;
        yield { type: 'content_block_start', index, content_block: { ...block, input: {} } };
        yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json } };
        yield { type: 'content_block_stop', index: index++ };
      }
    }
  };
  for await (const msg of source) {
    if (msg.event !== 'data') continue;
    const event = msg.data;
    if (event.type === 'error') {
      const type = event.error?.type ?? event.error?.error_type;
      const status = type === 'rate_limit_error' ? 429 : type === 'authentication_error' ? 401 : 502;
      throw new BackendError(`Claude stream reported ${type === 'rate_limit_error' ? 'a rate limit' : type === 'authentication_error' ? 'expired authentication' : 'an upstream error'}`, status);
    }
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') throw new BackendError('Native web tool calls are not supported');
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' || event.type === 'content_block_start' && event.content_block?.type === 'text') {
      const text = event.type === 'content_block_start' ? event.content_block.text : event.delta.text;
      if (typeof text !== 'string') throw new BackendError('Invalid Claude text delta');
      yield* emit(parser ? parser.items(text) : [{ text }]);
      if (limited || matcher.matched) { source.close(); break; }
    }
    if (event.type === 'message_delta' && event.delta?.stop_reason != null) {
      if (!['end_turn', 'max_tokens', 'refusal'].includes(event.delta.stop_reason)) throw new BackendError('Unsupported Claude stop reason');
      upstreamReason = event.delta.stop_reason;
    }
    if (event.type === 'message_stop') { stopped = true; break; }
  }
  if (!stopped && !limited && !matcher.matched) throw new BackendError('Claude stream ended before message_stop');
  if (parser && !limited && !matcher.matched) yield* emit(parser.items('', true));
  if (!limited && !matcher.matched) yield* emitText(matcher.feed('', true));
  if (!limited && !matcher.matched && upstreamReason === 'end_turn' && ['any', 'tool'].includes(p.choice.type) && !calls) throw new BackendError('Model did not produce the required tool call');
  if (textOpen) yield { type: 'content_block_stop', index };
  const reason = limited ? 'max_tokens' : matcher.matched ? 'stop_sequence' : upstreamReason === 'refusal' ? 'refusal' : calls ? 'tool_use' : upstreamReason;
  p.keepConversation = stopped && !limited && !matcher.matched;
  yield { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: reason === 'stop_sequence' ? matcher.matched : null }, usage: { output_tokens: Math.ceil(outputChars / 4) } };
  yield { type: 'message_stop' };
}

export function errorBody(error) {
  const status = error.status ?? 502;
  const type = status === 401 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : status === 400 ? 'invalid_request_error' : 'api_error';
  return { type: 'error', error: { type, message: error instanceof BackendError ? error.message : 'Claude web adapter failed' } };
}

export async function response(source, p, signal) {
  const events = translate(source, p);
  if (!p.req.stream) {
    try {
      let message;
      const blocks = [], json = new Map();
      for await (const event of events) {
        signal?.throwIfAborted();
        if (event.type === 'message_start') message = event.message;
        if (event.type === 'content_block_start') blocks[event.index] = event.content_block;
        if (event.type === 'content_block_delta') {
          const block = blocks[event.index];
          if (event.delta.type === 'text_delta') block.text += event.delta.text;
          else json.set(event.index, (json.get(event.index) ?? '') + event.delta.partial_json);
        }
        if (event.type === 'message_delta') { Object.assign(message, event.delta); message.usage.output_tokens = event.usage.output_tokens; }
      }
      for (const [i, value] of json) blocks[i].input = JSON.parse(value);
      message.content = blocks;
      return Response.json(message, { headers: { 'cache-control': 'no-store' } });
    } finally { source.close(); }
  }
  const encoder = new TextEncoder();
  let finished = false;
  const stream = new ReadableStream({
    async pull(controller) {
      if (finished) return;
      try {
        signal?.throwIfAborted();
        const next = await events.next();
        if (next.done) { finished = true; source.close(); controller.close(); }
        else controller.enqueue(encoder.encode(`event: ${next.value.type}\ndata: ${JSON.stringify(next.value)}\n\n`));
      } catch (error) {
        finished = true; source.close();
        if (signal?.aborted) controller.error(signal.reason ?? error);
        else {
          const body = errorBody(error);
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(body)}\n\n`));
          controller.close();
        }
      }
    },
    async cancel() { finished = true; source.close(); await events.return(); },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
}
