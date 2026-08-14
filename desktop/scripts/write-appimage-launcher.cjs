const fs = require("node:fs");
const path = require("node:path");

/**
 * AppImage needs libfuse2 to mount. Ubuntu 24.04 often lacks it, and a
 * double-click then shows no window. Ship a same-folder launcher that sets
 * APPIMAGE_EXTRACT_AND_RUN=1 so users can start without FUSE.
 */
module.exports = async function writeAppImageLauncher(context) {
  const extra = [];
  const artifacts = context.artifactPaths || [];
  for (const file of artifacts) {
    if (!file.endsWith(".AppImage")) continue;
    const scriptPath = file.replace(/\.AppImage$/i, "-no-fuse.sh");
    const appName = path.basename(file);
    const body = `#!/bin/sh
# DeepSeek Harness — start the AppImage without libfuse2.
# Keep this script next to ${appName}.
set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP="$DIR/${appName}"
if [ ! -f "$APP" ]; then
  MSG="请把本脚本和 ${appName} 放在同一文件夹。更推荐到 https://dsh.zhuquan.xyz/dl/ 下载 tar.gz 或 deb。"
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
`;
    fs.writeFileSync(scriptPath, body, { mode: 0o755 });
    extra.push(scriptPath);
  }
  return extra;
};
