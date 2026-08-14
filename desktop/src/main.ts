import { app, BrowserWindow, Menu, dialog, shell, ipcMain, screen, nativeImage } from "electron";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { loadSettings, saveSettings } from "./settings";
import { ensureHarness, fetchPublishedVersion, startHarnessWeb, stopHarness, type RunningHarness } from "./harness";
import { applyLinuxRuntimeFlags } from "./linux-flags";
import { resolveNodeRuntime } from "./node-runtime";
import { appIconFile, installUserShortcuts, needsUserShortcuts } from "./desktop-integration";
import {
  downloadDesktopAsset,
  fetchLatestDesktopRelease,
  pickDesktopAsset,
  shouldPromptDesktopUpdate,
  type DesktopRelease,
} from "./desktop-update";
import { ensureDefaultWorkspace } from "./dsh-workspace";
import { SKIN_OVERLAY_CSS, skinOverlayBootstrap } from "./skin-overlay";
import {
  DEFAULT_SKIN_ID,
  OFFICIAL_SKIN_ID,
  applySkin,
  ensureBuiltinSkin,
  importSkinFromDir,
  importSkinFromUrl,
  isSafeSkinId,
  listSkinCards,
  loadCatalog,
  type InstalledSkin,
} from "./skins";
import { loadWindowState, saveWindowState } from "./window-state";
import {
  APP_DISPLAY_NAME,
  APP_ID,
  DSH_PACKAGE,
  NPM_REGISTRY,
  chromiumAcceptLang,
  harnessLocaleEnv,
  hostIntlLocale,
  hostTimeZone,
  parseOsLocaleAssignments,
  parseOsTimeZone,
  resolveTimeZone,
  resolveUiLocale,
  resolveWorkspaceDir,
  shouldPromptHarnessUpdate,
  type DesktopSettings,
} from "./util";

installCrashGuards();

function readOptionalFile(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function osLocaleHint(): string {
  return [
    ...parseOsLocaleAssignments(readOptionalFile("/etc/locale.conf")),
    ...parseOsLocaleAssignments(readOptionalFile("/etc/default/locale")),
  ].join(" ");
}

function preferredLanguages(): string {
  try {
    return app.getPreferredSystemLanguages().join(" ");
  } catch {
    return "";
  }
}

const osLocale = osLocaleHint();
const timeZone = resolveTimeZone(
  process.env,
  parseOsTimeZone(readOptionalFile("/etc/timezone")),
  hostTimeZone(),
);
if (timeZone) process.env.TZ = timeZone;
const localeHint = [osLocale, preferredLanguages(), hostIntlLocale()].filter(Boolean).join(" ");
const uiLocale = resolveUiLocale(process.env, localeHint, timeZone);
const linuxReady = applyLinuxRuntimeFlags(uiLocale);

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let running: RunningHarness | null = null;
let settings: DesktopSettings;

function userData(): string {
  return app.getPath("userData");
}

function windowIcon(): string {
  return appIconFile();
}

function dialogParent(): BrowserWindow | undefined {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) return mainWindow;
  if (splashWindow && !splashWindow.isDestroyed()) return splashWindow;
  return undefined;
}

async function nativeBox(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  const parent = dialogParent();
  return parent
    ? await dialog.showMessageBox(parent, { noLink: true, ...options })
    : await dialog.showMessageBox({ noLink: true, ...options });
}

/** Electron only knows the OS locale once it is ready. */
function systemLocale(): string {
  try {
    return app.getSystemLocale() || app.getLocale();
  } catch {
    return "";
  }
}

function sendSplash(channel: string, payload: unknown): void {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  try {
    if (splashWindow.webContents.isDestroyed()) return;
    splashWindow.webContents.send(channel, payload);
  } catch {
    // Splash may close while the engine is still logging.
  }
}

function closeSplash(): void {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
  }
  splashWindow = null;
}

function revealMain(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  closeSplash();
}

function focusExistingWindow(): void {
  const win = mainWindow ?? splashWindow;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function createSplash(): Promise<void> {
  splashWindow = new BrowserWindow({
    width: 580,
    height: 420,
    frame: false,
    resizable: false,
    show: false,
    backgroundColor: "#101218",
    icon: windowIcon(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  splashWindow.on("closed", () => {
    splashWindow = null;
  });
  // Showing only after the document is loaded avoids a white flash on launch.
  await splashWindow.loadFile(path.join(__dirname, "..", "resources", "splash.html"));
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.show();
}

async function createMain(url: string, version: string): Promise<void> {
  const workArea = screen.getPrimaryDisplay().workArea;
  const state = await loadWindowState(userData(), workArea);
  mainWindow = new BrowserWindow({
    ...state.bounds,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#101218",
    title: `${APP_DISPLAY_NAME} — dsh ${version}`,
    icon: windowIcon(),
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  if (state.isMaximized) mainWindow.maximize();
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: "deny" };
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, desc, validatedURL, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    sendSplash("log", `界面加载失败（${code}）：${desc} ${validatedURL}`);
  });
  mainWindow.once("ready-to-show", () => revealMain());
  mainWindow.webContents.on("did-finish-load", () => {
    void injectSkinOverlay();
    setTimeout(() => revealMain(), 250);
  });
  mainWindow.on("close", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    void saveWindowState(userData(), {
      bounds: mainWindow.getNormalBounds(),
      isMaximized: mainWindow.isMaximized(),
    });
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  await loadHarnessUi(url);
  revealMain();
}

function dshHomeDir(): string {
  return path.join(userData(), "dsh-home");
}

async function syncSkins(onLog: (line: string) => void = sendSplash.bind(null, "log")): Promise<InstalledSkin[]> {
  if (!settings.skinsEnabled) {
    const catalog = await loadCatalog(userData()).catch(() => []);
    if (catalog.length) await applySkin(dshHomeDir(), catalog, OFFICIAL_SKIN_ID);
    return catalog;
  }
  try {
    await ensureBuiltinSkin(userData(), (line) => onLog(String(line)));
  } catch (error) {
    onLog(`默认皮肤暂时下不下来：${error instanceof Error ? error.message : String(error)}`);
  }
  const catalog = await loadCatalog(userData());
  const active = settings.activeSkinId || DEFAULT_SKIN_ID;
  await applySkin(dshHomeDir(), catalog, active);
  return catalog;
}

async function injectSkinOverlay(): Promise<void> {
  if (!settings?.skinsEnabled) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    await mainWindow.webContents.insertCSS(SKIN_OVERLAY_CSS);
    await mainWindow.webContents.executeJavaScript(skinOverlayBootstrap());
  } catch {
    // The official page may still be navigating.
  }
}

async function loadHarnessUi(url: string): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      await mainWindow.loadURL(url);
      return;
    } catch (error) {
      lastError = error;
      sendSplash("log", `界面暂时打不开，正在重试（${attempt}/8）…`);
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "文件",
      submenu: [
        {
          label: "打开工作区…",
          accelerator: "CmdOrCtrl+O",
          click: () => {
            void chooseWorkspace(true);
          },
        },
        {
          label: "打开工作区文件夹",
          click: () => {
            const dir = settings?.workspaceDir || path.join(homedir(), "DeepSeek");
            void shell.openPath(dir);
          },
        },
        {
          label: "创建桌面快捷方式",
          click: () => {
            void createShortcutsManually();
          },
        },
        { type: "separator" },
        { role: "quit", label: "退出" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "Harness",
      submenu: [
        {
          label: running ? `当前引擎 ${running.version}` : "引擎未启动",
          enabled: false,
        },
        {
          label: "检查桌面版更新",
          accelerator: "CmdOrCtrl+Shift+U",
          click: () => {
            void checkDesktopUpdates(true);
          },
        },
        {
          label: "检查 Harness 更新",
          accelerator: "CmdOrCtrl+U",
          click: () => {
            void checkHarnessUpdates(true);
          },
        },
        {
          label: "引擎设置…",
          click: () => {
            void openSettings();
          },
        },
        { type: "separator" },
        {
          label: "打开 DeepSeek Harness 仓库",
          click: () => {
            void shell.openExternal("https://github.com/deepseek-ai/deepseek-harness");
          },
        },
      ],
    },
    {
      label: "查看",
      submenu: [
        { role: "reload", label: "重新加载" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        {
          label: "皮肤中心",
          click: () => {
            if (!settings.skinsEnabled) {
              void nativeBox({
                type: "info",
                title: "皮肤中心",
                message: "皮肤中心已关闭",
                detail: "可在「引擎设置」里重新打开。默认皮肤来自 Small-tailqwq/dsh-deep-whale，CC BY-NC-SA 4.0。",
                buttons: ["确定"],
              });
              return;
            }
            void injectSkinOverlay().then(async () => {
              if (!mainWindow || mainWindow.isDestroyed()) return;
              await mainWindow.webContents.executeJavaScript(
                `document.getElementById("dsh-desktop-skin-root")?.classList.add("open")`,
              );
            });
          },
        },
        {
          label: "在浏览器中打开界面",
          click: () => {
            if (running?.url) void shell.openExternal(running.url);
          },
        },
        { role: "togglefullscreen", label: "全屏" },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "获取 API Key",
          click: () => {
            void shell.openExternal("https://platform.deepseek.com");
          },
        },
        {
          label: "使用说明",
          click: () => {
            void shell.openExternal("https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/index.md");
          },
        },
        { type: "separator" },
        {
          label: "关于",
          click: () => {
            void nativeBox({
              type: "info",
              title: "关于",
              message: APP_DISPLAY_NAME,
              detail: `桌面版 ${app.getVersion()}\n引擎 ${running?.version || settings?.lastHarnessVersion || "未启动"}\n工作区 ${settings?.workspaceDir || path.join(homedir(), "DeepSeek")}\n默认皮肤：Small-tailqwq/dsh-deep-whale（CC BY-NC-SA 4.0，禁止商用）\n署名：上善 → ZipZipPipe → Small-tailqwq`,
              buttons: ["确定"],
            });
          },
        },
      ],
    },
  ];
  if (process.platform === "darwin") {
    template.unshift({ label: app.name, submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }] });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createShortcutsManually(): Promise<void> {
  try {
    const workspaceDir = settings?.workspaceDir || path.join(homedir(), "DeepSeek");
    await mkdir(workspaceDir, { recursive: true });
    const detail = await installUserShortcuts({
      force: true,
      workspaceDir,
      version: app.getVersion(),
      userDataDir: userData(),
    });
    await nativeBox({
      type: "info",
      title: "快捷方式",
      message: "已创建 DeepSeek Harness 快捷方式",
      detail,
      buttons: ["确定"],
    });
  } catch (error) {
    await nativeBox({
      type: "error",
      title: "创建快捷方式失败",
      message: error instanceof Error ? error.message : String(error),
      buttons: ["确定"],
    });
  }
}

async function chooseWorkspace(reboot: boolean): Promise<void> {
  const picked = await dialog.showOpenDialog({
    title: "选择工作区",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: settings.workspaceDir || path.join(homedir(), "DeepSeek"),
  });
  if (picked.canceled || !picked.filePaths[0]) return;
  settings.workspaceDir = picked.filePaths[0];
  await saveSettings(userData(), settings);
  if (reboot) await boot(false);
}

function harnessChannel(): "latest" | "next" {
  return settings.channel === "next" ? "next" : "latest";
}

function harnessSourceLabel(): string {
  return `npm ${DSH_PACKAGE}@${harnessChannel()}`;
}

async function promptHarnessUpdate(current: string, latest: string): Promise<boolean> {
  const choice = await nativeBox({
    type: "info",
    title: "发现新的 Harness",
    message: `官方引擎有新版本：${latest}`,
    detail: `当前版本：${current}\n来源：${harnessSourceLabel()}\n更新只会下载官方 @deepseek-ai/dsh，不会重新克隆源码。`,
    buttons: ["更新并重启", "以后再说"],
    defaultId: 0,
    cancelId: 1,
  });
  return choice.response === 0;
}

async function checkHarnessUpdates(interactive: boolean): Promise<void> {
  try {
    const latest = await fetchPublishedVersion(settings.registry || NPM_REGISTRY, harnessChannel());
    const current = running?.version || settings.lastHarnessVersion || "未安装";
    if (current === latest) {
      if (interactive) {
        await nativeBox({
          type: "info",
          title: "Harness 更新",
          message: "DeepSeek Harness 已是最新版本",
          detail: `当前引擎：${current}\n来源：${harnessSourceLabel()}`,
          buttons: ["确定"],
        });
      }
      return;
    }
    if (!interactive && !shouldPromptHarnessUpdate(current, latest, settings.skippedHarnessVersion)) {
      return;
    }
    if (await promptHarnessUpdate(current, latest)) {
      settings.skippedHarnessVersion = "";
      await saveSettings(userData(), settings);
      await boot(true);
      return;
    }
    settings.skippedHarnessVersion = latest;
    await saveSettings(userData(), settings);
  } catch (error) {
    if (!interactive) return;
    await nativeBox({
      type: "error",
      title: "检查更新失败",
      message: error instanceof Error ? error.message : String(error),
      buttons: ["确定"],
    });
  }
}

async function maybeNotifyHarnessUpdate(): Promise<void> {
  if (!settings.autoUpdateHarness) return;
  if (settings.localHarnessDir) return;
  await checkHarnessUpdates(false);
}

async function checkDesktopUpdates(interactive: boolean): Promise<void> {
  try {
    const latest = await fetchLatestDesktopRelease();
    const current = app.getVersion();
    if (!shouldPromptDesktopUpdate(current, latest.version, interactive ? "" : settings.skippedDesktopVersion)) {
      if (interactive && current === latest.version) {
        await nativeBox({
          type: "info",
          title: "桌面版更新",
          message: "DeepSeek Desktop 已是最新版本",
          detail: `当前桌面版：${current}\n来源：GitHub Releases（不用 git pull）`,
          buttons: ["确定"],
        });
      } else if (interactive && current !== latest.version) {
        await nativeBox({
          type: "info",
          title: "桌面版更新",
          message: "没有需要安装的新版本",
          detail: `当前：${current}\n仓库最新：${latest.version}`,
          buttons: ["确定"],
        });
      }
      return;
    }
    const asset = pickDesktopAsset(latest.assets, process.platform, process.arch);
    const choice = await nativeBox({
      type: "info",
      title: "发现新的桌面版",
      message: `仓库已发布 ${latest.version}`,
      detail: [
        `当前版本：${current}`,
        asset ? `将下载：${asset.name}` : "打不开对应系统的安装包，将打开发布页。",
        "这是桌面壳更新，不用 git pull，也不会重新克隆 Harness。",
      ].join("\n"),
      buttons: ["下载并安装", "以后再说"],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice.response !== 0) {
      settings.skippedDesktopVersion = latest.version;
      await saveSettings(userData(), settings);
      return;
    }
    settings.skippedDesktopVersion = "";
    await saveSettings(userData(), settings);
    await installDesktopRelease(latest, asset);
  } catch (error) {
    if (!interactive) return;
    await nativeBox({
      type: "error",
      title: "检查桌面版更新失败",
      message: error instanceof Error ? error.message : String(error),
      buttons: ["确定"],
    });
  }
}

async function installDesktopRelease(
  release: DesktopRelease,
  asset: ReturnType<typeof pickDesktopAsset>,
): Promise<void> {
  if (!asset) {
    await shell.openExternal(release.htmlUrl);
    return;
  }
  const dest = path.join(userData(), "updates", asset.name);
  sendSplash("status", { phase: "engine", text: `正在下载桌面版 ${release.version}…` });
  const previousTitle = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getTitle() : "";
  const onLog = (line: string) => {
    sendSplash("log", line);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(line);
  };
  try {
    await downloadDesktopAsset(asset.url, dest, onLog);
  } finally {
    if (previousTitle && mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(previousTitle);
  }
  if (process.platform === "win32") {
    const child = spawn(dest, [], { detached: true, stdio: "ignore" });
    child.unref();
    app.quit();
    return;
  }
  await shell.openPath(dest);
  await nativeBox({
    type: "info",
    title: "已下载新版本",
    message: `已打开 ${asset.name}`,
    detail:
      process.platform === "darwin"
        ? "把 DeepSeek 拖到「应用程序」替换旧版。若仍提示文件已损坏，请双击安装盘里的 Open-DeepSeek.command。"
        : "解压或安装新包后即可使用。旧窗口可以关掉。",
    buttons: ["确定"],
  });
}

async function maybeNotifyDesktopUpdate(): Promise<void> {
  if (!settings.autoUpdateDesktop) return;
  if (!app.isPackaged) return;
  await checkDesktopUpdates(false);
}

async function openSettings(): Promise<void> {
  const win = new BrowserWindow({
    width: 520,
    height: 700,
    parent: mainWindow ?? undefined,
    modal: Boolean(mainWindow),
    backgroundColor: "#0c0e14",
    icon: windowIcon(),
    title: "引擎设置",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadFile(path.join(__dirname, "..", "resources", "settings.html"));
}

async function defaultWorkspace(): Promise<string> {
  const dir = resolveWorkspaceDir(settings.workspaceDir, homedir());
  await mkdir(dir, { recursive: true });
  if (settings.workspaceDir !== dir) {
    settings.workspaceDir = dir;
    await saveSettings(userData(), settings);
  }
  return dir;
}

/**
 * Background helpers (desktop integration, engine logging) must never take the
 * app down. Electron's default handler shows a fatal error dialog the user has
 * to dismiss before the window appears.
 */
function installCrashGuards(): void {
  process.on("uncaughtException", (error) => {
    console.error("uncaught", error);
    sendSplash("log", `后台任务出错（已忽略）：${error.message}`);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("unhandled", reason);
    sendSplash("log", `后台任务出错（已忽略）：${String(reason)}`);
  });
}

async function boot(forceUpdate: boolean): Promise<void> {
  try {
    if (forceUpdate && mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
    if (!splashWindow) await createSplash();
    const workspaceDir = await defaultWorkspace();
    if (needsUserShortcuts(app.isPackaged)) {
      await installUserShortcuts({
        workspaceDir,
        version: app.getVersion(),
        userDataDir: userData(),
      }).catch(() => undefined);
    }
    sendSplash("status", {
      phase: "runtime",
      text: "正在检查运行环境。首次启动需要联网下载引擎，大约 1–3 分钟。",
    });
    const runtime = await resolveNodeRuntime(path.join(userData(), "runtime"), (line) => {
      sendSplash("log", line);
    });
    sendSplash("log", `npm 源：${settings.registry}`);
    sendSplash("status", {
      phase: "engine",
      text: forceUpdate ? "正在更新官方 DeepSeek Harness…" : "正在准备官方 DeepSeek Harness…",
    });
    const install = await ensureHarness(
      settings,
      runtime,
      path.join(userData(), "harness"),
      (line) => sendSplash("log", line),
      forceUpdate,
    );
    settings.lastHarnessVersion = install.version;
    await saveSettings(userData(), settings);

    sendSplash("status", { phase: "start", text: `正在启动界面（dsh ${install.version}）…` });
    stopHarness(running);
    const dshHome = dshHomeDir();
    await ensureDefaultWorkspace(dshHome, workspaceDir, homedir()).catch(() => false);
    sendSplash("status", { phase: "start", text: settings.skinsEnabled ? "正在准备皮肤中心…" : "正在启动界面…" });
    await syncSkins((line) => sendSplash("log", line));
    running = await startHarnessWeb({
      runtime,
      install,
      workspaceDir,
      dshHome,
      extraEnv: harnessLocaleEnv(uiLocale),
      onLog: (line) => sendSplash("log", line),
    });
    buildMenu();
    sendSplash("status", { phase: "start", text: "正在打开 DeepSeek Harness…" });
    if (mainWindow && !mainWindow.isDestroyed()) {
      await loadHarnessUi(running.url);
      mainWindow.setTitle(`${APP_DISPLAY_NAME} — dsh ${running.version}`);
      revealMain();
    } else {
      await createMain(running.url, running.version);
    }
    void maybeNotifyDesktopUpdate().then(() => maybeNotifyHarnessUpdate());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendSplash("status", { phase: "error", text: message });
    await nativeBox({
      type: "error",
      title: APP_DISPLAY_NAME,
      message,
      buttons: ["确定"],
    });
  }
}

if (linuxReady) {
  app.setName(APP_DISPLAY_NAME);
  app.setAppUserModelId(APP_ID);
  // Keep the 0.1.2 folder name so upgrades do not re-download the engine or lose settings.
  app.setPath("userData", path.join(app.getPath("appData"), "DeepSeek"));
  // The Harness UI reads navigator.languages, which Electron drives with --lang.
  // This must be set before app ready. getSystemLocale() is not available yet.
  if (uiLocale) {
    app.commandLine.appendSwitch("lang", uiLocale);
    app.commandLine.appendSwitch("accept-lang", chromiumAcceptLang(uiLocale));
  }
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on("second-instance", () => focusExistingWindow());
    app.whenReady().then(async () => {
      if (process.platform === "darwin") {
        const img = nativeImage.createFromPath(windowIcon());
        if (!img.isEmpty()) app.dock?.setIcon(img);
        app.setAboutPanelOptions({
          applicationName: APP_DISPLAY_NAME,
          applicationVersion: app.getVersion(),
        });
      }
      settings = await loadSettings(
        userData(),
        [systemLocale(), osLocale, preferredLanguages(), hostIntlLocale()].filter(Boolean).join(" "),
        timeZone,
      );
      settings.workspaceDir = resolveWorkspaceDir(settings.workspaceDir, homedir());
      await saveSettings(userData(), settings);
      ipcMain.handle("settings:get", () => settings);
      ipcMain.handle("settings:save", async (_event, next: DesktopSettings) => {
        settings = { ...settings, ...next };
        await saveSettings(userData(), settings);
        return settings;
      });
      ipcMain.handle("settings:pick-dir", async () => {
        const picked = await dialog.showOpenDialog({ properties: ["openDirectory"] });
        return picked.filePaths[0] ?? "";
      });
      ipcMain.on("settings:apply", () => {
        void boot(true);
      });
      ipcMain.handle("skins:list", async () => {
        const catalog = await loadCatalog(userData());
        return await listSkinCards(catalog, settings.activeSkinId || DEFAULT_SKIN_ID);
      });
      ipcMain.handle("skins:select", async (_event, id: string) => {
        const next = String(id || OFFICIAL_SKIN_ID);
        if (!isSafeSkinId(next)) throw new Error(`皮肤 id 不合法：${next}`);
        settings.activeSkinId = next;
        await saveSettings(userData(), settings);
        const catalog = await loadCatalog(userData());
        await applySkin(dshHomeDir(), catalog, settings.activeSkinId);
        if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.reload();
      });
      ipcMain.handle("skins:import-dir", async () => {
        const picked = await dialog.showOpenDialog({
          title: "选择皮肤文件夹",
          properties: ["openDirectory"],
        });
        if (picked.canceled || !picked.filePaths[0]) return;
        const imported = await importSkinFromDir(userData(), picked.filePaths[0]);
        settings.activeSkinId = imported.id;
        await saveSettings(userData(), settings);
        const catalog = await loadCatalog(userData());
        await applySkin(dshHomeDir(), catalog, imported.id);
        if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.reload();
      });
      ipcMain.handle("skins:import-url", async (_event, url: string) => {
        const imported = await importSkinFromUrl(userData(), String(url || ""), (line) => sendSplash("log", line));
        settings.activeSkinId = imported.id;
        await saveSettings(userData(), settings);
        const catalog = await loadCatalog(userData());
        await applySkin(dshHomeDir(), catalog, imported.id);
        if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.reload();
      });
      ipcMain.on("splash:quit", () => {
        app.quit();
      });
      buildMenu();
      await boot(false);
    });

    app.on("window-all-closed", () => {
      if (process.platform !== "darwin") app.quit();
    });

    app.on("before-quit", () => {
      stopHarness(running);
      running = null;
    });
  }
}
