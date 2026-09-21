import { describe, expect, it } from "vitest";
import {
  CRASH_WINDOW_MS,
  MAX_AUTO_RESTARTS,
  MAX_RESTART_DELAY_MS,
  crashLoopDetected,
  formatExitReason,
  isUnexpectedExit,
  pruneCrashes,
  recordCrash,
  restartDelayMs,
  restartDelaySeconds,
} from "./supervisor";

describe("exit classification", () => {
  it("treats code 0 and a clean signal as intentional shutdowns", () => {
    expect(isUnexpectedExit(0, null)).toBe(false);
    expect(isUnexpectedExit(0, "SIGTERM")).toBe(false);
    expect(isUnexpectedExit(null, "SIGINT")).toBe(false);
    expect(isUnexpectedExit(1, null)).toBe(true);
    expect(isUnexpectedExit(null, "SIGKILL")).toBe(true);
  });

  it("describes the reason the way the log and the recovery window need", () => {
    expect(formatExitReason(1, null)).toBe("code 1");
    expect(formatExitReason(null, "SIGKILL")).toBe("signal SIGKILL");
    expect(formatExitReason(null, null)).toBe("code unknown");
  });
});

describe("restart policy", () => {
  it("backs off exponentially and stops at the cap", () => {
    expect(restartDelayMs(1)).toBe(1000);
    expect(restartDelayMs(2)).toBe(2000);
    expect(restartDelayMs(3)).toBe(4000);
    expect(restartDelayMs(9)).toBe(MAX_RESTART_DELAY_MS);
    expect(restartDelaySeconds(2)).toBe(2);
  });

  it("forgets crashes that fell out of the window, so a new crash still restarts", () => {
    const start = 1_000_000;
    const history = [start, start + 60_000, start + 120_000];
    const later = start + CRASH_WINDOW_MS * 2;
    expect(pruneCrashes(history, later)).toEqual([]);
    expect(crashLoopDetected(history, later)).toBe(false);
    expect(recordCrash(history, later)).toEqual([later]);
  });

  it("stops auto-restarting once the crash budget inside the window is spent", () => {
    const now = 5_000_000;
    const history = [now - 3000, now - 2000, now - 1000];
    expect(history).toHaveLength(MAX_AUTO_RESTARTS);
    expect(crashLoopDetected(history, now)).toBe(true);
    expect(crashLoopDetected(history.slice(0, 2), now)).toBe(false);
  });

  it("keeps the newest crash when the history is trimmed", () => {
    const now = 9_000_000;
    expect(recordCrash([now - 500], now).at(-1)).toBe(now);
  });
});
