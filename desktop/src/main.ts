import { app, BrowserWindow, Menu, Tray, clipboard, dialog, shell, ipcMain, screen, nativeImage, net } from "electron";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { loadSettings, saveSettings } from "./settings";
import { syncAllProviderModels, getProvidersInfo } from "./sync-models";
import { ensureHarness, fetchPublishedVersion, listInstalledHarnesses, startHarnessWeb, stopHarness, stopHarnessTree, type HarnessInstall, type RunningHarness } from "./harness";
import { applyLinuxRuntimeFlags } from "./linux-flags";
import { createTranslator, shellLocaleFromSetting, type ShellLocale, type Translator } from "./i18n";
import { FileLogger, collectLogText, logsDir } from "./logs";
import {
  buildDiagnosticsBundle,
  pickDiagnosticsDir,
  redactSecrets,
  writeDiagnosticsBundle,
  type DiagnosticsInput,
} from "./diagnostics";
import {
  crashLoopDetected,
  formatExitReason,
  isUnexpectedExit,
  recordCrash,
  restartDelaySeconds,
  restartDelayMs,
  MAX_AUTO_RESTARTS,
} from "./supervisor";
import { trayIconSize, trayMenuTemplate, trayTooltip, type TrayState } from "./tray";
import { buildRecoveryInfo, recoveryPagePath, pickRollbackTarget, type RecoveryReason } from "./recovery";
import { resolveNodeRuntime, type NodeRuntime } from "./node-runtime";
import { qualifyEntry } from "./market/install";
import { createMarketService, type MarketService } from "./market/service";
import { DSH1024_SOURCE, type CatalogSource } from "./market/catalog";
import { explainFirstRunError } from "./first-run-error";
import { appIconFile, installUserShortcuts, needsUserShortcuts } from "./desktop-integration";
import { readPairingSnapshot, rotatePairing, revokePairingDevice } from "./mobile-pairing";
import { engineNetworkEnv, readBridgeNetwork } from "./network-env";
import {
  DESKTOP_DOWNLOAD_PAGE,
  downloadDesktopAssetFromMirrors,
  fetchLatestDesktopRelease,
  installerDownloadUrls,
  pickDesktopAsset,
  shouldPromptDesktopUpdate,
  type DesktopRelease,
  type HttpFetcher,
} from "./desktop-update";
import { ensureDefaultWorkspace } from "./dsh-workspace";
import { SKIN_OVERLAY_CSS, skinOverlayBootstrap } from "./skin-overlay";
import {
  DEFAULT_SKIN_ID,
  OFFICIAL_SKIN_ID,
  applySkin,
  ensureBuiltinSkin,
  ensureHomePatchesAreArrays,
  importSkinFromDir,
  importSkinFromUrl,
  isSafeSkinId,
  listSkinCards,
  loadCatalog,
  type InstalledSkin,
} from "./skins";
import { migrateLegacyDesktopData, summarizeMigration, type LegacyMigrateResult } from "./legacy-home";
import { loadWindowState, saveWindowState } from "./window-state";
import { ensureBundledPlugins, migrateLegacySearchSettings, pluginSecretsEnv, renderPluginRows } from "./plugins";
import {
  APP_DISPLAY_NAME,
  APP_ID,
  DEFAULT_SETTINGS,
  DSH_PACKAGE,
  NPM_REGISTRY,
  bridgeOrigin,
  chromiumAcceptLang,
  compareVersions,
  harnessLocaleEnv,
  hostIntlLocale,
  hostTimeZone,
  normalizeWebPort,
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
/** The plugin market window, created on demand from the menu or the tray. */
let marketWindow: BrowserWindow | null = null;
let marketService: MarketService | null = null;
/** `--market` opens the market on launch, so a broken engine UI is not in the way. */
const marketOnly = process.argv.includes("--market");
let lastRuntime: NodeRuntime | null = null;
let lastInstall: HarnessInstall | null = null;
let skinBusy = false;
let booting = false;
let settings: DesktopSettings;
let lastMigration: LegacyMigrateResult | null = null;
let tray: Tray | null = null;
let recoveryWindow: BrowserWindow | null = null;
let logger: FileLogger | null = null;
let engineLogger: FileLogger | null = null;
let shellLocale: ShellLocale = "zh-CN";
let t: Translator = createTranslator("zh-CN");
let crashHistory: number[] = [];
let lastExitReason = "";
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let quitting = false;
let pendingRecoveryReason: RecoveryReason = { kind: "manual" };
/**
 * `--export-diagnostics` has to work when the window cannot open at all (broken
 * install, engine that never listens), so it is honoured before any engine,
 * window or tray work.
 */
const diagnosticsOnly = process.argv.includes("--export-diagnostics");

function uiText(key: string, vars?: Record<string, string | number>): string {
  return t(key, vars);
}

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

/** Chromium/net.fetch uses the Windows system proxy; Node fetch in the main process does not. */
function sessionAwareFetch(input: string, init?: RequestInit): Promise<Response> {
  return net.fetch(input, init) as Promise<Response>;
}

const desktopFetcher: HttpFetcher = (url, init) => sessionAwareFetch(url, init);

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
  const win11 = process.platform === "win32";
  splashWindow = new BrowserWindow({
    width: 528,
    height: 420,
    frame: false,
    resizable: false,
    show: false,
    roundedCorners: true,
    hasShadow: true,
    thickFrame: false,
    backgroundColor: win11 ? "#00000000" : "#f3f3f3",
    ...(win11 ? { transparent: true, backgroundMaterial: "mica" as const } : {}),
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
  await splashWindow.loadFile(path.join(__dirname, "..", "resources", "splash.html"), {
    query: { os: process.platform, locale: shellLocale },
  });
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
    // The harness UI itself has no menu bar: hide the native one so the window
    // matches it. Alt still reveals it, and every accelerator stays registered.
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
    shellLog(`界面加载失败（${code}）：${desc} ${validatedURL}`);
  });
  mainWindow.once("ready-to-show", () => revealMain());
  mainWindow.webContents.on("did-finish-load", () => {
    void injectSkinOverlay();
    setTimeout(() => revealMain(), 250);
  });
  mainWindow.on("close", (event) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    void saveWindowState(userData(), {
      bounds: mainWindow.getNormalBounds(),
      isMaximized: mainWindow.isMaximized(),
    });
    // DSH Desktop hides to the tray on close; quitting is an explicit action.
    if (!quitting && settings?.closeToTray && tray) {
      event.preventDefault();
      mainWindow.hide();
      refreshTray();
    }
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

async function syncSkins(onLog: (line: string) => void = shellLog): Promise<InstalledSkin[]> {
  const repaired = await ensureHomePatchesAreArrays(dshHomeDir());
  if (repaired.length) {
    onLog("已修复损坏的皮肤补丁文件（必须是 YAML 数组，空文件请用 []）");
  }
  // Bundled engine plugins (Tavily search / vision aux) are independent of the
  // skin toggle: install, link, and include their patch rows on every boot.
  await ensureBundledPlugins({
    userData: userData(),
    dshHome: dshHomeDir(),
    appRoot: path.join(__dirname, ".."),
    resourcesPath: process.resourcesPath,
    onLog: (line) => onLog(String(line)),
  }).catch((error) => onLog(`内置插件未能安装：${error instanceof Error ? error.message : String(error)}`));
  await migrateLegacySearchSettings({ dshHome: dshHomeDir(), settings, onLog: (line) => onLog(String(line)) }).catch(
    (error) => onLog(`搜索设置迁移失败：${error instanceof Error ? error.message : String(error)}`),
  );
  const pluginRows = renderPluginRows(settings);
  if (!settings.skinsEnabled) {
    const catalog = await loadCatalog(userData()).catch(() => []);
    if (catalog.length) await applySkin(dshHomeDir(), catalog, OFFICIAL_SKIN_ID, pluginRows);
    return catalog;
  }
  try {
    await ensureBuiltinSkin(userData(), (line) => onLog(String(line)), {
      bundledDir: path.join(__dirname, "..", "resources", "skins", "maid-atelier"),
      appRoot: path.join(__dirname, ".."),
      resourcesPath: process.resourcesPath,
    });
  } catch (error) {
    onLog(`默认皮肤未能安装：${error instanceof Error ? error.message : String(error)}`);
  }
  const catalog = await loadCatalog(userData());
  const active = settings.activeSkinId || DEFAULT_SKIN_ID;
  await applySkin(dshHomeDir(), catalog, active, pluginRows);
  return catalog;
}

/**
 * Facts the engine cannot derive itself, handed to the desktop panel plugin:
 * which shell version is running, where it writes logs, which engine it
 * launched, and whether a diagnostics export is possible from here. Secrets
 * never travel this way — that is `pluginSecretsEnv`'s job.
 */
function desktopPanelEnv(): NodeJS.ProcessEnv {
  return {
    DSH_DESKTOP_VERSION: app.getVersion(),
    DSH_DESKTOP_EXE: app.isPackaged ? process.execPath : "",
    DSH_DESKTOP_LOG_DIR: logsDir(userData()),
    DSH_DESKTOP_USER_DATA: userData(),
    DSH_DESKTOP_WORKSPACE: settings.workspaceDir,
    DSH_DESKTOP_CHANNEL: settings.channel,
    DSH_DESKTOP_LOCALE: shellLocale,
    DSH_DESKTOP_TRAY: tray ? "1" : "0",
    DSH_DESKTOP_MARKET: "1",
    DSH_DESKTOP_PACKAGED: app.isPackaged ? "1" : "0",
    ...(lastInstall?.version ? { DSH_ENGINE_VERSION: lastInstall.version } : {}),
  };
}

/** Locale plus the plugin secrets, shell facts and engine anchor the engine process needs. */
function engineExtraEnv(): NodeJS.ProcessEnv {
  return {
    ...harnessLocaleEnv(uiLocale),
    ...pluginSecretsEnv(settings),
    ...desktopPanelEnv(),
    // 模型网络路由：桥接 store 的 network 配置 → 引擎启动环境（HTTP(S)_PROXY/NO_PROXY）。
    // dsh-http-proxy 只在引擎启动时解析一次，所以这是唯一注入点，改路由 = 重启引擎。
    ...engineNetworkEnv(readBridgeNetwork(dshHomeDir())),
    ...(lastInstall?.prefix ? { DSH_ENGINE_ROOT: lastInstall.prefix } : {}),
  };
}

function preferredSkinId(): string {
  return settings.activeSkinId && settings.activeSkinId !== OFFICIAL_SKIN_ID
    ? settings.activeSkinId
    : DEFAULT_SKIN_ID;
}

/** Reload is not enough after "official": the plugin is unloaded and never comes back. */
async function restartHarnessUi(): Promise<void> {
  if (!lastRuntime || !lastInstall) {
    await boot(false);
    return;
  }
  const workspaceDir = settings.workspaceDir || path.join(homedir(), "DeepSeek");
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(uiText("status.switchingSkin"));
  }
  await syncSkins(shellLog);
  stopHarnessTree(running);
  running = await startHarnessWeb({
    runtime: lastRuntime,
    install: lastInstall,
    workspaceDir,
    dshHome: dshHomeDir(),
    extraEnv: engineExtraEnv(),
    port: normalizeWebPort(settings.webPort),
    onLog: engineLog,
  });
  superviseRunningHarness(restartEngine);
  buildMenu();
  refreshTray();
  if (mainWindow && !mainWindow.isDestroyed()) {
    await loadHarnessUi(running.url);
    mainWindow.setTitle(`${APP_DISPLAY_NAME} — dsh ${running.version}`);
    revealMain();
  }
}

async function applySkinSelection(id: string, enabled = settings.skinsEnabled): Promise<void> {
  if (skinBusy) return;
  skinBusy = true;
  try {
    settings.skinsEnabled = enabled;
    if (enabled) {
      settings.activeSkinId = id === OFFICIAL_SKIN_ID ? OFFICIAL_SKIN_ID : id || DEFAULT_SKIN_ID;
    } else if (!settings.activeSkinId || settings.activeSkinId === OFFICIAL_SKIN_ID) {
      settings.activeSkinId = DEFAULT_SKIN_ID;
    }
    await saveSettings(userData(), settings);
    await restartHarnessUi();
  } finally {
    skinBusy = false;
  }
}

async function openSkinCenter(): Promise<void> {
  if (!settings.skinsEnabled) {
    await applySkinSelection(preferredSkinId(), true);
    return;
  }
  await injectSkinOverlay();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await mainWindow.webContents.executeJavaScript(
    `document.getElementById("dsh-desktop-skin-root")?.classList.add("open")`,
  );
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
      shellLog(`界面暂时打不开，正在重试（${attempt}/8）…`);
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function shellLog(line: string): void {
  const text = String(line ?? "").trim();
  if (!text) return;
  logger?.append(text);
  sendSplash("log", text);
}

/** Engine output keeps its own file; the diagnostics bundle reports it separately. */
function engineLog(line: string): void {
  const text = String(line ?? "").trim();
  if (!text) return;
  engineLogger?.append(text);
  shellLog(text);
}

function systemLocaleHint(): string {
  return [uiLocale, systemLocale(), osLocale, preferredLanguages(), hostIntlLocale()].filter(Boolean).join(" ");
}

/** Menus, tray and the recovery page are rebuilt in place; nothing else depends on language. */
function applyShellLocale(): void {
  const choice = shellLocaleFromSetting(settings?.locale ?? "", systemLocaleHint());
  shellLocale = choice.locale;
  t = createTranslator(shellLocale);
  buildMenu();
  refreshTray();
  void injectSkinOverlay();
  shellLog(uiText("log.shellLocale", { locale: shellLocale, source: choice.source }));
}

async function pinShellLocale(locale: string): Promise<void> {
  settings.locale = locale;
  await saveSettings(userData(), settings);
  applyShellLocale();
}

async function installedEngineVersions(): Promise<string[]> {
  const installs = await listInstalledHarnesses(path.join(userData(), "harness")).catch(() => []);
  return installs.map((item) => item.version).filter(Boolean).sort(compareVersions);
}

async function diagnosticsInput(): Promise<DiagnosticsInput> {
  const current = settings ?? DEFAULT_SETTINGS;
  return {
    appName: APP_DISPLAY_NAME,
    appVersion: app.getVersion(),
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    node: process.versions.node ?? "",
    v8: process.versions.v8 ?? "",
    platform: process.platform,
    arch: process.arch,
    osRelease: process.getSystemVersion?.() ?? "",
    hostLocale: systemLocaleHint(),
    shellLocale,
    timeZone: timeZone || "",
    packaged: app.isPackaged,
    userData: userData(),
    dshHome: dshHomeDir(),
    workspaceDir: current.workspaceDir || path.join(homedir(), "DeepSeek"),
    logsPath: logsDir(userData()),
    engineVersion: running?.version ?? current.lastHarnessVersion ?? "",
    enginePrefix: lastInstall?.prefix ?? "",
    installedEngines: await installedEngineVersions(),
    channel: current.channel,
    registry: current.registry,
    webPort: normalizeWebPort(current.webPort),
    localUrl: running?.url ?? "",
    trayAvailable: Boolean(tray),
    autoRestarts: crashHistory.length,
    lastExitReason,
    settingsJson: JSON.stringify(current, null, 2),
    exportedBy: diagnosticsOnly ? "command line (--export-diagnostics)" : "desktop menu or tray",
  };
}

function diagnosticsOutDir(): string {
  return pickDiagnosticsDir([app.getPath("downloads"), app.getPath("desktop"), userData()]);
}

/**
 * DSH Desktop's troubleshooting flow starts with "Export diagnostics…": confirm,
 * write the zip, offer to reveal it. Never throws — diagnostics must not be able
 * to break the app they are meant to explain.
 */
async function exportDiagnostics(interactive: boolean): Promise<string | null> {
  if (interactive) {
    const confirm = await nativeBox({
      type: "question",
      title: uiText("diag.title"),
      message: uiText("diag.message"),
      detail: uiText("diag.detail"),
      buttons: [uiText("diag.export"), uiText("common.cancel")],
      defaultId: 0,
      cancelId: 1,
    });
    if (confirm.response !== 0) return null;
  }
  try {
    const bundle = writeDiagnosticsBundle(await diagnosticsInput(), diagnosticsOutDir());
    shellLog(uiText("log.diagExported", { path: bundle.path }));
    if (interactive) {
      const done = await nativeBox({
        type: "info",
        title: uiText("diag.doneTitle"),
        message: uiText("diag.doneMessage", { name: bundle.name }),
        detail: uiText("diag.doneDetail", { path: bundle.path }),
        buttons: [uiText("diag.reveal"), uiText("common.ok")],
        defaultId: 0,
        cancelId: 1,
      });
      if (done.response === 0) shell.showItemInFolder(bundle.path);
    }
    return bundle.path;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (interactive) {
      await nativeBox({ type: "error", title: uiText("diag.failed"), message, buttons: [uiText("common.ok")] });
    }
    return null;
  }
}

/** `--export-diagnostics`: no window, no engine, no tray — just the bundle. */
async function runDiagnosticsCli(): Promise<void> {
  try {
    settings = await loadSettings(userData(), uiLocale, timeZone).catch(() => DEFAULT_SETTINGS);
    shellLocale = shellLocaleFromSetting("", systemLocaleHint()).locale;
    t = createTranslator(shellLocale);
    logger = new FileLogger(userData(), "app.log");
    const bundlePath = await exportDiagnostics(false);
    if (!bundlePath) throw new Error("diagnostics bundle was not written");
    process.stdout.write(`${bundlePath}\n`);
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    app.exit(1);
  }
}

// ---------- engine supervision ----------

function scheduleEngineRestart(delayMs: number, restart: () => Promise<void>): void {
  if (restartTimer) clearTimeout(restartTimer);
  refreshTray();
  restartTimer = setTimeout(() => {
    restartTimer = null;
    shellLog(uiText("log.engineRestarting"));
    void restart().catch(() => undefined);
  }, delayMs);
}

/**
 * DSH Desktop restarts a dead host and falls back to a recovery window. Same
 * policy here: restart with backoff, and after MAX_AUTO_RESTARTS crashes inside
 * the window stop guessing and hand the user a recovery window instead.
 */
function superviseRunningHarness(restart: () => Promise<void>): void {
  const child = running?.process;
  if (!child) return;
  child.on("exit", (code, signal) => {
    if (quitting) return;
    lastExitReason = formatExitReason(code, signal);
    if (!isUnexpectedExit(code, signal)) return;
    const now = Date.now();
    crashHistory = recordCrash(crashHistory, now);
    if (crashLoopDetected(crashHistory, now)) {
      engineLog(uiText("log.engineRestartFailed", { count: MAX_AUTO_RESTARTS }));
      void openRecovery({ kind: "crash-loop", count: crashHistory.length });
      return;
    }
    const attempt = crashHistory.length;
    engineLog(
      uiText("log.engineExited", {
        code: lastExitReason,
        delay: restartDelaySeconds(attempt),
        attempt,
      }),
    );
    scheduleEngineRestart(restartDelayMs(attempt), restart);
  });
}

async function startEngineSupervised(): Promise<RunningHarness | null> {
  if (!lastRuntime || !lastInstall) return null;
  const workspaceDir = settings.workspaceDir || path.join(homedir(), "DeepSeek");
  try {
    running = await startHarnessWeb({
      runtime: lastRuntime,
      install: lastInstall,
      workspaceDir,
      dshHome: dshHomeDir(),
      extraEnv: engineExtraEnv(),
      port: normalizeWebPort(settings.webPort),
      onLog: engineLog,
    });
    superviseRunningHarness(restartEngine);
    watchNetworkRestart();
    return running;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lastExitReason = message;
    engineLog(`[shell] 引擎启动失败：${message}`);
    const now = Date.now();
    crashHistory = recordCrash(crashHistory, now);
    if (crashLoopDetected(crashHistory, now)) {
      await openRecovery({ kind: "start-failed", message });
    } else {
      scheduleEngineRestart(restartDelayMs(crashHistory.length), restartEngine);
    }
    return null;
  }
}

/** Tray "Restart Engine": stop the tree, start again, reload the window. */
async function restartEngine(): Promise<void> {
  if (!lastRuntime || !lastInstall) {
    await boot(false);
    return;
  }
  shellLog(uiText("status.restarting"));
  stopHarnessTree(running);
  running = null;
  const started = await startEngineSupervised();
  if (!started) return;
  buildMenu();
  refreshTray();
  if (mainWindow && !mainWindow.isDestroyed()) {
    await loadHarnessUi(started.url);
    mainWindow.setTitle(`${APP_DISPLAY_NAME} — dsh ${started.version}`);
    revealMain();
  } else {
    await createMain(started.url, started.version);
  }
}

/**
 * 网络路由的「重启电脑端」请求：桥接把 restartRequestedAt 写进 mobile-bridge.json，
 * 壳在这里发现后重启引擎（新引擎启动时带上新环境，桥接随后清除标记）。
 */
let netRestartHandledAt = 0;
let netWatchTimer: ReturnType<typeof setInterval> | null = null;
function watchNetworkRestart(): void {
  if (netWatchTimer) return;
  netWatchTimer = setInterval(() => {
    try {
      const network = readBridgeNetwork(dshHomeDir());
      const at = Number(network.restartRequestedAt ?? 0);
      if (at > netRestartHandledAt) {
        netRestartHandledAt = at;
        shellLog("收到「重启电脑端」请求（模型网络路由），正在重启引擎…");
        void restartEngine().catch(() => undefined);
      }
    } catch {
      /* 读不到 store 就当没有请求 */
    }
  }, 3000);
}

/** Rollback: boot the previous engine version and stop auto-upgrading to the broken one. */
async function rollbackEngine(): Promise<void> {
  const versions = await installedEngineVersions();
  const target = pickRollbackTarget(versions, running?.version ?? settings.lastHarnessVersion);
  if (!target) {
    await nativeBox({
      type: "info",
      title: uiText("recovery.title"),
      message: uiText("recovery.rollbackNone"),
      buttons: [uiText("common.ok")],
    });
    return;
  }
  shellLog(uiText("log.rollbackTo", { version: target }));
  settings.lastHarnessVersion = target;
  settings.skippedHarnessVersion = "";
  await saveSettings(userData(), settings);
  await boot(false);
}

/** Reinstall the version that is currently failing, ignoring "already installed". */
async function reinstallEngine(): Promise<void> {
  const current = running?.version || settings.lastHarnessVersion;
  settings.skippedHarnessVersion = "";
  if (current) settings.channel = current;
  await saveSettings(userData(), settings);
  await boot(true);
}

// ---------- recovery window ----------

async function recoveryInfo(reason: RecoveryReason) {
  return buildRecoveryInfo({
    locale: shellLocale,
    reason,
    translator: t,
    currentVersion: lastInstall?.version || settings?.lastHarnessVersion || "",
    installedVersions: await installedEngineVersions(),
    workspaceDir: settings?.workspaceDir || path.join(homedir(), "DeepSeek"),
    logsPath: logsDir(userData()),
  });
}

/** One recovery window at a time; every workflow is a button on the page. */
async function openRecovery(reason: RecoveryReason): Promise<void> {
  pendingRecoveryReason = reason;
  if (recoveryWindow && !recoveryWindow.isDestroyed()) {
    recoveryWindow.show();
    recoveryWindow.focus();
    refreshTray();
    return;
  }
  recoveryWindow = new BrowserWindow({
    width: 640,
    height: 580,
    resizable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: "#101218",
    title: `${APP_DISPLAY_NAME} — ${uiText("recovery.title")}`,
    icon: windowIcon(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  recoveryWindow.on("closed", () => {
    recoveryWindow = null;
    refreshTray();
  });
  await recoveryWindow.loadFile(recoveryPagePath(path.join(__dirname, "..")));
  refreshTray();
}

async function runRecoveryAction(action: string): Promise<void> {
  const closeRecovery = () => {
    if (recoveryWindow && !recoveryWindow.isDestroyed()) recoveryWindow.close();
    crashHistory = [];
    refreshTray();
  };
  switch (action) {
    case "restart":
      closeRecovery();
      await restartEngine();
      return;
    case "rollback":
      closeRecovery();
      await rollbackEngine();
      return;
    case "reinstall":
      closeRecovery();
      await reinstallEngine();
      return;
    case "logs":
      await shell.openPath(logsDir(userData()));
      return;
    case "diagnostics":
      await exportDiagnostics(true);
      return;
    case "quit":
      app.quit();
      return;
    default:
      return;
  }
}

// ---------- tray ----------

function trayState(): TrayState {
  return {
    windowVisible: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
    engineVersion: running?.version ?? "",
    engineStarting: booting,
    engineStopped: !running && !booting,
    recoveryOpen: Boolean(recoveryWindow && !recoveryWindow.isDestroyed()),
    hasLocalUrl: Boolean(running?.url),
    skinsEnabled: settings?.skinsEnabled !== false,
  };
}

function trayActions() {
  return {
    showWindow: () => {
      revealMain();
      refreshTray();
    },
    hideWindow: () => {
      mainWindow?.hide();
      refreshTray();
    },
    openInBrowser: () => {
      if (running?.url) void shell.openExternal(running.url);
    },
    copyUrl: () => {
      if (!running?.url) return;
      clipboard.writeText(running.url);
      shellLog(uiText("tray.copied", { url: running.url }));
    },
    openWorkspace: () => {
      const dir = settings?.workspaceDir || path.join(homedir(), "DeepSeek");
      void shell.openPath(dir);
    },
    restartEngine: () => {
      void restartEngine().catch(() => undefined);
    },
    openMarket: () => {
      void openMarket();
    },
    openSettings: () => {
      void openSettings();
    },
    checkEngineUpdate: () => {
      void checkHarnessUpdates(true);
    },
    checkDesktopUpdate: () => {
      void checkDesktopUpdates(true);
    },
    openLogs: () => {
      void shell.openPath(logsDir(userData()));
    },
    exportDiagnostics: () => {
      void exportDiagnostics(true);
    },
    openRecovery: () => {
      void openRecovery({ kind: "manual" });
    },
    openSkinList: () => {
      void openSkinCenter();
    },
    quit: () => {
      app.quit();
    },
  };
}

/** Tray icons are painted at menu-bar size; the 256px app icon would look blurry. */
function trayImage(): Electron.NativeImage {
  const image = nativeImage.createFromPath(windowIcon());
  if (image.isEmpty()) return image;
  return image.resize(trayIconSize(process.platform));
}

function createTray(): void {
  if (tray) return;
  try {
    const image = trayImage();
    if (image.isEmpty()) {
      shellLog(uiText("log.trayFailed", { message: "icon missing" }));
      return;
    }
    tray = new Tray(image);
    tray.on("click", () => {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.hide();
      else revealMain();
      refreshTray();
    });
    refreshTray();
    shellLog(uiText("log.trayReady"));
  } catch (error) {
    // A tray is a convenience; it must never be able to break startup.
    tray = null;
    shellLog(uiText("log.trayFailed", { message: error instanceof Error ? error.message : String(error) }));
  }
}

function refreshTray(): void {
  if (!tray) return;
  try {
    const state = trayState();
    tray.setToolTip(trayTooltip(t, state));
    tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(t, state, trayActions())));
  } catch {
    // Rebuilding the menu can race with shutdown.
  }
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: uiText("menu.file"),
      submenu: [
        {
          label: uiText("menu.file.openWorkspace"),
          accelerator: "CmdOrCtrl+O",
          click: () => {
            void chooseWorkspace(true);
          },
        },
        {
          label: uiText("menu.file.openWorkspaceFolder"),
          click: () => {
            const dir = settings?.workspaceDir || path.join(homedir(), "DeepSeek");
            void shell.openPath(dir);
          },
        },
        {
          label: uiText("menu.file.createShortcut"),
          click: () => {
            void createShortcutsManually();
          },
        },
        { type: "separator" },
        { role: "quit", label: uiText("menu.file.quit") },
      ],
    },
    {
      label: uiText("menu.edit"),
      submenu: [
        { role: "undo", label: uiText("menu.edit.undo") },
        { role: "redo", label: uiText("menu.edit.redo") },
        { type: "separator" },
        { role: "cut", label: uiText("menu.edit.cut") },
        { role: "copy", label: uiText("menu.edit.copy") },
        { role: "paste", label: uiText("menu.edit.paste") },
        { role: "selectAll", label: uiText("menu.edit.selectAll") },
      ],
    },
    {
      label: uiText("menu.harness"),
      submenu: [
        {
          label: running
            ? uiText("menu.harness.status", { version: running.version })
            : uiText("menu.harness.statusNone"),
          enabled: false,
        },
        {
          label: uiText("menu.harness.restartEngine"),
          click: () => {
            void restartEngine().catch(() => undefined);
          },
        },
        {
          label: uiText("menu.harness.checkDesktop"),
          accelerator: "CmdOrCtrl+Shift+U",
          click: () => {
            void checkDesktopUpdates(true);
          },
        },
        {
          label: uiText("menu.harness.checkEngine"),
          accelerator: "CmdOrCtrl+U",
          click: () => {
            void checkHarnessUpdates(true);
          },
        },
        {
          label: uiText("menu.harness.settings"),
          // The bar is hidden by default, so the settings window needs a way in
          // that does not require knowing about Alt.
          accelerator: "CmdOrCtrl+,",
          click: () => {
            void openSettings();
          },
        },
        {
          label: uiText("menu.harness.market"),
          click: () => {
            void openMarket();
          },
        },
        { type: "separator" },
        {
          label: uiText("menu.harness.openLogs"),
          click: () => {
            void shell.openPath(logsDir(userData()));
          },
        },
        {
          label: uiText("menu.harness.exportDiagnostics"),
          click: () => {
            void exportDiagnostics(true);
          },
        },
        {
          label: uiText("menu.harness.recovery"),
          click: () => {
            void openRecovery({ kind: "manual" });
          },
        },
        { type: "separator" },
        {
          label: uiText("menu.harness.openRepo"),
          click: () => {
            void shell.openExternal("https://github.com/deepseek-ai/deepseek-harness");
          },
        },
      ],
    },
    {
      label: uiText("menu.view"),
      submenu: [
        { role: "reload", label: uiText("menu.view.reload") },
        { role: "toggleDevTools", label: uiText("menu.view.devtools") },
        { type: "separator" },
        { role: "resetZoom", label: uiText("menu.view.resetZoom") },
        { role: "zoomIn", label: uiText("menu.view.zoomIn") },
        { role: "zoomOut", label: uiText("menu.view.zoomOut") },
        { type: "separator" },
        {
          label: uiText("menu.view.openBrowser"),
          click: () => {
            if (running?.url) void shell.openExternal(running.url);
          },
        },
        { role: "togglefullscreen", label: uiText("menu.view.fullscreen") },
      ],
    },
    {
      label: uiText("menu.skin"),
      submenu: [
        {
          label: uiText("menu.skin.open"),
          click: () => {
            void openSkinCenter();
          },
        },
        {
          label: settings?.skinsEnabled ? uiText("menu.skin.disable") : uiText("menu.skin.enable"),
          click: () => {
            void applySkinSelection(preferredSkinId(), !settings.skinsEnabled);
          },
        },
      ],
    },
    {
      label: uiText("menu.language"),
      submenu: [
        {
          label: uiText("menu.language.auto", { locale: systemLocaleHint() || "en" }),
          type: "radio",
          checked: !settings?.locale,
          click: () => {
            void pinShellLocale("");
          },
        },
        {
          label: "中文",
          type: "radio",
          checked: Boolean(settings?.locale) && shellLocale === "zh-CN",
          click: () => {
            void pinShellLocale("zh-CN");
          },
        },
        {
          label: "English",
          type: "radio",
          checked: Boolean(settings?.locale) && shellLocale === "en",
          click: () => {
            void pinShellLocale("en");
          },
        },
      ],
    },
    {
      label: uiText("menu.help"),
      submenu: [
        {
          label: uiText("menu.help.apiKey"),
          click: () => {
            void shell.openExternal("https://platform.deepseek.com");
          },
        },
        {
          label: uiText("menu.help.guide"),
          click: () => {
            void shell.openExternal("https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/index.md");
          },
        },
        { type: "separator" },
        {
          label: uiText("menu.help.about"),
          click: () => {
            void nativeBox({
              type: "info",
              title: uiText("menu.help.about"),
              message: uiText("about.message", { version: app.getVersion() }),
              detail: uiText("about.detail", {
                engine: running?.version || settings?.lastHarnessVersion || "未启动",
                workspace: settings?.workspaceDir || path.join(homedir(), "DeepSeek"),
                locale: shellLocale,
              }),
              buttons: [uiText("common.ok")],
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

async function offerDownloadPage(title: string, message: string): Promise<void> {
  const choice = await nativeBox({
    type: "error",
    title,
    message,
    detail: `也可以直接打开 ${DESKTOP_DOWNLOAD_PAGE}，用浏览器下载安装包（浏览器会走系统代理）。`,
    buttons: ["打开下载页", "确定"],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice.response === 0) await shell.openExternal(DESKTOP_DOWNLOAD_PAGE);
}

async function checkDesktopUpdates(interactive: boolean): Promise<void> {
  try {
    const latest = await fetchLatestDesktopRelease(desktopFetcher);
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
    await offerDownloadPage("检查桌面版更新失败", error instanceof Error ? error.message : String(error));
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
  if (!splashWindow || splashWindow.isDestroyed()) await createSplash();
  sendSplash("status", { phase: "engine", text: `正在下载桌面版 ${release.version}…` });
  const previousTitle = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getTitle() : "";
  const onLog = (line: string) => {
    shellLog(line);
    sendSplash("status", { phase: "engine", text: line });
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(line);
  };
  try {
    await downloadDesktopAssetFromMirrors(
      installerDownloadUrls(asset.name, release.version),
      dest,
      onLog,
      desktopFetcher,
      { knownSize: asset.size },
    );
  } finally {
    if (previousTitle && mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(previousTitle);
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) closeSplash();
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

/**
 * The market service, built once per app run. It reads `dshHomeDir()` and the
 * engine runtime lazily, so a market opened before the first boot finishes
 * still lists the catalog and simply refuses to install until the engine is
 * installed.
 */
function market(): MarketService {
  marketService = marketService ?? createMarketService({
    userData: userData(),
    dshHome: dshHomeDir,
    engine: () =>
      lastRuntime && lastInstall ? { nodePath: lastRuntime.node, engineBin: lastInstall.bin } : null,
    onLog: shellLog,
    onProgress: (chunk) => {
      if (marketWindow && !marketWindow.isDestroyed()) marketWindow.webContents.send("market:progress", chunk);
    },
  });
  return marketService;
}

/** Open (or focus) the plugin market window. */
async function openMarket(): Promise<void> {
  if (marketWindow && !marketWindow.isDestroyed()) {
    marketWindow.show();
    marketWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#0c0e14",
    icon: windowIcon(),
    title: uiText("market.title"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  marketWindow = win;
  win.on("closed", () => {
    if (marketWindow === win) marketWindow = null;
  });
  await win.loadFile(path.join(__dirname, "..", "resources", "market.html"), {
    query: { locale: shellLocale },
  });
}

/**
 * Open one of the engine's own settings sections inside the main window.
 *
 * The engine's settings is an in-app dialog, not a URL route — loading
 * `/settings/<id>` answers 404 — so the shell drives the same clicks a person
 * would: open 设置, then pick the section by its label. The main window already
 * holds the engine's auth cookie, and the section renders in the engine's own
 * design language (which is the whole point of moving it there).
 */
async function openEngineSettings(section: string): Promise<{ ok: boolean; error?: string }> {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: "主窗口不可用。" };
  const label = JSON.stringify(String(section ?? "").trim());
  const script = `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const find = (text) => [...document.querySelectorAll("*")]
      .filter((el) => el.children.length === 0 && (el.textContent || "").trim() === text)
      .pop();
    const fire = (el) => {
      const rect = el.getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }));
      }
    };
    let item = find(${label});
    if (!item) {
      const open = find("设置");
      if (!open) return { ok: false, error: "找不到引擎界面里的设置入口：请先切回主界面再试。" };
      fire(open);
      await sleep(800);
      item = find(${label});
    }
    if (!item) return { ok: false, error: "引擎设置里没有「" + ${label} + "」这一项：插件可能没装上，重启一次引擎再试。" };
    fire(item);
    return { ok: true };
  })()`;
  try {
    const result = (await mainWindow.webContents.executeJavaScript(script, true)) as { ok: boolean; error?: string } | null;
    mainWindow.show();
    mainWindow.focus();
    return result !== null && typeof result === "object" ? result : { ok: false, error: "引擎界面没有回应。" };
  } catch (error) {
    return { ok: false, error: `打不开引擎设置：${error instanceof Error ? error.message : String(error)}` };
  }
}

async function openSettings(): Promise<void> {
  const win = new BrowserWindow({
    // Matches the engine's own settings dialog (800x800 panel + rails); the page
    // inside is the same harness language, so the two read as one product.
    width: 860,
    height: 800,
    parent: mainWindow ?? undefined,
    modal: Boolean(mainWindow),
    backgroundColor: "#ffffff",
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
    shellLog(`后台任务出错（已忽略）：${error.message}`);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("unhandled", reason);
    shellLog(`后台任务出错（已忽略）：${String(reason)}`);
  });
}

async function boot(forceUpdate: boolean): Promise<void> {
  if (booting) return;
  booting = true;
  try {
    if (forceUpdate && mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
    engineLogger = engineLogger ?? new FileLogger(userData(), "engine.log");
    if (!splashWindow) await createSplash();
    refreshTray();
    const workspaceDir = await defaultWorkspace();
    sendSplash("status", {
      phase: "runtime",
      text: uiText("status.runtime"),
    });
    const runtime = await resolveNodeRuntime(
      path.join(userData(), "runtime"),
      shellLog,
      sessionAwareFetch,
    );
    lastRuntime = runtime;
    shellLog(uiText("status.registry", { registry: settings.registry }));
    sendSplash("status", {
      phase: "engine",
      text: forceUpdate ? uiText("status.engineUpdate") : uiText("status.enginePrepare"),
    });
    const install = await ensureHarness(
      settings,
      runtime,
      path.join(userData(), "harness"),
      shellLog,
      forceUpdate,
    );
    lastInstall = install;
    settings.lastHarnessVersion = install.version;
    await saveSettings(userData(), settings);

    // Sync before the engine starts so models added now are served by this
    // launch already; bounded so a dead endpoint cannot stall boot.
    if (settings.autoSyncModels !== false) {
      sendSplash("status", { phase: "start", text: uiText("status.syncModels") });
      await Promise.race([
        syncAllProviderModels(dshHomeDir(), install.prefix).then((res) => {
          if (res.count > 0) {
            shellLog(`已同步 ${res.count} 个新模型 (${res.providers.join(", ")})`);
          } else if (res.error) {
            shellLog(`模型同步失败：${res.error}`);
          }
        }).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 15_000)),
      ]);
    }

    sendSplash("status", { phase: "start", text: uiText("status.launching", { version: install.version }) });
    stopHarnessTree(running);
    const dshHome = dshHomeDir();
    await ensureDefaultWorkspace(dshHome, workspaceDir, homedir()).catch(() => false);
    if (lastMigration?.copied.length) shellLog(summarizeMigration(lastMigration));
    sendSplash("status", {
      phase: "start",
      text: settings.skinsEnabled ? uiText("status.skin") : uiText("status.launching", { version: install.version }),
    });
    await syncSkins(shellLog);
    running = await startHarnessWeb({
      runtime,
      install,
      workspaceDir,
      dshHome,
      extraEnv: engineExtraEnv(),
      port: normalizeWebPort(settings.webPort),
      onLog: engineLog,
    });
    superviseRunningHarness(restartEngine);
    watchNetworkRestart();
    // New engine versions rewrite profiles/web/node_modules and drop the skin link.
    await syncSkins(shellLog);
    buildMenu();
    sendSplash("status", { phase: "start", text: uiText("status.opening") });
    if (mainWindow && !mainWindow.isDestroyed()) {
      await loadHarnessUi(running.url);
      mainWindow.setTitle(`${APP_DISPLAY_NAME} — dsh ${running.version}`);
      revealMain();
    } else {
      await createMain(running.url, running.version);
    }
    if (needsUserShortcuts(app.isPackaged)) {
      await installUserShortcuts({
        workspaceDir,
        version: app.getVersion(),
        userDataDir: userData(),
      }).catch(() => undefined);
    }
    refreshTray();
    void maybeNotifyDesktopUpdate().then(() => maybeNotifyHarnessUpdate());
  } catch (error) {
    const message = explainFirstRunError(error, "unknown", process.platform);
    sendSplash("status", { phase: "error", text: message });
    await nativeBox({
      type: "error",
      title: APP_DISPLAY_NAME,
      message,
      buttons: ["确定"],
    });
  } finally {
    booting = false;
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
      // `--export-diagnostics` never starts an engine, a window or a tray: it must
      // work exactly when the app cannot start.
      if (diagnosticsOnly) {
        await runDiagnosticsCli();
        return;
      }
      if (process.platform === "darwin") {
        const img = nativeImage.createFromPath(windowIcon());
        if (!img.isEmpty()) app.dock?.setIcon(img);
        app.setAboutPanelOptions({
          applicationName: APP_DISPLAY_NAME,
          applicationVersion: app.getVersion(),
        });
      }
      lastMigration = await migrateLegacyDesktopData({
        currentUserData: userData(),
        appData: app.getPath("appData"),
        homeDir: homedir(),
      });
      settings = await loadSettings(
        userData(),
        [systemLocale(), osLocale, preferredLanguages(), hostIntlLocale()].filter(Boolean).join(" "),
        timeZone,
      );
      settings.workspaceDir = resolveWorkspaceDir(settings.workspaceDir, homedir());
      settings.webPort = normalizeWebPort(settings.webPort);
      await saveSettings(userData(), settings);
      logger = new FileLogger(userData(), "app.log");
      engineLogger = new FileLogger(userData(), "engine.log");
      shellLocale = shellLocaleFromSetting(settings.locale, systemLocaleHint()).locale;
      t = createTranslator(shellLocale);
      shellLog(
        uiText("log.shellLocale", { locale: shellLocale, source: settings.locale ? "setting" : "system" }),
      );
      /** Loopback base of the running engine; origin only — query/token must not leak in. */
      // 环回 REST 的基地址：必须去 token/query/尾斜杠（用 origin）——running.url
      // 来自 `dsh web: http://127.0.0.1:<port>/?token=…`，原样拼接会让请求落到
      // 「未认证的根路径」上（纯文本响应），设置页的 transfer/配对卡片全挂。
      const bridgeBaseUrl = (): string => bridgeOrigin(running?.url ?? "");
      ipcMain.handle("app:version", () => app.getVersion());
      ipcMain.handle("settings:get", () => settings);
      ipcMain.handle("settings:save", async (_event, next: DesktopSettings) => {
        settings = { ...settings, ...next };
        settings.webPort = normalizeWebPort(settings.webPort);
        await saveSettings(userData(), settings);
        applyShellLocale();
        return settings;
      });
      ipcMain.handle("settings:pick-dir", async () => {
        const picked = await dialog.showOpenDialog({ properties: ["openDirectory"] });
        return picked.filePaths[0] ?? "";
      });
      // Phone companion: the settings window shows the live pairing code, its QR
      // and the bound devices. Every call goes through the bridge's loopback
      // routes, so the plugin stays the only writer of the pairing store.
      ipcMain.handle("mobile:pairing", async (_event, options?: { ensure?: boolean }) => {
        const base = bridgeBaseUrl();
        if (base === "") {
          return {
            ok: false,
            error: "引擎还没起来，稍后再打开这个页面。",
            publicUrl: settings.mobile.publicUrl,
            pairCode: null,
            pairExpiresAt: null,
            pairLink: null,
            qrSvg: null,
            devices: [],
          };
        }
        return await readPairingSnapshot({
          bridgeBase: base,
          publicUrl: settings.mobile.publicUrl,
          ensure: options?.ensure === true,
        });
      });
      ipcMain.handle("mobile:rotate", async () => {
        const base = bridgeBaseUrl();
        if (base === "") return { ok: false, error: "引擎还没起来，稍等一下再试。" };
        return await rotatePairing(base);
      });
      ipcMain.handle("mobile:copy", async (_event, text: string) => {
        clipboard.writeText(String(text ?? ""));
        return { ok: true };
      });
      ipcMain.handle("mobile:revoke", async (_event, id: string) => {
        const result = await revokePairingDevice(bridgeBaseUrl(), String(id ?? ""));
        if (!result.ok) return result;
        return {
          ok: true,
          snapshot: await readPairingSnapshot({
            bridgeBase: bridgeBaseUrl(),
            publicUrl: settings.mobile.publicUrl,
          }),
        };
      });
      ipcMain.handle("mobile:open-search-settings", async () =>
        await openEngineSettings("搜索引擎"),
      );
      ipcMain.handle("mobile:open-pairing-settings", async () =>
        await openEngineSettings("手机配对"),
      );
      // 隔空传输（文件互传）：列表 / 选文件放入 / 删除 / 打开文件夹。
      // 所有操作都走桥接的回环路由，插件保持传输目录的唯一写入方。
      ipcMain.handle("transfer:list", async () => {
        const base = bridgeBaseUrl();
        if (base === "") return { ok: false, error: "引擎还没起来，稍等一下再试。", items: [], dir: "" };
        try {
          const res = await fetch(`${base}/mobile-local/transfer/list`);
          return await res.json();
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error), items: [], dir: "" };
        }
      });
      ipcMain.handle("transfer:add", async () => {
        const picked = await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"] });
        if (picked.canceled || picked.filePaths.length === 0) {
          return { ok: true, added: [], refused: [], canceled: true };
        }
        const base = bridgeBaseUrl();
        if (base === "") return { ok: false, error: "引擎还没起来，稍等一下再试。", added: [], refused: [] };
        try {
          const res = await fetch(`${base}/mobile-local/transfer/add`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ paths: picked.filePaths }),
          });
          return await res.json();
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error), added: [], refused: [] };
        }
      });
      ipcMain.handle("transfer:delete", async (_event, id: string) => {
        const base = bridgeBaseUrl();
        if (base === "") return { ok: false, error: "引擎还没起来，稍等一下再试。" };
        try {
          const res = await fetch(`${base}/mobile-local/transfer/delete`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: String(id ?? "") }),
          });
          return await res.json();
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      });
      ipcMain.handle("transfer:open-folder", async (_event, dir: string) => {
        // 只允许打开数据目录内的路径，防止渲染层拿这个口子开任意位置。
        const target = String(dir ?? "");
        const home = dshHomeDir();
        if (target === "" || !target.startsWith(home)) return { ok: false, error: "路径不在数据目录内" };
        const message = await shell.openPath(target);
        return message === "" ? { ok: true } : { ok: false, error: message };
      });
      // Actions that only the hidden native menu offered. They live in the
      // settings window now; every one of them answers with a reason on failure.
      ipcMain.handle("desktop:action", async (_event, action: string) => {
        switch (String(action)) {
          case "market":
            await openMarket();
            return { ok: true };
          case "recovery":
            await openRecovery({ kind: "manual" });
            return { ok: true };
          case "logs":
            await shell.openPath(logsDir(userData()));
            return { ok: true };
          case "engine-settings":
            return await openEngineSettings("通用设置");
          default:
            return { ok: false, error: `未知操作：${String(action)}` };
        }
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
        await applySkinSelection(next, true);
      });
      ipcMain.handle("skins:set-enabled", async (_event, enabled: boolean) => {
        await applySkinSelection(preferredSkinId(), Boolean(enabled));
      });
      ipcMain.handle("skins:import-dir", async () => {
        const picked = await dialog.showOpenDialog({
          title: "选择皮肤文件夹",
          properties: ["openDirectory"],
        });
        if (picked.canceled || !picked.filePaths[0]) return;
        const imported = await importSkinFromDir(userData(), picked.filePaths[0]);
        await applySkinSelection(imported.id, true);
      });
      ipcMain.handle("skins:import-url", async (_event, url: string) => {
        const imported = await importSkinFromUrl(userData(), String(url || ""), shellLog);
        await applySkinSelection(imported.id, true);
      });
      ipcMain.handle("models:sync", async () => {
        return await syncAllProviderModels(dshHomeDir(), lastInstall?.prefix);
      });
      ipcMain.handle("models:get-providers", async () => {
        return await getProvidersInfo(dshHomeDir(), lastInstall?.prefix);
      });
      ipcMain.on("splash:quit", () => {
        app.quit();
      });
      ipcMain.on("splash:retry", () => {
        void boot(false);
      });
      ipcMain.handle("diagnostics:export", async () => await exportDiagnostics(true));
      ipcMain.handle("recovery:info", async () => await recoveryInfo(pendingRecoveryReason));
      ipcMain.handle("recovery:action", async (_event, action: string) => {
        await runRecoveryAction(String(action || ""));
      });
      ipcMain.handle("market:sources", async () => await market().sources());
      ipcMain.handle("market:save-sources", async (_event, sources: CatalogSource[]) => {
        const saved = await market().saveSources(sources);
        shellLog(`插件市场数据源已保存：${saved.map((source) => source.label).join("、") || DSH1024_SOURCE.label}`);
        return saved;
      });
      ipcMain.handle(
        "market:browse",
        async (_event, input: { sourceId?: string; query?: string; category?: string }) => {
          const page = await market().browse({
            sourceId: String(input?.sourceId ?? DSH1024_SOURCE.id),
            query: String(input?.query ?? ""),
            category: String(input?.category ?? ""),
          });
          shellLog(`插件目录：${page.entries.length} 条（共 ${page.catalogTotal} 条，源 ${String(input?.sourceId ?? DSH1024_SOURCE.id)}）`);
          return page;
        },
      );
      ipcMain.handle("market:detail", async (_event, input: { sourceId?: string; id?: string }) =>
        await market().detail({ sourceId: String(input?.sourceId ?? ""), id: String(input?.id ?? "") }),
      );
      ipcMain.handle("market:check", async (_event, input: { sourceId?: string; id?: string }) => {
        const entry = await market().detail({ sourceId: String(input?.sourceId ?? ""), id: String(input?.id ?? "") });
        if (!entry) return { ok: false, reason: "在目录里找不到这个插件" };
        const qualified = await qualifyEntry(entry);
        return qualified.ok ? { ok: true, spec: qualified.spec } : { ok: false, reason: qualified.reason };
      });
      ipcMain.handle("market:inventory", async () => await market().inventory());
      ipcMain.handle("market:install", async (_event, input: { sourceId?: string; id?: string }) =>
        await market().install({ sourceId: String(input?.sourceId ?? ""), id: String(input?.id ?? "") }),
      );
      ipcMain.handle("market:uninstall", async (_event, packageName: string) =>
        await market().uninstall(String(packageName || "")),
      );
      ipcMain.handle("market:toggle", async (_event, input: { packageName?: string; disabled?: boolean }) =>
        await market().setDisabled(String(input?.packageName ?? ""), Boolean(input?.disabled)),
      );
      ipcMain.handle("market:open-external", async (_event, url: string) => {
        const target = String(url || "");
        const parsed = (() => {
          try {
            return new URL(target);
          } catch {
            return null;
          }
        })();
        if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
          throw new Error("只允许打开 http(s) 链接");
        }
        await shell.openExternal(target);
      });
      ipcMain.handle("market:ui-log", async (_event, info: { tab?: string; cards?: number; sample?: string }) => {
        shellLog(`插件市场界面：${String(info?.tab ?? "?")} 渲染 ${Number(info?.cards ?? 0)} 张卡片${info?.sample ? `（示例：${String(info.sample).slice(0, 120)}）` : ""}`);
      });
      ipcMain.handle("market:restart", async () => {
        await restartEngine();
        if (marketWindow && !marketWindow.isDestroyed()) marketWindow.webContents.send("log", "已重启引擎\n");
      });
      buildMenu();
      createTray();
      await boot(false);
      if (marketOnly) await openMarket();
    });

    app.on("window-all-closed", () => {
      if (process.platform === "darwin") return;
      // With a tray and close-to-tray the app keeps running behind the icon.
      if (settings?.closeToTray && tray) return;
      app.quit();
    });

    app.on("before-quit", () => {
      quitting = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      stopHarnessTree(running);
      running = null;
    });
  }
}
