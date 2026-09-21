import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  MODALITIES,
  PROVIDER_CARD_KEY,
  ROUTE_SEAT,
  ROUTE_SET,
  ROUTE_STATE,
  SETTINGS_NS,
  buildRows,
  declaredInputsOf,
  inject,
  modelsArrayOf,
  name as pluginName,
  normalizeDeclared,
  routeDeclaresList,
  withModelInput,
} from "../resources/plugins/model-vision/src/index";
import { BUNDLED_PLUGINS, renderPluginRows } from "./plugins";
import { DEFAULT_SETTINGS } from "./util";

const pluginRoot = path.join(__dirname, "..", "resources", "plugins", "model-vision");
const pluginPackage = JSON.parse(readFileSync(path.join(pluginRoot, "package.json"), "utf8")) as {
  name: string;
  main: string;
  dsh: { bundle: { patch: string }; client: { inject: string[]; platform: string } };
  exports: Record<string, string>;
};
const patchFile = readFileSync(path.join(pluginRoot, "cordis.patch.yml"), "utf8");
const bundleSource = readFileSync(path.join(pluginRoot, "client", "client.js"), "utf8");
const hostSource = readFileSync(path.join(pluginRoot, "src", "index.ts"), "utf8");
const bundled = BUNDLED_PLUGINS.find((plugin) => plugin.dir === "model-vision");

describe("bundled registration contract", () => {
  it("ships as a bundled plugin whose row id, package name and patch row agree", () => {
    expect(bundled).toBeDefined();
    expect(bundled?.packageName).toBe(pluginPackage.name);
    expect(patchFile).toContain(`id: ${bundled?.rowId}`);
    expect(patchFile).toContain(`name: '${pluginPackage.name}'`);
    expect(pluginPackage.dsh.bundle.patch).toBe("./cordis.patch.yml");
  });

  it("declares both halves: a host entry and a web client entry", () => {
    expect(pluginPackage.main).toBe("lib/index.js");
    expect(pluginPackage.exports["./client"]).toBe("./client/client.js");
    expect(pluginPackage.dsh.client.platform).toBe("web");
    // The package that declares the `settings.models.provider-card` seat must be
    // in the client inject list, or the seat may not exist when we register.
    expect(pluginPackage.dsh.client.inject).toContain("@deepseek-ai/dsh-client-ui-settings-models");
  });

  it("the host half's Cordis name is the patch row id", () => {
    expect(pluginName).toBe("dsh-model-vision");
    expect(bundled?.rowId).toBe(pluginName);
    expect(inject).toContain("settings");
    expect(inject).toContain("llm");
    expect(inject).toContain("webServer");
  });

  it("the shell always loads it, with no settings of its own to gate on", () => {
    const rows = renderPluginRows(DEFAULT_SETTINGS).join("\n");
    expect(rows).toContain("id: dsh-model-vision");
    expect(rows).toContain("name: '@dsh-desktop/dsh-model-vision'");
  });
});

describe("browser half contract", () => {
  it("loads in the loader's bundle format and returns a plugin object", () => {
    expect(bundleSource).toContain("window.__ModuleLoader__.load({");
    expect(bundleSource).toContain(`id: "${pluginPackage.name}"`);
    expect(bundleSource).toContain('name: "dsh-model-vision"');
    expect(bundleSource).toContain('inject: ["slots", "locale"]');
  });

  it("registers into the keyed provider-card seat under the pi-ai namespace key", () => {
    // A keyed seat dispatches on `entryKey`; without `key` the entry never
    // matches and the block silently never renders.
    expect(bundleSource).toContain('ctx.slots.inject("settings.models.provider-card"');
    expect(bundleSource).toContain('name: "settings.models.provider-card"');
    expect(bundleSource).toContain("key: PROVIDER_CARD_KEY");
    expect(bundleSource).toContain('const PROVIDER_CARD_KEY = "llm-pi-ai"');
    expect(PROVIDER_CARD_KEY).toBe(SETTINGS_NS);
  });

  it("passes the active language through the registration's inject face", () => {
    // The owner props carry no language; without this face the UI would render
    // Chinese on an English client and never follow a language switch.
    expect(bundleSource).toContain("inject: () => ({ lang })");
    expect(bundleSource).toContain("ctx.locale.getSnapshot().active");
  });

  it("reports a seat receipt and reads the host routes, never inventing data", () => {
    expect(bundleSource).toContain(`const SEAT_URL = "${ROUTE_SEAT}"`);
    expect(bundleSource).toContain(`const STATE_URL = "${ROUTE_STATE}"`);
    expect(bundleSource).toContain(`const SET_URL = "${ROUTE_SET}"`);
  });

  it("references only theme variables the dsh client actually defines", () => {
    // The panel once painted black on light themes by naming variables that do
    // not exist and falling back to hardcoded dark colours; this guard keeps a
    // new surface from repeating it.
    const real = [
      "dsw-alias-bg-base",
      "dsw-alias-bg-layer-1",
      "dsw-alias-bg-layer-2",
      "dsw-alias-bg-layer-3",
      "dsw-alias-bg-layer-4",
      "dsw-alias-border-l1",
      "dsw-alias-border-l2",
      "dsw-alias-border-l3",
      "dsw-alias-border-l4",
      "dsw-alias-label-primary",
      "dsw-alias-label-secondary",
      "dsw-alias-label-tertiary",
      "dsw-alias-state-error-primary",
      "dsw-alias-state-business-primary",
    ];
    const used = [...bundleSource.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1].slice(2));
    expect(used.length).toBeGreaterThan(0);
    for (const variable of new Set(used)) expect(real).toContain(variable);
    // Every fallback must be theme-neutral: no opaque dark literal may become a
    // surface when a variable is missing.
    const fallbacks = [...bundleSource.matchAll(/var\(--[a-z0-9-]+,\s*([^)]+)\)/g)].map((match) => match[1].trim());
    for (const fallback of fallbacks) {
      if (/^#[0-9a-f]{3,8}$/i.test(fallback)) {
        const hex = fallback.slice(1);
        const [r, g, b] = hex.length <= 4 ? hex.split("").map((c) => parseInt(c + c, 16)) : [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
        const luminance = (0.2126 * r! + 0.7152 * g! + 0.0722 * b!) / 255;
        expect(luminance).toBeGreaterThan(0.45);
      }
    }
  });
});

describe("modality declaration model", () => {
  it("treats absent, empty and junk declarations as 'declares nothing'", () => {
    expect(normalizeDeclared(undefined)).toBeNull();
    expect(normalizeDeclared(null)).toBeNull();
    expect(normalizeDeclared([])).toBeNull();
    expect(normalizeDeclared(["bogus"])).toBeNull();
    expect(normalizeDeclared(["image"])).toEqual(["image"]);
    expect(normalizeDeclared(["text", "image", "text"])).toEqual(["text", "image"]);
  });

  it("reads declared inputs per model and reports whether the route owns its list", () => {
    const section = {
      providers: {
        ouou: {
          models: [
            { id: "gpt-5.6-luna", contextWindow: 262144 },
            { id: "minimax-m3", input: ["text", "image"] },
          ],
        },
        codego: {},
      },
    };
    const declared = declaredInputsOf(section, "ouou");
    expect(declared.get("gpt-5.6-luna")).toBeNull();
    expect(declared.get("minimax-m3")).toEqual(["text", "image"]);
    expect(routeDeclaresList(section, "ouou")).toBe(true);
    expect(routeDeclaresList(section, "codego")).toBe(false);
    expect(modelsArrayOf(section, "codego")).toEqual([]);
  });

  it("restates the whole array, keeping every other field of every entry", () => {
    const current = [
      { id: "a", name: "A", contextWindow: 1000, maxTokens: 100 },
      { id: "b", name: "B" },
    ];
    const next = withModelInput(current, "b", true);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual(current[0]);
    expect(next[1]).toEqual({ id: "b", name: "B", input: ["text", "image"] });
    // The input array is copied, not shared with the source object.
    expect(next[1]!.input).not.toBe(current[0]!.input);
  });

  it("appends an entry for a model the user list does not name", () => {
    const next = withModelInput([{ id: "a" }], "catalog-model", true);
    expect(next).toEqual([{ id: "a" }, { id: "catalog-model", input: ["text", "image"] }]);
  });

  it("declares text alone when the toggle is cleared, never an empty list", () => {
    const next = withModelInput([{ id: "a", input: ["text", "image"] }], "a", false);
    expect(next[0]!.input).toEqual(["text"]);
    expect(MODALITIES).toEqual(["text", "image"]);
  });

  it("builds rows from the engine's own model list", () => {
    const rows = buildRows(
      [
        { id: "a", name: "A", inputModalities: ["text", "image"] },
        { id: "b" },
      ],
      new Map([["b", null]]),
    );
    expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
    expect(rows[0]).toMatchObject({ name: "A", effective: ["text", "image"], supportsImage: true });
    // An absent declaration is the engine's text-only answer, not a guess.
    expect(rows[1]).toMatchObject({ name: "b", effective: ["text"], supportsImage: false, declared: null });
  });

  it("never writes a path op into an array (the settings service cannot address one)", () => {
    // applyPathOp walks plain objects only, so the host half must always set the
    // whole `models` array; an indexed path would replace it with an object.
    expect(hostSource).toContain("path: ['providers', provider, 'models']");
    const pathOps = [...hostSource.matchAll(/path: \[([^\]]*)\]/g)].map((match) => match[1] ?? "");
    expect(pathOps.length).toBeGreaterThan(0);
    for (const op of pathOps) {
      expect(op).not.toMatch(/String\(|idx|index/);
      expect(op).not.toContain("${");
    }
  });
});
