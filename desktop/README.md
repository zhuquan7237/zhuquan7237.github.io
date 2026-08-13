# DeepSeek Harness Desktop (dsh 桌面版)

A Codex-style **desktop shell** around official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`, `@deepseek-ai/dsh`).

Search: DeepSeek Harness desktop, dsh desktop, DeepSeek Harness 桌面版, DeepSeek Harness 下载.

This package does **not** vendor harness source. On launch it:

1. Uses system Node `>= 22.19` or downloads an official Node sidecar
2. Installs / updates `@deepseek-ai/dsh` from npm into user data
3. Starts `dsh web` and shows the official Web UI in a native window

Harness releases therefore land without rebuilding this desktop app. The shell only needs a new version if windowing, installers, or the updater itself change.

## 给一般使用者

只需下载这一个软件，**不要**再 `git clone` DeepSeek Harness。首次启动必须联网（下载官方引擎，大约 1–3 分钟），完成后会自动打开界面。API Key 在官方界面里配置，或打开 [platform.deepseek.com](https://platform.deepseek.com)。

```sh
# Linux 推荐 tar.gz（不需要 FUSE）。AppImage 在 Ubuntu 24.04 上常因缺少 libfuse2 无法打开。
tar -xzf DeepSeek-0.1.1-linux-x64.tar.gz
./DeepSeek-0.1.1-linux-x64/DeepSeek

# Debian/Ubuntu
sudo apt install ./DeepSeek-0.1.1-linux-amd64.deb
```

Windows：下载 `DeepSeek-0.1.1-win.exe`。若 SmartScreen 提示未签名，选「更多信息 → 仍要运行」。

macOS：打开 dmg。若提示未签名，请右键 App → 打开。

第一次启动之后，菜单 **Harness → 检查 Harness 更新** 会对照 npm 最新版；有更新则只下载 dsh 包，不会重新拉 GitHub 源码。国内网络安装慢时，可在 **引擎设置** 把 registry 改成 `https://registry.npmmirror.com`。

## Installers

GitHub Actions builds:

| OS | Packages |
| --- | --- |
| Windows | NSIS `.exe` installer, portable `.exe`, `.zip` (x64 + arm64) |
| macOS | `.dmg`, `.zip` (Intel + Apple Silicon) |
| Linux | AppImage, `.deb`, `.tar.gz` (x64 + arm64) |

Download installers from the public [GitHub Release](https://github.com/zhuquan7237/zhuquan7237.github.io/releases/tag/desktop-v0.1.1). Anyone can download those files without signing in. GitHub Actions artifacts are not a public store.

## Run from source

```sh
cd desktop
npm install
npm start
```

Menus:

- **文件 → 打开工作区** — `dsh` 的工作目录（默认 `~/DeepSeek`）
- **Harness → 检查 Harness 更新** — 拉取最新 `@deepseek-ai/dsh`
- **Harness → 引擎设置** — npm 渠道、registry，或本地已构建的 checkout

## Why this is not a fork

`npx @deepseek-ai/dsh web` is the product. The desktop app is a Codex-like frame: native window, installers, workspace picker, and an independent engine updater. All agent tools, plugins, settings, and the Web UI come from the published harness.
