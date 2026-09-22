import { contextBridge, ipcRenderer } from "electron";
import type { SkinCard } from "./skins";
import type { DesktopSettings } from "./util";
import type { RecoveryActionId, RecoveryInfo } from "./recovery";
import type { CatalogSource, MarketEntry, MarketPage } from "./market/catalog";
import type { InstallOutcome, ProfileInventory } from "./market/service";

contextBridge.exposeInMainWorld("desktop", {
  onStatus: (handler: (payload: { phase: string; text: string }) => void) => {
    ipcRenderer.on("status", (_event, payload) => handler(payload));
  },
  onLog: (handler: (line: string) => void) => {
    ipcRenderer.on("log", (_event, line) => handler(String(line)));
  },
  getVersion: (): Promise<string> => ipcRenderer.invoke("app:version"),
  getSettings: (): Promise<DesktopSettings> => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings: DesktopSettings): Promise<DesktopSettings> => ipcRenderer.invoke("settings:save", settings),
  pickDir: (): Promise<string> => ipcRenderer.invoke("settings:pick-dir"),
  apply: () => ipcRenderer.send("settings:apply"),
  quit: () => ipcRenderer.send("splash:quit"),
  retry: () => ipcRenderer.send("splash:retry"),
  listSkins: (): Promise<SkinCard[]> => ipcRenderer.invoke("skins:list"),
  selectSkin: (id: string): Promise<void> => ipcRenderer.invoke("skins:select", id),
  setSkinsEnabled: (enabled: boolean): Promise<void> => ipcRenderer.invoke("skins:set-enabled", enabled),
  importSkinDir: (): Promise<void> => ipcRenderer.invoke("skins:import-dir"),
  importSkinUrl: (url: string): Promise<void> => ipcRenderer.invoke("skins:import-url", url),
  mobilePairing: (options?: { ensure?: boolean }): Promise<import("./mobile-pairing").PairingSnapshot> =>
    ipcRenderer.invoke("mobile:pairing", options),
  mobileRotate: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("mobile:rotate"),
  mobileCopy: (text: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("mobile:copy", text),
  mobileRevoke: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("mobile:revoke", id),
  mobileOpenSearchSettings: (): Promise<{ ok: boolean; error?: string; url?: string }> =>
    ipcRenderer.invoke("mobile:open-search-settings"),
  mobileOpenPairingSettings: (): Promise<{ ok: boolean; error?: string; url?: string }> =>
    ipcRenderer.invoke("mobile:open-pairing-settings"),
  desktopAction: (action: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("desktop:action", action),
  syncModels: (): Promise<any> => ipcRenderer.invoke("models:sync"),
  getProviders: (): Promise<any> => ipcRenderer.invoke("models:get-providers"),
  /** Diagnostics bundle, also reachable as `DeepSeek --export-diagnostics`. */
  exportDiagnostics: (): Promise<string | null> => ipcRenderer.invoke("diagnostics:export"),
  getRecoveryInfo: (): Promise<RecoveryInfo> => ipcRenderer.invoke("recovery:info"),
  recoveryAction: (action: RecoveryActionId): Promise<void> => ipcRenderer.invoke("recovery:action", action),
  marketSources: (): Promise<CatalogSource[]> => ipcRenderer.invoke("market:sources"),
  marketSaveSources: (sources: CatalogSource[]): Promise<CatalogSource[]> =>
    ipcRenderer.invoke("market:save-sources", sources),
  marketBrowse: (input: { sourceId: string; query?: string; category?: string }): Promise<MarketPage> =>
    ipcRenderer.invoke("market:browse", input),
  marketDetail: (input: { sourceId: string; id: string }): Promise<MarketEntry | null> =>
    ipcRenderer.invoke("market:detail", input),
  marketCheck: (input: { sourceId: string; id: string }): Promise<{ ok: boolean; spec?: string; reason?: string }> =>
    ipcRenderer.invoke("market:check", input),
  marketInventory: (): Promise<ProfileInventory> => ipcRenderer.invoke("market:inventory"),
  marketInstall: (input: { sourceId: string; id: string }): Promise<InstallOutcome> =>
    ipcRenderer.invoke("market:install", input),
  marketUninstall: (packageName: string): Promise<InstallOutcome> => ipcRenderer.invoke("market:uninstall", packageName),
  marketToggle: (input: { packageName: string; disabled: boolean }): Promise<InstallOutcome> =>
    ipcRenderer.invoke("market:toggle", input),
  marketOpenExternal: (url: string): Promise<void> => ipcRenderer.invoke("market:open-external", url),
  marketRestart: (): Promise<void> => ipcRenderer.invoke("market:restart"),
  /** UI state goes into the shell log, so a support bundle shows what rendered. */
  marketUiLog: (info: { tab?: string; cards?: number; sample?: string }): Promise<void> =>
    ipcRenderer.invoke("market:ui-log", info),
  onMarketProgress: (handler: (chunk: string) => void) => {
    ipcRenderer.on("market:progress", (_event, chunk) => handler(String(chunk)));
  },
});
