import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_FILE,
  DESKTOP_SETTINGS_FILE,
  DSH_HOME_DIRNAME,
  SETTINGS_FILE,
  candidateLegacyDshHomes,
  candidateLegacyUserDataDirs,
  dshHomeHasCredentials,
  mergeBlankDesktopSettings,
  migrateDshHome,
  migrateLegacyDesktopData,
  officialDshHome,
  pickLegacyDshHome,
  samePath,
  summarizeMigration,
  yamlHasPayload,
} from "./legacy-home";

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("legacy home detection", () => {
  it("treats comments-only yaml as empty", () => {
    expect(yamlHasPayload("# only comments\n\n")).toBe(false);
    expect(yamlHasPayload("DEEPSEEK_API_KEY: sk-test\n")).toBe(true);
  });

  it("lists old Electron folder names and official ~/.dsh", () => {
    const dirs = candidateLegacyUserDataDirs("/tmp/AppData");
    expect(dirs).toContain(path.join("/tmp/AppData", "深度求索"));
    expect(dirs).toContain(path.join("/tmp/AppData", "DeepSeek Harness"));
    const homes = candidateLegacyDshHomes("/tmp/AppData", "/tmp/home", path.join("/tmp/AppData", "DeepSeek"));
    expect(homes).toContain(path.join("/tmp/AppData", "深度求索", DSH_HOME_DIRNAME));
    expect(homes).toContain(officialDshHome("/tmp/home"));
    expect(homes.some((home) => samePath(home, path.join("/tmp/AppData", "DeepSeek", DSH_HOME_DIRNAME)))).toBe(false);
  });

  it("does not migrate when the current home already has a key", async () => {
    const root = await tempDir("ds-legacy-cur-");
    const current = path.join(root, "current");
    const old = path.join(root, "old");
    await mkdir(current, { recursive: true });
    await mkdir(old, { recursive: true });
    await writeFile(path.join(current, CREDENTIAL_FILE), "DEEPSEEK_API_KEY: sk-current\n", "utf8");
    await writeFile(path.join(old, CREDENTIAL_FILE), "DEEPSEEK_API_KEY: sk-old\n", "utf8");
    expect(await dshHomeHasCredentials(current)).toBe(true);
    expect(await pickLegacyDshHome(current, [old])).toBeNull();
  });

  it("picks the first old home that still has a key", async () => {
    const root = await tempDir("ds-legacy-pick-");
    const current = path.join(root, "current");
    const empty = path.join(root, "empty");
    const old = path.join(root, "old");
    await mkdir(current, { recursive: true });
    await mkdir(empty, { recursive: true });
    await mkdir(old, { recursive: true });
    await writeFile(path.join(empty, CREDENTIAL_FILE), "# waiting\n", "utf8");
    await writeFile(path.join(old, CREDENTIAL_FILE), "DEEPSEEK_API_KEY: sk-legacy\n", "utf8");
    expect(await pickLegacyDshHome(current, [empty, old])).toBe(old);
  });
});

describe("migrate dsh home", () => {
  it("copies credentials and settings but not the skin patch file", async () => {
    const root = await tempDir("ds-legacy-copy-");
    const from = path.join(root, "from");
    const to = path.join(root, "to");
    await mkdir(path.join(from, "storages"), { recursive: true });
    await mkdir(path.join(from, "sessions"), { recursive: true });
    await writeFile(path.join(from, CREDENTIAL_FILE), "DEEPSEEK_API_KEY: sk-legacy\n", "utf8");
    await writeFile(path.join(from, SETTINGS_FILE), "llm-deepseek:\n  thinking: enabled\n", "utf8");
    await writeFile(path.join(from, "cordis.patch.yml"), "- insert: broken\n", "utf8");
    await writeFile(path.join(from, "storages", "workspace.json"), "{\"ok\":true}\n", "utf8");
    await writeFile(path.join(from, "sessions", "one.jsonl"), "{}\n", "utf8");
    const copied = await migrateDshHome(from, to);
    expect(copied.sort()).toEqual([".credentials.yaml", "sessions", "settings.yaml", "storages"]);
    expect(await readFile(path.join(to, CREDENTIAL_FILE), "utf8")).toContain("sk-legacy");
    expect(await readFile(path.join(to, SETTINGS_FILE), "utf8")).toContain("llm-deepseek");
    await expect(readFile(path.join(to, "cordis.patch.yml"), "utf8")).rejects.toThrow();
  });

  it("does not overwrite a key the user already saved in the new folder", async () => {
    const root = await tempDir("ds-legacy-keep-");
    const from = path.join(root, "from");
    const to = path.join(root, "to");
    await mkdir(from, { recursive: true });
    await mkdir(to, { recursive: true });
    await writeFile(path.join(from, CREDENTIAL_FILE), "DEEPSEEK_API_KEY: sk-old\n", "utf8");
    await writeFile(path.join(to, CREDENTIAL_FILE), "DEEPSEEK_API_KEY: sk-new\n", "utf8");
    expect(await migrateDshHome(from, to)).toEqual([]);
    expect(await readFile(path.join(to, CREDENTIAL_FILE), "utf8")).toContain("sk-new");
  });
});

describe("desktop settings merge", () => {
  it("fills only blank fields from the old file", () => {
    const merged = mergeBlankDesktopSettings(
      { lastHarnessVersion: "", workspaceDir: "/home/fan/DeepSeek", skinsEnabled: true },
      { lastHarnessVersion: "0.1.0-rc.6", workspaceDir: "/old/ws", localHarnessDir: "/old/src" },
    );
    expect(merged.lastHarnessVersion).toBe("0.1.0-rc.6");
    expect(merged.workspaceDir).toBe("/home/fan/DeepSeek");
    expect(merged.localHarnessDir).toBe("/old/src");
  });
});

describe("full desktop migration", () => {
  it("restores a key from 深度求索 and engine files from that old userData", async () => {
    const root = await tempDir("ds-legacy-full-");
    const appData = path.join(root, "AppData");
    const homeDir = path.join(root, "home");
    const current = path.join(appData, "DeepSeek");
    const legacy = path.join(appData, "深度求索");
    await mkdir(path.join(legacy, DSH_HOME_DIRNAME), { recursive: true });
    await mkdir(path.join(legacy, "harness", "0.1.0"), { recursive: true });
    await mkdir(path.join(current, DSH_HOME_DIRNAME), { recursive: true });
    await writeFile(path.join(legacy, DSH_HOME_DIRNAME, CREDENTIAL_FILE), "DEEPSEEK_API_KEY: sk-from-old\n", "utf8");
    await writeFile(path.join(legacy, DSH_HOME_DIRNAME, SETTINGS_FILE), "keep: true\n", "utf8");
    await writeFile(
      path.join(legacy, DESKTOP_SETTINGS_FILE),
      JSON.stringify({ lastHarnessVersion: "0.1.0-rc.6", workspaceDir: "" }),
      "utf8",
    );
    await writeFile(path.join(legacy, "harness", "0.1.0", "ok"), "engine\n", "utf8");
    await writeFile(path.join(current, DESKTOP_SETTINGS_FILE), JSON.stringify({ lastHarnessVersion: "" }), "utf8");

    const result = await migrateLegacyDesktopData({ currentUserData: current, appData, homeDir });
    expect(result.fromDshHome).toBe(path.join(legacy, DSH_HOME_DIRNAME));
    expect(result.copied).toContain(`${DSH_HOME_DIRNAME}/${CREDENTIAL_FILE}`);
    expect(result.copied).toContain(DESKTOP_SETTINGS_FILE);
    expect(result.copied).toContain("harness");
    expect(await readFile(path.join(current, DSH_HOME_DIRNAME, CREDENTIAL_FILE), "utf8")).toContain("sk-from-old");
    expect(await readFile(path.join(current, DESKTOP_SETTINGS_FILE), "utf8")).toContain("0.1.0-rc.6");
    expect(await readFile(path.join(current, "harness", "0.1.0", "ok"), "utf8")).toContain("engine");
    expect(summarizeMigration(result)).toContain("已从旧目录恢复配置");
  });

  it("falls back to official ~/.dsh when no old desktop folder has a key", async () => {
    const root = await tempDir("ds-legacy-cli-");
    const appData = path.join(root, "AppData");
    const homeDir = path.join(root, "home");
    const current = path.join(appData, "DeepSeek");
    await mkdir(path.join(homeDir, ".dsh"), { recursive: true });
    await mkdir(current, { recursive: true });
    await writeFile(path.join(homeDir, ".dsh", CREDENTIAL_FILE), "DEEPSEEK_API_KEY: sk-cli\n", "utf8");
    const result = await migrateLegacyDesktopData({ currentUserData: current, appData, homeDir });
    expect(result.fromDshHome).toBe(path.join(homeDir, ".dsh"));
    expect(await readFile(path.join(current, DSH_HOME_DIRNAME, CREDENTIAL_FILE), "utf8")).toContain("sk-cli");
  });
});
