/**
 * Engine supervision policy.
 *
 * DSH Desktop ships a recovery window and a last-known-good profile; this shell
 * had nothing — an engine that exited (port clash, broken install, OOM) left a
 * dead window and no way back. The policy itself is pure so it can be tested:
 * restart a crashed engine a bounded number of times, then stop and hand the
 * user a recovery window instead of looping forever.
 */

export const CRASH_WINDOW_MS = 10 * 60_000;
export const MAX_AUTO_RESTARTS = 3;
export const MAX_RESTART_DELAY_MS = 15_000;

/** 1s, 2s, 4s … capped, so a slow port release still gets a chance to finish. */
export function restartDelayMs(attempt: number): number {
  const step = Math.max(1, Math.floor(attempt));
  return Math.min(MAX_RESTART_DELAY_MS, 1000 * 2 ** (step - 1));
}

/** Exit code 0 (or a clean signal exit) is an intentional shutdown, not a crash. */
export function isUnexpectedExit(code: number | null, signal: NodeJS.Signals | null): boolean {
  if (signal) return signal !== "SIGTERM" && signal !== "SIGINT";
  return code !== 0;
}

export function formatExitReason(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `signal ${signal}`;
  return `code ${code === null ? "unknown" : code}`;
}

/** Drops restarts older than the window so an old crash cannot block a new one. */
export function pruneCrashes(history: readonly number[], now: number, windowMs = CRASH_WINDOW_MS): number[] {
  return history.filter((at) => now - at < windowMs);
}

export function recordCrash(
  history: readonly number[],
  now: number,
  windowMs = CRASH_WINDOW_MS,
): number[] {
  return [...pruneCrashes(history, now, windowMs), now];
}

export function crashLoopDetected(
  history: readonly number[],
  now: number,
  maxRestarts = MAX_AUTO_RESTARTS,
  windowMs = CRASH_WINDOW_MS,
): boolean {
  return pruneCrashes(history, now, windowMs).length >= maxRestarts;
}

/** Seconds shown in the "restarting in Ns" log line. */
export function restartDelaySeconds(attempt: number): number {
  return Math.round(restartDelayMs(attempt) / 1000);
}
