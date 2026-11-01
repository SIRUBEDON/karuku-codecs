/* Small image-only codec. No filesystem, audio/video formats or FFmpeg. */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <webp/encode.h>
#include <webp/mux.h>
#include <webp/demux.h>
#include <libdeflate.h>
#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif

static uint8_t *result;
static size_t result_size;
static void clear_result(void) { free(result); result = NULL; result_size = 0; }
uint8_t *kw_result(void) { return result; }
size_t kw_result_size(void) { return result_size; }
void kw_clear_result(void) { clear_result(); }

static int config_for(WebPConfig *config, float quality, int lossless, int method) {
  if (!WebPConfigPreset(config, WEBP_PRESET_DEFAULT, quality)) return 0;
  config->lossless = !!lossless;
  config->method = method;
  config->exact = 1;
  config->thread_level = 0;
  return WebPValidateConfig(config);
}

int kw_webp(const uint8_t *rgba, int width, int height, float quality, int lossless, int method) {
  WebPConfig config;
  WebPPicture picture;
  WebPMemoryWriter writer;
  clear_result();
  if (!config_for(&config, quality, lossless, method) || !WebPPictureInit(&picture)) return 0;
  picture.width = width; picture.height = height; picture.use_argb = 1;
  WebPMemoryWriterInit(&writer);
  picture.writer = WebPMemoryWrite; picture.custom_ptr = &writer;
  int ok = WebPPictureImportRGBA(&picture, rgba, width * 4) && WebPEncode(&config, &picture);
  if (ok) { result = writer.mem; result_size = writer.size; }
  else WebPMemoryWriterClear(&writer);
  WebPPictureFree(&picture);
  return ok;
}

typedef struct { WebPAnimEncoder *encoder; int timestamp; int width; int height; } Animation;
Animation *kw_anim_new(int width, int height, int plays) {
  WebPAnimEncoderOptions options;
  if (width < 1 || height < 1 || !WebPAnimEncoderOptionsInit(&options)) return NULL;
  options.anim_params.loop_count = plays;
  options.anim_params.bgcolor = 0;
  Animation *animation = calloc(1, sizeof(*animation));
  if (!animation) return NULL;
  animation->encoder = WebPAnimEncoderNew(width, height, &options);
  if (!animation->encoder) { free(animation); return NULL; }
  animation->width = width; animation->height = height;
  return animation;
}
int kw_anim_add(Animation *animation, const uint8_t *rgba, int duration, float quality, int lossless, int method) {
  if (!animation || duration < 1 || duration > INT_MAX - animation->timestamp) return 0;
  WebPConfig config;
  WebPPicture picture;
  if (!config_for(&config, quality, lossless, method) || !WebPPictureInit(&picture)) return 0;
  picture.width = animation->width; picture.height = animation->height; picture.use_argb = 1;
  int ok = WebPPictureImportRGBA(&picture, rgba, picture.width * 4) &&
    WebPAnimEncoderAdd(animation->encoder, &picture, animation->timestamp, &config);
  WebPPictureFree(&picture);
  if (ok) animation->timestamp += duration;
  return ok;
}
int kw_anim_finish(Animation *animation) {
  clear_result();
  if (!animation || !WebPAnimEncoderAdd(animation->encoder, NULL, animation->timestamp, NULL)) return 0;
  WebPData data;
  WebPDataInit(&data);
  if (!WebPAnimEncoderAssemble(animation->encoder, &data)) return 0;
  result = (uint8_t *)data.bytes; result_size = data.size;
  return 1;
}
void kw_anim_delete(Animation *animation) {
  if (animation) { WebPAnimEncoderDelete(animation->encoder); free(animation); }
}

int kw_zlib(const uint8_t *data, size_t size, int level) {
  clear_result();
  struct libdeflate_compressor *compressor = libdeflate_alloc_compressor(level);
  if (!compressor) return 0;
  size_t bound = libdeflate_zlib_compress_bound(compressor, size);
  result = malloc(bound);
  if (result) result_size = libdeflate_zlib_compress(compressor, data, size, result, bound);
  libdeflate_free_compressor(compressor);
  if (!result_size) { clear_result(); return 0; }
  return 1;
}

/* PNG Sub filtering: 16 channel bytes (four RGBA pixels) per Wasm instruction. */
void kw_sub(const uint8_t *rgba, uint8_t *rows, int width, int height) {
  size_t stride = (size_t)width * 4;
  for (int y = 0; y < height; y++) {
    const uint8_t *source = rgba + y * stride;
    uint8_t *destination = rows + y * (stride + 1);
    *destination++ = 1;
    size_t x = 0;
#ifdef __wasm_simd128__
    if (stride >= 16) {
      v128_t current = wasm_v128_load(source);
      v128_t previous = wasm_i8x16_shuffle(wasm_i8x16_splat(0), current,
        12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27);
      wasm_v128_store(destination, wasm_i8x16_sub(current, previous));
      x = 16;
      for (; x + 16 <= stride; x += 16)
        wasm_v128_store(destination + x, wasm_i8x16_sub(wasm_v128_load(source + x), wasm_v128_load(source + x - 4)));
    }
#endif
    for (; x < stride; x++) destination[x] = source[x] - (x >= 4 ? source[x - 4] : 0);
  }
}

int kw_equal(const uint8_t *a, const uint8_t *b, size_t size) {
  size_t i = 0;
#ifdef __wasm_simd128__
  for (; i + 16 <= size; i += 16)
    if (!wasm_i8x16_all_true(wasm_i8x16_eq(wasm_v128_load(a + i), wasm_v128_load(b + i)))) return 0;
#endif
  return !memcmp(a + i, b + i, size - i);
}

/* PNG filtering of 8-bit RGBA rows, matching png.js filterRows byte for byte (bpp 4, row 0 sees a zero row).
 * mode 0-4: that filter on every row; 5: adaptive, each band of 4 rows uses the filter picked for the band's first
 * row (smallest sum of |signed byte|, ties to the lower type). Writes rows [from, to) with their filter bytes. */
#define KW_BAND 4
static inline unsigned kw_abs(uint8_t v) { return v < 128 ? v : 256 - v; }
static inline uint8_t kw_paeth(int a, int b, int c) {
  int pa = b - c, pb = a - c, pc = pa + pb;
  if (pa < 0) pa = -pa;
  if (pb < 0) pb = -pb;
  if (pc < 0) pc = -pc;
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
static int kw_pick(const uint8_t *cur, const uint8_t *up, size_t stride) {
  unsigned none = 0, sub = 0, upSum = 0, avg = 0, pth = 0;
  for (size_t x = 0; x < 4 && x < stride; x++) {
    uint8_t v = cur[x], b = up[x];
    none += kw_abs(v); sub += kw_abs(v); upSum += kw_abs(v - b); avg += kw_abs(v - (b >> 1)); pth += kw_abs(v - b);
  }
  for (size_t x = 4; x < stride; x++) {
    uint8_t v = cur[x], b = up[x], a = cur[x - 4], c = up[x - 4];
    none += kw_abs(v); sub += kw_abs(v - a); upSum += kw_abs(v - b); avg += kw_abs(v - ((a + b) >> 1));
    pth += kw_abs(v - kw_paeth(a, b, c));
  }
  int type = 0;
  unsigned best = none;
  if (sub < best) { type = 1; best = sub; }
  if (upSum < best) { type = 2; best = upSum; }
  if (avg < best) { type = 3; best = avg; }
  if (pth < best) type = 4;
  return type;
}
static void kw_filter_row(const uint8_t *cur, const uint8_t *up, size_t stride, int type, uint8_t *o) {
  size_t x = 0, head = stride < 4 ? stride : 4;
  if (type == 0) { memcpy(o, cur, stride); return; }
  if (type == 2) {
#ifdef __wasm_simd128__
    for (; x + 16 <= stride; x += 16) wasm_v128_store(o + x, wasm_i8x16_sub(wasm_v128_load(cur + x), wasm_v128_load(up + x)));
#endif
    for (; x < stride; x++) o[x] = cur[x] - up[x];
    return;
  }
  if (type == 1) {
    for (; x < head; x++) o[x] = cur[x];
#ifdef __wasm_simd128__
    for (; x + 16 <= stride; x += 16) wasm_v128_store(o + x, wasm_i8x16_sub(wasm_v128_load(cur + x), wasm_v128_load(cur + x - 4)));
#endif
    for (; x < stride; x++) o[x] = cur[x] - cur[x - 4];
    return;
  }
  if (type == 3) {
    for (; x < head; x++) o[x] = cur[x] - (up[x] >> 1);
    for (; x < stride; x++) o[x] = cur[x] - ((cur[x - 4] + up[x]) >> 1);
    return;
  }
  for (; x < head; x++) o[x] = cur[x] - up[x];
  for (; x < stride; x++) o[x] = cur[x] - kw_paeth(cur[x - 4], up[x], up[x - 4]);
}
int kw_filter(const uint8_t *rgba, uint8_t *rows, int width, int height, int mode, int from, int to) {
  if (width < 1 || height < 1 || mode < 0 || mode > 5 || from < 0 || to > height || from > to) return 0;
  size_t stride = (size_t)width * 4;
  uint8_t *zero = calloc(1, stride);
  if (!zero) return 0;
  int type = mode;
  for (int y = from; y < to; y++) {
    const uint8_t *cur = rgba + y * stride, *up = y ? cur - stride : zero;
    if (mode == 5 && (y == from || y % KW_BAND == 0)) {
      int first = y - y % KW_BAND;
      const uint8_t *row = rgba + first * stride;
      type = kw_pick(row, first ? row - stride : zero, stride);
    }
    uint8_t *out = rows + (size_t)(y - from) * (stride + 1);
    *out = type;
    kw_filter_row(cur, up, stride, type, out + 1);
  }
  free(zero);
  return 1;
}
/* The whole zlib PNG stream with a filter mode (see kw_filter) at a libdeflate level, in the result buffer. */
int kw_png(const uint8_t *rgba, int width, int height, int mode, int level) {
  clear_result();
  if (width < 1 || height < 1) return 0;
  size_t size = ((size_t)width * 4 + 1) * height;
  uint8_t *rows = malloc(size);
  if (!rows) return 0;
  int ok = kw_filter(rgba, rows, width, height, mode, 0, height) && kw_zlib(rows, size, level);
  free(rows);
  return ok;
}

WebPAnimDecoder *kw_decoder_new(const uint8_t *data, size_t size) {
  WebPAnimDecoderOptions options;
  if (!WebPAnimDecoderOptionsInit(&options)) return NULL;
  options.color_mode = MODE_RGBA;
  WebPData input = { data, size };
  return WebPAnimDecoderNew(&input, &options);
}
int kw_decoder_info(WebPAnimDecoder *decoder, uint32_t *output) {
  WebPAnimInfo info;
  if (!decoder || !WebPAnimDecoderGetInfo(decoder, &info)) return 0;
  output[0] = info.canvas_width; output[1] = info.canvas_height;
  output[2] = info.loop_count; output[3] = info.frame_count;
  return 1;
}
uint8_t *kw_decoder_next(WebPAnimDecoder *decoder, int *timestamp) {
  uint8_t *rgba = NULL;
  if (!decoder || !WebPAnimDecoderGetNext(decoder, &rgba, timestamp)) return NULL;
  return rgba;
}
void kw_decoder_delete(WebPAnimDecoder *decoder) { WebPAnimDecoderDelete(decoder); }
