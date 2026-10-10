import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (!process.env.npm_execpath) throw new Error('Run this test through npm run test:magpie');
const source = process.argv[2] ?? process.env.MAGPIE_SOURCE;
if (!source) throw new Error('Pass a Magpie source checkout: npm run test:magpie -- /absolute/path/to/magpie');
const base = JSON.parse(readFileSync(join(root, 'integrations/magpie-base.json'), 'utf8'));
const revision = spawnSync('git', ['-C', resolve(source), 'rev-parse', 'HEAD'], { encoding: 'utf8' });
if (revision.status !== 0 || revision.stdout.trim() !== base.commit) throw new Error(`Integration patch requires Magpie commit ${base.commit}`);
const sandbox = mkdtempSync(join(tmpdir(), 'claudeweb-magpie-integration-'));
const checkout = join(sandbox, 'magpie');
const env = { ...process.env, HOME: sandbox, USERPROFILE: sandbox, XDG_CONFIG_HOME: join(sandbox, 'config'), XDG_CACHE_HOME: join(sandbox, 'cache'), CLAUDEWEB_PLUGIN_SOURCE: root };
const caches = spawnSync('go', ['env', 'GOPATH', 'GOMODCACHE', 'GOCACHE'], { encoding: 'utf8' });
if (caches.status !== 0) throw new Error('Go is required to verify the host patch');
['GOPATH', 'GOMODCACHE', 'GOCACHE'].forEach((key, i) => { env[key] = caches.stdout.trim().split('\n')[i]; });
function run(command, args, { failureExpected = false } = {}) {
  const result = spawnSync(command, args, { cwd: checkout, env, stdio: failureExpected ? 'pipe' : 'inherit', encoding: 'utf8', timeout: 600_000 });
  if (result.error) throw result.error;
  if (failureExpected) {
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (!result.stdout?.includes('--- FAIL: TestCleanRemoveOwnedState') || !result.stdout.includes('cleanup callback did not run')) throw new Error('Baseline did not fail on the expected uninstall behavior');
  }
  if (failureExpected ? result.status === 0 : result.status !== 0) throw new Error(`${command} ${args.join(' ')} ${failureExpected ? 'unexpectedly passed' : 'failed'}`);
}
try {
  const packed = spawnSync(process.execPath, [process.env.npm_execpath, 'pack', '--silent'], { cwd: root, stdio: 'inherit' });
  if (packed.status !== 0) throw new Error('Could not build the npm release archive for the installation test');
  const clone = spawnSync('git', ['clone', '--quiet', '--local', '--no-hardlinks', resolve(source), checkout], { stdio: 'inherit' });
  if (clone.status !== 0) throw new Error('Could not prepare disposable Magpie checkout');
  const patch = readFileSync(join(root, 'integrations/magpie-clean-remove.patch'), 'utf8');
  const testPath = 'internal/plugin/cleanremove_test.go';
  const section = patch.split(`diff --git a/${testPath} b/${testPath}\n`)[1]?.split('\ndiff --git ')[0];
  if (!section) throw new Error('Regression test is missing from the host patch');
  // Only this test and its fixture compile on stock Magpie. Later tests also
  // exercise helpers introduced by the patch and cannot be a baseline proof.
  const regression = section.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n').split('\nfunc TestCleanRemoveFailureKeepsRegistrationAndAuth')[0];
  writeFileSync(join(checkout, testPath), regression);
  console.log('Checking that stock Magpie fails the clean-uninstall regression.');
  run('go', ['test', '-tags', 'nogui', './internal/plugin', '-run', '^TestCleanRemoveOwnedState$', '-count=1'], { failureExpected: true });
  rmSync(join(checkout, testPath));
  run('git', ['apply', '--check', join(root, 'integrations/magpie-clean-remove.patch')]);
  run('git', ['apply', join(root, 'integrations/magpie-clean-remove.patch')]);
  copyFileSync(join(root, 'integrations/magpie-cleanremove-e2e_test.go'), join(checkout, 'internal/provider/claudeweb_e2e_test.go'));
  run('gofmt', ['-w', 'internal/provider/claudeweb_e2e_test.go']);
  console.log('Verifying the patched host, real packaged plugin and clean uninstall in a private HOME.');
  run('go', ['test', '-race', '-tags', 'nogui', './internal/plugin', './internal/provider', '-run', 'TestCleanRemove|TestCleanRemoval|TestClaudeWebPlugin', '-count=1']);
  console.log('Verified: stock host fails; patched host serves text/tools and removes installed package, accounts and model state.');
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
