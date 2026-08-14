#!/bin/sh
# DeepSeek Harness — start the AppImage without libfuse2.
# Keep this script next to DeepSeek-0.1.18-linux-arm64.AppImage.
set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP="$DIR/DeepSeek-0.1.18-linux-arm64.AppImage"
if [ ! -f "$APP" ]; then
  MSG="请把本脚本和 DeepSeek-0.1.18-linux-arm64.AppImage 放在同一文件夹。更推荐到 https://dsh.zhuquan.xyz/dl/ 下载 tar.gz 或 deb。"
  echo "$MSG" >&2
  if command -v zenity >/dev/null 2>&1; then
    zenity --error --no-wrap --text="$MSG" || true
  elif command -v kdialog >/dev/null 2>&1; then
    kdialog --error "$MSG" || true
  fi
  exit 1
fi
export APPIMAGE_EXTRACT_AND_RUN=1
exec "$APP" "$@"
