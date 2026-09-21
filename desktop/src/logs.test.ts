import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileLogger, collectLogText, formatLogLine, logsDir, readLogTail, timestampLocal } from "./logs";

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "dsh-logs-"));
}

describe("log formatting", () => {
  it("stamps lines in local time, zero padded and sortable", () => {
    const date = new Date(2026, 8, 21, 9, 5, 7);
    expect(timestampLocal(date)).toBe("2026-09-21 09:05:07");
    expect(formatLogLine("boot", date)).toBe("[2026-09-21 09:05:07] boot\n");
  });
});

describe("FileLogger", () => {
  it("appends to logs/<name> under the user data directory", () => {
    const userData = tempDir();
    const logger = new FileLogger(userData, "app.log");
    logger.append("first");
    logger.append("second");
    expect(logger.file).toBe(path.join(logsDir(userData), "app.log"));
    const content = readFileSync(logger.file, "utf8");
    expect(content).toContain("first");
    expect(content.trim().split("\n")).toHaveLength(2);
  });

  it("keeps the folder bounded by rotating into exactly one older file", () => {
    const userData = tempDir();
    const logger = new FileLogger(userData, "app.log", 400);
    for (let i = 0; i < 30; i += 1) logger.append(`line-${i}`);
    const current = readFileSync(logger.file, "utf8");
    const previous = readFileSync(`${logger.file}.1`, "utf8");
    expect(previous.trim().length).toBeGreaterThan(0);
    expect(current).toContain("line-29");
    expect(current).not.toContain("line-0");
    expect(readLogTail(logger.file, 2).split("\n")).toHaveLength(2);
  });

  it("threads the rotated copy into the collected text", () => {
    const userData = tempDir();
    const logger = new FileLogger(userData, "engine.log", 400);
    for (let i = 0; i < 30; i += 1) logger.append(`engine-${i}`);
    const text = collectLogText({ userData, name: "engine.log" });
    const currentOnly = readLogTail(logger.file, 400);
    expect(text).toContain("engine-29");
    // The older file contributes, which is the whole point of keeping it.
    expect(text.length).toBeGreaterThan(currentOnly.length);
    expect(text.indexOf("engine-29")).toBeGreaterThan(text.indexOf("engine-13"));
  });

  it("returns nothing for a log that was never written", () => {
    expect(collectLogText({ userData: tempDir(), name: "missing.log" })).toBe("");
    expect(readLogTail(path.join(tempDir(), "nope.log"))).toBe("");
  });
});
