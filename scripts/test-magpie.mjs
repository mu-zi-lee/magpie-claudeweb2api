import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (!process.env.npm_execpath) throw new Error('Run this test through npm run test:magpie');
const source = process.argv[2] ?? process.env.MAGPIE_SOURCE;
if (!source) throw new Error('Pass a Magpie source checkout: npm run test:magpie -- /absolute/path/to/magpie');
const base = JSON.parse(readFileSync(join(root, 'integrations/magpie-base.json'), 'utf8'));
const revision = spawnSync('git', ['-C', resolve(source), 'rev-parse', 'HEAD'], { encoding: 'utf8' });
if (revision.status !== 0 || revision.stdout.trim() !== base.commit) throw new Error(`Integration test requires Magpie commit ${base.commit}`);
const sandbox = mkdtempSync(join(tmpdir(), 'claudeweb-magpie-integration-'));
const checkout = join(sandbox, 'magpie');
const env = { ...process.env, HOME: sandbox, USERPROFILE: sandbox, XDG_CONFIG_HOME: join(sandbox, 'config'), XDG_CACHE_HOME: join(sandbox, 'cache'), CLAUDEWEB_PLUGIN_SOURCE: root };
const caches = spawnSync('go', ['env', 'GOPATH', 'GOMODCACHE', 'GOCACHE'], { encoding: 'utf8' });
if (caches.status !== 0) throw new Error('Go is required to run the stock host integration test');
['GOPATH', 'GOMODCACHE', 'GOCACHE'].forEach((key, i) => { env[key] = caches.stdout.trim().split('\n')[i]; });
function run(command, args) {
  const result = spawnSync(command, args, { cwd: checkout, env, stdio: 'inherit', timeout: 600_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
}
try {
  const packed = spawnSync(process.execPath, [process.env.npm_execpath, 'pack', '--silent'], { cwd: root, stdio: 'inherit' });
  if (packed.status !== 0) throw new Error('Could not build the npm release archive for the installation test');
  const clone = spawnSync('git', ['clone', '--quiet', '--local', '--no-hardlinks', resolve(source), checkout], { stdio: 'inherit' });
  if (clone.status !== 0) throw new Error('Could not prepare disposable Magpie checkout');
  copyFileSync(join(root, 'integrations/magpie-e2e_test.go'), join(checkout, 'internal/provider/claudeweb_e2e_test.go'));
  run('gofmt', ['-w', 'internal/provider/claudeweb_e2e_test.go']);
  console.log('Verifying stock Magpie, the packaged plugin and ordinary removal in a private HOME.');
  run('go', ['test', '-race', '-tags', 'nogui', './internal/provider', '-run', '^TestClaudeWebPluginStockInstallRequestAndRemove$', '-count=1', '-v']);
  console.log('Verified: stock host stores the bundled icon, serves text/tools, reuses conversations, removes the package and closes the backend pipe.');
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
