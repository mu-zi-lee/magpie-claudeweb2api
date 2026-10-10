import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.optionalDependencies ?? {}).length) throw new Error('Runtime dependencies violate isolated packaging');
if (['preinstall', 'install', 'postinstall', 'preuninstall', 'uninstall', 'postuninstall'].some(name => pkg.scripts?.[name])) throw new Error('Magpie does not run npm lifecycle scripts');
const hashes = JSON.parse(await readFile(new URL('../bin/checksums.json', import.meta.url), 'utf8'));
for (const platform of ['darwin', 'linux', 'win32']) for (const arch of ['arm64', 'x64']) {
  const name = `claudeweb-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`;
  const file = new URL(`../bin/${name}`, import.meta.url);
  await access(file, platform === 'win32' ? constants.F_OK : constants.X_OK);
  if (createHash('sha256').update(await readFile(file)).digest('hex') !== hashes[name]) throw new Error(`Checksum mismatch: ${name}`);
}
console.log('All six release backends are present. No install scripts or runtime dependencies.');
