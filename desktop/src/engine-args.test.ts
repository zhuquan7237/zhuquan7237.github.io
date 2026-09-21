import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { harnessWebArgs, killTreeInvocation } from "./harness";
import { DEFAULT_SETTINGS, mergeNestedSettings, normalizeWebPort } from "./util";

describe("engine web arguments", () => {
  it("stays on loopback because the engine refuses to expose itself", () => {
    const args = harnessWebArgs("/opt/dsh/lib/bin.js", 0);
    expect(args).toEqual(["/opt/dsh/lib/bin.js", "web", "--no-open", "--host", "127.0.0.1", "--port", "0"]);
    expect(args).not.toContain("0.0.0.0");
  });

  it("passes a fixed port through and sanitizes anything the engine would reject", () => {
    expect(harnessWebArgs("bin", 43189).at(-1)).toBe("43189");
    expect(harnessWebArgs("bin", -1).at(-1)).toBe("0");
    expect(harnessWebArgs("bin", 70000).at(-1)).toBe("0");
  });
});

describe("normalizeWebPort", () => {
  it("keeps valid ports and falls back to an OS-chosen one", () => {
    expect(normalizeWebPort(0)).toBe(0);
    expect(normalizeWebPort(8080)).toBe(8080);
    expect(normalizeWebPort(65535)).toBe(65535);
    expect(normalizeWebPort("43189")).toBe(43189);
    expect(normalizeWebPort(65536)).toBe(0);
    expect(normalizeWebPort("abc")).toBe(0);
    expect(normalizeWebPort(undefined)).toBe(0);
    expect(normalizeWebPort(8080.7)).toBe(8080);
  });
});

describe("process tree kill", () => {
  it("walks the tree on Windows and leaves POSIX on SIGTERM", () => {
    expect(killTreeInvocation(1234, "win32")).toEqual({
      command: "taskkill",
      args: ["/pid", "1234", "/t", "/f"],
    });
    expect(killTreeInvocation(1234, "linux")).toBeNull();
    expect(killTreeInvocation(1234, "darwin")).toBeNull();
    expect(killTreeInvocation(undefined, "win32")).toBeNull();
    expect(killTreeInvocation(0, "win32")).toBeNull();
  });
});

describe("desktop settings", () => {
  it("ships the tray, port and language defaults", () => {
    expect(DEFAULT_SETTINGS.closeToTray).toBe(true);
    expect(DEFAULT_SETTINGS.webPort).toBe(0);
    expect(DEFAULT_SETTINGS.locale).toBe("");
  });

  it("keeps old settings files working", () => {
    const merged = mergeNestedSettings({ channel: "next" });
    expect(merged.channel).toBe("next");
    expect(merged.webPort).toBeUndefined();
  });
});

describe("recovery page asset", () => {
  it("exists, is packaged, and talks to the preload bridge", () => {
    const root = path.join(__dirname, "..");
    const page = readFileSync(path.join(root, "resources", "recovery.html"), "utf8");
    expect(page).toContain("getRecoveryInfo");
    expect(page).toContain("recoveryAction");
    for (const action of ["restart", "rollback", "reinstall", "logs", "diagnostics", "quit"]) {
      expect(page).toContain(`id="${action}"`);
    }
    const builder = readFileSync(path.join(root, "electron-builder.yml"), "utf8");
    expect(builder).toContain("resources/**/*");
  });

  it("keeps the splash page bilingual", () => {
    const splash = readFileSync(path.join(__dirname, "..", "resources", "splash.html"), "utf8");
    expect(splash).toContain('"zh-CN"');
    expect(splash).toContain("heroHint");
    expect(splash).toContain("--log-placeholder");
  });
});
