import { app, BrowserWindow, Menu, dialog, shell, ipcMain, screen, nativeImage } from "electron";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { loadSettings, saveSettings } from "./settings";
import { ensureHarness, fetchPublishedVersion, startHarnessWeb, stopHarness, type RunningHarness } from "./harness";
import { applyLinuxRuntimeFlags } from "./linux-flags";
import { resolveNodeRuntime } from "./node-runtime";
import { appIconFile, installUserShortcuts, needsUserShortcuts } from "./desktop-integration";
import { ensureDefaultWorkspace } from "./dsh-workspace";
import { loadWindowState, saveWindowState } from "./window-state";
import { APP_DISPLAY_NAME, APP_ID, NPM_REGISTRY, resolveUiLocale, type DesktopSettings } from "./util";

installCrashGuards();
const linuxReady = applyLinuxRuntimeFlags();

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
  mainWindow.webContents.once("did-finish-load", () => {
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
          label: "检查 Harness 更新",
          accelerator: "CmdOrCtrl+U",
          click: () => {
            void checkHarnessUpdates();
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
            void dialog.showMessageBox({
              type: "info",
              title: "关于",
              message: APP_DISPLAY_NAME,
              detail: `桌面版 ${app.getVersion()}\n引擎 ${running?.version || settings?.lastHarnessVersion || "未启动"}\n工作区 ${settings?.workspaceDir || path.join(homedir(), "DeepSeek")}`,
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
    const detail = await installUserShortcuts();
    await dialog.showMessageBox({
      type: "info",
      title: "快捷方式",
      message: "已创建 DeepSeek Harness 快捷方式",
      detail,
    });
  } catch (error) {
    await dialog.showErrorBox("创建快捷方式失败", error instanceof Error ? error.message : String(error));
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

async function checkHarnessUpdates(): Promise<void> {
  try {
    const channel = settings.channel === "next" ? "next" : "latest";
    const latest = await fetchPublishedVersion(settings.registry || NPM_REGISTRY, channel);
    const current = running?.version || settings.lastHarnessVersion || "未安装";
    if (current === latest) {
      await dialog.showMessageBox({
        type: "info",
        title: "Harness 更新",
        message: "DeepSeek Harness 已是最新版本",
        detail: `当前引擎：${current}\n来源：npm ${DSH_LABEL(channel)}\n不需要拉取 GitHub 源码。`,
      });
      return;
    }
    const choice = await dialog.showMessageBox({
      type: "question",
      title: "发现新的 Harness",
      message: `npm 上有新的 DeepSeek Harness：${latest}`,
      detail: `当前版本：${current}\n更新只会下载官方 @deepseek-ai/dsh，不会重新克隆 GitHub 源码。`,
      buttons: ["立即更新并重启", "取消"],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice.response === 0) await boot(true);
  } catch (error) {
    await dialog.showErrorBox(
      "检查更新失败",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function DSH_LABEL(channel: string): string {
  return `@deepseek-ai/dsh@${channel}`;
}

async function openSettings(): Promise<void> {
  const win = new BrowserWindow({
    width: 520,
    height: 620,
    parent: mainWindow ?? undefined,
    modal: Boolean(mainWindow),
    backgroundColor: "#161922",
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
  const dir = settings.workspaceDir || path.join(homedir(), "DeepSeek");
  await mkdir(dir, { recursive: true });
  if (!settings.workspaceDir) {
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
    if (!splashWindow) await createSplash();
    if (needsUserShortcuts(app.isPackaged)) {
      await installUserShortcuts().catch(() => undefined);
    }
    sendSplash("status", {
      phase: "runtime",
      text: "正在检查运行环境。首次启动需要联网下载引擎，大约 1–3 分钟。",
    });
    const runtime = await resolveNodeRuntime(path.join(userData(), "runtime"), (line) => {
      sendSplash("log", line);
    });
    if (forceUpdate) settings.autoUpdateHarness = true;
    sendSplash("status", { phase: "engine", text: "正在从 npm 同步官方 DeepSeek Harness…" });
    const install = await ensureHarness(
      settings,
      runtime,
      path.join(userData(), "harness"),
      (line) => sendSplash("log", line),
    );
    settings.lastHarnessVersion = install.version;
    await saveSettings(userData(), settings);

    sendSplash("status", { phase: "start", text: `正在启动界面（dsh ${install.version}）…` });
    stopHarness(running);
    const workspaceDir = await defaultWorkspace();
    const dshHome = path.join(userData(), "dsh-home");
    await ensureDefaultWorkspace(dshHome, workspaceDir).catch(() => false);
    running = await startHarnessWeb({
      runtime,
      install,
      workspaceDir,
      dshHome,
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendSplash("status", { phase: "error", text: message });
    await dialog.showErrorBox(APP_DISPLAY_NAME, message);
  }
}

if (linuxReady) {
  app.setName(APP_DISPLAY_NAME);
  app.setAppUserModelId(APP_ID);
  // Keep the 0.1.2 folder name so upgrades do not re-download the engine or lose settings.
  app.setPath("userData", path.join(app.getPath("appData"), "DeepSeek"));
  // The Harness UI reads navigator.languages, which Electron drives with --lang.
  // This must be set before app ready, so only the environment is available here.
  const uiLocale = resolveUiLocale(process.env);
  if (uiLocale) app.commandLine.appendSwitch("lang", uiLocale);
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
      settings = await loadSettings(userData(), systemLocale());
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
