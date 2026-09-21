import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  MODALITIES,
  catalogueFromModels,
  engineModalities,
  normalizeModelId,
  parseCatalogue,
  resolveCapabilities,
  ruleFor,
  sourceLabel,
  upstreamCapabilities,
} from "../resources/plugins/model-vision/src/capabilities";
import { applyPlan, normalizedInput, planRoute, summarizePlan } from "../resources/plugins/model-vision/src/sync";
import { BUNDLED_PLUGINS, renderPluginRows } from "./plugins";
import { DEFAULT_SETTINGS } from "./util";

const pluginRoot = path.join(__dirname, "..", "resources", "plugins", "model-vision");
const pluginPackage = JSON.parse(readFileSync(path.join(pluginRoot, "package.json"), "utf8")) as {
  name: string;
  main: string;
  files: string[];
  dsh: { bundle: { patch: string }; client: { inject: string[]; platform: string } };
  exports: Record<string, string>;
};
const patchFile = readFileSync(path.join(pluginRoot, "cordis.patch.yml"), "utf8");
const bundleSource = readFileSync(path.join(pluginRoot, "client", "client.js"), "utf8");
const hostSource = readFileSync(path.join(pluginRoot, "src", "index.ts"), "utf8");
const snapshot = JSON.parse(readFileSync(path.join(pluginRoot, "data", "catalogue.json"), "utf8")) as unknown;
const bundled = BUNDLED_PLUGINS.find((plugin) => plugin.dir === "model-vision");

describe("bundled registration contract", () => {
  it("ships as a bundled plugin whose row id, package name and patch row agree", () => {
    expect(bundled).toBeDefined();
    expect(bundled?.packageName).toBe(pluginPackage.name);
    expect(patchFile).toContain(`id: ${bundled?.rowId}`);
    expect(patchFile).toContain(`name: '${pluginPackage.name}'`);
    expect(pluginPackage.dsh.bundle.patch).toBe("./cordis.patch.yml");
  });

  it("ships the capability snapshot with the package", () => {
    // The snapshot is the only source that answers for models no endpoint
    // describes; losing it from `files` would ship a plugin that can say nothing.
    expect(pluginPackage.files).toContain("data");
    const parsed = parseCatalogue(snapshot);
    expect(parsed).toBeDefined();
    expect(Object.keys(parsed!.keys).length).toBeGreaterThan(200);
    expect(Object.values(parsed!.keys).some((entry) => (entry.m ?? []).includes("image"))).toBe(true);
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

  it("registers the standalone settings page, not a per-card block", () => {
    expect(bundleSource).toContain('ctx.slots.inject("settings.section"');
    expect(bundleSource).toContain('name: "settings.section"');
    expect(bundleSource).toContain('id: "model-capabilities"');
    // The page must not shadow the shipped Models section: only its own id seat.
    expect(bundleSource).not.toContain('id: "models"');
    expect(bundleSource).not.toContain("settings.models.provider-card");
  });

  it("passes the active language through the registration's inject face", () => {
    expect(bundleSource).toContain("inject: () => ({ lang: lang })");
    expect(bundleSource).toContain("ctx.locale.getSnapshot().active");
  });

  it("reads every host route it needs and surfaces failures as text", () => {
    for (const route of ["overview", "plan", "apply", "sync", "override", "catalogue", "seat"]) {
      expect(bundleSource).toContain(`/dsh-model-vision/${route}`);
    }
    expect(bundleSource).toContain("throw new Error((body && body.message)");
    expect(bundleSource).toContain("setError(");
  });

  it("references only theme variables the dsh client actually defines", () => {
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
      "dsw-alias-interactive-bg-hover",
      "dsw-alias-interactive-bg-active",
      "dsw-alias-state-error-primary",
      "dsw-alias-state-business-primary",
    ];
    const used = [...bundleSource.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1].slice(2));
    expect(used.length).toBeGreaterThan(0);
    for (const variable of new Set(used)) expect(real).toContain(variable);
    for (const fallback of [...bundleSource.matchAll(/var\(--[a-z0-9-]+,\s*([^)]+)\)/g)].map((match) => match[1].trim())) {
      if (/^#[0-9a-f]{3,8}$/i.test(fallback)) {
        const hex = fallback.slice(1);
        const channels =
          hex.length <= 4 ? hex.split("").map((c) => parseInt(c + c, 16)) : [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
        const luminance = (0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!) / 255;
        expect(luminance).toBeGreaterThan(0.45);
      }
    }
  });
});

describe("id normalization and family rules", () => {
  it("strips vendor prefixes, channel suffixes and separators", () => {
    expect(normalizeModelId("cline-pass/deepseek-v4.1-flash")).toBe("deepseek-v4-1-flash");
    expect(normalizeModelId("~openai/gpt-astra-latest")).toBe("gpt-astra");
    expect(normalizeModelId("gemini-3.5-flash-low")).toBe("gemini-3-5-flash");
    expect(normalizeModelId("z-ai/glm-5.3-flashx")).toBe("glm-5-3-flashx");
    expect(normalizeModelId("claude-opus-4-6-thinking")).toBe("claude-opus-4-6");
    // A routing decoration routes the same weights and must not hide a hit.
    expect(normalizeModelId("openai/gpt-oss-20b:free")).toBe("gpt-oss-20b");
    expect(normalizeModelId("google/gemma-4-31b-it:batch")).toBe("gemma-4-31b-it");
  });

  it("recognizes an image generator before the gpt-* vision rule", () => {
    // gpt-image-* shares the gpt prefix but accepts no image input.
    expect(ruleFor("gpt-image-2.5")?.name).toBe("image-generation");
    expect(ruleFor("gpt-image-2.5")?.input).toEqual(["text"]);
    expect(ruleFor("gpt-5.6-luna")?.name).toBe("vision-family");
    expect(ruleFor("codex-auto-review")?.name).toBe("text-only-special");
    expect(ruleFor("gemini-3-flash-agent")?.input).toEqual(["text", "image"]);
    expect(ruleFor("some-unknown-model")).toBeUndefined();
  });
});

describe("catalogue parsing", () => {
  it("reads the OpenRouter shape, including short-id aliases", () => {
    const keys = catalogueFromModels({
      data: [
        {
          id: "z-ai/glm-5.3-flashx",
          architecture: { input_modalities: ["text", "image", "video"] },
          context_length: 1048576,
          top_provider: { max_completion_tokens: 131072 },
        },
      ],
    });
    expect(keys["glm-5-3-flashx"]).toEqual({ i: "z-ai/glm-5.3-flashx", m: ["text", "image", "video"], c: 1048576, o: 131072 });
  });

  it("reads whatever capability fields an endpoint does publish", () => {
    const caps = upstreamCapabilities({ id: "auto", context_length: 256000, max_output_tokens: 32000 });
    expect(caps).toEqual({ contextWindow: 256000, maxTokens: 32000 });
    expect(upstreamCapabilities({ id: "x", object: "model", owned_by: "y" })).toEqual({});
    expect(upstreamCapabilities({ id: "x", input_modalities: ["image", "junk"] }).input).toEqual(["image"]);
  });

  it("points at a public catalogue and refuses a shapeless document", () => {
    // Its own merged catalogue first, a public directory as the fallback.
    expect(hostSource).toContain("https://dsh.zhuquan.xyz/dl/capabilities.json");
    expect(hostSource).toContain("CATALOGUE_FALLBACK_URL");
    expect(hostSource).toContain("https://openrouter.ai/api/v1/models");
    expect(parseCatalogue({ nope: true })).toBeUndefined();
  });
});

describe("capability resolution order", () => {
  const catalogue = { version: 1, generatedAt: "", source: "test", keys: { "glm-5-3-flashx": { i: "z-ai/glm-5.3-flashx", m: ["text", "image"], c: 1000000, o: 131072 } } };

  it("lets an explicit override win outright", () => {
    const caps = resolveCapabilities("z-ai/glm-5.3-flashx", {
      override: { input: ["text"] },
      catalogue,
      upstream: { input: ["text", "image"] },
    });
    expect(caps.input).toEqual({ value: ["text"], source: "manual" });
  });

  it("prefers the endpoint over the catalogue, and the catalogue over a rule", () => {
    const upstream = resolveCapabilities("z-ai/glm-5.3-flashx", { catalogue, upstream: { input: ["text"], contextWindow: 4096 } });
    expect(upstream.input.source).toBe("upstream");
    expect(upstream.contextWindow).toEqual({ value: 4096, source: "upstream" });
    const fromCatalogue = resolveCapabilities("z-ai/glm-5.3-flashx", { catalogue });
    expect(fromCatalogue.matched).toBe("z-ai/glm-5.3-flashx");
    expect(fromCatalogue.contextWindow.value).toBe(1000000);
    const fromRule = resolveCapabilities("gemini-9-nonexistent", { catalogue });
    expect(fromRule.input.source).toBe("rule");
    expect(fromRule.contextWindow.source).toBe("unknown");
  });

  it("leaves an unanswerable model unknown rather than guessing text-only", () => {
    const caps = resolveCapabilities("totally-unknown-model", { catalogue });
    expect(caps.input).toEqual({ value: undefined, source: "unknown" });
    expect(sourceLabel(caps.input.source)).toBe("未知");
    expect(sourceLabel("catalogue")).toBe("目录");
    // Family rules see the normalised id, so a dotted family must still match.
    expect(ruleFor("kimi-k2.7")?.input).toEqual(["text", "image"]);
    expect(ruleFor("gpt-4.1-mini")?.input).toEqual(["text", "image"]);
    expect(ruleFor("glm-4.5v")?.input).toEqual(["text", "image"]);
  });

  it("narrows every modality list to the engine's own vocabulary", () => {
    // A catalogue entry listing file/audio/video must not hand `file` to a schema
    // that accepts only text and image — the engine refuses the entire write.
    const rich = {
      version: 1,
      generatedAt: "",
      source: "test",
      keys: { "gemini-3-5-flash": { i: "google/gemini-3.5-flash", m: ["text", "image", "video", "file", "audio"], c: 1048576 } },
    };
    expect(resolveCapabilities("gemini-3.5-flash-low", { catalogue: rich }).input).toEqual({
      value: ["text", "image"],
      source: "catalogue",
    });
    const fileOnly = { version: 1, generatedAt: "", source: "test", keys: { weird: { i: "x/weird", m: ["file"] } } };
    expect(resolveCapabilities("weird", { catalogue: fileOnly }).input.source).toBe("unknown");
    expect(engineModalities(["image", "file", "image"])).toEqual(["image"]);
    expect(engineModalities("image")).toBeUndefined();
  });
});

describe("planning and applying", () => {
  const catalogue = {
    version: 1,
    generatedAt: "",
    source: "test",
    keys: {
      "gpt-5-6-luna": { i: "openai/gpt-5.6-luna", m: ["text", "image"], c: 1050000, o: 128000 },
      "new-model": { i: "vendor/new-model", m: ["text"], c: 200000, o: 8192 },
    },
  };

  it("classifies a new model, an unset field and a disagreement differently", () => {
    const plan = planRoute({
      route: "ouou",
      models: [
        { id: "gpt-5.6-luna", name: "GPT 5.6 Luna" },
        { id: "new-model" },
        { id: "keep-me" },
      ],
      stored: [
        { id: "gpt-5.6-luna", input: ["text"], contextWindow: 262144 },
        { id: "keep-me", input: ["text", "image"] },
      ],
      catalogue,
    });
    const luna = plan.models[0]!;
    // The stored context window disagrees with the catalogue → a correction waits.
    expect(luna.changes.map((change) => [change.field, change.verdict])).toEqual([
      ["input", "correct"],
      ["contextWindow", "correct"],
      ["maxTokens", "enrich"],
    ]);
    const fresh = plan.models[1]!;
    expect(fresh.present).toBe(false);
    expect(fresh.changes.every((change) => change.verdict === "add")).toBe(true);
    const kept = plan.models[2]!;
    // A stored declaration is an answer of its own: nothing to change, nothing unknown.
    expect(kept.present).toBe(true);
    expect(kept.capabilities.input).toEqual({ value: ["text", "image"], source: "declared" });
    expect(kept.changes).toEqual([]);
    expect(kept.unknown).toBe(false);
    expect(plan.counts).toMatchObject({ total: 3, added: 1, correctable: 1, unknown: 0 });
    expect(summarizePlan(plan)).toContain("3 个模型");
  });

  it("auto-applies additions and enrichment, and holds corrections until accepted", () => {
    const plan = planRoute({
      route: "ouou",
      models: [{ id: "gpt-5.6-luna" }, { id: "new-model" }],
      stored: [{ id: "gpt-5.6-luna", input: ["text"], contextWindow: 262144, name: "keep" }],
      catalogue,
    });
    const held = applyPlan({ stored: [{ id: "gpt-5.6-luna", input: ["text"], contextWindow: 262144, name: "keep" }], plan });
    // Corrections untouched, enrichment applied, the new model appended.
    expect(held[0]).toEqual({ id: "gpt-5.6-luna", input: ["text"], contextWindow: 262144, name: "keep", maxTokens: 128000 });
    expect(held[1]).toMatchObject({ id: "new-model", input: ["text"], contextWindow: 200000, maxTokens: 8192 });
    const accepted = applyPlan({
      stored: [{ id: "gpt-5.6-luna", input: ["text"], contextWindow: 262144, name: "keep" }],
      plan,
      accepted: ["gpt-5.6-luna"],
    });
    expect(accepted[0]).toMatchObject({ input: ["text", "image"], contextWindow: 1050000, name: "keep" });
  });

  it("keeps every entry the plan does not name, and every field it does not touch", () => {
    const stored = [
      { id: "untouched", name: "U", contextWindow: 1, extra: { nested: true } },
      { id: "gpt-5.6-luna", name: "L" },
    ];
    const plan = planRoute({ route: "ouou", models: [{ id: "gpt-5.6-luna" }], stored, catalogue });
    const next = applyPlan({ stored, plan });
    expect(next[0]).toEqual(stored[0]);
    expect(next[1]).toMatchObject({ id: "gpt-5.6-luna", name: "L", input: ["text", "image"] });
  });

  it("reads stored modalities the way the engine does", () => {
    expect(normalizedInput(["text", "image", "junk"])).toEqual(["text", "image"]);
    expect(normalizedInput([])).toBeUndefined();
    expect(normalizedInput("text")).toBeUndefined();
    expect(MODALITIES).toEqual(["text", "image"]);
  });
});

describe("host wiring", () => {
  it("never addresses an array element in a settings path", () => {
    // applyPathOp walks plain objects only, so the whole models array is restated.
    const pathOps = [...hostSource.matchAll(/path: \[([^\]]*)\]/g)].map((match) => match[1] ?? "");
    expect(pathOps.length).toBeGreaterThan(0);
    for (const op of pathOps) {
      expect(op).not.toMatch(/String\(|idx|index/);
      expect(op).not.toContain("${");
    }
  });

  it("schedules a daily catalogue refresh and tolerates being offline", () => {
    expect(hostSource).toContain("CATALOGUE_MAX_AGE_MS");
    expect(hostSource).toContain("setInterval(");
    expect(hostSource).toContain("内置能力目录读取失败");
    expect(hostSource).toContain("能力目录刷新失败");
  });
});
