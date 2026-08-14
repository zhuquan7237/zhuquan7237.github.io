import { BrowserWindow, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AppDialogButton, AppDialogKind, AppDialogView } from "./util";

export interface AppDialogRequest {
  kind: AppDialogKind;
  title: string;
  message: string;
  detail?: string;
  currentVersion?: string;
  latestVersion?: string;
  source?: string;
  extra?: string;
  buttons: AppDialogButton[];
  defaultId?: string;
  cancelId?: string;
  width?: number;
  height?: number;
}

let ipcBound = false;
const waiters = new Map<string, (buttonId: string) => void>();

function bindIpc(): void {
  if (ipcBound) return;
  ipcBound = true;
  ipcMain.on("dialog:result", (_event, payload: { requestId?: string; buttonId?: string }) => {
    const requestId = payload?.requestId;
    if (!requestId) return;
    const resolve = waiters.get(requestId);
    if (!resolve) return;
    waiters.delete(requestId);
    resolve(payload.buttonId || "cancel");
  });
}

function dialogSize(kind: AppDialogKind, request: AppDialogRequest): { width: number; height: number } {
  if (request.width && request.height) return { width: request.width, height: request.height };
  if (kind === "update") return { width: 500, height: 430 };
  if (kind === "about") return { width: 460, height: 360 };
  if (kind === "error") return { width: 460, height: 340 };
  return { width: 440, height: 300 };
}

export function showAppDialog(
  request: AppDialogRequest,
  options: { parent?: BrowserWindow | null; icon: string },
): Promise<string> {
  bindIpc();
  const requestId = randomUUID();
  const size = dialogSize(request.kind, request);
  const parent = options.parent && !options.parent.isDestroyed() ? options.parent : undefined;

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: size.width,
      height: size.height,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      parent,
      modal: Boolean(parent),
      backgroundColor: "#00000000",
      hasShadow: false,
      icon: options.icon,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    const finish = (buttonId: string) => {
      waiters.delete(requestId);
      if (!win.isDestroyed()) win.close();
      resolve(buttonId);
    };

    waiters.set(requestId, finish);
    win.on("closed", () => {
      if (waiters.has(requestId)) {
        waiters.delete(requestId);
        resolve(request.cancelId || "cancel");
      }
    });

    const view: AppDialogView = {
      requestId,
      kind: request.kind,
      title: request.title,
      message: request.message,
      detail: request.detail,
      currentVersion: request.currentVersion,
      latestVersion: request.latestVersion,
      source: request.source,
      extra: request.extra,
      buttons: request.buttons,
      defaultId: request.defaultId,
      cancelId: request.cancelId,
    };

    void win.loadFile(path.join(__dirname, "..", "resources", "dialog.html")).then(() => {
      if (win.isDestroyed()) return;
      win.webContents.send("dialog:open", view);
      win.show();
      win.focus();
    });
  });
}
