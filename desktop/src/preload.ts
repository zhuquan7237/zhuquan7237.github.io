import { contextBridge, ipcRenderer } from "electron";
import type { AppDialogView, DesktopSettings } from "./util";

contextBridge.exposeInMainWorld("desktop", {
  onStatus: (handler: (payload: { phase: string; text: string }) => void) => {
    ipcRenderer.on("status", (_event, payload) => handler(payload));
  },
  onLog: (handler: (line: string) => void) => {
    ipcRenderer.on("log", (_event, line) => handler(String(line)));
  },
  onDialogOpen: (handler: (payload: AppDialogView) => void) => {
    ipcRenderer.on("dialog:open", (_event, payload) => handler(payload));
  },
  respondDialog: (requestId: string, buttonId: string) => {
    ipcRenderer.send("dialog:result", { requestId, buttonId });
  },
  getSettings: (): Promise<DesktopSettings> => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings: DesktopSettings): Promise<DesktopSettings> => ipcRenderer.invoke("settings:save", settings),
  pickDir: (): Promise<string> => ipcRenderer.invoke("settings:pick-dir"),
  apply: () => ipcRenderer.send("settings:apply"),
  quit: () => ipcRenderer.send("splash:quit"),
});
