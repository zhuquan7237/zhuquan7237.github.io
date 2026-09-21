# 与 DSH Desktop（anywhere-labs）对照：差在哪、学了什么、什么学不来

对照对象是社区里使用人数最多的桌面端：**[anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop)**（28k star，13k commit，v2.0.13）。
本文记录两边的真实差异、本次 0.3.0 学来的能力，以及**故意不学**的部分和原因。

## 1. 两边的根本路线不同

| | anywhere-labs DSH Desktop | 本项目（薄壳路线） |
| --- | --- | --- |
| 内核来源 | **整仓 vendor**：`deepseek-harness` 作为 submodule，stable 固定 `0.1.5-rc.2`、beta 固定 `0.1.6-alpha.2`，并维护 12 个补丁 | npm 上的官方 `@deepseek-ai/dsh`，启动时按已装版本/最新版本安装，**不拷贝、不打补丁** |
| 桌面壳形态 | 桌面壳本身是一个 DSH 插件（Cordis），与上游插件同机制组合 | 独立 Electron main，通过 `dsh web` 的 HTTP/WebSocket 界面承载 |
| 版本更新 | 换内核 = 重新 vendor + 重打补丁 + 重新发版 | 引擎 `npm install` 即更新，**桌面壳不需要重新打包** |
| 数据目录 | `~/.dsh`（每个 profile 一个 home） | `userData/dsh-home`，工作区默认 `~/DeepSeek` |
| 安装包 | Win x64 + macOS Universal | Win/Linux/macOS，x64 + arm64（含 AppImage/deb/rpm/tar.gz） |

这就是本项目 README 里写的「不整仓拷贝」：代价是**上游补丁能力用不了**（见第 4 节），收益是引擎永远跟得上官方发布、安装包小、多平台多架构齐全。

## 2. 逐项对照

| 能力 | anywhere-labs v2.0.13 | 本项目 0.2.6（改造前） | 本项目 0.3.0（本次） |
| --- | --- | --- | --- |
| 系统托盘 | ✅ 完整菜单（终端/诊断/更新/Profile） | ❌ 无托盘 | ✅ 完整菜单（见 3.1） |
| 外壳语言 | ✅ 中英跟随系统，运行中切换同步 | ❌ 菜单/对话框硬编码中文 | ✅ zh/en 跟随系统，可固定，即时切换（3.2） |
| 诊断导出 | ✅ `diagnostics-*.zip` + `--export-diagnostics` | ❌ 只有闪屏日志，窗口起不来就无从取证 | ✅ 同样的 zip + 同样的命令行参数（3.3） |
| 引擎崩溃恢复 | ✅ 恢复窗口（插件管理/回滚/切换配置/诊断 四 Tab） | ❌ 引擎一崩，窗口变死页 | ✅ 看门狗 + 恢复窗口（重启/回滚/重装/日志/诊断）（3.4） |
| 本地端口 | ✅ `dsh-desktop.port`（0=随机） | ⚠️ 固定 `--port 0`，不可配 | ✅ 引擎设置里可固定端口（3.5） |
| 关闭窗口行为 | ✅ 关闭只隐藏，托盘退出才结束 | ⚠️ 关窗即退出、引擎被回收 | ✅ 默认最小化到托盘，可关（3.5） |
| 日志留档 | ✅ 有应用日志与诊断包 | ❌ 无文件日志 | ✅ `logs/app.log`、`logs/engine.log`（1MB 轮转） |
| Windows 进程树回收 | ✅ 上游 subprocess service 管整棵树 | ⚠️ 只杀主进程 | ✅ 退出时 `taskkill /t`（3.5） |
| 工作配置 Profile | ✅ desktop/web/自定义 profile，last-known-good | ❌ 单 DSH home（引擎多版本目录已保留） | ❌ 未做（见 4.1） |
| 插件市场 | ✅ DSH Community Market 内置 | ❌ | ❌ 未做（见 4.2） |
| 手机远程控制 | ✅ Agents-Anywhere 内置 | ❌ | ❌ 未做（见 4.3） |
| 局域网访问 | ✅ 明确确认风险后可开 | ❌ | ❌ **引擎层不支持**（见 4.4） |
| 窗口模式/原生材质 | ✅ 兼容/扩展/增强三种模式 + Mica | ⚠️ 闪屏有 Mica，主窗口无 | ❌ 未做 |
| 皮肤中心 | ❌ | ✅ 内置「深海女仆工坊」+ 目录/GitHub 导入 | ✅ 保留 |
| 视觉辅助模型 | ❌ | ✅ 内置 vision-aux 插件 | ✅ 保留 |
| 自定义联网搜索 | ❌ | ✅ 内置 Tavily provider 插件 | ✅ 保留 |
| 模型列表同步 | ❌ | ✅ 按引擎真实 schema 写回 | ✅ 保留 |
| Linux 零配置 | 兼容模式为主 | ✅ AppImage/deb/rpm/tar.gz + 自动建快捷方式 | ✅ 保留 |

## 3. 本次学来的五项（都做了实测）

### 3.1 系统托盘（`src/tray.ts`）
关闭窗口不再等于退出：托盘菜单提供打开/隐藏主窗口、在浏览器打开、复制本机地址、引擎状态、重启引擎、引擎设置、检查更新、打开工作区、打开日志、导出诊断、恢复模式、退出。
托盘图标按平台缩放到 16px（macOS 18px），状态变更时**重建菜单**——这正是上游 release note 里修的「托盘菜单中英文混用」那类问题的根因：菜单是快照，状态变了就得重建。

### 3.2 外壳双语（`src/i18n.ts`）
菜单、托盘、对话框、闪屏状态、恢复页全部走字典；`settings.locale` 可固定，空值跟随系统（zh-* → 中文，其余 → 英文）。闪屏页通过 `?locale=` 收到同一语言，首屏就不会出现看不懂的界面。中英字典键集合有测试保证一致，避免某种语言静默退回 key。

### 3.3 诊断导出（`src/diagnostics.ts`、`src/zip-write.ts`、`src/logs.ts`）
生成 `diagnostics-<时间戳>-<版本>.zip`，内含 `system-info.txt`、脱敏后的 `desktop-settings.json`、`logs/app.log`、`logs/engine.log`、`running.json`、`diagnostics-readme.txt`。
- 支持命令行：`DeepSeek --export-diagnostics` **不启动引擎、不开窗口、不建托盘**，专治「窗口起不来」。
- 密钥脱敏覆盖 JSON 字段、`XXX_API_KEY=` 赋值、`sk-`/`tvly-`/`ghp_` 前缀、`Bearer` 头。
- ZIP 容器自己写（仅依赖 js-yaml 的包不适合再引入压缩库）：`store` 方式 + CRC32 + 中央目录，Windows 资源管理器、macOS、`unzip`、PowerShell `Expand-Archive` 都能打开（已实测）。

### 3.4 引擎看门狗 + 恢复窗口（`src/supervisor.ts`、`src/recovery.ts`、`resources/recovery.html`）
引擎异常退出（非 0 码、非 SIGTERM/SIGINT）→ 按 1s/2s/4s…（上限 15s）退避自动重启；10 分钟窗口内连续 3 次失败就**停止猜测**，弹出恢复窗口：重新启动引擎、回滚到另一个已装引擎版本、重装当前版本、打开日志、导出诊断、退出。
回滚用的是本机已装的引擎目录（`userData/harness/<version>`），不需要重新下载。

### 3.5 本地端口、关闭行为与进程树回收
- `settings.webPort`：`0` = 让系统分配（默认），固定端口可让依赖 `localStorage` 的界面插件在重启后保留设置；非法值在进引擎前就被 `normalizeWebPort()` 归零，引擎不会因参数报错。
- `settings.closeToTray`：默认只在托盘隐藏；设为 false 时关窗即退出。
- 退出时 Windows 走 `taskkill /pid <pid> /t /f` 打整棵进程树（POSIX 保持 SIGTERM，因为子进程不是组长，负 pid 可能误伤）。

## 4. 故意没学的四项，以及原因

### 4.1 工作配置 Profile
上游的 profile 是一整套 generation 生命周期（dispose 当前 generation 再起新的，service/窗口/subprocess 句柄不能跨 generation 缓存）。这需要把桌面壳做成 DSH 插件、由 Loader 组合 bundle，属于**架构级改造**，与本项目的薄壳路线冲突。当前替代方案：多版本引擎目录 + 恢复模式回滚。

### 4.2 插件市场
上游 DSH Community Market 是一个独立子项目（数据源 Schema、adapter 审核、详情页/安装流程）。本项目的插件安装继续用官方 CLI（`dsh plugin --profile web add <pkg>`），本次不引入市场。

### 4.3 手机远程控制
上游内置 Agents-Anywhere（P2P + APIProxy）。本项目只监听回环地址，没有对外通道；接入需要独立服务端与账号体系，超出「桌面薄壳」范围。

### 4.4 局域网访问（重要）
上游可以在确认风险后把 Web 服务绑到所有网卡。**官方引擎现在明确拒绝这么做**：

```
error: --host 0.0.0.0 is intentionally not supported yet for safety:
it would expose remote code execution to the network; use 127.0.0.1 instead
```

上游能提供这个开关，是因为它 vendor 了内核并维护补丁；本项目不补丁官方源码，所以**这个能力在薄壳路线上拿不到**。与其做一个假的开关，不如把事实写清楚：本地端口可配，`--host` 恒为 `127.0.0.1`。

## 5. 实测验证记录（2026-09-21，Windows 11）

| 验证项 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 通过 |
| `npx vitest run` | 26 个测试文件 / 188 通过（4 跳过），其中新增 6 个。 |
| `DeepSeek --export-diagnostics` | 输出绝对路径，生成 `diagnostics-20260921-105928-0.2.6.zip` 与 `…-110530-0.3.0.zip`；`python zipfile.testzip()` 通过；PowerShell `Expand-Archive` 完整解出 7 个条目；`desktop-settings.json` 中 `apiKey` 已是 `[redacted]`。 |
| 启动 | 日志依次出现「界面语言：zh-CN（来源：system）」「系统托盘已就绪」「使用已安装的引擎 0.1.5-rc.2」「dsh web: http://127.0.0.1:1885/?token=…」 |
| 引擎看门狗 | 强杀引擎 → 日志「引擎异常退出（code 4294967295），1 秒后自动重启（第 1 次）」→ 引擎在新端口 `9377` 恢复 |
| 崩溃环 → 恢复模式 | 再连续杀 2 次 → 「引擎连续 3 次异常退出，已打开恢复模式。」且引擎进程数归 0（不再重启）；恢复窗口标题为「恢复模式」 |
| 关闭到托盘 | `closeToTray=true` 时关闭主窗口：Electron 仍在运行、无可见窗口、引擎继续服务（HTTP 401 = 正常无 token 回应） |
| 优雅退出 | `closeToTray=false` 时关闭窗口：Electron 与引擎进程**都归 0**，无残留 |

## 6. 仍然落后的部分（下一步可选）
1. 窗口模式/原生材质（Mica、亚克力）与自定义标题栏。
2. 崩溃转储（Crashpad `.dmp`）收集进诊断包。
3. 引擎回滚目前读「已装版本列表」，没有记录 last-known-good 的语义（上游会记录最近一次成功启动的 profile）。
4. 设置页仍是中文界面（外壳双语已覆盖菜单/托盘/对话框/闪屏/恢复页）。
