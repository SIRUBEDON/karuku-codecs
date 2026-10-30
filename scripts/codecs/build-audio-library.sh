#!/usr/bin/env bash
set -euo pipefail
WORK=${1:?Build directory}
SDK=${2:?Emsdk directory}
BUILD="$WORK/lame-audio"
PREFIX="$WORK/prefix-audio"
mkdir -p "$BUILD" "$PREFIX/lib" "$PREFIX/include/lame" "$WORK/tools"
if [[ "$OSTYPE" == msys* || "$OSTYPE" == cygwin* ]]; then
  PYTHON="$SDK/python/3.13.3_64bit/python.exe"
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
export PATH="$WORK/tools:$SDK/upstream/bin:$PATH"
if [[ "${3:-}" != --ogg-only ]]; then
cd "$BUILD"
# Describe the 32-bit target ABI; build only the static encoder library.
CC=emcc AR=emar RANLIB=emranlib NM="$SDK/upstream/bin/llvm-nm" LD="$SDK/upstream/bin/wasm-ld" \
CFLAGS='-O3 -flto -msimd128 -msse2' LDFLAGS='-O3 -flto -msimd128 -msse2' \
  bash "$WORK/sources/lame-3.100/configure" --host=i686-unknown-linux --prefix="$PREFIX" \
    --disable-shared --enable-static --disable-frontend --disable-decoder
make -C libmp3lame -j6
make -C libmp3lame install
make -C include install
fi
[[ -f "$PREFIX/lib/libmp3lame.a" ]] || { echo 'Build LAME before --ogg-only.' >&2; exit 1; }
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
for name in ogg vorbis; do
  version=$(test "$name" = ogg && echo 1.3.6 || echo 1.3.7)
  mkdir -p "$WORK/$name-audio"
  cd "$WORK/$name-audio"
  CC=emcc AR=emar RANLIB=emranlib NM="$SDK/upstream/bin/llvm-nm" LD="$SDK/upstream/bin/wasm-ld" \
  CFLAGS='-O3 -flto -msimd128 -msse2' CPPFLAGS="-I$PREFIX/include" LDFLAGS="-O3 -flto -msimd128 -msse2 -L$PREFIX/lib" \
    bash "$WORK/sources/lib$name-$version/configure" --host=wasm32-unknown-none --prefix="$PREFIX" \
      --disable-shared --enable-static --disable-docs --disable-examples --disable-oggtest
  directory=$(test "$name" = ogg && echo src || echo lib)
  # Override configure's legacy x86-only -mno-ieee-fp and native optimization flags.
  make -C "$directory" -j6 CFLAGS='-O3 -flto -msimd128 -msse2 -D_REENTRANT -fsigned-char'
  make -C "$directory" install CFLAGS='-O3 -flto -msimd128 -msse2 -D_REENTRANT -fsigned-char'
  make -C include install
  make install-pkgconfigDATA
done
printf '\nLAME, Ogg and Vorbis audio libraries ready.\n'
