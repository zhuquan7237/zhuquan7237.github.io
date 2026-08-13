import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_SETTINGS,
  applyRegistryPreference,
  hostTimeZone,
  preferredNpmRegistry,
  type DesktopSettings,
} from "./util";

export async function loadSettings(userData: string, systemLocale = ""): Promise<DesktopSettings> {
  const preferred = preferredNpmRegistry(process.env, process.env.TZ || hostTimeZone(), systemLocale);
  const file = path.join(userData, "desktop-settings.json");
  let saved: Partial<DesktopSettings> = {};
  try {
    saved = JSON.parse(await readFile(file, "utf8")) as Partial<DesktopSettings>;
  } catch {
    saved = {};
  }
  return { ...DEFAULT_SETTINGS, ...saved, ...applyRegistryPreference(saved, preferred) };
}

export async function saveSettings(userData: string, settings: DesktopSettings): Promise<void> {
  await mkdir(userData, { recursive: true });
  await writeFile(path.join(userData, "desktop-settings.json"), JSON.stringify(settings, null, 2), "utf8");
}
