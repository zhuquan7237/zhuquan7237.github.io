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
  it("inserts the search-engines router and pins ctx.web to it", () => {
    // The seam refuses to choose between two usable providers, and the official
    // DeepSeek provider is registered by the base layer whether or not its key
    // works — so the pin is written unconditionally, and which engine answers is
    // decided by the plugin's own settings page at request time.
    for (const settings of [
      settingsWith(),
      settingsWith({ webSearch: { provider: "tavily", tavily: { apiKey: "tvly-secret", baseURL: "https://api.tavily.com", maxResults: 6 } } }),
    ]) {
      const rows = renderPluginRows(settings).join("\n");
      expect(rows).toContain("- id: dsh-search-engines");
      expect(rows).toContain("name: '@dsh-desktop/dsh-search-engines'");
      expect(rows).toContain("- id: web");
      expect(rows).toContain("searchProvider: search-engines");
      // The old two-option provider row is gone: two registered providers that
      // could disagree is what made search fail with WEB_PROVIDER_AMBIGUOUS.
      expect(rows).not.toContain("- id: web-search-tavily");
      // Secrets never land in the plaintext patch file.
      expect(rows).not.toContain("tvly-secret");
    }
  });

  it("carries the always-on rows and nothing stateful but the optional ones", () => {
    // The panel, the capability resolver and the search-engine router always
    // load: each owns a settings page or an engine-level registration, so their
    // rows are the baseline every other assertion here is measured against.
    for (const settings of [
      settingsWith(),
      settingsWith({ webSearch: { provider: "deepseek-official", tavily: DEFAULT_SETTINGS.webSearch.tavily } }),
    ]) {
      const rows = renderPluginRows(settings);
      expect(rows).toEqual([
        "- insert:",
        "    - id: dsh-desktop-panel",
        "      name: '@dsh-desktop/dsh-desktop-panel'",
        "- insert:",
        "    - id: dsh-model-vision",
        "      name: '@dsh-desktop/dsh-model-vision'",
        "- insert:",
        "    - id: dsh-search-engines",
        "      name: '@dsh-desktop/dsh-search-engines'",
        "- id: web",
        "  config:",
        "    searchProvider: search-engines",
        "- insert:",
        "    - id: dsh-mobile-bridge",
        "      name: '@dsh-desktop/dsh-mobile-bridge'",
      ]);
      expect(rows.join("\n")).not.toContain("web-search-tavily");
      expect(rows.join("\n")).not.toContain("vision-aux");
    }
  });

  it("always loads the desktop panel, so its row survives every settings combination", () => {
    const rows = renderPluginRows(settingsWith()).join("\n");
    expect(rows).toContain("id: dsh-desktop-panel");
    expect(rows).toContain("name: '@dsh-desktop/dsh-desktop-panel'");
    const off = renderPluginRows(
      settingsWith({ visionAux: { ...DEFAULT_SETTINGS.visionAux, enabled: false }, webSearch: { provider: "deepseek-official", tavily: DEFAULT_SETTINGS.webSearch.tavily } }),
    ).join("\n");
    expect(off).toContain("id: dsh-desktop-panel");
  });

  it("always loads the mobile bridge and advertises its public URL when set", () => {
    const plain = renderPluginRows(settingsWith()).join("\n");
    expect(plain).toContain("- id: dsh-mobile-bridge");
    expect(plain).toContain("name: '@dsh-desktop/dsh-mobile-bridge'");
    expect(plain).not.toContain("publicUrl");

    const withUrl = renderPluginRows(settingsWith({ mobile: { publicUrl: "https://m.zhuquan.xyz" } })).join("\n");
    expect(withUrl).toContain("config:");
    expect(withUrl).toContain("publicUrl: 'https://m.zhuquan.xyz'");

    // Old settings files gain the group with its defaults.
    expect(mergeNestedSettings({ channel: "next" }).mobile).toEqual({ publicUrl: "" });
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
    ).join("\n");
    expect(noModel).not.toContain("vision-aux");
    expect(noModel).toContain("dsh-desktop-panel");
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
    expect(merged).toContain("- id: dsh-search-engines");
    expect(merged).toContain("searchProvider: search-engines");
    expect(stripManagedPatch(merged).trim()).toBe("");

    const again = mergeSkinPatch(merged, [], "official", [], pluginRows);
    expect(again.match(new RegExp(MANAGED_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1);
  });
});


describe("bundled plugin installation", () => {
  it("reinstalls when the version changed, and when only the content did", async () => {
    const { mkdtemp, mkdir, writeFile, readFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const root = await mkdtemp(path.join(os.tmpdir(), "dsh-plugin-install-"));
    const source = path.join(root, "bundled");
    const dest = path.join(root, "installed");
    const logs: string[] = [];
    const write = async (body: string) => {
      await mkdir(path.join(source, "lib"), { recursive: true });
      await mkdir(path.join(source, "client"), { recursive: true });
      await writeFile(path.join(source, "package.json"), JSON.stringify({ name: "@dsh-desktop/x", version: "1.0.0" }));
      await writeFile(path.join(source, "lib", "index.js"), body);
      await writeFile(path.join(source, "client", "client.js"), "window.__ModuleLoader__.load({});\n");
    };
    await write("module.exports = 1;\n");

    expect(await installPluginFromDir(source, dest, (line) => logs.push(line))).toBe("installed");
    expect(await installPluginFromDir(source, dest, (line) => logs.push(line))).toBe("unchanged");

    // The case that shipped broken in 0.5.4: same version, new behaviour.
    await write("module.exports = 2;\n");
    expect(await installPluginFromDir(source, dest, (line) => logs.push(line))).toBe("updated");
    expect(await readFile(path.join(dest, "lib", "index.js"), "utf8")).toContain("2");

    // A re-run with identical content must not rewrite the installed copy.
    const stamp = await readFile(path.join(dest, "lib", "index.js"), "utf8");
    expect(await installPluginFromDir(source, dest, (line) => logs.push(line))).toBe("unchanged");
    expect(await readFile(path.join(dest, "lib", "index.js"), "utf8")).toBe(stamp);
  });
});
