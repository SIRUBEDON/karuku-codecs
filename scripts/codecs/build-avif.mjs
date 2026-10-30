import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).flatMap((v, i, a) => v.startsWith('--') ? [[v.slice(2), a[i + 1]]] : []));
if (!args.work || !args.emsdk) throw new Error('Usage: build-avif.mjs --work BUILD --emsdk EMSDK [--cmake CMAKE] [--ninja NINJA]');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = resolve(args.work), sdk = resolve(args.emsdk), em = join(sdk, 'upstream/emscripten');
const python = process.platform === 'win32' ? join(sdk, 'python/3.13.3_64bit/python.exe') : 'python3';
const env = { ...process.env, EM_CONFIG: join(sdk, '.emscripten'), EM_CACHE: join(em, 'cache'),
  EMSDK_PYTHON: python, PATH: [em, dirname(python), process.env.PATH].join(delimiter) };
const cmake = args.cmake || 'cmake', ninja = args.ninja || 'ninja';
const run = (command, values) => new Promise((success, failure) => {
  const child = spawn(command, values, { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', failure);
  child.on('exit', code => code ? failure(new Error(`${command} exited ${code}`)) : success());
});
const flags = '-O3 -flto -msimd128 -DNDEBUG';
const common = ['-G', 'Ninja', `-DCMAKE_MAKE_PROGRAM=${ninja}`, `-DCMAKE_TOOLCHAIN_FILE=${join(em, 'cmake/Modules/Platform/Emscripten.cmake')}`,
  '-DCMAKE_BUILD_TYPE=Release', `-DCMAKE_C_FLAGS_RELEASE=${flags}`, `-DCMAKE_CXX_FLAGS_RELEASE=${flags}`, '-DBUILD_SHARED_LIBS=OFF'];
const aomSource = join(work, 'sources/aom'), aomBuild = join(work, 'aom-avif');
const avifSource = join(work, 'sources/libavif'), avifBuild = join(work, 'libavif-avif');
if (!args['link-only']) {
await run(cmake, ['-S', aomSource, '-B', aomBuild, ...common, '-DAOM_TARGET_CPU=generic',
  '-DENABLE_DOCS=OFF', '-DENABLE_TESTS=OFF', '-DENABLE_EXAMPLES=OFF', '-DENABLE_TOOLS=OFF',
  ...(args.perl ? [`-DPERL_EXECUTABLE=${args.perl}`] : []),
  '-DCONFIG_MULTITHREAD=0', '-DCONFIG_RUNTIME_CPU_DETECT=0', '-DCONFIG_AV1_ENCODER=1', '-DCONFIG_AV1_DECODER=1']);
await run(cmake, ['--build', aomBuild, '--target', 'aom', '--parallel', '4']);
await run(cmake, ['-S', avifSource, '-B', avifBuild, ...common, '-DAVIF_CODEC_AOM=SYSTEM',
  `-DAOM_INCLUDE_DIR=${aomSource}`, `-DAOM_LIBRARY=${join(aomBuild, 'libaom.a')}`, '-DAVIF_LIBYUV=OFF',
  '-DAVIF_LIBSHARPYUV=OFF', '-DAVIF_BUILD_APPS=OFF', '-DAVIF_BUILD_TESTS=OFF', '-DAVIF_BUILD_MAN_PAGES=OFF']);
await run(cmake, ['--build', avifBuild, '--target', 'avif', '--parallel', '4']);
}
const out = join(root, 'codecs/avif');
await mkdir(out, { recursive: true });
const exported = ['malloc', 'free', 'ka_error', 'ka_result', 'ka_result_size', 'ka_clear_result',
  'ka_encoder_new', 'ka_encoder_add', 'ka_encoder_finish', 'ka_encoder_delete',
  'ka_decoder_new', 'ka_decoder_info', 'ka_decoder_timing', 'ka_decoder_next', 'ka_decoder_delete'];
await run(python, [join(em, 'emcc.py'), ...flags.split(' '), `-I${join(avifSource, 'include')}`, join(root, 'scripts/codecs/avif.c'),
  join(avifBuild, 'libavif_internal.a'), join(aomBuild, 'libaom.a'), '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sENVIRONMENT=worker',
  '-sFILESYSTEM=0', '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=33554432', '-sMAXIMUM_MEMORY=1073741824',
  '-sSTACK_SIZE=5242880', '-sMALLOC=emmalloc', '-sASSERTIONS=0', `-sEXPORTED_FUNCTIONS=${JSON.stringify(exported.map(name => '_' + name))}`,
  '-sEXPORTED_RUNTIME_METHODS=[]', '-o', join(out, 'avif-core.js')]);
await writeFile(join(work, 'avif-build-options.json'), JSON.stringify({ emscripten: '3.1.40', flags: flags.split(' '),
  aom: { version: '3.12.1', cpu: 'generic', encoder: true, decoder: true, threads: 1, runtimeCpuDetect: false },
  libavif: { version: '1.2.1', codec: 'aom', libyuv: false, libsharpyuv: false }, initialMemoryBytes: 33554432 }, null, 2) + '\n');
console.log('AVIF encoder and decoder are built as an independent, filesystem-free WASM.');
