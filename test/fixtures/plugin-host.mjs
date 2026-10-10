import plugin from '../../src/index.mjs';

let hooks, loader, auth, options;
process.on('message', async ({ id, action, value }) => {
  if (action === 'exit') process.exit(0);
  try {
    let result;
    if (action === 'load') {
      options = value;
      hooks = await plugin.server({}, options);
      loader = await hooks.auth.loader(async () => auth);
      result = Object.keys(hooks);
    } else if (action === 'headers') {
      const output = { headers: {} };
      await hooks['chat.headers'](value, output);
      result = output;
    } else if (action === 'fetch') {
      auth = value.auth;
      options.proxy = value.proxy;
      const response = await loader.fetch(value.url, value.init);
      result = { status: response.status, headers: [...response.headers], body: await response.text() };
    } else throw new Error(`Unknown test action: ${action}`);
    process.send({ id, result });
  } catch (error) {
    process.send({ id, error: error.message });
  }
});
