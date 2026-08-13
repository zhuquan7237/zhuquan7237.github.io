import { app, BrowserWindow, Menu, dialog, shell, ipcMain } from "electron";
import path from "node:path";
import { homedir } from "node:os";
import { loadSettings, saveSettings } from "./settings";
import { ensureHarness, fetchPublishedVersion, startHarnessWeb, stopHarness, type RunningHarness } from "./harness";
import { resolveNodeRuntime } from "./node-runtime";
import { NPM_REGISTRY, type DesktopSettings } from "./util";

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let running: RunningHarness | null = null;
let settings: DesktopSettings;

function userData(): string {
  return app.getPath("userData");
}

function sendSplash(channel: string, payload: unknown): void {
  splashWindow?.webContents.send(channel, payload);
}

async function createSplash(): Promise<void> {
  splashWindow = new BrowserWindow({
    width: 560,
    height: 360,
    frame: false,
    resizable: false,
    show: true,
    backgroundColor: "#101218",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await splashWindow.loadFile(path.join(__dirname, "..", "resources", "splash.html"));
}

async function createMain(url: string, version: string): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#101218",
    title: `DeepSeek — dsh ${version}`,
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: "deny" };
  });
  await mainWindow.loadURL(url);
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    splashWindow?.close();
    splashWindow = null;
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        {
          label: "Open Workspace…",
          accelerator: "CmdOrCtrl+O",
          click: () => {
            void chooseWorkspace(true);
          },
        },
        { type: "separator" },
        { role: "quit" },
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
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        {
          label: "Open UI in browser",
          click: () => {
            if (running?.url) void shell.openExternal(running.url);
          },
        },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "API keys",
          click: () => {
            void shell.openExternal("https://platform.deepseek.com");
          },
        },
        {
          label: "Harness docs",
          click: () => {
            void shell.openExternal("https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/index.md");
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

async function chooseWorkspace(reboot: boolean): Promise<void> {
  const picked = await dialog.showOpenDialog({
    title: "Choose workspace",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: settings.workspaceDir || homedir(),
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
        message: `DeepSeek Harness 已是最新版本`,
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
    height: 560,
    parent: mainWindow ?? undefined,
    modal: Boolean(mainWindow),
    backgroundColor: "#161922",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadFile(path.join(__dirname, "..", "resources", "settings.html"));
}

async function boot(forceUpdate: boolean): Promise<void> {
  try {
    if (!splashWindow) await createSplash();
    sendSplash("status", { phase: "runtime", text: "Checking Node.js runtime…" });
    const runtime = await resolveNodeRuntime(path.join(userData(), "runtime"), (line) => {
      sendSplash("log", line);
    });
    if (forceUpdate) settings.autoUpdateHarness = true;
    sendSplash("status", { phase: "engine", text: "Syncing DeepSeek Harness from npm…" });
    const install = await ensureHarness(
      settings,
      runtime,
      path.join(userData(), "harness"),
      (line) => sendSplash("log", line),
    );
    settings.lastHarnessVersion = install.version;
    await saveSettings(userData(), settings);

    sendSplash("status", { phase: "start", text: `Starting dsh web ${install.version}…` });
    stopHarness(running);
    running = await startHarnessWeb({
      runtime,
      install,
      workspaceDir: settings.workspaceDir || homedir(),
      dshHome: path.join(userData(), "dsh-home"),
      onLog: (line) => sendSplash("log", line),
    });
    buildMenu();
    if (mainWindow) {
      await mainWindow.loadURL(running.url);
      mainWindow.setTitle(`DeepSeek — dsh ${running.version}`);
      splashWindow?.close();
      splashWindow = null;
    } else {
      await createMain(running.url, running.version);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendSplash("status", { phase: "error", text: message });
    await dialog.showErrorBox("DeepSeek Desktop", message);
  }
}

app.whenReady().then(async () => {
  settings = await loadSettings(userData());
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
