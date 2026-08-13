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
 * Linux tarballs rarely ship a SUID chrome-sandbox, which makes Chromium abort.
 * Call this before app.whenReady(). Do not force disable-dev-shm-usage: that
 * moves shared memory into /tmp and can make the renderer fail with ERR_FAILED.
 */
export function applyLinuxRuntimeFlags(): void {
  if (process.platform !== "linux") return;
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  const helper = path.join(path.dirname(process.execPath), "chrome-sandbox");
  if (!chromeSandboxIsConfigured(readSandboxHelper(helper))) {
    app.commandLine.appendSwitch("no-sandbox");
    app.commandLine.appendSwitch("disable-gpu-sandbox");
  }
}
