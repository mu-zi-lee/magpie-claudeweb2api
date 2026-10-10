import { Bridge, BackendError } from './bridge.mjs';
import { prepare, response, errorBody } from './protocol.mjs';
import { createHash } from 'node:crypto';

const PROVIDER = 'claude-web';
const ORIGIN = 'https://claude.ai';

// Only this object is exported: Magpie interprets exported functions as plugin entry points.
export default {
  id: 'magpie-claudeweb2api',
  async server(input, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Plugin options must be an object');
    if (input.magpie?.cleanRemove !== 1) {
      throw new Error('This plugin requires Magpie cleanRemove v1 to guarantee automatic uninstall cleanup. Apply integrations/magpie-clean-remove.patch before installing.');
    }
    if (options.proxy !== undefined && typeof options.proxy !== 'string') throw new Error('proxy must be a URL string or "direct"');
    const origin = options.origin ?? ORIGIN;
    const upstream = new URL(origin);
    if (upstream.username || upstream.password || upstream.search || upstream.hash || !['', '/'].includes(upstream.pathname) ||
        (upstream.protocol !== 'https:' && !(upstream.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(upstream.hostname)))) {
      throw new Error('origin must be an HTTPS origin (HTTP is allowed only on loopback for local tests)');
    }
    for (const name of ['contextLimit', 'outputLimit']) {
      if (options[name] !== undefined && (!Number.isSafeInteger(options[name]) || options[name] < 1)) throw new Error(`${name} must be a positive integer`);
    }
    for (const name of ['locale', 'timezone']) {
      if (options[name] !== undefined && (typeof options[name] !== 'string' || !options[name].trim())) throw new Error(`${name} must be a nonempty string`);
    }
    const bridge = new Bridge();
    // Bind a session to its original login. Magpie may select another account
    // later; refuse that switch instead of silently forking the web dialogue.
    const bindings = new Map();
    const digest = value => createHash('sha256').update(value).digest('hex');
    // Check the bundled executable on loading, even before the first account signs in.
    await bridge.start();
    const command = (method, auth, extra = {}) => {
      if (auth?.type !== 'api' || typeof auth.key !== 'string') throw new BackendError('Sign in with a Claude sessionKey or Cookie', 401);
      return { method, auth: { key: auth.key }, origin, proxy: options.proxy ?? input.magpie.proxyFor?.(origin) ?? '', ...extra };
    };
    return {
      'chat.headers': async ({ sessionID, model }, output) => {
        if (model?.providerID === PROVIDER && typeof sessionID === 'string' && sessionID) output.headers['x-claudeweb-conversation'] = digest(sessionID);
      },
      config: async cfg => {
        cfg.provider ??= {};
        cfg.provider[PROVIDER] ??= { name: 'Claude Web', npm: '@ai-sdk/anthropic', api: 'https://claude-web.invalid/v1', models: {} };
      },
      auth: {
        provider: PROVIDER,
        maxConcurrency: 1,
        methods: [{ type: 'api', label: 'Claude sessionKey or full Cookie', placeholder: 'sk-ant-sid… or sessionKey=…; …' }],
        async loader(getAuth) {
          return {
            baseURL: 'https://claude-web.invalid/v1',
            // Never send the saved Cookie in gateway header fields.
            apiKey: 'managed-locally',
            async fetch(url, init = {}) {
              let source;
              try {
                if (new URL(url).pathname !== '/v1/messages' || (init.method ?? 'POST').toUpperCase() !== 'POST') throw new BackendError('This provider serves Anthropic Messages only', 400);
                const p = prepare(init.body, options);
                const headers = new Headers(init.headers);
                const named = ['x-claudeweb-conversation', 'x-magpie-session', 'x-session-id', 'x-opencode-session', 'session_id'].map(name => headers.get(name)).find(Boolean);
                if (!p.completion.conversation_id && named) p.completion.conversation_id = digest(named);
                const auth = await getAuth();
                const cmd = command('complete', auth, { completion: p.completion });
                const id = p.completion.conversation_id;
                if (id) {
                  const now = Date.now();
                  for (const [key, value] of bindings) if (now - value.used >= 30 * 60_000) bindings.delete(key);
                  const cookie = auth.key.trim();
                  const session = cookie.includes('=') ? cookie.split(';').map(x => x.trim()).find(x => x.startsWith('sessionKey='))?.slice(11) : cookie;
                  const owner = digest(session ?? cookie);
                  const prior = bindings.get(id);
                  if (prior && (prior.owner !== owner || prior.proxy !== cmd.proxy)) throw new BackendError('This conversation is bound to another account or proxy; pin the original account or start a new conversation_id', 409);
                  if (!prior && bindings.size >= 1024) throw new BackendError('Conversation binding capacity is busy; wait for idle sessions to expire', 429, '60');
                  bindings.set(id, { owner, proxy: cmd.proxy, used: now });
                }
                const upstreamSource = await bridge.open(cmd, init.signal);
                let closed = false, receivedHead = false;
                const close = () => {
                  if (closed) return;
                  closed = true;
                  upstreamSource.close();
                  if (id && receivedHead && !p.keepConversation) {
                    // A fast upstream may already have committed before the
                    // local parser stops. Discard also covers that late race.
                    void bridge.call({ ...cmd, method: 'discard', completion: { conversation_id: id, turn_key: cmd.completion.turn_key } }).catch(() => {});
                  }
                };
                source = { next: () => upstreamSource.next(), close, return: () => upstreamSource.return(), [Symbol.asyncIterator]() { return this; } };
                const first = await source.next();
                if (first.done || first.value.event !== 'head') throw new BackendError('Backend returned no response headers');
                receivedHead = true;
                return await response(source, p, init.signal);
              } catch (error) {
                source?.close();
                if (init.signal?.aborted) throw init.signal.reason ?? error;
                const headers = { 'cache-control': 'no-store' };
                if (error.retryAfter) headers['retry-after'] = error.retryAfter;
                if (error.signIn === 'expired') headers['x-magpie-sign-in'] = 'expired';
                return Response.json(errorBody(error), { status: error.status ?? 502, headers });
              }
            },
          };
        },
      },
      provider: {
        id: PROVIDER,
        async models(provider, { auth } = {}) {
          if (!auth) return provider.models;
          const ids = await bridge.call(command('models', auth));
          return Object.fromEntries(ids.map(id => [id, {
            id, name: id, api: { id, url: 'https://claude-web.invalid/v1', npm: '@ai-sdk/anthropic' },
            // These are adapter planning limits, not claims about the subscription's limits.
            limit: { context: options.contextLimit ?? 200_000, output: options.outputLimit ?? 8192 },
            capabilities: { reasoning: false, toolcall: true, attachment: false, input: { text: true, image: false }, output: { text: true } },
          }]));
        },
      },
      'magpie.uninstall': async () => { bindings.clear(); await bridge.dispose(); },
      'magpie.dispose': async () => { bindings.clear(); await bridge.dispose(); },
    };
  },
};
