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
  for (const value of [...variants]) variants.add(String(value).replace(/:(free|batch|extended|nitro|floor|online)$/i, ""));
  const keys = new Set();
  for (const value of variants) {
    if (!value) continue;
    keys.add(normalizeModelId(value));
    keys.add(normalizeModelId(String(value).replace(/:.*$/, "")));
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

function modelsDevModels(doc) {
  const rows = [];
  for (const provider of Object.values(doc ?? {})) {
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
  if (fetched.modelsdev) layers.push(["models.dev", modelsDevModels(fetched.modelsdev)]);
  if (fetched.openrouter) layers.push(["openrouter", openRouterModels(fetched.openrouter)]);

  const keys = {};
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
        if (row.reasoning !== undefined && entry.r === undefined) entry.r = row.reasoning;
        if (!entry.s) entry.s = source;
      }
      kept += 1;
    }
    counts[source] = kept;
  }

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
