import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDiagnosticsBundle,
  buildDiagnosticsEntries,
  diagnosticsFileName,
  pickDiagnosticsDir,
  redactSecrets,
  systemInfoText,
  writeDiagnosticsBundle,
  type DiagnosticsInput,
} from "./diagnostics";

function tempUserData(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-diag-"));
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  return dir;
}

function input(userData: string, overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    appName: "DeepSeek Harness",
    appVersion: "0.3.0",
    electron: "37.2.6",
    chrome: "128.0.0.0",
    node: "22.23.2",
    v8: "12.8",
    platform: "win32",
    arch: "x64",
    osRelease: "10.0.26100",
    hostLocale: "zh-CN",
    shellLocale: "zh-CN",
    timeZone: "Asia/Shanghai",
    packaged: true,
    userData,
    dshHome: path.join(userData, "dsh-home"),
    workspaceDir: "C:\\Users\\me\\DeepSeek",
    logsPath: path.join(userData, "logs"),
    engineVersion: "0.1.5-rc.2",
    enginePrefix: path.join(userData, "harness", "0.1.5-rc.2"),
    installedEngines: ["0.1.2-rc.1", "0.1.5-rc.2"],
    channel: "latest",
    registry: "https://registry.npmmirror.com",
    webPort: 0,
    localUrl: "http://127.0.0.1:53111/",
    trayAvailable: true,
    autoRestarts: 1,
    lastExitReason: "code 1",
    settingsJson: JSON.stringify(
      { registry: "https://registry.npmmirror.com", visionAux: { apiKey: "sk-live-1234567890", model: "minimax-m3" } },
      null,
      2,
    ),
    exportedBy: "desktop menu or tray",
    ...overrides,
  };
}

describe("redactSecrets", () => {
  it("blanks JSON credentials but keeps the shape readable", () => {
    const redacted = redactSecrets('{"apiKey":"sk-abcdefghijklmnop","model":"minimax-m3"}');
    expect(redacted).not.toContain("sk-abcdefghijklmnop");
    expect(redacted).toContain('"apiKey":"[redacted]"');
    expect(redacted).toContain("minimax-m3");
  });

  it("blanks env assignments, known prefixes and Authorization headers", () => {
    const redacted = redactSecrets(
      [
        "DSH_VISION_AUX_API_KEY=sk-abcdefghijklmnop",
        "OPENCODE_GO_API_KEY: tvly-abcdefgh",
        "Authorization: Bearer abcdefghijklmnop",
        "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      ].join("\n"),
    );
    expect(redacted).not.toMatch(/sk-abcdefghijklmnop|tvly-abcdefgh|Bearer abcdefghijklmnop|ghp_/);
    expect(redacted).toContain("DSH_VISION_AUX_API_KEY=[redacted]");
    expect(redacted).toContain("Bearer [redacted]");
  });

  it("leaves ordinary log lines alone", () => {
    const line = "[2026-09-21 10:46:12] 引擎 0.1.5-rc.2 已就绪";
    expect(redactSecrets(line)).toBe(line);
  });
});

describe("system info", () => {
  it("names the versions, the engine state and the paths", () => {
    const text = systemInfoText(input(tempUserData()), new Date(Date.UTC(2026, 8, 21, 2, 46, 12)));
    expect(text).toContain("desktop: 0.3.0");
    expect(text).toContain("engine: dsh 0.1.5-rc.2");
    expect(text).toContain("installed engines: 0.1.2-rc.1, 0.1.5-rc.2");
    expect(text).toContain("web port: random");
    expect(text).toContain("tray: yes");
    expect(text).toContain("2026-09-21T02:46:12.000Z");
  });
});

describe("bundle", () => {
  it("always has the same entries, with the settings redacted inside the zip", () => {
    const userData = tempUserData();
    writeFileSync(path.join(userData, "logs", "app.log"), "boot\nDSH_TAVILY_API_KEY=tvly-secretvalue\n", "utf8");
    writeFileSync(path.join(userData, "logs", "engine.log"), "dsh web: http://127.0.0.1:53111/\n", "utf8");

    const entries = buildDiagnosticsEntries(input(userData));
    expect(entries.map((entry) => entry.name)).toEqual([
      "diagnostics-readme.txt",
      "system-info.txt",
      "desktop-settings.json",
      "logs/app.log",
      "logs/engine.log",
      "running.json",
    ]);
    const settings = String(entries[2].data);
    expect(settings).toContain("[redacted]");
    expect(settings).not.toContain("sk-live-1234567890");
    const appLog = String(entries[3].data);
    expect(appLog).toContain("boot");
    expect(appLog).not.toContain("tvly-secretvalue");
    const running = JSON.parse(String(entries[5].data)) as Record<string, unknown>;
    expect(running.engineVersion).toBe("0.1.5-rc.2");
    expect(running.trayAvailable).toBe(true);
  });

  it("writes a zip whose name carries the version and the timestamp", () => {
    const userData = tempUserData();
    const now = new Date(2026, 8, 21, 10, 46, 12);
    expect(diagnosticsFileName("0.3.0", now)).toBe("diagnostics-20260921-104612-0.3.0.zip");
    const bundle = writeDiagnosticsBundle(input(userData), userData, now);
    expect(path.basename(bundle.path)).toBe("diagnostics-20260921-104612-0.3.0.zip");
    expect(bundle.path.startsWith(userData)).toBe(true);
    const written = buildDiagnosticsBundle(input(userData), now);
    expect(written.data.subarray(0, 2).toString("utf8")).toBe("PK");
  });

  it("prefers an existing output directory and never crashes on an empty list", () => {
    const userData = tempUserData();
    expect(pickDiagnosticsDir(["", path.join(userData, "absent"), userData])).toBe(userData);
    expect(pickDiagnosticsDir(["", ""])).toBe(".");
  });
});
