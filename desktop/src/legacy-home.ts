import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const CURRENT_USERDATA_NAME = "DeepSeek";
export const DSH_HOME_DIRNAME = "dsh-home";
export const CREDENTIAL_FILE = ".credentials.yaml";
export const SETTINGS_FILE = "settings.yaml";
export const DESKTOP_SETTINGS_FILE = "desktop-settings.json";

/** Older desktop builds used Electron's translated or package name as the folder. */
export const LEGACY_USERDATA_NAMES = [
  "深度求索",
  "DeepSeek Harness",
  "deepseek-desktop",
  "deepseek-harness",
  "DeepSeek-Harness",
];

export const SKIP_DSH_HOME_NAMES = new Set([
  "cordis.patch.yml",
  "cordis.patch.yaml",
  "cordis.yml",
  "cordis.yaml",
  "profiles",
]);

export interface LegacyMigrateOptions {
  currentUserData: string;
  appData: string;
  homeDir: string;
}

export interface LegacyMigrateResult {
  fromUserData: string;
  fromDshHome: string;
  copied: string[];
}

export function officialDshHome(homeDir: string): string {
  return path.join(homeDir, ".dsh");
}

export function candidateLegacyUserDataDirs(appData: string): string[] {
  return LEGACY_USERDATA_NAMES.map((name) => path.join(appData, name));
}

export function samePath(left: string, right: string): boolean {
  const a = path.normalize(path.resolve(left));
  const b = path.normalize(path.resolve(right));
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function yamlHasPayload(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    return true;
  }
  return false;
}

export async function fileHasPayload(file: string): Promise<boolean> {
  try {
    return yamlHasPayload(await readFile(file, "utf8"));
  } catch {
    return false;
  }
}

export async function dshHomeHasCredentials(dshHome: string): Promise<boolean> {
  return (
    (await fileHasPayload(path.join(dshHome, CREDENTIAL_FILE))) ||
    (await fileHasPayload(path.join(dshHome, ".credentials.yml")))
  );
}

export function candidateLegacyDshHomes(
  appData: string,
  homeDir: string,
  currentUserData: string,
): string[] {
  const currentHome = path.join(currentUserData, DSH_HOME_DIRNAME);
  const homes = [
    ...candidateLegacyUserDataDirs(appData).map((dir) => path.join(dir, DSH_HOME_DIRNAME)),
    officialDshHome(homeDir),
  ];
  const unique: string[] = [];
  for (const home of homes) {
    if (samePath(home, currentHome)) continue;
    if (unique.some((seen) => samePath(seen, home))) continue;
    unique.push(home);
  }
  return unique;
}

export async function pickLegacyDshHome(currentDshHome: string, candidates: string[]): Promise<string | null> {
  if (await dshHomeHasCredentials(currentDshHome)) return null;
  for (const home of candidates) {
    if (samePath(home, currentDshHome)) continue;
    if (await dshHomeHasCredentials(home)) return home;
  }
  return null;
}

export function isBlankSetting(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

export function mergeBlankDesktopSettings(
  current: Record<string, unknown>,
  legacy: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...current };
  for (const [key, value] of Object.entries(legacy)) {
    if (isBlankSetting(next[key]) && !isBlankSetting(value)) next[key] = value;
  }
  return next;
}

export async function dirHasEntries(dir: string): Promise<boolean> {
  try {
    const names = await readdir(dir);
    return names.length > 0;
  } catch {
    return false;
  }
}

export async function copyMissingFile(from: string, to: string): Promise<boolean> {
  if (!(await fileExists(from))) return false;
  if (await fileHasPayload(to)) return false;
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to);
  return true;
}

export async function copyMissingDirIfEmpty(from: string, to: string): Promise<boolean> {
  if (!(await dirHasEntries(from))) return false;
  if (await dirHasEntries(to)) return false;
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
  return true;
}

export async function migrateDshHome(from: string, to: string): Promise<string[]> {
  const copied: string[] = [];
  for (const name of [CREDENTIAL_FILE, ".credentials.yml"]) {
    if (await copyMissingFile(path.join(from, name), path.join(to, name))) copied.push(name);
  }
  for (const name of [SETTINGS_FILE, "settings.yml"]) {
    if (await copyMissingFile(path.join(from, name), path.join(to, name))) copied.push(name);
  }
  if (await copyMissingDirIfEmpty(path.join(from, "storages"), path.join(to, "storages"))) {
    copied.push("storages");
  }
  if (await copyMissingDirIfEmpty(path.join(from, "sessions"), path.join(to, "sessions"))) {
    copied.push("sessions");
  }
  return copied;
}

export function userDataOwningHome(dshHome: string, userDataDirs: string[]): string {
  for (const dir of userDataDirs) {
    if (samePath(path.join(dir, DSH_HOME_DIRNAME), dshHome)) return dir;
  }
  return "";
}

export async function firstUserDataWithChild(dirs: string[], child: string): Promise<string> {
  for (const dir of dirs) {
    if (await dirHasEntries(path.join(dir, child))) return dir;
  }
  return "";
}

export async function migrateLegacyDesktopData(options: LegacyMigrateOptions): Promise<LegacyMigrateResult> {
  const currentDshHome = path.join(options.currentUserData, DSH_HOME_DIRNAME);
  const legacyUserData = candidateLegacyUserDataDirs(options.appData).filter(
    (dir) => !samePath(dir, options.currentUserData),
  );
  const dshCandidates = candidateLegacyDshHomes(options.appData, options.homeDir, options.currentUserData);
  const fromDshHome = (await pickLegacyDshHome(currentDshHome, dshCandidates)) ?? "";
  const copied: string[] = [];

  if (fromDshHome) {
    for (const name of await migrateDshHome(fromDshHome, currentDshHome)) {
      copied.push(`${DSH_HOME_DIRNAME}/${name}`);
    }
  }

  const destSettingsFile = path.join(options.currentUserData, DESKTOP_SETTINGS_FILE);
  let currentSettings: Record<string, unknown> = {};
  try {
    currentSettings = JSON.parse(await readFile(destSettingsFile, "utf8")) as Record<string, unknown>;
  } catch {
    currentSettings = {};
  }
  for (const dir of legacyUserData) {
    try {
      const legacy = JSON.parse(
        await readFile(path.join(dir, DESKTOP_SETTINGS_FILE), "utf8"),
      ) as Record<string, unknown>;
      const merged = mergeBlankDesktopSettings(currentSettings, legacy);
      if (JSON.stringify(merged) !== JSON.stringify(currentSettings)) {
        await mkdir(options.currentUserData, { recursive: true });
        await writeFile(destSettingsFile, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
        copied.push(DESKTOP_SETTINGS_FILE);
        currentSettings = merged;
      }
      break;
    } catch {
      // try the next old folder
    }
  }

  const fromUserData =
    userDataOwningHome(fromDshHome, legacyUserData) ||
    (await firstUserDataWithChild(legacyUserData, "harness")) ||
    (await firstUserDataWithChild(legacyUserData, "runtime")) ||
    (await firstUserDataWithChild(legacyUserData, "skins"));

  if (fromUserData) {
    for (const child of ["harness", "runtime", "skins"]) {
      if (await copyMissingDirIfEmpty(path.join(fromUserData, child), path.join(options.currentUserData, child))) {
        copied.push(child);
      }
    }
  }

  return { fromUserData, fromDshHome, copied };
}

export function summarizeMigration(result: LegacyMigrateResult): string {
  if (!result.copied.length) return "";
  const source = result.fromDshHome || result.fromUserData;
  return `已从旧目录恢复配置：${result.copied.join("、")}（来源 ${source}）`;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}
