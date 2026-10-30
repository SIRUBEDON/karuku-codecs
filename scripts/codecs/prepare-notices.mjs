import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.argv.length < 4) throw new Error('Usage: prepare-notices.mjs BUILD_DIRECTORY EMSDK_DIRECTORY');
const work = resolve(process.argv[2]), sdk = resolve(process.argv[3]), root = fileURLToPath(new URL('../../', import.meta.url));
const source = join(work, 'sources'), out = join(root, 'codecs/licenses');
await mkdir(out, { recursive: true });
for (const [path, name] of [
  [join(source, 'ffmpeg/COPYING.LGPLv2.1'), 'FFmpeg-LGPL-2.1.txt'],
  [join(source, 'ffmpeg/LICENSE.md'), 'FFmpeg-LICENSE.md'],
  [join(source, 'ffmpeg-wasm/LICENSE'), 'ffmpeg-wasm-MIT.txt'],
  [join(source, 'libwebp-1.6.0/COPYING'), 'libwebp-BSD.txt'],
  [join(source, 'libwebp-1.6.0/PATENTS'), 'libwebp-PATENTS.txt'],
  [join(source, 'libwebp-1.6.0/AUTHORS'), 'libwebp-AUTHORS.txt'],
  [join(source, 'libdeflate-1.24/COPYING'), 'libdeflate-MIT.txt'],
  [join(source, 'libavif/LICENSE'), 'libavif-BSD.txt'],
  [join(source, 'aom/LICENSE'), 'libaom-BSD.txt'],
  [join(source, 'aom/PATENTS'), 'libaom-PATENTS.txt'],
  [join(source, 'aom/AUTHORS'), 'libaom-AUTHORS.txt'],
  [join(source, 'zlib-1.3.1/zlib.h'), 'zlib-header-and-license.h'],
  [join(source, 'lame-3.100/COPYING'), 'LAME-LGPL-2.0.txt'],
  [join(source, 'lame-3.100/LICENSE'), 'LAME-LICENSE.txt'],
  [join(source, 'lame-3.100/README'), 'LAME-README.txt'],
  [join(source, 'libogg-1.3.6/COPYING'), 'libogg-BSD.txt'],
  [join(source, 'libvorbis-1.3.7/COPYING'), 'libvorbis-BSD.txt'],
  [join(sdk, 'upstream/emscripten/LICENSE'), 'Emscripten-LICENSE.txt'],
  [join(root, 'node_modules/gifenc/LICENSE.md'), 'gifenc-MIT.md'],
  [join(root, 'node_modules/fflate/LICENSE'), 'fflate-MIT.txt'],
]) await copyFile(path, join(out, name));
// The enabled MJPEG decoder includes IJG-derived IDCT code. Preserve its attribution too.
const jpeg = await readFile(join(source, 'ffmpeg/libavcodec/jrevdct.c'), 'utf8');
await writeFile(join(out, 'FFmpeg-IJG-attribution.txt'), 'This software is based in part on the work of the Independent JPEG Group.\nThe upstream FFmpeg source below has not been modified.\n\n' + jpeg.slice(0, jpeg.indexOf('#include')));
for (const mode of ['st', 'mt', 'audio']) {
  await copyFile(join(work, `ffmpeg-${mode}/config.h`), join(out, `ffmpeg-${mode}-config.h`));
  await copyFile(join(work, `ffmpeg-${mode}/config_components.h`), join(out, `ffmpeg-${mode}-config-components.h`));
}
await copyFile(join(work, 'lame-audio/config.h'), join(out, 'lame-audio-config.h'));
for (const name of ['ogg', 'vorbis']) await copyFile(join(work, `${name}-audio/config.h`), join(out, `${name}-audio-config.h`));
console.log('Matching third-party license texts and configured feature lists are ready.');
