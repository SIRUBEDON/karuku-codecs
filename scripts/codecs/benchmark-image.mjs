// PNG pipeline benchmark: the synthetic 960×540 gradient through the JS (fflate) and WASM (libdeflate) encoders, the old
// Sub-only WASM stream (compressSub) next to the current filter choice (compressPixels) at levels 4 and 9 on the bench
// PNGs, recompressPng against re-deflating only, and still PNG output as RGBA only against the exact type reduction. Every output is checked to unfilter to the input pixels.
import { readFile, readdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { concatBytes, encodeRgbaPng, filterRows, parsePng, recompressPng, unfilterRows } from '../../src/media/png.js';
import { imageCodec } from '../../src/media/image-codec.js';
import createImageCore from '../../codecs/image/image-core.js';
import { unzlibSync } from 'fflate';
const ROOT = new URL('../../', import.meta.url);
const width = 960, height = 540, rgba = new Uint8Array(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const i = (y * width + x) * 4;
  rgba[i] = x & 255; rgba[i + 1] = y & 255; rgba[i + 2] = (x + y) & 255; rgba[i + 3] = x < width / 3 ? 0 : 255;
}
globalThis.self = { location: { href: new URL('../../codecs/image/image-core.js', import.meta.url).href } };
const runtime = imageCodec(await createImageCore({ wasmBinary: await readFile(new URL('../../codecs/image/image-core.wasm', import.meta.url)) }));
delete globalThis.self;
const median = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const measure = (fn, reps = 10) => {
  fn(); const timesMs = []; let bytes;
  for (let i = 0; i < reps; i++) { const start = performance.now(); bytes = fn(); timesMs.push(Number((performance.now() - start).toFixed(2))); }
  return { timesMs, bytes: bytes.length, data: bytes };
};
const idat = png => unzlibSync(concatBytes(parsePng(png).chunks.filter(c => c.type === 'IDAT').map(c => c.data)));
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
/** Unfiltered samples of a still PNG (the inflated stream itself when interlaced: recompressPng never refilters those). */
const samples = png => {
  const p = parsePng(png), bits = CHANNELS[p.colorType] * p.bitDepth, rows = idat(png);
  return p.interlace ? rows : unfilterRows(rows, p.width, p.height, Math.max(1, bits >> 3), Math.ceil(p.width * bits / 8));
};
/** 8-bit RGBA of a non-interlaced PNG up to 8 bits per sample, any colour type (PLTE/tRNS and grey scaling per spec 11.2.2). */
const rgbaOf = png => {
  const p = parsePng(png), channels = CHANNELS[p.colorType], raw = samples(png), stride = Math.ceil(p.width * channels * p.bitDepth / 8), max = (1 << p.bitDepth) - 1;
  const chunk = type => p.chunks.find(c => c.type === type)?.data, plte = chunk('PLTE'), trns = chunk('tRNS') ?? new Uint8Array(), out = new Uint8Array(p.width * p.height * 4);
  for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) {
    const s = k => { const bit = (x * channels + k) * p.bitDepth; return (raw[y * stride + (bit >> 3)] >> (8 - p.bitDepth - (bit & 7))) & max; };
    out.set(p.colorType === 3 ? [...plte.subarray(s(0) * 3, s(0) * 3 + 3), s(0) < trns.length ? trns[s(0)] : 255] : p.colorType === 0 ? [...Array(3).fill(s(0) * 255 / max), 255]
      : p.colorType === 4 ? [s(0), s(0), s(0), s(1)] : p.colorType === 2 ? [s(0), s(1), s(2), 255] : [s(0), s(1), s(2), s(3)], (y * p.width + x) * 4);
  }
  return out;
};
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const rowTypes = (rows, stride, h) => { const n = [0, 0, 0, 0, 0]; for (let y = 0; y < h; y++) n[rows[y * (stride + 1)]]++; return n; };

const js = measure(() => encodeRgbaPng(rgba, width, height));
const wasm = measure(() => encodeRgbaPng(rgba, width, height, (p, w, h) => runtime.compressPixels(p, w, h, 9)));
const wasm4 = measure(() => encodeRgbaPng(rgba, width, height, (p, w, h) => runtime.compressPixels(p, w, h, 4)));
const legacy = measure(() => encodeRgbaPng(rgba, width, height, (p, w, h) => runtime.compressSub(p, w, h, 9)));
const legacy4 = measure(() => encodeRgbaPng(rgba, width, height, (p, w, h) => runtime.compressSub(p, w, h, 4)));
const pixelEquality = [js, wasm, wasm4, legacy, legacy4].every(r => same(unfilterRows(idat(r.data), width, height, 4), rgba));
if (!pixelEquality) throw new Error('The benchmark pipelines changed pixels.');
const syntheticTypes = rowTypes(idat(wasm.data), width * 4, height);
for (const r of [js, wasm, wasm4, legacy, legacy4]) delete r.data;

// Bench PNGs: 8-bit RGBA ones are re-encoded from their pixels; every one is recompressed losslessly.
const files = [...(await readdir(new URL('tests/fixtures/bench/', ROOT))).filter(f => f.endsWith('.png')).map(f => `tests/fixtures/bench/${f}`),
  ...(await readdir(new URL('tests/fixtures/bench/png/', ROOT))).filter(f => f.endsWith('.png')).map(f => `tests/fixtures/bench/png/${f}`),
  'public/fixtures/frame_00001.png', 'public/fixtures/uncompressed.png'];
const images = [], recompress = [], stills = [];
for (const file of files) {
  const bytes = new Uint8Array(await readFile(new URL(file, ROOT))), p = parsePng(bytes), stride = p.width * 4;
  // Still PNG output of the same pixels: RGBA only (the previous encodeRgbaPng) next to the exact type reduction.
  if (p.bitDepth <= 8 && !p.interlace && file.startsWith('tests/')) {
    const pixels = rgbaOf(bytes), row = { file, width: p.width, height: p.height };
    for (const level of [4, 9]) {
      const compress = (px, w, h) => runtime.compressPixels(px, w, h, level), reduce = { level, deflate: runtime.deflate };
      const rgbaOnly = measure(() => encodeRgbaPng(pixels, p.width, p.height, compress), 5), reduced = measure(() => encodeRgbaPng(pixels, p.width, p.height, compress, reduce), 5);
      if (!same(rgbaOf(reduced.data), pixels)) throw new Error(`${file}: reduced still PNG changed pixels`);
      const q = parsePng(reduced.data);
      row[level] = { rgbaBytes: rgbaOnly.bytes, rgbaMs: median(rgbaOnly.timesMs), bytes: reduced.bytes, ms: median(reduced.timesMs), type: `${q.colorType}/${q.bitDepth}` };
    }
    stills.push(row);
  }
  if (p.bitDepth === 8 && p.colorType === 6 && !p.interlace) {
    const pixels = unfilterRows(idat(bytes), p.width, p.height, 4), row = { file, width: p.width, height: p.height, bytes: {}, ms: {} };
    for (const level of [4, 9]) {
      const old = measure(() => runtime.compressSub(pixels, p.width, p.height, level), 5), now = measure(() => runtime.compressPixels(pixels, p.width, p.height, level), 5);
      if (!same(unfilterRows(unzlibSync(now.data), p.width, p.height, 4), pixels)) throw new Error(`${file}: compressPixels changed pixels`);
      Object.assign(row.bytes, { [`legacySub${level}`]: old.bytes, [`chosen${level}`]: now.bytes,
        [`none${level}`]: runtime.deflate(filterRows(pixels, p.width, p.height, 4, 'none'), level).length,
        [`adaptive${level}`]: runtime.deflate(filterRows(pixels, p.width, p.height, 4, 'adaptive'), level).length });
      Object.assign(row.ms, { [`legacySub${level}`]: median(old.timesMs), [`chosen${level}`]: median(now.timesMs) });
      row[`types${level}`] = rowTypes(unzlibSync(now.data), stride, p.height);
    }
    images.push(row);
  }
  const inflated = idat(bytes), streamBytes = concatBytes(p.chunks.filter(c => c.type === 'IDAT').map(c => c.data)).length;
  const redeflated = Math.min(streamBytes, runtime.deflate(inflated, 9).length);
  const out = measure(() => recompressPng(bytes, data => runtime.deflate(data, 9)), 3);
  const outStream = concatBytes(parsePng(out.data).chunks.filter(c => c.type === 'IDAT').map(c => c.data)).length;
  if (!same(samples(out.data), samples(bytes))) throw new Error(`${file}: recompressPng changed pixels`);
  recompress.push({ file, colorType: p.colorType, bitDepth: p.bitDepth, interlace: p.interlace, inputTypes: new Set(Array.from({ length: p.interlace ? 0 : p.height },
    (_, y) => inflated[y * (Math.ceil(p.width * CHANNELS[p.colorType] * p.bitDepth / 8) + 1)])).size, fileBytes: bytes.length, outputBytes: out.bytes,
    idat: { original: streamBytes, redeflateOnly: redeflated, chosen: outStream }, ms: median(out.timesMs) });
}
runtime.dispose();
console.log(JSON.stringify({ width, height, level: 9, pixelEquality, js, wasm, wasm4, legacy, legacy4, syntheticTypes, images, recompress, stills,
  note: 'js = encodeRgbaPng (fflate), wasm/wasm4 = compressPixels (JS filter choice + libdeflate) at 9/4, legacy/legacy4 = compressSub (SIMD Sub + libdeflate, the pre-chapter-9 stream).' }, null, 2));
