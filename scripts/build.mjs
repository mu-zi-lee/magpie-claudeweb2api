import { spawnSync } from 'node:child_process';
import { mkdirSync, chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const targets = process.argv.includes('--all')
  ? [['darwin', 'arm64'], ['darwin', 'amd64'], ['linux', 'arm64'], ['linux', 'amd64'], ['windows', 'arm64'], ['windows', 'amd64']]
  : [[{ win32: 'windows' }[process.platform] ?? process.platform, process.arch === 'x64' ? 'amd64' : process.arch]];
mkdirSync(new URL('../bin/', import.meta.url), { recursive: true });
for (const [os, arch] of targets) {
  const platform = os === 'windows' ? 'win32' : os;
  const jsArch = arch === 'amd64' ? 'x64' : arch;
  const output = `${root}bin/claudeweb-${platform}-${jsArch}${os === 'windows' ? '.exe' : ''}`;
  const build = spawnSync('go', ['build', '-trimpath', '-ldflags=-s -w -buildid=', '-o', output, '.'], {
    cwd: root + 'backend', env: { ...process.env, GOOS: os, GOARCH: arch, CGO_ENABLED: '0' }, stdio: 'inherit',
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
  if (os !== 'windows') chmodSync(output, 0o755);
  console.log(`Built ${platform}/${jsArch}`);
}
const hashes = {};
for (const file of readdirSync(root + 'bin').sort()) {
  if (/^claudeweb-(darwin|linux|win32)-(arm64|x64)(\.exe)?$/.test(file)) {
    hashes[file] = createHash('sha256').update(readFileSync(root + 'bin/' + file)).digest('hex');
  }
}
writeFileSync(root + 'bin/checksums.json', JSON.stringify(hashes, null, 2) + '\n');
