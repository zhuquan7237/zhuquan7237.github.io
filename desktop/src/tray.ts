/**
 * Tray menu.
 *
 * DSH Desktop has a tray with window/terminal/profile/update/diagnostics
 * entries, and its release notes even include a fix for mixed-language tray
 * menus. This shell had a menu bar but no tray at all, so closing the window
 * ended the engine. The template is built from a translator plus a state
 * snapshot, which keeps it rebuildable whenever the language, engine state or
 * window visibility changes — the same reason DSH Desktop rebuilds its tray.
 */

import type { MenuItemConstructorOptions } from "electron";
import type { Translator } from "./i18n";

export interface TrayState {
  windowVisible: boolean;
  engineVersion: string;
  engineStarting: boolean;
  engineStopped: boolean;
  recoveryOpen: boolean;
  hasLocalUrl: boolean;
  skinsEnabled: boolean;
}

export interface TrayActions {
  showWindow: () => void;
  hideWindow: () => void;
  openInBrowser: () => void;
  copyUrl: () => void;
  openWorkspace: () => void;
  restartEngine: () => void;
  openSettings: () => void;
  checkEngineUpdate: () => void;
  checkDesktopUpdate: () => void;
  openLogs: () => void;
  exportDiagnostics: () => void;
  openRecovery: () => void;
  openSkinList: () => void;
  quit: () => void;
}

/** One line for the tooltip and the disabled status row. */
export function trayStateLabel(t: Translator, state: TrayState): string {
  if (state.recoveryOpen) return t("tray.stateRecovering");
  if (state.engineStopped) return t("tray.stateStopped");
  if (state.engineStarting || !state.engineVersion) return t("tray.stateStarting");
  return t("tray.stateRunning", { version: state.engineVersion });
}

export function trayTooltip(t: Translator, state: TrayState): string {
  return t("tray.tooltip", { state: trayStateLabel(t, state) });
}

export function trayMenuTemplate(
  t: Translator,
  state: TrayState,
  actions: TrayActions,
): MenuItemConstructorOptions[] {
  return [
    state.windowVisible
      ? { label: t("tray.hide"), click: actions.hideWindow }
      : { label: t("tray.show"), click: actions.showWindow },
    {
      label: t("tray.openBrowser"),
      enabled: Boolean(state.engineVersion) && !state.engineStopped,
      click: actions.openInBrowser,
    },
    {
      label: t("tray.copyUrl"),
      enabled: state.hasLocalUrl,
      click: actions.copyUrl,
    },
    { type: "separator" },
    { label: trayStateLabel(t, state), enabled: false },
    { label: t("menu.harness.restartEngine"), click: actions.restartEngine },
    { label: t("menu.harness.settings"), click: actions.openSettings },
    { label: t("menu.harness.checkEngine"), click: actions.checkEngineUpdate },
    { label: t("menu.harness.checkDesktop"), click: actions.checkDesktopUpdate },
    { type: "separator" },
    { label: t("tray.workspace"), click: actions.openWorkspace },
    { label: t("menu.harness.openLogs"), click: actions.openLogs },
    { label: t("menu.harness.exportDiagnostics"), click: actions.exportDiagnostics },
    { label: t("menu.harness.recovery"), click: actions.openRecovery },
    ...(state.skinsEnabled
      ? [{ type: "separator" as const }, { label: t("menu.skin.open"), click: actions.openSkinList }]
      : []),
    { type: "separator" },
    { label: t("menu.file.quit"), click: actions.quit },
  ];
}

/** Tray icons are painted at menu-bar size; a 256px app icon would look blurry. */
export function trayIconSize(platform: NodeJS.Platform): { width: number; height: number } {
  if (platform === "darwin") return { width: 18, height: 18 };
  return { width: 16, height: 16 };
}
