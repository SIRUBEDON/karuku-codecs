import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
const root = fileURLToPath(new URL('../../', import.meta.url));
if (!process.argv[2]) throw new Error('Usage: package-sources.mjs BUILD_DIRECTORY');
const work = resolve(process.argv[2]), lock = JSON.parse(await readFile(new URL('./sources.lock.json', import.meta.url))), entries = {}, avifEntries = {};
await mkdir(join(work, 'source-archives'), { recursive: true });
for (const [name, git] of Object.entries(lock.git)) {
  const dir = join(work, 'sources', name), file = join(work, 'source-archives', `${name}-${git.commit}.tar.gz`);
  const result = spawnSync('git', ['archive', '--format=tar.gz', `--output=${file}`, git.commit], { cwd: dir, windowsHide: true, stdio: 'inherit' });
  if (result.error || result.status) throw result.error || new Error(`Cannot archive ${name}`);
  const destination = ['aom', 'libavif'].includes(name) ? avifEntries : entries;
  destination[`upstream/${name}-${git.commit}.tar.gz`] = [new Uint8Array(await readFile(file)), { level: 0 }];
}
for (const archive of lock.archives) entries[`upstream/${archive.file}`] = [new Uint8Array(await readFile(join(work, 'sources', archive.file))), { level: 0 }];
async function addTree(path) {
  for (const file of await readdir(join(root, path), { withFileTypes: true })) {
    const relative = `${path}/${file.name}`;
    if (file.isDirectory()) await addTree(relative);
    else entries[relative] = new Uint8Array(await readFile(join(root, relative)));
  }
}
await addTree('scripts/codecs'); await addTree('src/media'); await addTree('codecs/licenses');
for (const file of ['codecs/manifest.json', 'package.json', 'package-lock.json', 'THIRD_PARTY_NOTICES.md', 'scripts/prepare-codecs.mjs'])
  entries[file] = new Uint8Array(await readFile(join(root, file)));
const readme = 'Matching sources for the dedicated kururi WASM cores.\nDownload BOTH kururi-codec-sources.zip and kururi-avif-sources.zip from /codecs/.\nThe first contains app codec/build code, notices and FFmpeg/LAME/Ogg/Vorbis/WebP/deflate sources; the second contains libavif/libaom sources.\nThey are separate so every static asset remains below the Cloudflare Workers 25 MiB limit.\nExtract upstream tar.gz and tar.xz archives into BUILD_DIRECTORY/sources, using directory names from scripts/codecs/sources.lock.json.\nAll Git archives have no directory prefix; create the corresponding directory before extraction.\nUse the pinned Emsdk and scripts/codecs/BUILD.md to rebuild/link, including your modifications.\nNo upstream FFmpeg source modification was applied. The ffmpeg.wasm CLI bindings come from the pinned source archive.\nThird-party license texts and actual FFmpeg feature configs are included.\nThe main application source license is not yet selected.\n';
entries['README.txt'] = new TextEncoder().encode(readme);
avifEntries['README.txt'] = entries['README.txt'];
avifEntries['scripts/codecs/sources.lock.json'] = entries['scripts/codecs/sources.lock.json'];
for (const [name, bytes] of Object.entries(entries)) if (/^codecs\/licenses\/lib(avif|aom)/.test(name)) avifEntries[name] = bytes;
for (const [name, source] of [['kururi-codec-sources.zip', entries], ['kururi-avif-sources.zip', avifEntries]]) {
  const zip = zipSync(source, { level: 6 });
  if (zip.length > 25 * 1024 * 1024) throw new Error(`${name} exceeds the Workers Static Assets limit; split the source package further.`);
  await writeFile(join(root, 'codecs', name), zip);
  console.log(`Matching ${name}: ${zip.length} bytes, ${Object.keys(source).length} entries.`);
}
