export type FirstRunStage = "node" | "engine" | "start" | "unknown";

export function looksLikeNetworkError(text: string): boolean {
  return /enotfound|eai_again|enetunreach|econnrefused|econnreset|etimedout|fetch failed|network|offline|socket hang up|getaddrinfo|download failed|下载失败/i.test(
    text,
  );
}

export function looksLikeXzMissing(text: string): boolean {
  return /xz:\s*cannot exec|cannot exec: no such file|tar:.*xz|unknown option.*J|\.tar\.xz/i.test(text);
}

export function looksLikeNativeBuildError(text: string): boolean {
  return /node-gyp|gyp err|not recovariable|not recoverable|make: (?:command )?(?:not found|no such)|g\+\+|clang\+\+|visual studio|msbuild|xcode-select|node-pty|binding\.gyp|unix_pty|conpty/i.test(
    text,
  );
}

export function looksLikeFuseMissing(text: string): boolean {
  return /libfuse\.so|fuse:|dlopen.*fuse|appimage.*fuse/i.test(text);
}

export function buildToolsHint(platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return "请在「终端」运行 xcode-select --install，装好命令行工具后重新打开软件。";
  }
  if (platform === "win32") {
    return "请安装 Visual Studio Build Tools（勾选「使用 C++ 的桌面开发」）和 Python，然后重新打开软件。";
  }
  return "Ubuntu / Debian 请运行：sudo apt install build-essential python3\nFedora 请运行：sudo dnf groupinstall \"Development Tools\" && sudo dnf install python3";
}

export function fuseHint(): string {
  return "这个 AppImage 需要 libfuse2，双击没窗口是正常的。请改用 tar.gz 或 deb（推荐），或运行：sudo apt install libfuse2。也可把「无 FUSE 启动脚本」和 AppImage 放在同一文件夹后运行脚本。";
}

export function explainFirstRunError(
  error: unknown,
  stage: FirstRunStage = "unknown",
  platform: NodeJS.Platform = process.platform,
): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (looksLikeFuseMissing(raw)) return fuseHint();
  if (looksLikeXzMissing(raw)) {
    return "解压 Node 失败。请更新到本版本（已改为不依赖系统 xz），或安装 xz-utils 后重试。";
  }
  if (looksLikeNativeBuildError(raw)) {
    return `安装官方引擎时编译 node-pty 失败，系统缺少 make / g++ 等编译工具。\n${buildToolsHint(platform)}`;
  }
  if (looksLikeNetworkError(raw)) {
    return "首次启动需要联网下载官方 Node 和引擎，没网过不去。请接通网络后点「重试」。国内网络会走镜像。";
  }
  if (stage === "engine" && /failed \(\d+\)/.test(raw)) {
    return `安装官方引擎失败。若日志出现 node-gyp / make / g++，请先安装编译工具。\n${buildToolsHint(platform)}`;
  }
  const cleaned = raw
    .replace(/\s+/g, " ")
    .replace(/not recovariable/gi, "not recoverable")
    .trim();
  if (cleaned.length > 280) return `${cleaned.slice(0, 260)}…`;
  return cleaned || "启动失败，请查看下方日志后点「重试」。";
}

export function commandExistsArgs(name: string, platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === "win32") return { command: "where.exe", args: [name] };
  return { command: "sh", args: ["-c", `command -v ${shellQuote(name)}`] };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
