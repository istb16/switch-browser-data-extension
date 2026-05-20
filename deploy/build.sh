#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

TARGETS=(manifest.json popup options lib icons content _locales)
[ -d background ] && TARGETS+=(background)

rm -f manifest.zip
zip -r manifest.zip "${TARGETS[@]}"
echo "Created manifest.zip"
