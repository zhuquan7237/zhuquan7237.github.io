import { app } from "electron";
import { statSync } from "node:fs";
import path from "node:path";
import { chromeSandboxIsConfigured } from "./util";

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

/**
 * Chromium only honors --no-sandbox for zygote children when it is a real
 * process argv flag. app.commandLine.appendSwitch() is not enough, and
 * without it Linux tarballs die on /dev/shm (often mounted noexec).
 * Call this before app.whenReady(); it may exit and relaunch.
 */
export function applyLinuxRuntimeFlags(): boolean {
  if (process.platform !== "linux") return true;

  const extra: string[] = [];
  const helper = path.join(path.dirname(process.execPath), "chrome-sandbox");
  if (!chromeSandboxIsConfigured(readSandboxHelper(helper)) && !hasSwitch("no-sandbox")) {
    extra.push("--no-sandbox", "--disable-gpu-sandbox");
    process.env.ELECTRON_DISABLE_SANDBOX = "1";
  }
  if (!hasSwitch("disable-gpu")) extra.push("--disable-gpu");
  // /dev/shm is frequently noexec in VMs; Chromium needs an executable mapping.
  if (!hasSwitch("disable-dev-shm-usage")) extra.push("--disable-dev-shm-usage");

  if (extra.length > 0) {
    app.relaunch({ args: [...process.argv.slice(1), ...extra] });
    app.exit(0);
    return false;
  }

  app.disableHardwareAcceleration();
  return true;
}
