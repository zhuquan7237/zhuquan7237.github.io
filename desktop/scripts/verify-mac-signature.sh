#!/bin/bash
# Fail the macOS pack job if the .app is unsigned. Sequoia reports that as "damaged".
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
found=0
while IFS= read -r app; do
  echo "codesign --verify $app"
  codesign --verify --deep --verbose=2 "$app"
  if [ ! -f "$app/Contents/_CodeSignature/CodeResources" ]; then
    echo "missing sealed CodeResources in $app" >&2
    exit 1
  fi
  codesign -dv --verbose=4 "$app" 2>&1 | tee /tmp/deepseek-codesign.txt
  found=1
done < <(find "$root/release" -name "DeepSeek.app" -type d)

if [ "$found" -eq 0 ]; then
  echo "no DeepSeek.app under $root/release" >&2
  exit 1
fi
echo "macOS ad-hoc signature ok"
