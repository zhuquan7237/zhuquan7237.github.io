import { app } from "electron";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { chromeSandboxIsConfigured, linuxRuntimeArgvExtras, linuxShmNeedsWorkaround } from "./util";

function readSandboxHelper(helperPath: string): { uid: number; mode: number } | null {
  try {
    const info = statSync(helperPath);
    return { uid: info.uid, mode: info.mode };
  } catch {
    return null;
  }
}

function hasSwitch(name: string): boolean {
  return app.commandLine.hasSwitch(name) || process.argv.includes(`--${name}`);
}

function shmIsNoexec(): boolean {
  try {
    return linuxShmNeedsWorkaround(readFileSync("/proc/mounts", "utf8"));
  } catch {
    return false;
  }
}

/**
 * Chromium only honors --no-sandbox for zygote children when it is a real
 * process argv flag. app.commandLine.appendSwitch() is not enough.
 * Call this before app.whenReady(); it may exit and relaunch.
 */
export function applyLinuxRuntimeFlags(): boolean {
  if (process.platform !== "linux") return true;

  const helper = path.join(path.dirname(process.execPath), "chrome-sandbox");
  const extra = linuxRuntimeArgvExtras({
    sandboxConfigured: chromeSandboxIsConfigured(readSandboxHelper(helper)),
    shmNoexec: shmIsNoexec(),
    hasSwitch,
  });
  if (extra.includes("--no-sandbox")) {
    process.env.ELECTRON_DISABLE_SANDBOX = "1";
  }

  if (extra.length > 0) {
    app.relaunch({ args: [...process.argv.slice(1), ...extra] });
    app.exit(0);
    return false;
  }

  return true;
}
