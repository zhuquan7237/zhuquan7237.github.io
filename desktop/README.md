<p align="center">
  <img src="../assets/deepseek-whale.png" width="96" alt="DeepSeek" />
</p>

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

- Windows 安装包会创建**桌面快捷方式**和开始菜单，并带应用图标
- Linux `.deb` 会出现在应用菜单；`.tar.gz` / AppImage 第一次启动会自动创建桌面和应用菜单快捷方式。之后再打开不会重写快捷方式（避免图标变成「未信任」）
- macOS 请把 App 拖进「应用程序」。若提示已损坏，双击 DMG 里的 <code>Open-DeepSeek.command</code>（这是 Gatekeeper 隔离，不是安装包坏了）
- 第二次打开同一个软件只会唤起已有窗口，工作区默认 `~/DeepSeek`，窗口大小会记住
- 中文系统、或时区在中国时，会默认走国内 npm 镜像；也可在 **引擎设置** 一键切换官方源 / 国内镜像

```sh
# Linux 推荐 tar.gz（不需要 FUSE）。AppImage 在 Ubuntu 24.04 上常因缺少 libfuse2 无法打开。
tar -xzf DeepSeek-0.1.10-linux-x64.tar.gz
./DeepSeek-0.1.10-linux-x64/DeepSeek

# Debian/Ubuntu
sudo apt install ./DeepSeek-0.1.10-linux-amd64.deb
```

Windows：下载 `DeepSeek-0.1.10-win.exe`。若 SmartScreen 提示未签名，选「更多信息 → 仍要运行」。

macOS：打开 dmg，把 App 拖进「应用程序」。若提示「文件已损坏」，双击盘里的 `Open-DeepSeek.command`，或系统设置 → 隐私与安全性 → 仍要打开。

第一次启动之后，软件会对照两处更新，都先问你再动手，不用 `git pull`：

- **桌面版**（这个窗口/安装包）→ GitHub Release。菜单 **Harness → 检查桌面版更新**
- **引擎**（`@deepseek-ai/dsh`）→ npm。菜单 **Harness → 检查 Harness 更新**

国内网络安装慢时，可在 **引擎设置** 点「国内镜像」。

## Installers

GitHub Actions builds:

| OS | Packages |
| --- | --- |
| Windows | NSIS `.exe` installer, portable `.exe`, `.zip` (x64 + arm64) |
| macOS | `.dmg`, `.zip` (Intel + Apple Silicon) |
| Linux | AppImage, `.deb`, `.tar.gz` (x64 + arm64) |

Download installers from the public [GitHub Release](https://github.com/zhuquan7237/zhuquan7237.github.io/releases/tag/desktop-v0.1.10). Anyone can download those files without signing in. GitHub Actions artifacts are not a public store.

请用 **0.1.10**。不要用 0.1.0–0.1.9。

## 皮肤中心

对话窗口右上角圆形按钮会弹出皮肤列表（带过渡动画）。默认皮肤是 [Small-tailqwq/dsh-deep-whale](https://github.com/Small-tailqwq/dsh-deep-whale) 的「深海女仆工坊」，CC BY-NC-SA 4.0，**禁止商用**。署名链：一创 [上善](https://www.pixiv.net/users/62155430) → 二创 [ZipZipPipe](https://www.pixiv.net/users/18604994) → 三创 Small-tailqwq。可在 **引擎设置** 关闭皮肤中心。以后有新皮肤可从文件夹或 GitHub 地址导入。

## Run from source

```sh
cd desktop
npm install
npm start
```

Menus:

- **文件 → 打开工作区** — `dsh` 的工作目录（默认 `~/DeepSeek`）
- **Harness → 检查 Harness 更新** — 拉取最新 `@deepseek-ai/dsh`
- **Harness → 引擎设置** — npm 渠道、registry、皮肤中心开关，或本地已构建的 checkout
- **查看 → 皮肤中心** — 打开对话窗口右上角的皮肤列表

## Why this is not a fork

`npx @deepseek-ai/dsh web` is the product. The desktop app is a Codex-like frame: native window, installers, workspace picker, and an independent engine updater. All agent tools, plugins, settings, and the Web UI come from the published harness.
