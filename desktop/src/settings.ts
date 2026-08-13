import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SETTINGS, hostTimeZone, preferredNpmRegistry, type DesktopSettings } from "./util";

export async function loadSettings(userData: string): Promise<DesktopSettings> {
  const defaults: DesktopSettings = {
    ...DEFAULT_SETTINGS,
    registry: preferredNpmRegistry(process.env, process.env.TZ || hostTimeZone()),
  };
  const file = path.join(userData, "desktop-settings.json");
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<DesktopSettings>;
    return { ...defaults, ...parsed };
  } catch {
    return { ...defaults };
  }
}

export async function saveSettings(userData: string, settings: DesktopSettings): Promise<void> {
  await mkdir(userData, { recursive: true });
  await writeFile(path.join(userData, "desktop-settings.json"), JSON.stringify(settings, null, 2), "utf8");
}
