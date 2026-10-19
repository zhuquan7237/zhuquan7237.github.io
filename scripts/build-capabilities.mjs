#!/usr/bin/env node
/**
 * Build the shared model-capability catalogue served from dsh.zhuquan.xyz.
 *
 * A gateway's own /v1/models says almost nothing about what a model accepts:
 * measured across the six routes on the author's machine, one publishes a
 * context length, one publishes nothing at all. Every desktop client therefore
 * needs the same answer to the same question — does this model take an image,
 * how long is its context, how much can it emit — and that answer can be built
 * once, centrally, instead of per machine.
 *
 * This script reads public model directories, merges them, and writes the
 * catalogue the model-vision plugin fetches. It runs on a schedule in CI, so it
 * needs neither the author's machine nor any credential.
 *
 *   node scripts/build-capabilities.mjs                    # network
 *   node scripts/build-capabilities.mjs --offline <dir>     # rehearse from saved JSON
 *   node scripts/build-capabilities.mjs --out <path>
 *
 * Exit code is non-zero when a source fails or the result regresses, so a bad
 * run turns CI red instead of quietly publishing a thin catalogue.
 */

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const require = createRequire(import.meta.url);

const SOURCES = {
  openrouter: "https://openrouter.ai/api/v1/models",
  modelsdev: "https://models.dev/api.json",
};

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const OFFLINE = flag("offline", "");
const OUT = path.resolve(ROOT, flag("out", "dl/capabilities.json"));
const OVERRIDES = path.resolve(ROOT, "dl/capabilities-overrides.json");
// Produced on the author's machine by scripts/collect-gateway-capabilities.py:
// private gateways publish capability metadata for models no public directory
// lists, and CI cannot reach them (their keys never leave the machine).
const GATEWAYS = path.resolve(ROOT, "dl/capabilities-gateways.json");
const TIMEOUT_MS = 90_000;

/**
 * The plugin's own normaliser, taken from its built bundle rather than
 * reimplemented: an artifact key this script invents is a key the plugin will
 * never look up, and a drifting copy would look correct in review.
 */
function loadNormalizer() {
  const candidates = [
    path.resolve(ROOT, "desktop/resources/plugins/model-vision/lib/capabilities.js"),
    path.resolve(ROOT, "desktop/resources/plugins/model-vision/src/capabilities.ts"),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const mod = require(file);
      if (typeof mod.normalizeModelId === "function") return mod.normalizeModelId;
    } catch {
      // A TypeScript entry cannot be required; fall through to the built bundle.
    }
  }
  throw new Error("model-vision's normalizeModelId was not found — build the plugin first");
}

/**
 * Keys a single model id must be reachable under. Beyond the plugin's own
 * normalisation we also drop vendor-routing decorations (`:free`, `:batch`)
 * and the vendor prefix, so a lookup succeeds whichever form the caller holds.
 */
function keysFor(id, normalizeModelId) {
  const variants = new Set([id, String(id).split("/").pop() ?? id]);
  // Strip a routing decoration only, never a region prefix (`cn:model` names a
  // route, not a decoration — the plugin's normaliser already removes it).
  const undecorate = (value) => String(value).replace(/:(free|batch|extended|nitro|floor|online|thinking)$/i, "");
  for (const value of [...variants]) variants.add(undecorate(value));
  const keys = new Set();
  for (const value of variants) {
    if (!value) continue;
    keys.add(normalizeModelId(value));
    keys.add(normalizeModelId(undecorate(value)));
    // Alias for a client whose normaliser predates decoration stripping: a
    // published catalogue must not stop answering an installer already out there.
    keys.add(String(value).trim().toLowerCase().replace(/^[~@]+/, "").replace(/[._\s]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, ""));
  }
  return [...keys].filter(Boolean);
}

/** Keep only the modalities the engine can act on; a stray `file` refuses a whole write. */
function engineModalities(list) {
  const kept = (Array.isArray(list) ? list : []).filter((m) => m === "text" || m === "image");
  return [...new Set(kept)];
}

const positive = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined);

/**
 * Reasoning levels the engine's selector can name (dsh-llm-pi-ai THINKING_LEVELS).
 * A source that spells a level differently cannot be offered as that level, so
 * unknown spellings are dropped here rather than shipped for clients to ignore.
 */
const REASONING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Keep only effort spellings a client can actually offer as levels. */
function engineEfforts(values) {
  const kept = (Array.isArray(values) ? values : [])
    .map((value) => String(value ?? "").trim().toLowerCase())
    .filter((value) => REASONING_LEVELS.has(value));
  return [...new Set(kept)];
}

/**
 * One directory row's reasoning: `0` for a model that does not reason, `1` for
 * one that reasons with no named levels, or the effort spellings it accepts.
 */
function reasoningFields(model) {
  const options = Array.isArray(model?.reasoning_options) ? model.reasoning_options : [];
  const efforts = [];
  let toggle = false;
  for (const option of options) {
    const type = String(option?.type ?? "");
    if (type === "effort") efforts.push(...engineEfforts(option?.values));
    else if (type === "toggle" || type === "budget_tokens") toggle = true;
  }
  if (efforts.length > 0) return [...new Set(efforts)];
  if (toggle) return 1;
  if (model?.reasoning === false) return 0;
  return undefined;
}

/** One provider directory → the same flat shape for every source. */
function openRouterModels(doc) {
  const rows = Array.isArray(doc?.data) ? doc.data : [];
  return rows.map((row) => ({
    id: String(row?.id ?? ""),
    modalities: engineModalities(row?.architecture?.input_modalities),
    context: positive(row?.context_length),
    output: positive(row?.top_provider?.max_completion_tokens ?? row?.per_request_limits?.max_completion_tokens),
    // OpenRouter names the reasoning parameters a model accepts but not the
    // levels, so this is the weakest positive signal: "it reasons".
    reasoning: (row?.supported_parameters ?? []).some((name) => name === "reasoning" || name === "reasoning_effort") ? 1 : undefined,
  }));
}

/**
 * Which directory provider speaks for a model's vendor. A vendor's own row is a
 * statement about the model; a reseller's row is a statement about one
 * deployment, so the two cannot be averaged.
 */
const VENDOR_OF = [
  [/^deepseek/, ["deepseek"]],
  [/^(glm|zai)/, ["zai"]],
  [/^(kimi|moonshot)/, ["moonshotai"]],
  [/^(gpt|chatgpt|o[0-9])/, ["openai"]],
  [/^claude/, ["anthropic"]],
  [/^(gemini|gemma)/, ["google"]],
  [/^grok/, ["xai"]],
  [/^qwen/, ["alibaba", "alibaba-cn"]],
  [/^mimo/, ["xiaomi"]],
  [/^minimax/, ["minimax"]],
  [/^llama/, ["meta"]],
  [/^(mistral|magistral|devstral)/, ["mistral"]],
];

function isVendorRow(providerId, modelId) {
  const key = String(modelId || "").toLowerCase().replace(/[._\s]+/g, "-");
  return VENDOR_OF.some(([test, providers]) => test.test(key) && providers.includes(providerId));
}

function modelsDevModels(doc) {
  const rows = [];
  for (const [providerId, provider] of Object.entries(doc ?? {})) {
    for (const model of Object.values(provider?.models ?? {})) {
      const modalities = engineModalities(model?.modalities?.input);
      // `attachment` is the directory's own flag for accepting uploads; it is
      // trusted only as a positive signal when the modality list is absent.
      const attachment = model?.attachment === true;
      rows.push({
        id: String(model?.id ?? ""),
        modalities: modalities.length > 0 ? modalities : attachment ? ["text", "image"] : ["text"],
        context: positive(model?.limit?.context),
        output: positive(model?.limit?.output),
        reasoning: reasoningFields(model),
        vendor: isVendorRow(providerId, model?.id ?? ""),
      });
    }
  }
  return rows;
}

async function fetchJson(url, offlineName) {
  if (OFFLINE) {
    const file = path.join(OFFLINE, offlineName);
    if (!existsSync(file)) throw new Error(`offline copy missing: ${file}`);
    return JSON.parse(readFileSync(file, "utf8"));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "user-agent": "dsh-capabilities-builder" } });
    if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Which catalogue states a model's reasoning levels, and whose answer wins.
 *
 * Directories disagree because each mirrors one deployment, and taking
 * whichever row happened to come first made DeepSeek depend on dictionary
 * order. The policy, in order:
 *
 *  1. the endpoint's own `/v1/models` answer (a gateway knows what it accepts);
 *  2. the vendor's own directory row (`zai` for GLM, `openai` for GPT);
 *  3. the most common complete set among the mirrors, when at least two agree;
 *  4. otherwise "it reasons, no named levels" — honest, not invented.
 *
 * Hand-written `dl/capabilities-overrides.json` rows still outrank all of this.
 */
const LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const sortLevels = (levels) => [...new Set(levels)].sort((a, b) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b));

function noteReasoning(evidence, key, value, { vendor = false, endpoint = false, manual = false } = {}) {
  let slot = evidence.get(key);
  if (!slot) {
    slot = { sets: new Map(), vendorSet: undefined, endpointSet: undefined, manualSet: undefined, toggle: 0, none: 0, enumerations: 0 };
    evidence.set(key, slot);
  }
  if (Array.isArray(value)) {
    slot.enumerations += 1;
    const signature = value.join(",");
    slot.sets.set(signature, (slot.sets.get(signature) ?? 0) + 1);
    if (endpoint && !slot.endpointSet) slot.endpointSet = value;
    if (vendor && !slot.vendorSet) slot.vendorSet = value;
    if (manual && !slot.manualSet) slot.manualSet = value;
  } else if (value === 1) {
    slot.toggle += 1;
  } else if (value === 0) {
    slot.none += 1;
  }
}

function decideReasoning(slot) {
  if (!slot) return undefined;
  if (slot.manualSet) return sortLevels(slot.manualSet);
  if (slot.endpointSet) return sortLevels(slot.endpointSet);
  if (slot.vendorSet) return sortLevels(slot.vendorSet);
  // More mirrors describe it as "reasons, no named levels" than enumerate any:
  // do not invent a ladder just because two resellers copied one.
  if (slot.toggle > slot.enumerations) return slot.none > slot.toggle ? 0 : 1;
  if (slot.sets.size > 0) {
    const ranked = [...slot.sets.entries()].sort((a, b) => b[1] - a[1] || b[0].split(",").length - a[0].split(",").length);
    const [signature, votes] = ranked[0];
    // Two independent mirrors agreeing is evidence; a lone source is still the
    // only answer available when nothing else enumerates.
    if (votes >= 2 || slot.enumerations === votes) return sortLevels(signature.split(","));
    return 1;
  }
  if (slot.none > 0 && slot.none >= slot.toggle) return 0;
  return slot.toggle > 0 ? 1 : undefined;
}

/**
 * Variants inherit from their base model, but only when the base is specific
 * enough to be a family (`gpt-5-5` → `gpt-5-5-openai-compact`) or the suffix is
 * a known variant tag (`hy3-x`). A one-token base with an arbitrary tail
 * (`grok` → `grok-chat-auto`) proves nothing and is left alone.
 */
const VARIANT_TAGS = new Set(["x", "b", "c", "1", "2", "3", "4", "compact", "fast", "slow", "auto", "expert", "heavy", "lite", "edit", "pro", "mini", "air", "exp", "ctrl", "lkeap", "volc", "taiji", "highspeed", "agent"]);

function inheritReasoning(keys) {
  const donors = Object.entries(keys).filter(([, entry]) => Array.isArray(entry.r));
  for (const [key, entry] of Object.entries(keys)) {
    if (entry.r !== undefined && entry.r !== 1) continue; // explicit 0 or an own list stands
    let best;
    for (const [donorKey, donor] of donors) {
      if (donorKey === key || !key.startsWith(`${donorKey}-`)) continue;
      const tail = key.slice(donorKey.length + 1).split("-");
      const base = donorKey.split("-").length;
      const fits = (base >= 2 && tail.length <= 2) || (tail.length === 1 && VARIANT_TAGS.has(tail[0]));
      if (fits && (!best || donorKey.length > best[0].length)) best = [donorKey, donor];
    }
    if (best) entry.r = best[1].r.slice();
  }
}

async function main() {
  const normalizeModelId = loadNormalizer();

  const fetched = {};
  const problems = [];
  for (const [name, url] of Object.entries(SOURCES)) {
    try {
      fetched[name] = await fetchJson(url, `${name}.json`);
      console.log(`fetched ${name}`);
    } catch (error) {
      problems.push(`${name}: ${error.message}`);
    }
  }
  if (problems.length === Object.keys(SOURCES).length) throw new Error(`every source failed — ${problems.join("; ")}`);

  // Authority: a hand-written override beats the directories, and the directory
  // that carries per-provider limits beats the one that mirrors a single router.
  const layers = [];
  if (existsSync(OVERRIDES)) {
    const raw = JSON.parse(readFileSync(OVERRIDES, "utf8"));
    const rows = Array.isArray(raw?.models) ? raw.models : [];
    layers.push(["manual", rows.map((row) => ({
      id: String(row?.id ?? ""),
      modalities: engineModalities(row?.modalities),
      context: positive(row?.context),
      output: positive(row?.output),
      reasoning: row?.reasoning === undefined ? undefined : Array.isArray(row.reasoning) ? engineEfforts(row.reasoning) : positive(row.reasoning),
    }))]);
    console.log(`overrides ${rows.length}`);
  }
  if (existsSync(GATEWAYS)) {
    const raw = JSON.parse(readFileSync(GATEWAYS, "utf8"));
    const rows = Array.isArray(raw?.models) ? raw.models : [];
    layers.push(["gateway", rows.map((row) => ({
      id: String(row?.id ?? ""),
      modalities: engineModalities(row?.modalities),
      context: positive(row?.context),
      output: positive(row?.output),
      reasoning: row?.reasoning === undefined ? undefined : Array.isArray(row.reasoning) ? engineEfforts(row.reasoning) : positive(row.reasoning),
    }))]);
    console.log(`gateways ${rows.length} (${raw?.generatedAt ?? "unknown"})`);
  }
  if (fetched.modelsdev) layers.push(["models.dev", modelsDevModels(fetched.modelsdev)]);
  if (fetched.openrouter) layers.push(["openrouter", openRouterModels(fetched.openrouter)]);
  const keys = {};
  const evidence = new Map();
  const counts = {};
  for (const [source, rows] of layers) {
    let kept = 0;
    for (const row of rows) {
      if (!row.id) continue;
      for (const key of keysFor(row.id, normalizeModelId)) {
        const entry = (keys[key] ??= { i: row.id });
        if (row.modalities.length > 0 && !entry.m) entry.m = row.modalities;
        if (row.context !== undefined && !entry.c) entry.c = row.context;
        if (row.output !== undefined && !entry.o) entry.o = row.output;
        if (row.reasoning !== undefined) noteReasoning(evidence, key, row.reasoning, { vendor: row.vendor === true, endpoint: source === "gateway", manual: source === "manual" });
        if (!entry.s) entry.s = source;
      }
      kept += 1;
    }
    counts[source] = kept;
  }

  for (const [key, entry] of Object.entries(keys)) entry.r = decideReasoning(evidence.get(key), key);

  inheritReasoning(keys);

  const total = Object.keys(keys).length;
  const withImage = Object.values(keys).filter((entry) => (entry.m ?? []).includes("image")).length;
  const withContext = Object.values(keys).filter((entry) => entry.c !== undefined).length;
  const withReasoning = Object.values(keys).filter((entry) => Array.isArray(entry.r)).length;

  // Regression guard: a source changing shape must fail the run, not halve the
  // catalogue every client silently relies on. A publication timestamp is not a
  // change either — rewriting the file for it alone would commit half a megabyte
  // a day and redeploy the site for nothing, so the timestamp describes the data.
  if (existsSync(OUT)) {
    let previous;
    try {
      previous = JSON.parse(readFileSync(OUT, "utf8"));
    } catch {
      previous = undefined;
    }
    const before = Object.keys(previous?.keys ?? {}).length;
    if (before > 200 && total < before * 0.8) {
      throw new Error(`refusing to publish ${total} keys after ${before} — a source probably changed shape`);
    }
    if (previous && before === total && JSON.stringify(previous.keys) === JSON.stringify(keys)) {
      console.log(`unchanged — keeping the published catalogue (${before} keys, ${previous.generatedAt})`);
      return;
    }
    console.log(`previous ${before} keys`);
  }

  const doc = {
    version: 2,
    generatedAt: new Date().toISOString(),
    source: "dsh.zhuquan.xyz",
    counts,
    total,
    withImage,
    withContext,
    withReasoning,
    keys,
  };
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(doc)}\n`, "utf8");
  const bytes = readFileSync(OUT).length;
  console.log(`wrote ${path.relative(ROOT, OUT)} — ${total} keys, ${withImage} image, ${withContext} context, ${withReasoning} with effort levels, ${(bytes / 1024).toFixed(1)} KB`);
  if (problems.length > 0) console.log(`incomplete sources: ${problems.join("; ")}`);
}

main().catch((error) => {
  console.error(`build-capabilities failed: ${error.message}`);
  process.exit(1);
});
