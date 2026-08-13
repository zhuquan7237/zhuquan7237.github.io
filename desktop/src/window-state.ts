import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { clampWindowBounds, type Rect } from "./util";

export interface WindowState {
  bounds: Rect;
  isMaximized: boolean;
}

export async function loadWindowState(userData: string, workArea: Rect): Promise<WindowState> {
  const fallback: WindowState = {
    bounds: { x: workArea.x + 40, y: workArea.y + 40, width: 1440, height: 920 },
    isMaximized: false,
  };
  try {
    const parsed = JSON.parse(await readFile(path.join(userData, "window-state.json"), "utf8")) as Partial<WindowState>;
    if (!parsed.bounds) return fallback;
    return {
      bounds: clampWindowBounds(parsed.bounds, workArea),
      isMaximized: Boolean(parsed.isMaximized),
    };
  } catch {
    return {
      bounds: clampWindowBounds(fallback.bounds, workArea),
      isMaximized: false,
    };
  }
}

export async function saveWindowState(userData: string, state: WindowState): Promise<void> {
  await mkdir(userData, { recursive: true });
  await writeFile(path.join(userData, "window-state.json"), JSON.stringify(state, null, 2), "utf8");
}
