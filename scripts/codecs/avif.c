#include <avif/avif.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <math.h>

// Filesystem-free boundary. Compressed input stays owned by JS until decoder deletion.
static avifRWData result = AVIF_DATA_EMPTY;
static char last_error[512];
const char *ka_error(void) { return last_error; }
const uint8_t *ka_result(void) { return result.data; }
uint32_t ka_result_size(void) { return (uint32_t)result.size; }
void ka_clear_result(void) { avifRWDataFree(&result); }
static int failed(avifResult code, const avifDiagnostics *diag) {
  snprintf(last_error, sizeof(last_error), "%s%s%s", avifResultToString(code),
    diag && diag->error[0] ? ": " : "", diag ? diag->error : "");
  return 0;
}
static int valid_size(uint32_t width, uint32_t height) {
  if (!width || !height || width > 32768 || height > 32768 || (uint64_t)width * height > 16777216)
    return failed(AVIF_RESULT_INVALID_ARGUMENT, NULL);
  return 1;
}
typedef struct { avifEncoder *encoder; avifImage *image; int still; } Encode;
// yuv444: full-resolution chroma for lossy pictures (AV1 High profile); lossless is always 4:4:4 with the identity matrix.
Encode *ka_encoder_new(uint32_t width, uint32_t height, int plays, int quality, int lossless, int speed, int still, int yuv444) {
  last_error[0] = 0;
  if (!valid_size(width, height)) return NULL;
  Encode *state = calloc(1, sizeof(*state));
  if (!state) { failed(AVIF_RESULT_OUT_OF_MEMORY, NULL); return NULL; }
  state->encoder = avifEncoderCreate();
  state->image = avifImageCreate(width, height, 8, lossless || yuv444 ? AVIF_PIXEL_FORMAT_YUV444 : AVIF_PIXEL_FORMAT_YUV420);
  if (!state->encoder || !state->image) {
    if (state->encoder) avifEncoderDestroy(state->encoder);
    if (state->image) avifImageDestroy(state->image);
    free(state); failed(AVIF_RESULT_OUT_OF_MEMORY, NULL); return NULL;
  }
  state->still = still;
  state->encoder->codecChoice = AVIF_CODEC_CHOICE_AOM;
  state->encoder->maxThreads = 1;
  state->encoder->speed = speed;
  state->encoder->quality = lossless ? AVIF_QUALITY_LOSSLESS : quality;
  state->encoder->qualityAlpha = AVIF_QUALITY_LOSSLESS;
  state->encoder->timescale = 1000000; // microseconds, including sub-millisecond frame holds
  state->encoder->repetitionCount = plays == 0 ? AVIF_REPETITION_COUNT_INFINITE : plays - 1;
  state->image->yuvRange = AVIF_RANGE_FULL;
  state->image->colorPrimaries = AVIF_COLOR_PRIMARIES_BT709;
  state->image->transferCharacteristics = AVIF_TRANSFER_CHARACTERISTICS_SRGB;
  state->image->matrixCoefficients = lossless ? AVIF_MATRIX_COEFFICIENTS_IDENTITY : AVIF_MATRIX_COEFFICIENTS_BT709;
  return state;
}
int ka_encoder_add(Encode *state, uint8_t *pixels, double duration_us) {
  if (!state || !pixels || !isfinite(duration_us) || duration_us < 1 || duration_us > UINT32_MAX)
    return failed(AVIF_RESULT_INVALID_ARGUMENT, NULL);
  avifRGBImage rgb;
  avifRGBImageSetDefaults(&rgb, state->image);
  rgb.format = AVIF_RGB_FORMAT_RGBA; rgb.depth = 8;
  rgb.pixels = pixels; rgb.rowBytes = state->image->width * 4;
  avifResult code = avifImageRGBToYUV(state->image, &rgb);
  if (code != AVIF_RESULT_OK) return failed(code, NULL);
  code = avifEncoderAddImage(state->encoder, state->image, (uint64_t)duration_us,
    state->still ? AVIF_ADD_IMAGE_FLAG_SINGLE : AVIF_ADD_IMAGE_FLAG_NONE);
  return code == AVIF_RESULT_OK ? 1 : failed(code, &state->encoder->diag);
}
int ka_encoder_finish(Encode *state) {
  ka_clear_result();
  if (!state) return failed(AVIF_RESULT_INVALID_ARGUMENT, NULL);
  avifResult code = avifEncoderFinish(state->encoder, &result);
  return code == AVIF_RESULT_OK ? 1 : failed(code, &state->encoder->diag);
}
void ka_encoder_delete(Encode *state) {
  if (!state) return;
  avifEncoderDestroy(state->encoder); avifImageDestroy(state->image); free(state);
}
typedef struct { avifDecoder *decoder; avifRGBImage rgb; } Decode;
Decode *ka_decoder_new(const uint8_t *bytes, uint32_t size) {
  last_error[0] = 0;
  Decode *state = calloc(1, sizeof(*state));
  if (!state) { failed(AVIF_RESULT_OUT_OF_MEMORY, NULL); return NULL; }
  state->decoder = avifDecoderCreate();
  if (!state->decoder) { free(state); failed(AVIF_RESULT_OUT_OF_MEMORY, NULL); return NULL; }
  avifDecoder *decoder = state->decoder;
  decoder->codecChoice = AVIF_CODEC_CHOICE_AOM; decoder->maxThreads = 1;
  decoder->imageSizeLimit = 16777216; decoder->imageDimensionLimit = 32768; decoder->imageCountLimit = 10000;
  decoder->ignoreExif = AVIF_TRUE; decoder->ignoreXMP = AVIF_TRUE;
  avifResult code = avifDecoderSetIOMemory(decoder, bytes, size);
  if (code == AVIF_RESULT_OK) code = avifDecoderParse(decoder);
  if (code != AVIF_RESULT_OK) {
    failed(code, &decoder->diag); avifDecoderDestroy(decoder); free(state); return NULL;
  }
  // libavif exposes transforms without applying them. Reject these instead of changing orientation/crop silently.
  if (decoder->image->transformFlags & (AVIF_TRANSFORM_CLAP | AVIF_TRANSFORM_IROT | AVIF_TRANSFORM_IMIR)) {
    snprintf(last_error, sizeof(last_error), "AVIF orientation/crop metadata is not supported");
    avifDecoderDestroy(decoder); free(state); return NULL;
  }
  return state;
}
int ka_decoder_info(Decode *state, uint32_t *info) {
  if (!state) return 0;
  avifDecoder *d = state->decoder;
  info[0] = d->image->width; info[1] = d->image->height;
  info[2] = d->repetitionCount == AVIF_REPETITION_COUNT_INFINITE ? 0 : d->repetitionCount < 0 ? 1 : d->repetitionCount + 1;
  info[3] = d->imageCount;
  info[4] = d->imageSequenceTrackPresent; info[5] = d->alphaPresent;
  return 1;
}
double ka_decoder_timing(Decode *state, uint32_t index) {
  avifImageTiming timing;
  if (!state || avifDecoderNthImageTiming(state->decoder, index, &timing) != AVIF_RESULT_OK) return -1;
  return timing.duration * 1000;
}
const uint8_t *ka_decoder_next(Decode *state) {
  if (!state) return NULL;
  avifResult code = avifDecoderNextImage(state->decoder);
  if (code != AVIF_RESULT_OK) { failed(code, &state->decoder->diag); return NULL; }
  if (!state->rgb.pixels) {
    avifRGBImageSetDefaults(&state->rgb, state->decoder->image);
    state->rgb.format = AVIF_RGB_FORMAT_RGBA; state->rgb.depth = 8;
    code = avifRGBImageAllocatePixels(&state->rgb);
    if (code != AVIF_RESULT_OK) { failed(code, NULL); return NULL; }
  }
  code = avifImageYUVToRGB(state->decoder->image, &state->rgb);
  if (code != AVIF_RESULT_OK) { failed(code, NULL); return NULL; }
  return state->rgb.pixels;
}
void ka_decoder_delete(Decode *state) {
  if (!state) return;
  avifRGBImageFreePixels(&state->rgb); avifDecoderDestroy(state->decoder); free(state);
}
