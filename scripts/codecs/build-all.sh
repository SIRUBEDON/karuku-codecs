#!/usr/bin/env bash
set -euo pipefail
WORK=${1:?Usage: build-all.sh BUILD_DIRECTORY EMSDK_DIRECTORY}
SDK=${2:?Emsdk directory}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
native_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
node "$ROOT/scripts/codecs/bootstrap.mjs" "$(native_path "$WORK")"
node "$ROOT/scripts/codecs/build-libraries.mjs" --work "$(native_path "$WORK")" --emsdk "$(native_path "$SDK")" --mode image
node "$ROOT/scripts/codecs/build-avif.mjs" --work "$(native_path "$WORK")" --emsdk "$(native_path "$SDK")"
for mode in st mt; do
  node "$ROOT/scripts/codecs/build-libraries.mjs" --work "$(native_path "$WORK")" --emsdk "$(native_path "$SDK")" --mode "$mode"
  bash "$ROOT/scripts/codecs/build-ffmpeg.sh" "$WORK" "$SDK" "$mode"
done
bash "$ROOT/scripts/codecs/build-audio-library.sh" "$WORK" "$SDK"
bash "$ROOT/scripts/codecs/build-ffmpeg.sh" "$WORK" "$SDK" audio
node "$ROOT/scripts/codecs/prepare-notices.mjs" "$(native_path "$WORK")" "$(native_path "$SDK")"
node "$ROOT/scripts/codecs/update-manifest.mjs"
node "$ROOT/scripts/codecs/package-sources.mjs" "$(native_path "$WORK")"
node "$ROOT/scripts/prepare-codecs.mjs"
