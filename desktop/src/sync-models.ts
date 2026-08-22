import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";

export interface ProviderInfo {
  id: string;
  name: string;
  baseURL: string;
  modelCount: number;
  models: string[];
}

export interface SyncResult {
  success: boolean;
  count: number;
  providers: string[];
  error?: string;
  details?: { id: string; added: number; total: number }[];
}

/**
 * Model-list sync against the engine's real settings schema.
 *
 * dsh keeps providers under `llm-pi-ai.providers` as a map of
 * `{ apiKeyEnv?, baseURL?, api?, models? }`. A provider without a `models`
 * list serves the static catalog shipped inside the engine's
 * `@earendil-works/pi-ai` package, which lags behind the gateway. Configuring
 * `models` replaces the served catalog, so sync fetches the live list from
 * the gateway (Anthropic-style `/v1/models` first — OpenCode Zen and other
 * anthropic-compatible gateways only serve that shape — then OpenAI-style
 * `/models`) and merges remote-only ids in. Entries are never removed: a
 * user-curated list only grows. Catalog-known models stay minimal `{ id }`
 * entries so engine defaults (pricing, context window, wire protocol) keep
 * applying; unknown models carry the fields the engine cannot infer.
 */

const PI_AI_DATA_DIR = path.join(
  "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data",
);

interface CatalogModel {
  id: string;
  baseUrl?: string;
}

interface ProviderCatalog {
  baseUrl?: string;
  dominantApi?: string;
  baseUrlByApi: Map<string, string>;
  models: Map<string, CatalogModel>;
}

function readProviderCatalog(harnessPrefix: string | undefined, providerId: string): ProviderCatalog | null {
  if (!harnessPrefix) return null;
  const file = path.join(harnessPrefix, PI_AI_DATA_DIR, `${providerId}.json`);
  let raw: Record<string, Record<string, CatalogModel & { baseUrl?: string }>>;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const models = new Map<string, CatalogModel>();
  const apiCounts = new Map<string, number>();
  const baseUrlCounts = new Map<string, number>();
  const baseUrlByApi = new Map<string, string>();
  for (const [api, group] of Object.entries(raw)) {
    if (!group || typeof group !== "object") continue;
    let added = 0;
    const groupBaseCounts = new Map<string, number>();
    for (const model of Object.values(group)) {
      if (!model || typeof model !== "object") continue;
      models.set(model.id, { id: model.id, baseUrl: model.baseUrl });
      if (model.baseUrl) {
        baseUrlCounts.set(model.baseUrl, (baseUrlCounts.get(model.baseUrl) ?? 0) + 1);
        groupBaseCounts.set(model.baseUrl, (groupBaseCounts.get(model.baseUrl) ?? 0) + 1);
      }
      added += 1;
    }
    if (added > 0) {
      apiCounts.set(api, (apiCounts.get(api) ?? 0) + added);
      let groupBase: string | undefined;
      let groupBest = 0;
      for (const [url, count] of groupBaseCounts) {
        if (count > groupBest) {
          groupBase = url;
          groupBest = count;
        }
      }
      if (groupBase) baseUrlByApi.set(api, groupBase);
    }
  }
  let dominantApi: string | undefined;
  let best = 0;
  for (const [api, count] of apiCounts) {
    if (count > best) {
      dominantApi = api;
      best = count;
    }
  }
  let baseUrl: string | undefined;
  let baseBest = 0;
  for (const [url, count] of baseUrlCounts) {
    if (count > baseBest) {
      baseUrl = url;
      baseBest = count;
    }
  }
  return { baseUrl, dominantApi, baseUrlByApi, models };
}

function readCredentialRefs(dshHome: string): Record<string, string> {
  try {
    const parsed = (yaml.load(
      fs.readFileSync(path.join(dshHome, ".credentials.yaml"), "utf8"),
    ) || {}) as { refs?: Record<string, string> };
    return parsed.refs && typeof parsed.refs === "object" ? parsed.refs : {};
  } catch {
    return {};
  }
}

function resolveApiKey(dshHome: string, apiKeyEnv?: string): string | undefined {
  if (!apiKeyEnv) return undefined;
  const fromEnv = process.env[apiKeyEnv];
  if (fromEnv) return fromEnv;
  return readCredentialRefs(dshHome)[apiKeyEnv];
}

function modelIdOf(entry: unknown): string {
  if (typeof entry === "string") return entry;
  const id = (entry as { id?: unknown })?.id;
  return typeof id === "string" ? id : "";
}

async function fetchJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Try `/v1/models` then `/models`, Bearer then anthropic headers, first JSON list wins. */
export async function fetchRemoteModelIds(baseURL: string, apiKey?: string): Promise<string[]> {
  const base = baseURL.trim().replace(/\/+$/, "");
  const auths: Record<string, string>[] = [];
  if (apiKey) {
    auths.push({ Authorization: `Bearer ${apiKey}` });
    auths.push({ "x-api-key": apiKey, "anthropic-version": "2023-06-01" });
  } else {
    auths.push({});
  }
  for (const suffix of ["/v1/models", "/models"]) {
    for (const auth of auths) {
      const data = await fetchJson(`${base}${suffix}`, { ...auth, Accept: "application/json" }, 8000);
      const items = Array.isArray(data)
        ? data
        : ((data as { data?: unknown[]; models?: unknown[] })?.data ?? (data as { models?: unknown[] })?.models);
      if (!Array.isArray(items)) continue;
      const ids: string[] = [];
      for (const item of items) {
        const id = typeof item === "string" ? item : (item as { id?: unknown })?.id ?? (item as { name?: unknown })?.name;
        if (typeof id === "string" && id && !ids.includes(id)) ids.push(id);
      }
      if (ids.length > 0) return ids;
    }
  }
  return [];
}

function resolveSettingsFile(dshHome?: string): string {
  const home = dshHome || process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "settings.yaml");
}

type ProviderConfig = {
  apiKeyEnv?: string;
  baseURL?: string;
  api?: string;
  models?: unknown[];
};

function readProviderConfigs(parsed: Record<string, unknown>): Map<string, ProviderConfig> {
  const result = new Map<string, ProviderConfig>();
  const llm = parsed["llm-pi-ai"] as { providers?: Record<string, ProviderConfig> } | undefined;
  const providers = llm?.providers;
  if (!providers || typeof providers !== "object") return result;
  for (const [id, cfg] of Object.entries(providers)) {
    if (cfg && typeof cfg === "object") result.set(id, cfg as ProviderConfig);
  }
  return result;
}

function effectiveModels(
  cfg: ProviderConfig,
  catalog: ProviderCatalog | null,
): { entries: unknown[]; ids: Set<string> } {
  if (Array.isArray(cfg.models)) {
    return { entries: [...cfg.models], ids: new Set(cfg.models.map(modelIdOf).filter(Boolean)) };
  }
  const entries = [...(catalog?.models.keys() ?? [])].map((id) => ({ id }));
  return { entries, ids: new Set(entries.map((e) => modelIdOf(e)).filter(Boolean)) };
}

export async function getProvidersInfo(dshHome?: string, harnessPrefix?: string): Promise<ProviderInfo[]> {
  const filePath = resolveSettingsFile(dshHome);
  if (!fs.existsSync(filePath)) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = (yaml.load(fs.readFileSync(filePath, "utf8")) || {}) as Record<string, unknown>;
  } catch {
    return [];
  }
  const result: ProviderInfo[] = [];
  for (const [id, cfg] of readProviderConfigs(parsed)) {
    const catalog = readProviderCatalog(harnessPrefix, id);
    const { entries } = effectiveModels(cfg, catalog);
    const models = entries.map(modelIdOf).filter(Boolean);
    result.push({
      id,
      name: id,
      baseURL: cfg.baseURL || catalog?.baseUrl || "",
      modelCount: models.length,
      models,
    });
  }
  return result;
}

export async function syncAllProviderModels(dshHome?: string, harnessPrefix?: string): Promise<SyncResult> {
  const home = dshHome || process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const filePath = resolveSettingsFile(home);
  if (!fs.existsSync(filePath)) {
    return { success: false, count: 0, providers: [], error: `配置文件不存在: ${filePath}` };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = (yaml.load(fs.readFileSync(filePath, "utf8")) || {}) as Record<string, unknown>;
  } catch (err: any) {
    return { success: false, count: 0, providers: [], error: `读取配置文件失败: ${err?.message || err}` };
  }

  const configs = readProviderConfigs(parsed);
  if (configs.size === 0) {
    return { success: true, count: 0, providers: [], details: [] };
  }

  let totalNew = 0;
  const updatedProviders: string[] = [];
  const details: { id: string; added: number; total: number }[] = [];

  await Promise.all(
    [...configs.entries()].map(async ([id, cfg]) => {
      const catalog = readProviderCatalog(harnessPrefix, id);
      const baseURL = cfg.baseURL || catalog?.baseUrl;
      if (!baseURL) return;

      const remoteIds = await fetchRemoteModelIds(baseURL, resolveApiKey(home, cfg.apiKeyEnv));
      if (remoteIds.length === 0) return;

      const { entries, ids } = effectiveModels(cfg, catalog);
      let added = 0;
      for (const remoteId of remoteIds) {
        if (ids.has(remoteId)) continue;
        const known = catalog?.models.get(remoteId);
        const entry: Record<string, unknown> = known ? { id: remoteId } : { id: remoteId, name: remoteId };
        if (!known) {
          const api = cfg.api ?? catalog?.dominantApi;
          if (!api) continue; // cannot build a valid entry without a wire protocol
          entry.api = api;
          // Base URLs are per wire protocol on gateways that multiplex
          // (OpenCode Zen: anthropic at /go, OpenAI at /go/v1).
          const apiBase = catalog?.baseUrlByApi.get(api) ?? catalog?.baseUrl ?? baseURL;
          if (!cfg.baseURL) entry.baseURL = apiBase;
        }
        entries.push(entry);
        ids.add(remoteId);
        added += 1;
      }
      if (added === 0) return;

      cfg.models = entries;
      totalNew += added;
      updatedProviders.push(id);
      details.push({ id, added, total: entries.length });
    }),
  );

  if (totalNew > 0) {
    try {
      const dump = yaml.dump(parsed, { indent: 2, lineWidth: -1, noRefs: true });
      fs.writeFileSync(filePath, dump, "utf8");
    } catch (err: any) {
      return { success: false, count: totalNew, providers: updatedProviders, error: `写入配置文件失败: ${err?.message || err}` };
    }
  }

  return { success: true, count: totalNew, providers: updatedProviders, details };
}
