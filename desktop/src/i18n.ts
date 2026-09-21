/**
 * Shell UI translations.
 *
 * The desktop frame (menus, tray, dialogs, recovery window) used to be Chinese
 * only, which looks broken on an English desktop — the exact bug DSH Desktop
 * fixed for its own tray. The engine's Web UI already follows `--lang`, so the
 * shell follows the same resolved locale: a zh-* locale gets Chinese, anything
 * else gets English. `settings.locale` can pin it.
 */

export type ShellLocale = "zh-CN" | "en";

export const SHELL_LOCALES: readonly ShellLocale[] = ["zh-CN", "en"];

type Dictionary = Record<string, string>;

const zh: Dictionary = {
  "common.ok": "确定",
  "common.cancel": "取消",
  "common.close": "关闭",

  "menu.file": "文件",
  "menu.file.openWorkspace": "打开工作区…",
  "menu.file.openWorkspaceFolder": "打开工作区文件夹",
  "menu.file.createShortcut": "创建桌面快捷方式",
  "menu.file.quit": "退出",
  "menu.edit": "编辑",
  "menu.edit.undo": "撤销",
  "menu.edit.redo": "重做",
  "menu.edit.cut": "剪切",
  "menu.edit.copy": "复制",
  "menu.edit.paste": "粘贴",
  "menu.edit.selectAll": "全选",
  "menu.harness": "Harness",
  "menu.harness.status": "当前引擎 {version}",
  "menu.harness.statusNone": "引擎未启动",
  "menu.harness.checkDesktop": "检查桌面版更新",
  "menu.harness.checkEngine": "检查 Harness 更新",
  "menu.harness.settings": "引擎设置…",
  "menu.harness.restartEngine": "重启引擎",
  "menu.harness.openLogs": "打开日志文件夹",
  "menu.harness.exportDiagnostics": "导出诊断信息…",
  "menu.harness.recovery": "恢复模式…",
  "menu.harness.openRepo": "打开 DeepSeek Harness 仓库",
  "menu.view": "查看",
  "menu.view.reload": "重新加载",
  "menu.view.devtools": "开发者工具",
  "menu.view.resetZoom": "实际大小",
  "menu.view.zoomIn": "放大",
  "menu.view.zoomOut": "缩小",
  "menu.view.openBrowser": "在浏览器中打开界面",
  "menu.view.fullscreen": "全屏",
  "menu.skin": "皮肤",
  "menu.skin.open": "打开皮肤列表",
  "menu.skin.enable": "打开皮肤中心",
  "menu.skin.disable": "关闭皮肤中心",
  "menu.help": "帮助",
  "menu.help.apiKey": "获取 API Key",
  "menu.help.guide": "使用说明",
  "menu.help.about": "关于",
  "menu.language": "界面语言",
  "menu.language.auto": "跟随系统（{locale}）",

  "tray.tooltip": "DeepSeek Harness — {state}",
  "tray.show": "打开主窗口",
  "tray.hide": "隐藏主窗口",
  "tray.openBrowser": "在浏览器中打开界面",
  "tray.workspace": "打开工作区文件夹",
  "tray.copyUrl": "复制本机地址",
  "tray.copied": "已复制：{url}",
  "tray.stateRunning": "引擎运行中（dsh {version}）",
  "tray.stateStarting": "引擎启动中…",
  "tray.stateStopped": "引擎已停止",
  "tray.stateRecovering": "引擎异常，等待恢复",
  "tray.closeHint": "关闭窗口后仍在托盘运行，可从托盘菜单退出。",

  "about.message": "DeepSeek Harness 桌面版 {version}",
  "about.detail": "引擎：dsh {engine}\n工作区：{workspace}\n界面语言：{locale}\n默认皮肤：Small-tailqwq/dsh-deep-whale（CC BY-NC-SA 4.0，禁止商用）\n署名：上善 → ZipZipPipe → Small-tailqwq",

  "update.harnessTitle": "发现新的 Harness",
  "update.harnessMessage": "官方引擎有新版本：{version}",
  "update.harnessDetail": "当前版本：{current}\n来源：{source}\n更新只会下载官方 @deepseek-ai/dsh，不会重新克隆源码。",
  "update.harnessCurrentTitle": "Harness 更新",
  "update.harnessCurrentMessage": "DeepSeek Harness 已是最新版本",
  "update.harnessCurrentDetail": "当前引擎：{current}\n来源：{source}",
  "update.updateAndRestart": "更新并重启",
  "update.later": "以后再说",
  "update.desktopTitle": "发现新的桌面版",
  "update.desktopMessage": "仓库已发布 {version}",
  "update.desktopDetail": "当前版本：{current}\n{asset}\n这是桌面壳更新，不用 git pull，也不会重新克隆 Harness。",
  "update.desktopAsset": "将下载：{name}",
  "update.desktopNoAsset": "打不开对应系统的安装包，将打开发布页。",
  "update.desktopCurrentMessage": "DeepSeek Desktop 已是最新版本",
  "update.desktopCurrentDetail": "当前桌面版：{current}\n来源：GitHub Releases（不用 git pull）",
  "update.desktopNothing": "没有需要安装的新版本",
  "update.desktopNothingDetail": "当前：{current}\n仓库最新：{latest}",
  "update.downloadAndInstall": "下载并安装",
  "update.checkFailed": "检查更新失败",
  "update.downloading": "正在下载桌面版 {version}…",
  "update.installedTitle": "已下载新版本",
  "update.installedMessage": "已打开 {name}",
  "update.installedDetailMac": "把 DeepSeek 拖到「应用程序」替换旧版。若仍提示文件已损坏，请双击安装盘里的 Open-DeepSeek.command。",
  "update.installedDetailOther": "解压或安装新包后即可使用。旧窗口可以关掉。",
  "update.openDownloadPage": "打开下载页",
  "update.downloadPageDetail": "也可以直接打开 {page}，用浏览器下载安装包（浏览器会走系统代理）。",

  "diag.title": "导出诊断信息",
  "diag.message": "导出诊断包？",
  "diag.detail": "将生成一个 zip，包含最近的桌面版日志、引擎日志、系统信息、当前运行状态，以及已脱敏的桌面设置。\n\n日志里仍可能含有本地路径、工作区 ID 与会话 ID，公开上传前请自行检查。",
  "diag.export": "导出",
  "diag.doneTitle": "诊断包已导出",
  "diag.doneMessage": "已生成 {name}",
  "diag.doneDetail": "位置：{path}\n公开上传前请先检查内容。",
  "diag.reveal": "在文件夹中显示",
  "diag.failed": "导出诊断失败",
  "diag.redacted": "[已脱敏]",
  "diag.entryReadme": "diagnostics-readme.txt",
  "diag.entrySystem": "system-info.txt",
  "diag.entrySettings": "desktop-settings.json",
  "diag.entryAppLog": "logs/app.log",
  "diag.entryEngineLog": "logs/engine.log",
  "diag.entryRunning": "running.json",

  "recovery.title": "恢复模式",
  "recovery.heading": "引擎没有正常启动",
  "recovery.reasonCrashLoop": "引擎连续 {count} 次异常退出，已停止自动重启。",
  "recovery.reasonStartFailed": "引擎启动失败：{message}",
  "recovery.reasonManual": "你从菜单打开了恢复模式。",
  "recovery.hint": "可以先重启引擎；仍然失败时回滚到上一个已安装的引擎版本，或重装当前版本。",
  "recovery.installed": "本机已安装引擎：{list}",
  "recovery.installedNone": "本机没有已安装的引擎。",
  "recovery.restart": "重新启动引擎",
  "recovery.rollback": "回滚到引擎 {version}",
  "recovery.rollbackNone": "没有可回滚的版本",
  "recovery.reinstall": "重装当前版本（{version}）",
  "recovery.openLogs": "打开日志文件夹",
  "recovery.exportDiagnostics": "导出诊断信息",
  "recovery.quit": "退出桌面版",
  "recovery.working": "正在处理，请稍候…",
  "recovery.restarted": "已重新启动，窗口会自动打开。",

  "status.runtime": "正在检查运行环境。首次启动需要联网下载引擎，大约 1–3 分钟。",
  "status.registry": "npm 源：{registry}",
  "status.enginePrepare": "正在准备官方 DeepSeek Harness…",
  "status.engineUpdate": "正在更新官方 DeepSeek Harness…",
  "status.syncModels": "正在同步模型列表…",
  "status.launching": "正在启动界面（dsh {version}）…",
  "status.skin": "正在准备皮肤中心…",
  "status.opening": "正在打开 DeepSeek Harness…",
  "status.restarting": "正在重启引擎…",
  "status.switchingSkin": "正在切换皮肤…",

  "log.engineExited": "引擎异常退出（{code}），{delay} 秒后自动重启（第 {attempt} 次）。",
  "log.engineRestartFailed": "引擎连续 {count} 次异常退出，已打开恢复模式。",
  "log.engineRestarting": "正在自动重启引擎…",
  "log.diagExported": "诊断包：{path}",
  "log.rollbackTo": "回滚到已安装的引擎 {version}",
  "log.shellLocale": "界面语言：{locale}（来源：{source}）",
  "log.trayReady": "系统托盘已就绪，关闭窗口后仍会运行。",
  "log.trayFailed": "系统托盘不可用：{message}",
};

const en: Dictionary = {
  "common.ok": "OK",
  "common.cancel": "Cancel",
  "common.close": "Close",

  "menu.file": "File",
  "menu.file.openWorkspace": "Open Workspace…",
  "menu.file.openWorkspaceFolder": "Open Workspace Folder",
  "menu.file.createShortcut": "Create Desktop Shortcut",
  "menu.file.quit": "Quit",
  "menu.edit": "Edit",
  "menu.edit.undo": "Undo",
  "menu.edit.redo": "Redo",
  "menu.edit.cut": "Cut",
  "menu.edit.copy": "Copy",
  "menu.edit.paste": "Paste",
  "menu.edit.selectAll": "Select All",
  "menu.harness": "Harness",
  "menu.harness.status": "Engine {version}",
  "menu.harness.statusNone": "Engine not running",
  "menu.harness.checkDesktop": "Check Desktop Update",
  "menu.harness.checkEngine": "Check Harness Update",
  "menu.harness.settings": "Engine Settings…",
  "menu.harness.restartEngine": "Restart Engine",
  "menu.harness.openLogs": "Open Logs Folder",
  "menu.harness.exportDiagnostics": "Export Diagnostics…",
  "menu.harness.recovery": "Recovery Mode…",
  "menu.harness.openRepo": "Open DeepSeek Harness Repository",
  "menu.view": "View",
  "menu.view.reload": "Reload",
  "menu.view.devtools": "Developer Tools",
  "menu.view.resetZoom": "Actual Size",
  "menu.view.zoomIn": "Zoom In",
  "menu.view.zoomOut": "Zoom Out",
  "menu.view.openBrowser": "Open UI in Browser",
  "menu.view.fullscreen": "Toggle Full Screen",
  "menu.skin": "Skins",
  "menu.skin.open": "Open Skin List",
  "menu.skin.enable": "Enable Skin Center",
  "menu.skin.disable": "Disable Skin Center",
  "menu.help": "Help",
  "menu.help.apiKey": "Get an API Key",
  "menu.help.guide": "User Guide",
  "menu.help.about": "About",
  "menu.language": "Language",
  "menu.language.auto": "Follow system ({locale})",

  "tray.tooltip": "DeepSeek Harness — {state}",
  "tray.show": "Show Main Window",
  "tray.hide": "Hide Main Window",
  "tray.openBrowser": "Open UI in Browser",
  "tray.workspace": "Open Workspace Folder",
  "tray.copyUrl": "Copy Local URL",
  "tray.copied": "Copied: {url}",
  "tray.stateRunning": "Engine running (dsh {version})",
  "tray.stateStarting": "Engine starting…",
  "tray.stateStopped": "Engine stopped",
  "tray.stateRecovering": "Engine failed, waiting for recovery",
  "tray.closeHint": "Closing the window keeps the app in the tray; quit from the tray menu.",

  "about.message": "DeepSeek Harness Desktop {version}",
  "about.detail": "Engine: dsh {engine}\nWorkspace: {workspace}\nUI language: {locale}\nDefault skin: Small-tailqwq/dsh-deep-whale (CC BY-NC-SA 4.0, non-commercial)\nCredits: 上善 → ZipZipPipe → Small-tailqwq",

  "update.harnessTitle": "New Harness Available",
  "update.harnessMessage": "A newer official engine is available: {version}",
  "update.harnessDetail": "Current: {current}\nSource: {source}\nThis only downloads the official @deepseek-ai/dsh; it never re-clones the source.",
  "update.harnessCurrentTitle": "Harness Update",
  "update.harnessCurrentMessage": "DeepSeek Harness is up to date",
  "update.harnessCurrentDetail": "Current engine: {current}\nSource: {source}",
  "update.updateAndRestart": "Update and Restart",
  "update.later": "Later",
  "update.desktopTitle": "New Desktop Build Available",
  "update.desktopMessage": "Release {version} is published",
  "update.desktopDetail": "Current: {current}\n{asset}\nThis is a shell update: no git pull, and the Harness is never re-cloned.",
  "update.desktopAsset": "Download: {name}",
  "update.desktopNoAsset": "No installer for this platform — the release page will open instead.",
  "update.desktopCurrentMessage": "DeepSeek Desktop is up to date",
  "update.desktopCurrentDetail": "Current desktop build: {current}\nSource: GitHub Releases (no git pull)",
  "update.desktopNothing": "Nothing to install",
  "update.desktopNothingDetail": "Current: {current}\nLatest in repo: {latest}",
  "update.downloadAndInstall": "Download and Install",
  "update.checkFailed": "Update check failed",
  "update.downloading": "Downloading desktop {version}…",
  "update.installedTitle": "New version downloaded",
  "update.installedMessage": "Opened {name}",
  "update.installedDetailMac": "Drag DeepSeek into Applications to replace the old build. If macOS still calls it damaged, double-click Open-DeepSeek.command on the disk image.",
  "update.installedDetailOther": "Unpack or install the package, then use it. The old window can be closed.",
  "update.openDownloadPage": "Open Download Page",
  "update.downloadPageDetail": "You can also open {page} and download in a browser (it uses the system proxy).",

  "diag.title": "Export Diagnostics",
  "diag.message": "Export a diagnostics bundle?",
  "diag.detail": "Creates a zip with recent desktop logs, engine logs, system info, the current run state, and desktop settings with secrets redacted.\n\nLogs can still contain local paths, workspace IDs, and session IDs. Review before sharing publicly.",
  "diag.export": "Export",
  "diag.doneTitle": "Diagnostics exported",
  "diag.doneMessage": "Created {name}",
  "diag.doneDetail": "Location: {path}\nReview the contents before sharing publicly.",
  "diag.reveal": "Show in Folder",
  "diag.failed": "Diagnostics export failed",
  "diag.redacted": "[redacted]",
  "diag.entryReadme": "diagnostics-readme.txt",
  "diag.entrySystem": "system-info.txt",
  "diag.entrySettings": "desktop-settings.json",
  "diag.entryAppLog": "logs/app.log",
  "diag.entryEngineLog": "logs/engine.log",
  "diag.entryRunning": "running.json",

  "recovery.title": "Recovery Mode",
  "recovery.heading": "The engine did not start",
  "recovery.reasonCrashLoop": "The engine exited unexpectedly {count} times in a row; automatic restarts stopped.",
  "recovery.reasonStartFailed": "Engine start failed: {message}",
  "recovery.reasonManual": "You opened recovery mode from the menu.",
  "recovery.hint": "Try restarting the engine first. If it keeps failing, roll back to the previous installed engine or reinstall the current one.",
  "recovery.installed": "Installed engines: {list}",
  "recovery.installedNone": "No engine is installed on this machine.",
  "recovery.restart": "Restart Engine",
  "recovery.rollback": "Roll Back to Engine {version}",
  "recovery.rollbackNone": "Nothing to roll back",
  "recovery.reinstall": "Reinstall {version}",
  "recovery.openLogs": "Open Logs Folder",
  "recovery.exportDiagnostics": "Export Diagnostics",
  "recovery.quit": "Quit Desktop",
  "recovery.working": "Working…",
  "recovery.restarted": "Restarted — the window will open automatically.",

  "status.runtime": "Checking the runtime. The first launch downloads the engine and needs a network connection (about 1–3 minutes).",
  "status.registry": "npm registry: {registry}",
  "status.enginePrepare": "Preparing the official DeepSeek Harness…",
  "status.engineUpdate": "Updating the official DeepSeek Harness…",
  "status.syncModels": "Syncing model lists…",
  "status.launching": "Starting the UI (dsh {version})…",
  "status.skin": "Preparing the skin center…",
  "status.opening": "Opening DeepSeek Harness…",
  "status.restarting": "Restarting the engine…",
  "status.switchingSkin": "Switching skin…",

  "log.engineExited": "Engine exited unexpectedly ({code}); restarting in {delay}s (attempt {attempt}).",
  "log.engineRestartFailed": "The engine exited unexpectedly {count} times in a row; recovery mode opened.",
  "log.engineRestarting": "Restarting the engine automatically…",
  "log.diagExported": "Diagnostics: {path}",
  "log.rollbackTo": "Rolling back to the installed engine {version}",
  "log.shellLocale": "UI language: {locale} (source: {source})",
  "log.trayReady": "Tray icon ready; closing the window keeps the app running.",
  "log.trayFailed": "Tray unavailable: {message}",
};

const DICTIONARIES: Record<ShellLocale, Dictionary> = { "zh-CN": zh, en };

export type Translator = (key: string, vars?: Record<string, string | number>) => string;

/** A zh-* tag means Chinese; every other locale falls back to English. */
export function resolveShellLocale(input: string | undefined | null): ShellLocale {
  const value = String(input ?? "").trim().toLowerCase();
  if (value.startsWith("zh")) return "zh-CN";
  return "en";
}

/** `settings.locale` pins the shell language; an empty value follows the system. */
export function shellLocaleFromSetting(setting: string, systemLocale: string): {
  locale: ShellLocale;
  source: "setting" | "system";
} {
  const pinned = String(setting ?? "").trim();
  if (pinned) return { locale: resolveShellLocale(pinned), source: "setting" };
  return { locale: resolveShellLocale(systemLocale), source: "system" };
}

export function createTranslator(locale: string | undefined | null): Translator {
  const dict = DICTIONARIES[resolveShellLocale(locale)];
  const fallback = DICTIONARIES.en;
  return (key, vars) => {
    const template = dict[key] ?? fallback[key] ?? key;
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
      vars[name] === undefined || vars[name] === null ? "" : String(vars[name]),
    );
  };
}

export function dictionaryKeys(locale: ShellLocale): string[] {
  return Object.keys(DICTIONARIES[locale]).sort();
}
