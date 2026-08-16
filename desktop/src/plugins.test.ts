import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUNDLED_PLUGINS,
  ensureBundledPlugins,
  installPluginFromDir,
  linkPluginPackage,
  pluginBundledCandidates,
  pluginSecretsEnv,
  renderPluginRows,
} from "./plugins";
import { MANAGED_END, MANAGED_START, mergeSkinPatch, stripManagedPatch } from "./skins";
import { DEFAULT_SETTINGS, mergeNestedSettings, type DesktopSettings } from "./util";

const temps: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function settingsWith(overrides: Partial<DesktopSettings> = {}): DesktopSettings {
  return { ...DEFAULT_SETTINGS, ...mergeNestedSettings(overrides), ...overrides };
}

async function makeFakePlugin(root: string, version: string): Promise<string> {
  const dir = path.join(root, "bundled", "vision-aux");
  await mkdir(path.join(dir, "lib"), { recursive: true });
  await writeFile(path.join(dir, "lib", "index.js"), "export const name = 'vision-aux'");
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "@dsh-desktop/dsh-vision-aux", version }));
  return dir;
}

describe("renderPluginRows", () => {
  it("emits the tavily insert and the web searchProvider override", () => {
    const rows = renderPluginRows(
      settingsWith({ webSearch: { provider: "tavily", tavily: { apiKey: "tvly-secret", baseURL: "https://api.tavily.com", maxResults: 6 } } }),
    ).join("\n");
    expect(rows).toContain("- id: web-search-tavily");
    expect(rows).toContain("name: '@dsh-desktop/dsh-web-search-tavily'");
    expect(rows).toContain("maxResults: 6");
    expect(rows).toContain("- id: web");
    expect(rows).toContain("searchProvider: tavily");
    // Secrets never land in the plaintext patch file.
    expect(rows).not.toContain("tvly-secret");
  });

  it("emits no web rows while the official provider is selected", () => {
    expect(renderPluginRows(settingsWith())).toEqual([]);
    expect(
      renderPluginRows(
        settingsWith({ webSearch: { provider: "deepseek-official", tavily: DEFAULT_SETTINGS.webSearch.tavily } }),
      ),
    ).toEqual([]);
  });

  it("emits the vision row only when enabled with a model", () => {
    const enabled = renderPluginRows(
      settingsWith({ visionAux: { ...DEFAULT_SETTINGS.visionAux, enabled: true, apiKey: "sk-secret", model: "qwen-vl-max", baseURL: "https://v.test/v1", timeoutMs: 30_000 } }),
    ).join("\n");
    expect(enabled).toContain("- id: vision-aux");
    expect(enabled).toContain("model: 'qwen-vl-max'");
    expect(enabled).toContain("timeoutMs: 30000");
    expect(enabled).not.toContain("sk-secret");

    const noModel = renderPluginRows(
      settingsWith({ visionAux: { ...DEFAULT_SETTINGS.visionAux, enabled: true, model: "  " } }),
    );
    expect(noModel).toEqual([]);
  });

  it("exposes the secrets as env values instead", () => {
    const env = pluginSecretsEnv(
      settingsWith({
        webSearch: { provider: "tavily", tavily: { apiKey: " tvly-x ", baseURL: "", maxResults: 8 } },
        visionAux: { ...DEFAULT_SETTINGS.visionAux, apiKey: "sk-y" },
      }),
    );
    expect(env.DSH_TAVILY_API_KEY).toBe("tvly-x");
    expect(env.DSH_VISION_AUX_API_KEY).toBe("sk-y");
  });
});

describe("plugin install and link", () => {
  it("installs once per version and links into both profiles", async () => {
    const root = await tempDir("ds-plugin-");
    const bundled = await makeFakePlugin(root, "1.0.0");
    const dest = path.join(root, "userData", "plugins", "vision-aux");
    const logs: string[] = [];

    expect(await installPluginFromDir(bundled, dest, (line) => logs.push(line))).toBe("installed");
    expect(await installPluginFromDir(bundled, dest, () => undefined)).toBe("unchanged");

    const next = await makeFakePlugin(root, "1.0.1");
    expect(await installPluginFromDir(next, dest, () => undefined)).toBe("updated");
    expect(await readFile(path.join(dest, "package.json"), "utf8")).toContain("1.0.1");
    expect(logs.some((line) => line.includes("vision-aux"))).toBe(true);

    const dshHome = path.join(root, "dsh-home");
    const linked = await linkPluginPackage(dshHome, "@dsh-desktop/dsh-vision-aux", dest);
    expect(linked).toHaveLength(2);
    for (const target of linked) {
      const pkg = JSON.parse(await readFile(path.join(target, "package.json"), "utf8")) as { version?: string };
      expect(pkg.version).toBe("1.0.1");
    }
    expect(linked[0]).toContain(path.join("profiles", "web", "node_modules"));
    expect(linked[1]).toContain(path.join("profiles", "node_modules"));
  });

  it("ensureBundledPlugins wires every bundled plugin and survives a missing one", async () => {
    const root = await tempDir("ds-ensure-");
    const bundledRoot = path.join(root, "resources", "plugins");
    const vision = await makeFakePlugin(root, "1.0.0");
    await mkdir(path.dirname(vision), { recursive: true });
    // Move the fake plugin into the expected bundled layout; web-search-tavily stays missing.
    const expected = path.join(bundledRoot, "vision-aux");
    await mkdir(bundledRoot, { recursive: true });
    await rm(expected, { recursive: true, force: true });
    const { cp } = await import("node:fs/promises");
    await cp(vision, expected, { recursive: true });

    const logs: string[] = [];
    await ensureBundledPlugins({
      userData: path.join(root, "userData"),
      dshHome: path.join(root, "dsh-home"),
      appRoot: root,
      resourcesPath: path.join(root, "nonexistent-resources"),
      onLog: (line) => logs.push(line),
    });
    expect(await stat(path.join(root, "userData", "plugins", "vision-aux", "lib", "index.js"))).toBeTruthy();
    expect(logs.some((line) => line.includes("web-search-tavily") && line.includes("缺失"))).toBe(true);
    const linked = path.join(root, "dsh-home", "profiles", "web", "node_modules", "@dsh-desktop", "dsh-vision-aux");
    expect(await readFile(path.join(linked, "package.json"), "utf8")).toContain("1.0.0");
  });

  it("searches unpacked twins before asar virtual paths", () => {
    const plugin = BUNDLED_PLUGINS.find((item) => item.rowId === "web-search-tavily");
    expect(plugin).toBeDefined();
    const candidates = pluginBundledCandidates(plugin!, {
      resourcesPath: "/res/app.asar.unpacked".replace("app.asar.unpacked", "app.asar.unpacked"),
    });
    expect(candidates.some((dir) => dir.includes("plugins") && dir.includes("web-search-tavily"))).toBe(true);
  });
});

describe("plugin rows inside the managed skin patch", () => {
  it("renders and later strips plugin rows with the managed markers", () => {
    const pluginRows = renderPluginRows(
      settingsWith({ webSearch: { provider: "tavily", tavily: { apiKey: "", baseURL: "https://api.tavily.com", maxResults: 8 } } }),
    );
    const merged = mergeSkinPatch("", [], "official", [], pluginRows);
    expect(merged).toContain(MANAGED_START);
    expect(merged).toContain("- id: web-search-tavily");
    expect(merged).toContain("searchProvider: tavily");
    expect(stripManagedPatch(merged).trim()).toBe("");

    const again = mergeSkinPatch(merged, [], "official", [], pluginRows);
    expect(again.match(new RegExp(MANAGED_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1);
  });
});
