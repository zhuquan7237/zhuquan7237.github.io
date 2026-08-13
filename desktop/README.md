# DeepSeek Desktop

A Codex-style **desktop shell** around official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This package does **not** vendor harness source. On launch it:

1. Uses system Node `>= 22.19` or downloads an official Node sidecar
2. Installs / updates `@deepseek-ai/dsh` from npm into user data
3. Starts `dsh web` and shows the official Web UI in a native window

Harness releases therefore land without rebuilding this desktop app. The shell only needs a new version if windowing, installers, or the updater itself change.

## Linux 虚拟机

只需下载这一个软件，**不要**再 `git clone` DeepSeek Harness。

```sh
# 任选其一。AppImage 可能需要 libfuse2；tar.gz 不需要。
chmod +x DeepSeek-0.1.0-linux-x86_64.AppImage
./DeepSeek-0.1.0-linux-x86_64.AppImage

# 或
tar -xzf DeepSeek-0.1.0-linux-x64.tar.gz
./DeepSeek-0.1.0-linux-x64/DeepSeek

# Debian/Ubuntu
sudo apt install ./DeepSeek-0.1.0-linux-amd64.deb
```

第一次启动会联网安装官方 `@deepseek-ai/dsh`。之后菜单 **Harness → 检查 Harness 更新** 会对照 npm 最新版；有更新则只下载 dsh 包，不会重新拉 GitHub 源码。

## Installers

GitHub Actions builds:

| OS | Packages |
| --- | --- |
| Windows | NSIS `.exe` installer, portable `.exe`, `.zip` (x64 + arm64) |
| macOS | `.dmg`, `.zip` (Intel + Apple Silicon) |
| Linux | AppImage, `.deb`, `.tar.gz` (x64 + arm64) |

Download installers from the public [GitHub Release](https://github.com/zhuquan7237/zhuquan7237.github.io/releases/tag/desktop-v0.1.0). Anyone can download those files without signing in. GitHub Actions artifacts are not a public store.

## Run from source

```sh
cd desktop
npm install
npm start
```

Menus:

- **File → Open Workspace** — cwd for `dsh` (default filesystem root)
- **Harness → Check for Harness updates** — pull latest `@deepseek-ai/dsh`
- **Harness → Engine settings** — npm channel, registry, or a local built checkout

## Why this is not a fork

`npx @deepseek-ai/dsh web` is the product. The desktop app is a Codex-like frame: native window, installers, workspace picker, and an independent engine updater. All agent tools, plugins, settings, and the Web UI come from the published harness.
