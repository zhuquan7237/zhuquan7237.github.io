import { describe, expect, it, vi } from "vitest";
import { createTranslator } from "./i18n";
import { trayIconSize, trayMenuTemplate, trayStateLabel, trayTooltip, type TrayActions, type TrayState } from "./tray";

const noop = () => undefined;

function actions(overrides: Partial<TrayActions> = {}): TrayActions {
  return {
    showWindow: noop,
    hideWindow: noop,
    openInBrowser: noop,
    copyUrl: noop,
    openWorkspace: noop,
    restartEngine: noop,
    openSettings: noop,
    checkEngineUpdate: noop,
    checkDesktopUpdate: noop,
    openLogs: noop,
    exportDiagnostics: noop,
    openRecovery: noop,
    openSkinList: noop,
    quit: noop,
    ...overrides,
  };
}

function state(overrides: Partial<TrayState> = {}): TrayState {
  return {
    windowVisible: true,
    engineVersion: "0.1.5-rc.2",
    engineStarting: false,
    engineStopped: false,
    recoveryOpen: false,
    hasLocalUrl: true,
    skinsEnabled: true,
    ...overrides,
  };
}

const en = createTranslator("en");
const zh = createTranslator("zh-CN");

describe("tray state label", () => {
  it("reports the engine state the tooltip and status row show", () => {
    expect(trayStateLabel(en, state())).toBe("Engine running (dsh 0.1.5-rc.2)");
    expect(trayStateLabel(en, state({ engineStarting: true }))).toBe("Engine starting…");
    expect(trayStateLabel(en, state({ engineStopped: true, engineVersion: "" }))).toBe("Engine stopped");
    expect(trayStateLabel(en, state({ recoveryOpen: true }))).toBe("Engine failed, waiting for recovery");
    expect(trayStateLabel(zh, state())).toContain("引擎运行中");
    expect(trayTooltip(en, state())).toContain("Engine running");
  });
});

describe("tray menu", () => {
  it("offers show or hide depending on the window", () => {
    const visible = trayMenuTemplate(en, state(), actions());
    const hidden = trayMenuTemplate(en, state({ windowVisible: false }), actions());
    expect(visible[0].label).toBe("Hide Main Window");
    expect(hidden[0].label).toBe("Show Main Window");
  });

  it("wires the entries this shell added on top of the upstream menu", () => {
    const restart = vi.fn();
    const diagnostics = vi.fn();
    const recovery = vi.fn();
    const logs = vi.fn();
    const template = trayMenuTemplate(
      en,
      state(),
      actions({ restartEngine: restart, exportDiagnostics: diagnostics, openRecovery: recovery, openLogs: logs }),
    );
    const labels = template.map((item) => item.label).filter(Boolean);
    expect(labels).toContain("Restart Engine");
    expect(labels).toContain("Export Diagnostics…");
    expect(labels).toContain("Recovery Mode…");
    expect(labels).toContain("Open Logs Folder");
    expect(labels).toContain("Quit");

    const click = (label: string) => {
      const item = template.find((entry) => entry.label === label);
      (item?.click as (() => void) | undefined)?.();
    };
    click("Restart Engine");
    click("Export Diagnostics…");
    click("Recovery Mode…");
    expect(restart).toHaveBeenCalledTimes(1);
    expect(diagnostics).toHaveBeenCalledTimes(1);
    expect(recovery).toHaveBeenCalledTimes(1);
  });

  it("disables actions that need a running engine", () => {
    const template = trayMenuTemplate(en, state({ engineStopped: true, engineVersion: "", hasLocalUrl: false }), actions());
    const browser = template.find((item) => item.label === "Open UI in Browser");
    const copy = template.find((item) => item.label === "Copy Local URL");
    const status = template.find((item) => item.label === "Engine stopped");
    expect(browser?.enabled).toBe(false);
    expect(copy?.enabled).toBe(false);
    expect(status?.enabled).toBe(false);
  });

  it("hides the skin entry when the skin center is off", () => {
    const labels = trayMenuTemplate(en, state({ skinsEnabled: false }), actions()).map((item) => item.label);
    expect(labels).not.toContain("Open Skin List");
  });

  it("uses menu-bar sized icons on every platform", () => {
    expect(trayIconSize("win32")).toEqual({ width: 16, height: 16 });
    expect(trayIconSize("linux")).toEqual({ width: 16, height: 16 });
    expect(trayIconSize("darwin")).toEqual({ width: 18, height: 18 });
  });
});
