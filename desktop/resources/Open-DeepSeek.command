#!/bin/bash
# Clears Gatekeeper quarantine so macOS Sequoia does not call an unsigned
# (ad-hoc signed) app "damaged". Double-click this from the DMG if needed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

strip_and_open() {
  local app="$1"
  xattr -cr "$app" >/dev/null 2>&1 || true
  open "$app"
}

if [ -d "$HERE/DeepSeek.app" ]; then
  strip_and_open "$HERE/DeepSeek.app"
elif [ -d "/Applications/DeepSeek.app" ]; then
  strip_and_open "/Applications/DeepSeek.app"
else
  echo "找不到 DeepSeek.app。请先把它拖到「应用程序」文件夹，再运行这个脚本。"
  read -r _
fi
