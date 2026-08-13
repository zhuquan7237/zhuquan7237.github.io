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

/**
 * Linux VMs and unpacked tarballs fail in two common ways:
 * Chromium aborts without a SUID sandbox helper, and GPU compositing paints a black window.
 * Call this before app.whenReady().
 */
export function applyLinuxRuntimeFlags(): void {
  if (process.platform !== "linux") return;
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-dev-shm-usage");
  const helper = path.join(path.dirname(process.execPath), "chrome-sandbox");
  if (!chromeSandboxIsConfigured(readSandboxHelper(helper))) {
    app.commandLine.appendSwitch("no-sandbox");
    app.commandLine.appendSwitch("disable-gpu-sandbox");
  }
}
