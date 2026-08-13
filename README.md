<div align="center">

<img src="assets/icon.png" width="72" alt="DeepSeek Harness" />

# DeepSeek Harness 桌面版

**下载就能用的 Codex 式编程助手。**  
引擎是官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`@deepseek-ai/dsh`），不用 `git clone`。

[![Release](https://img.shields.io/github/v/release/zhuquan7237/zhuquan7237.github.io?include_prereleases&label=release)](https://github.com/zhuquan7237/zhuquan7237.github.io/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/zhuquan7237/zhuquan7237.github.io/total)](https://github.com/zhuquan7237/zhuquan7237.github.io/releases/latest)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-4d93f8)](https://github.com/zhuquan7237/zhuquan7237.github.io/releases/latest)

[主页 / 下载](https://zhuquan7237.github.io) ·
[关于作者](https://zhuquan7237.github.io/me.html) ·
[GitHub 搜索名](https://github.com/zhuquan7237/deepseek-harness-desktop) ·
[下载 0.1.4](https://github.com/zhuquan7237/zhuquan7237.github.io/releases/latest) ·
[Windows](https://github.com/zhuquan7237/zhuquan7237.github.io/releases/download/desktop-v0.1.4/DeepSeek-0.1.4-win.exe) ·
[Linux tar.gz](https://github.com/zhuquan7237/zhuquan7237.github.io/releases/download/desktop-v0.1.4/DeepSeek-0.1.4-linux-x64.tar.gz) ·
[macOS Apple Silicon](https://github.com/zhuquan7237/zhuquan7237.github.io/releases/download/desktop-v0.1.4/DeepSeek-0.1.4-mac-arm64.dmg)

<img src="assets/desktop-preview.png" alt="DeepSeek Harness 桌面版运行截图" width="920" />

</div>

## 这是什么

官方 `dsh web` 已经很好用，但普通人还是得自己装 Node、克隆仓库、在终端里启动。这个项目做的是薄薄一层**桌面壳**：

1. 给你一个能双击的安装包（Windows / Linux / macOS，x64 与 arm64）
2. 启动时自动准备 Node，并从 npm 安装官方 `@deepseek-ai/dsh`
3. 把官方界面嵌进原生窗口：桌面快捷方式、图标、工作区、中文菜单

工具、插件、Plan/Agent、设置仍然全部来自官方 Harness。菜单 **Harness → 检查 Harness 更新** 只更新引擎，不必重装桌面软件。

作者：[朱泉 / Quan Zhu](https://zhuquan7237.github.io/me.html)，广东海洋大学材料科学与工程。

## 30 秒开始

| 系统 | 下载 | 说明 |
| --- | --- | --- |
| Windows | [DeepSeek-0.1.4-win.exe](https://github.com/zhuquan7237/zhuquan7237.github.io/releases/download/desktop-v0.1.4/DeepSeek-0.1.4-win.exe) | 会创建桌面和开始菜单快捷方式。SmartScreen 选「更多信息 → 仍要运行」 |
| Linux | [x64 tar.gz](https://github.com/zhuquan7237/zhuquan7237.github.io/releases/download/desktop-v0.1.4/DeepSeek-0.1.4-linux-x64.tar.gz) · [deb](https://github.com/zhuquan7237/zhuquan7237.github.io/releases/download/desktop-v0.1.4/DeepSeek-0.1.4-linux-amd64.deb) | 优先 tar.gz 或 deb。AppImage 在 Ubuntu 24.04 常缺 libfuse2 |
| macOS | [arm64 dmg](https://github.com/zhuquan7237/zhuquan7237.github.io/releases/download/desktop-v0.1.4/DeepSeek-0.1.4-mac-arm64.dmg) · [Intel dmg](https://github.com/zhuquan7237/zhuquan7237.github.io/releases/download/desktop-v0.1.4/DeepSeek-0.1.4-mac-x64.dmg) | 拖到「应用程序」。未签名请右键打开 |

```sh
# Linux
tar -xzf DeepSeek-0.1.4-linux-x64.tar.gz
./DeepSeek-0.1.4-linux-x64/DeepSeek
```

首次启动需要联网大约 1–3 分钟（下载 Node 和官方 dsh）。API Key 在官方界面里填写，或打开 [platform.deepseek.com](https://platform.deepseek.com)。中文系统会默认走国内 npm 镜像。

请用 **0.1.4**。不要用 0.1.0 / 0.1.1。

## 和「自己跑官方仓库」的差别

| | 官方仓库 | 这个桌面版 |
| --- | --- | --- |
| 怎么开始 | clone、装依赖、终端里 `dsh web` | 下载安装包，双击 |
| 引擎 | 你本地那份源码 | 每次从 npm 拉官方 `@deepseek-ai/dsh` |
| 更新 Harness | 自己 git pull / 重新构建 | 软件内检查更新 |
| 界面 | 浏览器 | 原生窗口 + 快捷方式 + 图标 |

这**不是** DeepSeek Harness 的 fork。源码在 [`desktop/`](./desktop/)。

## 仓库里还有什么

- [产品主页](https://zhuquan7237.github.io) — 按系统下载
- [关于作者](https://zhuquan7237.github.io/me.html)
- [浏览器预览](https://zhuquan7237.github.io/app/) — 轻量网页版，不能替代完整 Harness
- [番茄钟](https://zhuquan7237.github.io/pomodoro.html)

本地运行桌面壳：

```sh
cd desktop
npm install
npm start
```

## 搜索

在 GitHub 搜 **DeepSeek Harness Desktop** / **dsh desktop** 请用可搜索仓库：[zhuquan7237/deepseek-harness-desktop](https://github.com/zhuquan7237/deepseek-harness-desktop)（这个 Pages 仓库名叫 `zhuquan7237.github.io`，按产品名排不到前面）。

DeepSeek Harness 桌面版、dsh desktop、DeepSeek Harness 下载、DeepSeek Harness Windows、DeepSeek Harness Linux、`@deepseek-ai/dsh`、Codex DeepSeek。
