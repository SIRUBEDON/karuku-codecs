import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { encodeRgbaPng, parsePng } from '../../src/media/png.js';
import { imageCodec } from '../../src/media/image-codec.js';
import createImageCore from '../../codecs/image/image-core.js';
import { unzlibSync } from 'fflate';
const width = 960, height = 540, rgba = new Uint8Array(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const i = (y * width + x) * 4;
  rgba[i] = x & 255; rgba[i + 1] = y & 255; rgba[i + 2] = (x + y) & 255; rgba[i + 3] = x < width / 3 ? 0 : 255;
}
globalThis.self = { location: { href: new URL('../../codecs/image/image-core.js', import.meta.url).href } };
const runtime = imageCodec(await createImageCore({ wasmBinary: await readFile(new URL('../../codecs/image/image-core.wasm', import.meta.url)) }));
delete globalThis.self;
const measure = fn => {
  fn(); const timesMs = []; let bytes;
  for (let i = 0; i < 10; i++) { const start = performance.now(); bytes = fn(); timesMs.push(Number((performance.now() - start).toFixed(2))); }
  return { timesMs, bytes: bytes.length, data: bytes };
};
const js = measure(() => encodeRgbaPng(rgba, width, height));
const wasm = measure(() => encodeRgbaPng(rgba, width, height, (p, w, h) => runtime.compressPixels(p, w, h, 9)));
const inflate = data => unzlibSync(parsePng(data).chunks.find(c => c.type === 'IDAT').data);
const a = inflate(js.data), b = inflate(wasm.data);
if (a.length !== b.length || !a.every((v, i) => v === b[i])) throw new Error('The benchmark pipelines changed filtered pixels.');
delete js.data; delete wasm.data; runtime.dispose();
console.log(JSON.stringify({ width, height, level: 9, pixelEquality: true, js, wasm,
  note: 'Whole PNG pipeline comparison: SIMD Sub + libdeflate versus scalar JS Sub + fflate. This does not isolate SIMD speed.' }, null, 2));
