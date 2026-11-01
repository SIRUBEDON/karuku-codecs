import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const args = Object.fromEntries(process.argv.slice(2).map((v, i, a) => v.startsWith('--') ? [v.slice(2), a[i + 1]] : []).filter(p => p.length));
const work = resolve(args.work);
const sdk = resolve(args.emsdk);
const mode = args.mode || 'image';
if (!['image', 'st', 'mt'].includes(mode)) throw new Error('mode must be image, st or mt');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sources = join(work, 'sources');
const prefix = join(work, mode === 'mt' ? 'prefix-mt' : 'prefix-st');
const python = process.platform === 'win32' ? join(sdk, 'python/3.13.3_64bit/python.exe') : 'python3';
const emscripten = join(sdk, 'upstream/emscripten');
const env = { ...process.env, EM_CONFIG: join(sdk, '.emscripten'), EM_CACHE: join(emscripten, 'cache') };
const flags = ['-O3', '-flto', '-msimd128', '-msse2', '-DNDEBUG', ...(mode === 'mt' ? ['-pthread'] : [])];
const run = (tool, values) => new Promise((success, failure) => {
  const child = spawn(python, [join(emscripten, `${tool}.py`), ...values], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  child.stderr.on('data', b => { errors += b; });
  child.on('error', failure);
  child.on('exit', code => code ? failure(new Error(`${tool} exited ${code}: ${errors.slice(-5000)}`)) : success());
});
await mkdir(join(prefix, 'lib/pkgconfig'), { recursive: true });
await mkdir(join(prefix, 'include/webp'), { recursive: true });

async function compile(name, base, files, includes = [], defines = []) {
  const objectDir = join(work, `objects-${mode}`, name);
  await mkdir(objectDir, { recursive: true });
  const objects = [];
  // Flags, headers and toolchain changes invalidate the cache, not just the C file's timestamp.
  const fingerprint = createHash('sha256').update(JSON.stringify({ flags, includes, defines, emscripten: '3.1.40' }));
  async function hashHeaders(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) await hashHeaders(join(directory, entry.name));
      else if (entry.isFile() && /\.(h|inc)$/.test(entry.name)) fingerprint.update(join(directory, entry.name)).update(await readFile(join(directory, entry.name)));
    }
  }
  await hashHeaders(base);
  const digest = fingerprint.digest('hex'), cacheFile = join(objectDir, 'compile-fingerprint.txt');
  const cacheMatches = await readFile(cacheFile, 'utf8').then(value => value === digest, () => false);
  let done = 0, next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < files.length) {
      const file = files[next++];
      const object = join(objectDir, file.replaceAll(/[\\/]/g, '_').replace(/\.c$/, '.o'));
      objects.push(object);
      let fresh = false;
      try { fresh = cacheMatches && (await stat(object)).mtimeMs >= (await stat(join(base, file))).mtimeMs; } catch {}
      if (!fresh) await run('emcc', [...flags, ...includes.map(p => `-I${p}`), ...defines, '-c', join(base, file), '-o', object]);
      done++;
      if (done % 20 === 0 || done === files.length) console.log(`${name} ${done}/${files.length}`);
    }
  }));
  objects.sort();
  const library = join(prefix, `lib/lib${name}.a`);
  await run('emar', ['rcs', library, ...objects]);
  await writeFile(cacheFile, digest);
  return library;
}

const webp = join(sources, 'libwebp-1.6.0');
const webpFiles = [];
for (const directory of ['dec', 'enc', 'dsp', 'utils', 'mux', 'demux'])
  for (const file of await readdir(join(webp, 'src', directory)))
    if (file.endsWith('.c')) webpFiles.push(`src/${directory}/${file}`);
for (const file of await readdir(join(webp, 'sharpyuv')))
  if (file.endsWith('.c')) webpFiles.push(`sharpyuv/${file}`);
await compile('webp', webp, webpFiles, [webp, join(webp, 'src')]);
for (const file of await readdir(join(webp, 'src/webp')))
  if (file.endsWith('.h')) await copyFile(join(webp, 'src/webp', file), join(prefix, 'include/webp', file));
const pcPrefix = prefix.replaceAll('\\', '/');
for (const name of ['libwebp', 'libwebpmux', 'libwebpdemux'])
  await writeFile(join(prefix, `lib/pkgconfig/${name}.pc`), `prefix=${pcPrefix}\nlibdir=\${prefix}/lib\nincludedir=\${prefix}/include\nName: ${name}\nDescription: dedicated libwebp build\nVersion: 1.6.0\nLibs: -L\${libdir} -lwebp\nCflags: -I\${includedir}\n`);

if (mode === 'image') {
  const deflate = join(sources, 'libdeflate-1.24');
  const deflateFiles = (await readdir(join(deflate, 'lib'))).filter(f => f.endsWith('.c')).map(f => `lib/${f}`);
  await compile('deflate', deflate, deflateFiles, [deflate]);
  const outputDir = join(root, 'codecs/image');
  await mkdir(outputDir, { recursive: true });
  const exports = ['malloc', 'free', 'kw_result', 'kw_result_size', 'kw_clear_result', 'kw_webp',
    'kw_anim_new', 'kw_anim_add', 'kw_anim_finish', 'kw_anim_delete', 'kw_zlib', 'kw_sub', 'kw_filter', 'kw_png', 'kw_equal',
    'kw_decoder_new', 'kw_decoder_info', 'kw_decoder_next', 'kw_decoder_delete'].map(n => `_${n}`);
  await run('emcc', [...flags, `-I${join(webp, 'src')}`, `-I${deflate}`, join(root, 'scripts/codecs/image.c'),
    `-L${join(prefix, 'lib')}`, '-lwebp', '-ldeflate', '-sMODULARIZE', '-sEXPORT_ES6', '-sEXPORT_NAME=createImageCore',
    '-sENVIRONMENT=worker', '-sFILESYSTEM=0', '-sALLOW_MEMORY_GROWTH', '-sINITIAL_MEMORY=16777216', '-sMAXIMUM_MEMORY=1073741824',
    `-sEXPORTED_FUNCTIONS=${JSON.stringify(exports)}`, '-o', join(outputDir, 'image-core.js')]);
  console.log(`Image WASM: ${(await stat(join(outputDir, 'image-core.wasm'))).size} bytes`);
} else {
  const zlib = join(sources, 'zlib-1.3.1');
  await compile('z', zlib, ['adler32.c', 'compress.c', 'crc32.c', 'deflate.c', 'infback.c', 'inffast.c',
    'inflate.c', 'inftrees.c', 'trees.c', 'uncompr.c', 'zutil.c'], [zlib], ['-DHAVE_UNISTD_H=1']);
  for (const file of ['zlib.h', 'zconf.h']) await copyFile(join(zlib, file), join(prefix, 'include', file));
  await writeFile(join(prefix, 'lib/pkgconfig/zlib.pc'), `prefix=${pcPrefix}\nlibdir=\${prefix}/lib\nincludedir=\${prefix}/include\nName: zlib\nDescription: zlib\nVersion: 1.3.1\nLibs: -L\${libdir} -lz\nCflags: -I\${includedir}\n`);
  console.log(`${mode} libraries ready`);
}
