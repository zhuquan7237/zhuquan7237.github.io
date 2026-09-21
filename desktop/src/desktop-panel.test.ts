import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  MARKET_BLOCK_BEGIN,
  MARKET_BLOCK_END,
  desktopFacts,
  inventoryOf,
  mergeBlock,
  parseDisabled,
  renderBlock,
  shellPluginsOf,
  summarize,
  tailFile,
  toggleRowId,
} from "../resources/plugins/desktop-panel/src/index";
import { BUNDLED_PLUGINS } from "./plugins";

const pluginRoot = path.join(__dirname, "..", "resources", "plugins", "desktop-panel");
const pluginPackage = JSON.parse(readFileSync(path.join(pluginRoot, "package.json"), "utf8")) as {
  name: string;
  dsh: { bundle: { patch: string }; client: { inject: string[]; platform: string } };
  exports: Record<string, string>;
  main: string;
};
const patchFile = readFileSync(path.join(pluginRoot, "cordis.patch.yml"), "utf8");
const bundle = BUNDLED_PLUGINS.find((plugin) => plugin.dir === "desktop-panel");

describe("bundled registration contract", () => {
  it("ships as a bundled plugin whose row id, package name and patch row agree", () => {
    expect(bundle).toBeDefined();
    expect(bundle?.packageName).toBe(pluginPackage.name);
    // The patch row must name the package and carry the plugin's Cordis name,
    // because that id is what the loader resolves the fiber by.
    expect(patchFile).toContain(`id: ${bundle?.rowId}`);
    expect(patchFile).toContain(`name: '${pluginPackage.name}'`);
    expect(pluginPackage.dsh.bundle.patch).toBe("./cordis.patch.yml");
  });

  it("declares both halves: a host entry and a web client entry", () => {
    expect(pluginPackage.main).toBe("lib/index.js");
    expect(pluginPackage.exports["./client"]).toBe("./client/client.js");
    expect(pluginPackage.dsh.client.platform).toBe("web");
    // The dual-face declaration is what makes the host compose a boot manifest
    // row for this package; locale and the settings shell are its seats.
    expect(pluginPackage.dsh.client.inject).toContain("@deepseek-ai/dsh-client-locale");
    expect(pluginPackage.dsh.client.inject).toContain("@deepseek-ai/dsh-client-ui-settings");
  });

  it("registers its settings seat without a browser, through the loader contract", () => {
    // The client half is a `__ModuleLoader__` bundle. Executing it here proves
    // the factory returns a Cordis plugin and that apply() claims its seat —
    // the part that silently blanks a settings page when it is wrong.
    const source = readFileSync(path.join(pluginRoot, "client", "client.js"), "utf8");
    const registrations: unknown[] = [];
    const slots: string[] = [];
    const sandbox = {
      window: {
        __ModuleLoader__: {
          load: (entry: { id: string; factory: (require: (name: string) => unknown) => unknown }) => {
            registrations.push(entry);
          },
        },
      },
      fetch: () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("{}") }),
      navigator: { language: "zh-CN" },
      console: { warn: () => undefined },
      setTimeout,
    };
    const run = new Function("window", "fetch", "navigator", "console", "setTimeout", source);
    run(sandbox.window, sandbox.fetch, sandbox.navigator, sandbox.console, sandbox.setTimeout);

    expect(registrations).toHaveLength(1);
    const entry = registrations[0] as { id: string; factory: (r: (n: string) => unknown) => any };
    expect(entry.id).toBe(pluginPackage.name);

    const require = (name: string) => {
      if (name === "react") {
        return {
          createElement: () => null,
          useState: () => [null, () => undefined],
          useEffect: () => undefined,
        };
      }
      throw new Error(`unexpected external: ${name}`);
    };
    const plugin = entry.factory(require);
    expect(plugin.inject).toEqual(["slots"]);
    expect(typeof plugin.apply).toBe("function");
    expect(typeof plugin.name).toBe("string");

    const ctx = {
      slots: {
        inject: (slot: string, register: () => unknown) => {
          slots.push(slot);
          register();
        },
        register: (meta: Record<string, unknown>) => meta,
      },
    };
    plugin.apply(ctx);
    expect(slots).toEqual(["settings.section"]);
  });
});

describe("shell facts", () => {
  it("reads what the desktop passes and defaults the rest", () => {
    const facts = desktopFacts({
      DSH_DESKTOP_VERSION: "0.4.0",
      DSH_DESKTOP_LOG_DIR: "C:/logs",
      DSH_DESKTOP_TRAY: "1",
      DSH_DESKTOP_PACKAGED: "0",
    } as NodeJS.ProcessEnv);
    expect(facts.shellVersion).toBe("0.4.0");
    expect(facts.logDir).toBe("C:/logs");
    expect(facts.trayAvailable).toBe(true);
    expect(facts.packaged).toBe(false);
    expect(facts.executable).toBe("");
    expect(desktopFacts({} as NodeJS.ProcessEnv).marketAvailable).toBe(false);
  });
});

describe("toggle block", () => {
  const skinRows = ["# managed by DeepSeek desktop", "- id: maid-atelier", "  enabled: true"].join("\n");

  it("only claims rows inside its own block", () => {
    expect(parseDisabled("- id: someone-else\n  disabled: true\n")).toEqual([]);
    const block = renderBlock(["b", "a"]);
    expect(block.startsWith(MARKET_BLOCK_BEGIN)).toBe(true);
    expect(block.endsWith(MARKET_BLOCK_END)).toBe(true);
    expect(parseDisabled(block)).toEqual(["a", "b"]);
  });

  it("inserts, preserves and clears without touching other rows", () => {
    const existing = `${skinRows}\n\n- id: hand-written\n  config:\n    keep: true\n`;
    const off = mergeBlock(existing, ["dsh-pet"]);
    expect(off).toContain("- id: maid-atelier");
    expect(off).toContain("- id: hand-written");
    expect(off).toContain("- id: dsh-pet\n  disabled: true");
    expect(mergeBlock(off, ["dsh-pet"])).toBe(off);
    const cleared = mergeBlock(off, []);
    expect(cleared).not.toContain(MARKET_BLOCK_BEGIN);
    expect(cleared).toContain("- id: maid-atelier");
    expect(mergeBlock(cleared, [])).toBe(`${cleared.replace(/\s+$/, "")}\n`);
  });

  it("keeps a valid array document valid when nothing is disabled", () => {
    expect(mergeBlock("[]\n", [])).toBe("[]\n");
    expect(renderBlock([])).toBe("");
  });
});

describe("profile inventory", () => {
  const manifest = {
    dependencies: { "dsh-pet": "^0.2.11", "@linxin666/dsh-doctor": "^0.3.24" },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "dsh-pet", "@linxin666/dsh-doctor"] } },
  };

  it("separates removable plugins from in-box layers", () => {
    const inv = inventoryOf(manifest, mergeBlock("[]\n", ["dsh-pet"]));
    const byName = Object.fromEntries(inv.plugins.map((plugin) => [plugin.packageName, plugin]));
    expect(byName["dsh-pet"]).toMatchObject({ removable: true, core: false, disabled: true, version: "^0.2.11" });
    expect(byName["@deepseek-ai/dsh-base"]).toMatchObject({ removable: false, core: true, bundle: true });
    expect(inv.disabled).toEqual(["dsh-pet"]);
    expect(inv.plugins.map((plugin) => plugin.packageName)).toEqual([...inv.plugins.map((p) => p.packageName)].sort());
  });

  it("summarizes for the status card and survives an empty profile", () => {
    const inv = inventoryOf(manifest, "");
    expect(summarize(inv)).toMatchObject({ total: 3, enabled: 3, disabled: 0, removable: 2, shell: 0 });
    expect(inventoryOf(null, "").plugins).toEqual([]);
    expect(summarize(inventoryOf(null, ""))).toEqual({ total: 0, enabled: 0, disabled: 0, removable: 0, shell: 0 });
  });

  it("reports shell-installed plugins, which never appear as dependencies", () => {
    // The desktop links its bundled plugins into the profile and loads them
    // through insert rows, so a manifest-only inventory would hide what is
    // actually running.
    const patch = [
      "- insert:",
      "    - id: web-search-tavily",
      "      name: '@dsh-desktop/dsh-web-search-tavily'",
      "- insert:",
      "    - id: dsh-desktop-panel",
      "      name: '@dsh-desktop/dsh-desktop-panel'",
      "      config:",
      "        keep: true",
      MARKET_BLOCK_BEGIN,
      "- id: dsh-desktop-panel",
      "  disabled: true",
      MARKET_BLOCK_END,
    ].join("\n");
    expect(shellPluginsOf(patch)).toEqual([
      { rowId: "web-search-tavily", packageName: "@dsh-desktop/dsh-web-search-tavily" },
      { rowId: "dsh-desktop-panel", packageName: "@dsh-desktop/dsh-desktop-panel" },
    ]);
    const inv = inventoryOf(manifest, patch);
    expect(inv.shellPlugins).toEqual([
      { rowId: "web-search-tavily", packageName: "@dsh-desktop/dsh-web-search-tavily", disabled: false },
      { rowId: "dsh-desktop-panel", packageName: "@dsh-desktop/dsh-desktop-panel", disabled: true },
    ]);
    // Bundled plugins already in the bundle list are not duplicated.
    expect(shellPluginsOf(patch).filter((row) => inv.plugins.some((p) => p.packageName === row.packageName))).toEqual([]);
    expect(summarize(inv)).toMatchObject({ total: 5, disabled: 1, shell: 2 });
  });

  it("keeps its own switch out of the panel, because the patch layer applies live", () => {
    // Disabling this plugin removes its own routes, so a panel that offered the
    // toggle could not offer it back; the desktop market window owns that case.
    const source = readFileSync(path.join(pluginRoot, "client", "client.js"), "utf8");
    const hostSource = readFileSync(path.join(pluginRoot, "src", "index.ts"), "utf8");
    expect(hostSource).toContain("packageName === name");
    expect(hostSource).toContain("面板不能停用自己");
    expect(source).toContain('plugin.rowId === "dsh-desktop-panel"');
  });

  it("resolves a toggle to the row id the patch layer keys on", () => {
    const inv = inventoryOf(
      manifest,
      ["- insert:", "    - id: vision-aux", "      name: '@dsh-desktop/dsh-vision-aux'"].join("\n"),
    );
    expect(toggleRowId(inv, "dsh-pet")).toBe("dsh-pet");
    expect(toggleRowId(inv, "vision-aux")).toBe("vision-aux");
    expect(toggleRowId(inv, "@dsh-desktop/dsh-vision-aux")).toBe("vision-aux");
    expect(toggleRowId(inv, "not-installed")).toBeNull();
  });
});

describe("log tail", () => {
  it("returns the last lines and stays quiet about a missing file", async () => {
    const file = path.join(__dirname, "..", "resources", "plugins", "desktop-panel", "cordis.patch.yml");
    const tail = await tailFile(file, 2);
    expect(tail.split("\n")).toHaveLength(2);
    expect(await tailFile(path.join(__dirname, "does-not-exist.log"), 5)).toBe("");
  });
});
