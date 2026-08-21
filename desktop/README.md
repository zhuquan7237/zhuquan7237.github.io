<p align="center">
  <img src="../assets/deepseek-whale.png" width="96" alt="DeepSeek" />
</p>

# DeepSeek Harness Desktop (dsh 桌面版)

基于官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 打造的 Electron 桌面端（`dsh` / `@deepseek-ai/dsh`）。Windows / Linux / macOS 开箱即用。

Search: DeepSeek Harness Desktop, dsh desktop, DeepSeek Harness 桌面版, DeepSeek Harness 桌面端, DeepSeek Harness 下载.

<p align="center">
  <img src="../assets/desktop-preview.png" alt="DeepSeek Harness 桌面版 0.2.1：默认皮肤「深海女仆工坊」" width="920" />
</p>

This package does **not** vendor the official monorepo. Other community desktops copy the whole harness into their GitHub repo (that ranks well in search). This shell installs `@deepseek-ai/dsh` from npm instead. See [compare.html](https://dsh.zhuquan.xyz/compare.html). On launch it:

1. Uses system Node `>= 22.19` or downloads an official Node sidecar
2. Installs / updates `@deepseek-ai/dsh` from npm into user data
3. Starts `dsh web` and shows the official Web UI in a native window

Harness releases therefore land without rebuilding this desktop app. The shell only needs a new version if windowing, installers, or the updater itself change.

## 给一般使用者

只需下载这一个软件，**不要**再 `git clone` DeepSeek Harness。首次启动必须联网（下载官方引擎，大约 1–3 分钟），完成后会自动打开界面。默认皮肤已打进安装包。从旧版升级时会尽量继承 API 密钥。API Key 在官方界面里配置，或打开 [platform.deepseek.com](https://platform.deepseek.com)。

- Windows 安装包会创建**桌面快捷方式**和开始菜单，并带应用图标
- Linux `.deb` 会出现在应用菜单；`.tar.gz` / AppImage 第一次启动会自动创建桌面和应用菜单快捷方式。快捷方式必须指向 AppImage / 便携版 exe 本身，不能指向 `/tmp/.mount_*` 或 `%TEMP%` 里当次解压出来的文件（关掉软件后那些路径会消失）。目标没变就不再重写（避免 GNOME 图标变成「未信任」）；若旧快捷方式已经指向消失的临时目录，下次从安装包打开会自动修好
- macOS 请把 App 拖进「应用程序」。若提示已损坏，在终端运行 <code>xattr -cr /Applications/DeepSeek.app</code>（Gatekeeper 隔离，不是安装包坏了）。说明见仓库里的 <code>mac.html</code>
- 第二次打开同一个软件只会唤起已有窗口，工作区默认 `~/DeepSeek`，窗口大小会记住
- 中文系统、或时区在中国时，会默认走国内 npm 镜像；也可在 **引擎设置** 一键切换官方源 / 国内镜像

```sh
# Linux 推荐 tar.gz（不需要 FUSE）。AppImage 在 Ubuntu 24.04 上常因缺少 libfuse2 无法打开。
tar -xzf DeepSeek-0.2.1-linux-x64.tar.gz
./DeepSeek-0.2.1-linux-x64/DeepSeek

# Debian/Ubuntu
sudo apt install ./DeepSeek-0.2.1-linux-amd64.deb
```

Windows：下载 `DeepSeek-0.2.1-win.exe`。若 SmartScreen 提示未签名，选「更多信息 → 仍要运行」。

macOS：打开 dmg，把 App 拖进「应用程序」。若提示「文件已损坏」，终端运行 `xattr -cr /Applications/DeepSeek.app`，或双击盘里的 `Open-DeepSeek.command` / 打开 `Read-Me-First.txt`。

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

Download installers from [dsh.zhuquan.xyz/dl/](https://dsh.zhuquan.xyz/dl/). GitHub Release is the fallback. GitHub Actions artifacts are not a public store.

- Linux：
  - `https://dsh.zhuquan.xyz/dl/DeepSeek-0.2.1-linux-x64.tar.gz`
  - `https://dsh.zhuquan.xyz/dl/DeepSeek-0.2.1-linux-amd64.deb`
  - `https://dsh.zhuquan.xyz/dl/DeepSeek-0.2.1-linux-arm64.tar.gz`
  - `https://dsh.zhuquan.xyz/dl/DeepSeek-0.2.1-linux-arm64.deb`

请用 **0.2.1**。不要用 0.1.0–0.1.19。安装包优先从 https://dsh.zhuquan.xyz/dl/ 下载。

## 皮肤中心

打开软件后的宫殿大厅和双女仆，就是默认皮肤「深海女仆工坊」。**这套画面不是桌面壳作者画的。** 谢谢一创 [上善](https://www.pixiv.net/users/62155430)、二创 [ZipZipPipe](https://www.pixiv.net/users/18604994)、三创 [Small-tailqwq](https://github.com/Small-tailqwq/dsh-deep-whale)。

对话窗口右上角 DeepSeek 鲸鱼按钮会弹出皮肤列表（带过渡动画）。默认皮肤是 [Small-tailqwq/dsh-deep-whale](https://github.com/Small-tailqwq/dsh-deep-whale) 的「深海女仆工坊」，已打进安装包，CC BY-NC-SA 4.0，**禁止商用**。关闭皮肤中心：列表里的按钮、菜单 **皮肤**，或引擎设置。以后有新皮肤可从文件夹或 GitHub 地址导入。切回官方皮肤后再选默认皮肤会重启界面，避免插件卸掉后切不回来。完整致谢见 https://dsh.zhuquan.xyz/#skin 。

## 视觉辅助模型（0.2.0 起）

主模型不支持识图时（如 `deepseek-chat`），先把图片交给一个 **OpenAI 兼容的视觉模型**转成文字描述，再交给主模型；主模型自己支持识图时（如各家的 VL 模型）原图直通，不做任何改动。识别能力由引擎的 `ctx.llm.resolveModelInfo().inputModalities` 自动判断，无需手动切换。

在 **Harness → 引擎设置** 里填写：接口地址（如 `https://api.siliconflow.cn/v1`）、API Key、视觉模型名（如 `Qwen/Qwen2.5-VL-72B-Instruct`）。任何 OpenAI 兼容的视觉接口都可以：通义 Qwen-VL（百炼兼容模式）、智谱 GLM-4V、OpenAI gpt-4o、硅基流动聚合、本地 Ollama 等。API Key 只保存在本机，通过环境变量传给引擎进程，不写入任何明文配置文件。

实现方式是随安装包内置的引擎插件 `@dsh-desktop/dsh-vision-aux`：监听 `agent/pre-step`，把进入模型的消息里的图片块替换为描述文本（保留消息身份）。描述失败的图片会替换为占位说明，对话不中断。

## 自定义联网搜索（0.2.0 起）

模型的 `web_search` 工具默认走 DeepSeek 官方搜索。0.2.0 起可在 **引擎设置** 里切换为 **Tavily**（[tavily.com](https://tavily.com)，专为 AI 检索设计，注册有每月 1000 次免费额度）：填入自己的 Tavily API Key 即可，Key 同样只保存在本机。

实现方式是内置引擎插件 `@dsh-desktop/dsh-web-search-tavily`：向引擎的 `ctx.web` 搜索能力注册一个 provider（与官方 Exa / Perplexity provider 同一机制），并把 web 配置指向它。模型看到的 `web_search` 工具名、参数、结果卡片完全不变。

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
- **皮肤 → 打开皮肤列表 / 关闭皮肤中心** — 右上角鲸鱼按钮，或在这里开关皮肤中心

## Why this is not a fork

`npx @deepseek-ai/dsh web` is the product. The desktop app is a Codex-like frame: native window, installers, workspace picker, and an independent engine updater. All agent tools, plugins, settings, and the Web UI come from the published harness.
