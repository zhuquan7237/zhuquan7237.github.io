import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTranslator } from "./i18n";
import { buildRecoveryInfo, describeRecoveryReason, pickRollbackTarget, recoveryPagePath } from "./recovery";

const zh = createTranslator("zh-CN");
const en = createTranslator("en");

describe("recovery reason", () => {
  it("explains a crash loop, a start failure and a manual visit", () => {
    expect(describeRecoveryReason(zh, { kind: "crash-loop", count: 3 })).toContain("连续 3 次");
    expect(describeRecoveryReason(zh, { kind: "start-failed", message: "端口被占用" })).toContain("端口被占用");
    expect(describeRecoveryReason(en, { kind: "manual" })).toContain("menu");
  });
});

describe("rollback target", () => {
  it("picks the newest installed engine that is not the failing one", () => {
    expect(pickRollbackTarget(["0.1.2-rc.1", "0.1.5-rc.1", "0.1.5-rc.2"], "0.1.5-rc.2")).toBe("0.1.5-rc.1");
    expect(pickRollbackTarget(["0.1.2-rc.1"], "0.1.5-rc.2")).toBe("0.1.2-rc.1");
  });

  it("degrades to no rollback when there is only one version", () => {
    expect(pickRollbackTarget(["0.1.5-rc.2"], "0.1.5-rc.2")).toBe("");
    expect(pickRollbackTarget([], "")).toBe("");
    expect(pickRollbackTarget(["", ""], "")).toBe("");
  });
});

describe("recovery info", () => {
  const base = {
    locale: "en",
    reason: { kind: "crash-loop", count: 3 } as const,
    translator: en,
    currentVersion: "0.1.5-rc.2",
    installedVersions: ["0.1.2-rc.1", "0.1.5-rc.2"],
    workspaceDir: "C:/work",
    logsPath: "C:/logs",
  };

  it("fills every label the page renders, including the rollback button", () => {
    const info = buildRecoveryInfo(base);
    expect(info.canRollback).toBe(true);
    expect(info.rollbackTarget).toBe("0.1.2-rc.1");
    expect(info.labels.rollback).toBe("Roll Back to Engine 0.1.2-rc.1");
    expect(info.labels.reinstall).toBe("Reinstall 0.1.5-rc.2");
    expect(info.installed).toContain("0.1.2-rc.1, 0.1.5-rc.2");
    expect(info.reason).toContain("3 times");
  });

  it("disables rollback instead of offering a button that cannot work", () => {
    const info = buildRecoveryInfo({ ...base, installedVersions: ["0.1.5-rc.2"] });
    expect(info.canRollback).toBe(false);
    expect(info.rollbackTarget).toBe("");
    expect(info.labels.rollback).toBe(info.labels.rollbackNone);
  });

  it("says so when nothing is installed at all", () => {
    const info = buildRecoveryInfo({ ...base, installedVersions: [] });
    expect(info.installed).toBe(en("recovery.installedNone"));
  });

  it("points the window at the bundled page", () => {
    expect(recoveryPagePath(path.join("C:", "app"))).toBe(path.join("C:", "app", "resources", "recovery.html"));
  });
});
