#!/usr/bin/env bash
# Downloads and Git revisions are checked by the portable Node bootstrap.
set -euo pipefail
WORK=${1:?Usage: bootstrap.sh WORK_DIRECTORY}
node "$(dirname "$0")/bootstrap.mjs" "$WORK"
