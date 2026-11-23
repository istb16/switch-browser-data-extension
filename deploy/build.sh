#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

TARGETS=(manifest.json popup options lib icons content _locales viewer)
[ -d background ] && TARGETS+=(background)

ZIP=store/manifest.zip
rm -f "$ZIP"
zip -r "$ZIP" "${TARGETS[@]}"
echo "Created $ZIP"
