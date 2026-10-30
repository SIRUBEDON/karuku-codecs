import { spawnSync } from 'node:child_process';
import { mkdir, readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const lock = JSON.parse(await readFile(new URL('./sources.lock.json', import.meta.url)));
const work = resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Usage: node bootstrap.mjs BUILD_DIRECTORY');
const sources = join(work, 'sources');
await mkdir(sources, { recursive: true });
const exists = path => access(path).then(() => true, () => false);
function run(command, args, cwd = sources) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} exited ${result.status}`);
}
for (const archive of lock.archives) {
  const path = join(sources, archive.file);
  if (!await exists(path)) run('curl', ['--fail', '--location', '--retry', '3', archive.url, '-o', path]);
  const actual = createHash('sha256').update(await readFile(path)).digest('hex');
  if (actual !== archive.sha256) throw new Error(`${archive.file}: SHA-256 mismatch; preserve and investigate the download.`);
  if (!await exists(join(sources, archive.directory))) run('tar', ['xf', path]);
}
for (const [name, git] of Object.entries(lock.git)) {
  const path = join(sources, name);
  if (!await exists(path)) {
    run('git', ['init', path]);
    run('git', ['remote', 'add', 'origin', git.url], path);
    run('git', ['fetch', '--depth', '1', 'origin', git.commit], path);
    run('git', ['checkout', '--detach', 'FETCH_HEAD'], path);
  }
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || result.stdout.trim() !== git.commit) throw new Error(`${name}: existing source does not match the lock; use a new build directory.`);
}
console.log('Pinned and checksum-verified build inputs are ready.');
