#!/bin/bash
# Remove Gatekeeper quarantine so an ad-hoc signed app is not called "damaged".
# Double-click from the DMG, or run the same xattr line in Terminal.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

dialog() {
  local text="$1"
  echo "$text"
  osascript -e "display dialog \"${text}\" buttons {\"好\"} default button 1 with title \"DeepSeek Harness\"" >/dev/null 2>&1 || true
}

unlock() {
  local app="$1"
  xattr -dr com.apple.quarantine "$app" >/dev/null 2>&1 || true
  xattr -cr "$app" >/dev/null 2>&1 || true
  open "$app"
}

if [ -d "$HERE/DeepSeek.app" ]; then
  unlock "$HERE/DeepSeek.app"
elif [ -d "/Applications/DeepSeek.app" ]; then
  unlock "/Applications/DeepSeek.app"
else
  dialog "找不到 DeepSeek.app。请先把它拖到「应用程序」，再在终端运行：xattr -cr /Applications/DeepSeek.app"
  exit 1
fi
