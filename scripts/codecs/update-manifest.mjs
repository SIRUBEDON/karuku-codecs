import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceLock = JSON.parse(await readFile(resolve(root, 'scripts/codecs/sources.lock.json'), 'utf8'));
const manifest = { version: 1, emscripten: '3.1.40', ffmpeg: '5.1.10', libwebp: '1.6.0', libdeflate: '1.24', zlib: '1.3.1', libavif: '1.2.1', libaom: '3.12.1', lame: '3.100',
  libogg: '1.3.6', libvorbis: '1.3.7', sourceLock, compilerFlags: ['-O3', '-flto', '-msimd128', '-msse2'], codecs: {} };
for (const [variant, names] of Object.entries({ image: ['image-core.js', 'image-core.wasm'],
  avif: ['avif-core.js', 'avif-core.wasm'],
  audio: ['ffmpeg-core.js', 'ffmpeg-core.wasm'],
  st: ['ffmpeg-core.js', 'ffmpeg-core.wasm'], mt: ['ffmpeg-core.js', 'ffmpeg-core.wasm', 'ffmpeg-core.worker.js'] })) {
  const files = {};
  for (const name of names) {
    const path = resolve(root, 'codecs', variant, name);
    let bytes;
    try { bytes = await readFile(path); } catch { break; }
    if (name.endsWith('.wasm') && !WebAssembly.validate(bytes)) throw new Error(`Invalid codec binary: ${path}`);
    files[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  if (Object.keys(files).length === names.length) manifest.codecs[variant] = { files,
    initialMemoryBytes: variant === 'mt' ? 134217728 : variant === 'image' ? 16777216 : 33554432,
    ...(variant === 'avif' ? { compilerFlags: ['-O3', '-flto', '-msimd128', '-DNDEBUG'], filesystem: false,
      features: ['avif-still-encode', 'avif-sequence-encode', 'avif-decode', 'lossless-alpha'], av1Codec: 'aom', cpu: 'generic' } : {}),
    ...(variant === 'audio' ? { features: ['mp3-encode', 'vorbis-encode', 'mp3-decode', 'aac-decode', 'pcm-decode', 'flac-decode', 'alac-decode', 'vorbis-decode', 'opus-decode', 'wma-decode'],
      encoders: ['libmp3lame', 'libvorbis'], filesystem: 'WORKERFS' } : {}),
    threads: variant === 'mt' ? 2 : 1 };
}
if (!manifest.codecs.image || !manifest.codecs.st) throw new Error('Build the image and single-thread codecs first.');
await writeFile(resolve(root, 'codecs/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(Object.fromEntries(Object.entries(manifest.codecs).map(([name, info]) => [name, info.files[`${['image', 'avif'].includes(name) ? name : 'ffmpeg'}-core.wasm`].bytes])));
