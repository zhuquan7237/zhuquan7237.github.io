import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SETTINGS, type DesktopSettings } from "./util";

export async function loadSettings(userData: string): Promise<DesktopSettings> {
  const file = path.join(userData, "desktop-settings.json");
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<DesktopSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(userData: string, settings: DesktopSettings): Promise<void> {
  await mkdir(userData, { recursive: true });
  await writeFile(path.join(userData, "desktop-settings.json"), JSON.stringify(settings, null, 2), "utf8");
}
