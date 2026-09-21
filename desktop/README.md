<p align="center">
  <img src="../assets/deepseek-whale.png" width="96" alt="DeepSeek" />
</p>

# DeepSeek Harness Desktop (dsh 桌面版)

基于官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 打造的 Electron 桌面端（`dsh` / `@deepseek-ai/dsh`）。Windows / Linux / macOS 开箱即用。

Search: DeepSeek Harness Desktop, dsh desktop, DeepSeek Harness 桌面版, DeepSeek Harness 桌面端, DeepSeek Harness 下载.

<p align="center">
  <img src="../assets/desktop-preview.png" alt="DeepSeek Harness 桌面版 0.2.6：默认皮肤「深海女仆工坊」" width="920" />
</p>

This package does **not** vendor the official monorepo. Other community desktops copy the whole harness into their GitHub repo (that ranks well in search). This shell installs `@deepseek-ai/dsh` from npm instead. See [compare.html](https://dsh.zhuquan.xyz/compare.html). On launch it:

1. Uses system Node `>= 22.19` or downloads an official Node sidecar
2. Installs / updates `@deepseek-ai/dsh` from npm into user data
3. Starts `dsh web` and shows the official Web UI in a native window

Harness releases therefore land without rebuilding this desktop app. The shell only needs a new version if windowing, installers, or the updater itself change.

## 0.5.0 新增：桌面端面板（第一个第一方 DSH 插件）

0.5.0 起，桌面端不再只是一个外壳：它随包附带一个**双面 DSH 插件**（`@dsh-desktop/dsh-desktop-panel`），并把它装进引擎的 profile。打开 dsh 界面 → **设置 → 桌面端**，就能在聊天界面里看到平时只有桌面窗口才有的东西：

- **外壳事实**：桌面版版本、引擎版本与端口、profile、工作区、日志目录（一键复制）。
- **插件开关**：列出当前 profile 的插件，可启用/停用（写引擎自己的 `cordis.patch.yml` 层，重启后依然生效）；profile 自带的层标为只读。
- **日志**：直接看外壳日志与引擎日志的尾部，不用去翻文件夹。
- **导出诊断包**：打包版里一键调用桌面端自己的 `--export-diagnostics`，返回 zip 路径。

实现方式：

- **Host 半边**（`resources/plugins/desktop-panel/src/index.ts`）在引擎内注册 `/dsh-desktop/*` 路由，把外壳通过 `DSH_DESKTOP_*` 环境变量交给引擎的事实（版本、日志目录、是否打包、托盘是否可用…）暴露出来，并读写 profile 清单与 patch 层。它不自己管 node_modules，也不执行数据源给的命令。
- **Client 半边**（`resources/plugins/desktop-panel/client/client.js`）是手写的模块加载器 bundle（`window.__ModuleLoader__.load` + `dsh.client` 声明），只用宿主注入的 `react`，通过官方 `slots` 服务注册 `settings.section` 槽位——和社区插件走同一条组合路径，没有任何特权。
- **装法**：和其它内置插件一样随包分发、启动时安装并链接进 profile，patch 行由 `renderPluginRows` 无条件写入，所以升级桌面端就会跟着更新。
- **可观测**：客户端半边每次落地都会把「apply / seated / failed」阶段写进 `logs/desktop-panel-client.json` 并记日志，支持包里能直接看出界面到底注册成功没有。

桌面端版本与插件版本分开：面板插件升到 `0.1.3`，桌面外壳 `0.5.0`。

## 0.4.0 新增：插件市场

DeepSeek Harness 的生态已经有一万多个插件，0.4.0 把「发现 → 一键安装 → 启停 → 卸载」放进了桌面端，不用切浏览器，也不用记命令：

- **目录**：内置 **DSH 1024Store**（13,701 条目录）作为默认数据源，支持搜索、分类筛选、详情与 README；数据源可换、可加，任何返回本市场开放 JSON 格式的 HTTPS 地址都能接进来（等于自带「自建市场」能力）。
- **一键安装**：只有暴露**纯 npm 包名**的条目才给安装按钮，点了之后还会先向 npm 查 `latest`，要求包名一致、版本是稳定三段式、并声明了 `dsh.bundle.patch`，然后调用官方引擎自己的 `dsh plugin --profile web add <包名>@<版本>`。桌面端不自己写 `node_modules`，也**不执行目录里给的任何命令**；目录里的版本号只作展示。
- **启停与卸载**：停用/启用写进 `$DSH_HOME/cordis.patch.yml` 的市场区块（引擎自带的 patch 机制，重启后依然生效，皮肤和手写的行不会被碰）；卸载只允许卸**直接依赖且是 profile 层**的插件，`@deepseek-ai/dsh-base` 这类自带层是只读的。
- **入口**：菜单/托盘的 **插件市场…**，或用 `DeepSeek --market` 直接打开（引擎起不来时也能开，方便先卸掉装坏的插件）。
- **隐私与配额**：数据源请求只允许 HTTPS、不带凭据、有体积上限、禁内网地址；目录与搜索响应缓存 10 分钟并做并发去重，避免烧掉公开 API 的匿名配额。

```sh
# 市场窗口每次渲染都会把状态写进日志，排查时先看它
# %APPDATA%\DeepSeek\logs\app.log
#  插件目录：100 条（共 13701 条，源 dsh1024）
#  插件市场界面：discover 渲染 100 张卡片（示例：dsh1024, @openviking/dsh-memory-plugin, …）
```

## 0.3.0 新增（对照 anywhere-labs/dsh-desktop 补齐）

社区里使用人数最多的桌面端 [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop) 有几项能力值得一提，0.3.0 把能在「薄壳 + 官方 npm 引擎」路线上实现的部分补齐了，逐项对照与差异原因见 [docs/parity-with-dsh-desktop.md](./docs/parity-with-dsh-desktop.md)：

- **系统托盘**：关闭窗口只是隐藏，引擎继续跑；托盘菜单可打开/隐藏窗口、在浏览器打开、复制本机地址、重启引擎、打开工作区、打开日志、导出诊断、进入恢复模式、退出。要关窗即退出，把「关闭窗口时最小化到托盘」关掉即可。
- **外壳双语**：菜单、托盘、对话框、闪屏、恢复窗口都跟随系统语言（中文系统中文，其余英文），也可以在 **引擎设置 → 界面语言** 里固定，切换即时生效。
- **诊断导出**：菜单/托盘 **Harness → 导出诊断信息…** 生成 `diagnostics-<时间>.zip`（系统信息、已脱敏的设置、桌面日志、引擎日志、运行状态）。窗口根本起不来时，用命令行导出，不会启动引擎：

  ```sh
  # Windows
  "%LOCALAPPDATA%\Programs\DeepSeek\DeepSeek.exe" --export-diagnostics
  # Linux / macOS（源码运行时）
  npx electron . --export-diagnostics
  ```

  命令会在终端打印 zip 的绝对路径。
- **引擎看门狗与恢复模式**：引擎异常退出会自动退避重启；连续 3 次失败则弹出**恢复模式**窗口，可重新启动引擎、回滚到本机另一个已装引擎版本、重装当前版本、打开日志或导出诊断。
- **本地端口与日志留档**：引擎设置里可固定 `dsh web` 端口（0 = 自动），退出时在 Windows 打整棵进程树，不留残余进程；桌面版与引擎日志写入 `userData/logs/`（1 MB 轮转），诊断包直接取这两份。
- 仍然没有的：插件市场、手机远程控制、Profile 工作配置、局域网访问（官方引擎明确拒绝 `--host 0.0.0.0`，需要 vendor 内核才能像上游那样开放，本项目不补丁上游源码）。

## 给一般使用者

只需下载这一个软件，**不要**再 `git clone` DeepSeek Harness。首次启动必须联网（下载官方引擎，大约 1–3 分钟），完成后会自动打开界面。默认皮肤已打进安装包。从旧版升级时会尽量继承 API 密钥。API Key 在官方界面里配置，或打开 [platform.deepseek.com](https://platform.deepseek.com)。

- Windows 安装包会创建**桌面快捷方式**和开始菜单，并带应用图标
- Linux `.deb` 会出现在应用菜单；`.tar.gz` / AppImage 第一次启动会自动创建桌面和应用菜单快捷方式。快捷方式必须指向 AppImage / 便携版 exe 本身，不能指向 `/tmp/.mount_*` 或 `%TEMP%` 里当次解压出来的文件（关掉软件后那些路径会消失）。目标没变就不再重写（避免 GNOME 图标变成「未信任」）；若旧快捷方式已经指向消失的临时目录，下次从安装包打开会自动修好
- macOS 请把 App 拖进「应用程序」。若提示已损坏，在终端运行 <code>xattr -cr /Applications/DeepSeek.app</code>（Gatekeeper 隔离，不是安装包坏了）。说明见仓库里的 <code>mac.html</code>
- 第二次打开同一个软件只会唤起已有窗口，工作区默认 `~/DeepSeek`，窗口大小会记住
- 中文系统、或时区在中国时，会默认走国内 npm 镜像；也可在 **引擎设置** 一键切换官方源 / 国内镜像

```sh
# Linux 推荐 tar.gz（不需要 FUSE）。AppImage 在 Ubuntu 24.04 上常因缺少 libfuse2 无法打开。
tar -xzf DeepSeek-0.2.6-linux-x64.tar.gz
./DeepSeek-0.2.6-linux-x64/DeepSeek

# Debian/Ubuntu
sudo apt install ./DeepSeek-0.2.6-linux-amd64.deb
```

Windows：下载 `DeepSeek-0.2.6-win.exe`。若 SmartScreen 提示未签名，选「更多信息 → 仍要运行」。

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
  - `https://dsh.zhuquan.xyz/dl/DeepSeek-0.2.6-linux-x64.tar.gz`
  - `https://dsh.zhuquan.xyz/dl/DeepSeek-0.2.6-linux-amd64.deb`
  - `https://dsh.zhuquan.xyz/dl/DeepSeek-0.2.6-linux-arm64.tar.gz`
  - `https://dsh.zhuquan.xyz/dl/DeepSeek-0.2.6-linux-arm64.deb`

请用 **0.2.6**。不要用 0.1.0–0.1.19。安装包优先从 https://dsh.zhuquan.xyz/dl/ 下载。

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
- **Harness → 检查 Harness 更新 / 检查桌面版更新** — npm 上的 `@deepseek-ai/dsh` 与 GitHub Release
- **Harness → 重启引擎 / 打开日志文件夹 / 导出诊断信息… / 恢复模式…** — 引擎生命周期与排查入口
- **Harness → 插件市场…** — 浏览目录、一键安装、启停、卸载插件
- **Harness → 引擎设置** — npm 渠道、registry、本地端口、关闭行为、界面语言、皮肤中心开关，或本地已构建的 checkout
- **皮肤 → 打开皮肤列表 / 关闭皮肤中心** — 右上角鲸鱼按钮，或在这里开关皮肤中心
- **托盘图标** — 左键显示/隐藏窗口，右键是同样的功能菜单（含退出）

## Why this is not a fork

`npx @deepseek-ai/dsh web` is the product. The desktop app is a Codex-like frame: native window, installers, workspace picker, and an independent engine updater. All agent tools, plugins, settings, and the Web UI come from the published harness.
