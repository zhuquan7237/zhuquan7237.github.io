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
 * dsh keeps providers under `llm-pi-ai.providers` as a map. A provider the
 * engine's pi-ai catalog knows serves that catalog unchanged; a hand-declared
 * provider (the shape the harness UI's "add provider" card writes) carries
 * route-level `api` + `baseURL` plus a `models` list of `{ id, ... }` entries.
 * Model entries have no per-entry `api`/`baseURL` fields — writing them (as
 * 0.2.5 did) makes the engine reject the whole llm-pi-ai section: models stop
 * loading and every settings.mutate in the namespace (including adding a
 * provider in the UI) answers settings-rejected.
 *
 * Sync therefore never touches an existing provider profile. Gateway models
 * that the installed catalog does not know land in a separate companion route
 * `<id>-sync` written in exactly the hand-declared shape, sharing the parent's
 * credential reference; the parent keeps serving the catalog (pricing,
 * context windows, per-model wire protocols) untouched. Custom providers
 * already own api + baseURL, so new ids append to their models list as bare
 * `{ id }` entries. Everything is merge-only: entries are never removed, and
 * user-curated lists on catalog providers are left alone.
 */

const PI_AI_DATA_DIR = path.join(
  "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data",
);

const SYNC_ROUTE_SUFFIX = "-sync";

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
  let raw: Record<string, Record<string, CatalogModel>>;
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

type ModelEntry = Record<string, unknown>;

interface ProviderConfig {
  apiKeyEnv?: string;
  displayName?: string;
  api?: string;
  baseURL?: string;
  models?: ModelEntry[];
  [key: string]: unknown;
}

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

/**
 * Strip entries 0.2.5 wrote with per-model `api`/`baseURL` fields the engine's
 * model schema does not have. Catalog-known ids keep bare `{ id }`; unknown ids
 * move to the companion sync route. Returns the cleaned entries (null when the
 * list was not poisoned) and the ids to relocate.
 */
function remediatePoisonedModels(
  cfg: ProviderConfig,
  catalog: ProviderCatalog | null,
): { clean: ModelEntry[] | null; relocate: string[] } {
  if (!Array.isArray(cfg.models)) return { clean: null, relocate: [] };
  let poisoned = false;
  const clean: ModelEntry[] = [];
  const relocate: string[] = [];
  for (const raw of cfg.models) {
    if (raw && typeof raw === "object" && ("api" in raw || "baseURL" in raw)) {
      poisoned = true;
      const id = modelIdOf(raw);
      if (id && !catalog?.models.has(id)) relocate.push(id);
      else if (id) clean.push({ id });
    } else {
      clean.push(raw as ModelEntry);
    }
  }
  return poisoned ? { clean, relocate } : { clean: null, relocate };
}

function syncRouteId(providerId: string): string {
  return `${providerId}${SYNC_ROUTE_SUFFIX}`;
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
    const configured = Array.isArray(cfg.models)
      ? cfg.models.map(modelIdOf).filter(Boolean)
      : [...(catalog?.models.keys() ?? [])];
    result.push({
      id,
      name: cfg.displayName || id,
      baseURL: cfg.baseURL || catalog?.baseUrl || "",
      modelCount: configured.length,
      models: configured,
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
      if (id.endsWith(SYNC_ROUTE_SUFFIX)) return; // companion routes are managed below
      const catalog = readProviderCatalog(harnessPrefix, id);
      const fetchBase = cfg.baseURL || catalog?.baseUrl;
      const { clean, relocate } = remediatePoisonedModels(cfg, catalog);
      const remoteIds = fetchBase ? await fetchRemoteModelIds(fetchBase, resolveApiKey(home, cfg.apiKeyEnv)) : [];
      if (remoteIds.length === 0 && relocate.length === 0 && clean === null) return;

      const isCatalogRoute = catalog !== null && catalog.models.size > 0;
      if (!isCatalogRoute && typeof cfg.api === "string" && cfg.baseURL) {
        // A hand-declared provider already owns its protocol and endpoint:
        // strip any 0.2.5 poison, then append unknown ids to its own models.
        const models = clean ?? (Array.isArray(cfg.models) ? cfg.models : []);
        const known = new Set(models.map(modelIdOf).filter(Boolean));
        let added = 0;
        for (const rid of [...relocate, ...remoteIds]) {
          if (!rid || known.has(rid)) continue;
          models.push({ id: rid });
          known.add(rid);
          added += 1;
        }
        cfg.models = models;
        if (added > 0 || clean !== null) {
          totalNew += added;
          updatedProviders.push(id);
          details.push({ id, added, total: models.length });
        }
        return;
      }

      // Catalog route: the parent keeps serving the catalog untouched (only
      // stripped when 0.2.5 poisoned it); unknown gateway models go to the
      // companion sync route in the hand-declared shape.
      if (clean !== null) cfg.models = clean;
      const api = cfg.api ?? catalog?.dominantApi;
      if (!api) return;
      const apiBase = catalog?.baseUrlByApi.get(api) ?? cfg.baseURL ?? catalog?.baseUrl;
      if (!apiBase) return;

      const routeKey = syncRouteId(id);
      const providers = (parsed["llm-pi-ai"] as { providers: Record<string, ProviderConfig> }).providers;
      let companion = providers[routeKey];
      const existing = Array.isArray(companion?.models) ? companion!.models! : [];
      const known = new Set(existing.map(modelIdOf).filter(Boolean));
      // Gateway-new = remote ids neither the installed catalog nor the
      // parent's own (possibly user-curated) list already serves.
      const parentServes = new Set([
        ...(catalog?.models.keys() ?? []),
        ...(Array.isArray(cfg.models) ? cfg.models.map(modelIdOf) : []),
      ]);
      const candidates = new Set(relocate);
      if (remoteIds.length > 0) {
        for (const rid of remoteIds) {
          if (!parentServes.has(rid)) candidates.add(rid);
        }
      }
      let added = 0;
      for (const rid of candidates) {
        if (!rid || known.has(rid)) continue;
        existing.push({ id: rid });
        known.add(rid);
        added += 1;
      }
      if (added === 0 && !companion) return;

      providers[routeKey] = {
        ...(companion ?? {}),
        displayName: (companion?.displayName as string) || `${id}${SYNC_ROUTE_SUFFIX}`,
        apiKeyEnv: cfg.apiKeyEnv || (companion?.apiKeyEnv as string) || `${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`,
        api,
        baseURL: apiBase,
        models: existing,
      };
      if (added > 0 || clean !== null) {
        totalNew += added;
        updatedProviders.push(routeKey);
        details.push({ id: routeKey, added, total: existing.length });
      }
    }),
  );

  if (totalNew > 0 || updatedProviders.length > 0) {
    try {
      const dump = yaml.dump(parsed, { indent: 2, lineWidth: -1, noRefs: true });
      fs.writeFileSync(filePath, dump, "utf8");
    } catch (err: any) {
      return { success: false, count: totalNew, providers: updatedProviders, error: `写入配置文件失败: ${err?.message || err}` };
    }
  }

  return { success: true, count: totalNew, providers: updatedProviders, details };
}
