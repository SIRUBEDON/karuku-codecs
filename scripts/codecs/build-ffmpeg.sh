#!/usr/bin/env bash
set -euo pipefail
WORK=${1:?Build directory}
SDK=${2:?Emsdk directory}
MODE=${3:-st}
[[ "$MODE" == st || "$MODE" == mt || "$MODE" == audio ]] || { echo 'Mode must be st, mt or audio.' >&2; exit 1; }
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PREFIX="$WORK/prefix-$MODE"
BUILD="$WORK/ffmpeg-$MODE"
SOURCE="$WORK/sources/ffmpeg"
WRAPPER="$WORK/sources/ffmpeg-wasm"
FFTOOLS="$WRAPPER/src/fftools"
mkdir -p "$BUILD" "$WORK/tools" "$ROOT/codecs/$MODE"
if [[ "$OSTYPE" == msys* || "$OSTYPE" == cygwin* ]]; then
  PYTHON="$SDK/python/3.13.3_64bit/python.exe"
  export EMSDK_PYTHON="$(cygpath -m "$PYTHON")"
  export PATH="$SDK/python/3.13.3_64bit:$PATH"
  export EM_CONFIG="$(cygpath -m "$SDK/.emscripten")"
  export EM_CACHE="$(cygpath -m "$SDK/upstream/emscripten/cache")"
else
  PYTHON=python3
  export EM_CONFIG="$SDK/.emscripten"
fi
for tool in emcc emar emranlib; do
  printf '#!/usr/bin/env bash\nexec "%s" "%s" "$@"\n' "$PYTHON" "$SDK/upstream/emscripten/$tool.py" > "$WORK/tools/$tool"
  chmod +x "$WORK/tools/$tool"
done
printf '#!/usr/bin/env bash\nexec "%s" "$@"\n' "$SDK/upstream/bin/llvm-nm$(test -f "$SDK/upstream/bin/llvm-nm.exe" && echo .exe || true)" > "$WORK/tools/emnm"
chmod +x "$WORK/tools/emnm"
export PATH="$WORK/tools:$PATH"
command -v node >/dev/null || { echo 'Node.js must be on PATH in this bash shell.' >&2; exit 1; }
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
FLAGS='-O3 -flto -msimd128 -msse2'
THREAD_FLAGS=()
if [[ "$MODE" == mt ]]; then FLAGS="$FLAGS -pthread"; THREAD_FLAGS=(-pthread -sUSE_PTHREADS=1 -sPTHREAD_POOL_SIZE=2); fi
if [[ "$MODE" == audio ]]; then
  FEATURES=(--enable-libmp3lame --enable-libvorbis --disable-zlib
    --enable-decoder=mp3,mp3float,mp2,mp2float,aac,aac_latm,flac,alac,vorbis,opus,ac3,eac3,pcm_s8,pcm_u8,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f32be,pcm_f64le,pcm_f64be,pcm_alaw,pcm_mulaw,adpcm_ima_wav,adpcm_ima_qt,adpcm_ms,wmav1,wmav2
    --enable-parser=mpegaudio,aac,aac_latm,flac,opus,vorbis,ac3
    --enable-demuxer=mp3,aac,wav,flac,ogg,mov,matroska,aiff,asf
    --enable-encoder=libmp3lame,libvorbis --enable-muxer=mp3,ogg,null
    --enable-filter=abuffer,abuffersink,anull,anullsink,aformat,aresample,atrim,asetpts)
  LIBS='-lmp3lame -lvorbisenc -lvorbis -logg -lm'
else
  FEATURES=(--enable-zlib --enable-libwebp
    --enable-decoder=h264,hevc,mpeg4,mpeg1video,mpeg2video,mjpeg,png,apng,gif,webp,bmp,tiff,rawvideo,ffv1,huffyuv,utvideo,lagarith,magicyuv,qtrle,prores,vp8,vp9,wmv1,wmv2,wmv3,vc1
    --enable-parser=h264,hevc,mpeg4video,mjpeg,mpegvideo,vp8,vp9,png,vc1
    --enable-demuxer=avi,mov,matroska,apng,gif,image2,image2pipe,png_pipe,webp_pipe,mjpeg,mpegvideo,concat
    --enable-encoder=png,apng,gif,libwebp,libwebp_anim --enable-muxer=apng,gif,webp,image2,image2pipe,null
    --enable-filter=buffer,buffersink,abuffer,abuffersink,scale,format,fps,setsar,hue,split,drawbox,overlay,palettegen,paletteuse,null,trim,setpts,transpose,vflip,hflip,nullsink,anull,anullsink,aformat)
  LIBS='-lwebp -lz -lm'
fi
cd "$BUILD"
# Reconfigure on each build so changes to the feature list cannot reuse an old
# config.mak and silently produce a core with the previous decoder set.
  bash "$SOURCE/configure" --prefix="$PREFIX" --cc=emcc --cxx=emcc --ar=emar --ranlib=emranlib --nm=emnm \
    --target-os=none --arch=x86_32 --enable-cross-compile --disable-everything --disable-programs \
    --disable-asm --disable-x86asm --disable-stripping --disable-runtime-cpudetect --disable-autodetect --disable-network \
    --disable-doc --disable-debug --disable-devices --disable-hwaccels --disable-avdevice --disable-postproc \
    --disable-iconv --disable-bzlib --disable-lzma --enable-small \
    $(test "$MODE" = mt && echo --enable-pthreads || echo --disable-pthreads --disable-w32threads --disable-os2threads) \
    "${FEATURES[@]}" \
    --enable-protocol=file,pipe \
    --extra-cflags="$FLAGS -I$PREFIX/include" --extra-ldflags="$FLAGS -L$PREFIX/lib" \
    --extra-libs="$LIBS" --pkg-config-flags=--static
make -j6
EXPORTED=$(node "$WRAPPER/src/bind/ffmpeg/export.js")
RUNTIME=$(node "$WRAPPER/src/bind/ffmpeg/export-runtime.js")
emcc $FLAGS "${THREAD_FLAGS[@]}" -I. -I"$SOURCE" -I"$FFTOOLS" -I"$PREFIX/include" \
  -Llibavcodec -Llibavfilter -Llibavformat -Llibavutil -Llibswresample -Llibswscale -L"$PREFIX/lib" \
  "$FFTOOLS/cmdutils.c" "$FFTOOLS/ffmpeg.c" "$FFTOOLS/ffmpeg_filter.c" \
  "$FFTOOLS/ffmpeg_hw.c" "$FFTOOLS/ffmpeg_mux.c" "$FFTOOLS/ffmpeg_opt.c" \
  "$FFTOOLS/opt_common.c" "$FFTOOLS/ffprobe.c" \
  -lavformat -lavcodec -lavfilter -lavutil -lswresample -lswscale $LIBS \
  -Wno-deprecated-declarations -sENVIRONMENT=worker -sWASM_BIGINT -sSTACK_SIZE=5242880 \
  -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createFFmpegCore \
  -sINITIAL_MEMORY=$(test "$MODE" = mt && echo 134217728 || echo 33554432) \
  -sALLOW_MEMORY_GROWTH -sMAXIMUM_MEMORY=1073741824 \
  "-sEXPORTED_FUNCTIONS=$EXPORTED" "-sEXPORTED_RUNTIME_METHODS=$RUNTIME" \
  -lworkerfs.js --pre-js "$WRAPPER/src/bind/ffmpeg/bind.js" \
  -o "$ROOT/codecs/$MODE/ffmpeg-core.js"
printf '\n%s dedicated core ready.\n' "$MODE"
