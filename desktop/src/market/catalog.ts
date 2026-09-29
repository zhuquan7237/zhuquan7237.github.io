/**
 * Plugin market catalog layer: provider-neutral entries, normalizers for the
 * public catalog sources, and a hardened JSON fetcher.
 *
 * The market never trusts provider metadata as an install instruction. A
 * provider may name an npm package; `install.ts` still resolves npm `latest`
 * and re-validates the package before anything is installed. Provider command
 * text is display-only and is never executed.
 *
 * @module market/catalog
 */

/** Catalog entry after normalization, shared by every provider. */
export interface MarketEntry {
  /** Provider-scoped stable id (for 1024Store: `owner/repo[/sub/dir…]`). */
  id: string;
  name: string;
  owner: string;
  /** Repository page, shown and opened in the browser. */
  repoUrl: string;
  description: { en: string; zh: string };
  categoryId: string;
  /** Normalized npm identity; empty when the entry is browse-only. */
  npmPackage: string;
  /** Provider-supplied command, reconstructed for display only. Never executed. */
  displayCommand: string;
  /** Version the provider last verified; informational, npm `latest` wins. */
  revision: string;
  stars: number;
  installs: number;
  added: string;
  pushedAt: string;
  sourceId: string;
  /** dshMarket extras: everything below is optional and absent on other sources. */
  topCategory?: string;
  downloads?: number;
  likes?: number;
  favorites?: number;
  hot?: number;
  verified?: boolean;
  capabilities?: string[];
  redLines?: string[];
  license?: string;
  unpackedSize?: number;
  peers?: string[];
  firstSeen?: string;
  hasZh?: boolean;
  version?: string;
}

/** One category as served by the catalog, so clients never hard-code the table. */
export interface MarketCategory {
  id: string;
  en: string;
  zh: string;
  count: number;
}

/** One page of catalog results. */
export interface MarketPage {
  entries: MarketEntry[];
  categories: MarketCategory[];
  page: number;
  totalPages: number;
  /** Entries in the served window. */
  total: number;
  /** Full catalog size, served or not. */
  catalogTotal: number;
}

export const EMPTY_PAGE: MarketPage = {
  entries: [],
  categories: [],
  page: 1,
  totalPages: 0,
  total: 0,
  catalogTotal: 0,
};

/** A catalog provider the user can browse. */
export interface CatalogSource {
  id: string;
  label: string;
  /** `dsh1024` speaks the DSH 1024Store API; `custom` speaks our own open schema; `dshMarket` speaks the self-hosted market API. */
  kind: "dsh1024" | "custom" | "dshMarket";
  /** Origin (dsh1024/dshMarket) or full JSON URL (custom). */
  url: string;
}

export const DSH1024_SOURCE: CatalogSource = {
  id: "dsh1024",
  label: "DSH 1024Store",
  kind: "dsh1024",
  url: "https://deepseek1024.com",
};

/** The house market: daily-aggregated, curated, searchable, with AI picks and a daily digest. */
export const DSH_MARKET_SOURCE: CatalogSource = {
  id: "dsh",
  label: "DSH 插件市场",
  kind: "dshMarket",
  url: "https://market.zhuquan.xyz",
};

export const DSH1024_SEARCH_ENDPOINT = "https://api.deepseek1024.com/v1/plugins/search";

/**
 * A plain npm package name: optional `@scope/` plus a lowercase name. Anything
 * carrying a protocol, path, git ref, alias or range is rejected — a catalog
 * entry contributes an identity, never an install spec.
 */
export function looksLikeNpmName(candidate: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(candidate.trim());
}

/**
 * Extract the npm package identity from a provider install command. Only the
 * exact plain `dsh plugin --profile <name> add <package>` shape counts; a
 * `github:`/`file:`/`link:` spec, an `@version`/`@range` suffix, or extra flags
 * yield "" so the entry stays browse-only.
 * @param command - provider-supplied command text.
 * @returns the npm package name, or "" when the command is not a plain npm add.
 */
export function npmPackageFromCommand(command: string): string {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length !== 6) return "";
  const [bin, plugin, profileFlag, profile, add, spec] = tokens;
  if (bin !== "dsh" || plugin !== "plugin" || profileFlag !== "--profile" || add !== "add") return "";
  if (!profile) return "";
  if (spec.includes("@", 1) || spec.includes(":") || spec.includes("/../")) return "";
  return looksLikeNpmName(spec) ? spec : "";
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function descriptionOf(raw: Record<string, unknown>): { en: string; zh: string } {
  const value = raw.description;
  if (typeof value === "string") return { en: value, zh: value };
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return { en: text(record.en), zh: text(record.zh) };
  }
  return { en: "", zh: "" };
}

/** One `installMethods` row from a detail payload. */
interface InstallMethod {
  kind?: unknown;
  spec?: unknown;
  revision?: unknown;
}

function npmSpecFromMethods(raw: Record<string, unknown>): { npmPackage: string; revision: string } {
  const methods = Array.isArray(raw.installMethods) ? (raw.installMethods as InstallMethod[]) : [];
  for (const method of methods) {
    if (text(method.kind) !== "npm") continue;
    const spec = text(method.spec);
    if (!looksLikeNpmName(spec)) continue;
    return { npmPackage: spec, revision: text(method.revision) };
  }
  return { npmPackage: "", revision: "" };
}

/** Category id from either a listing (string) or a detail payload (object). */
function categoryIdOf(raw: Record<string, unknown>): string {
  const value = raw.category;
  if (typeof value === "string") return value.trim() || "unclassified";
  if (value && typeof value === "object") return text((value as Record<string, unknown>).id) || "unclassified";
  return "unclassified";
}

/**
 * Normalize one provider row. Both the listing projection and the detail
 * payload are accepted: the npm identity prefers `installMethods`, falls back
 * to parsing the display command, and is "" when neither is a plain npm spec.
 * @param raw - one entry from a provider payload.
 * @param sourceId - the source the entry came from.
 * @returns the normalized entry.
 */
export function normalizeEntry(raw: unknown, sourceId: string): MarketEntry {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const fromMethods = npmSpecFromMethods(record);
  const displayCommand = text(record.install);
  const npmPackage = fromMethods.npmPackage || npmPackageFromCommand(displayCommand);
  const id = text(record.id);
  return {
    id,
    name: text(record.name) || id.split("/").pop() || id,
    owner: text(record.owner) || id.split("/")[0] || "",
    repoUrl: text(record.url) || text(record.repository),
    description: descriptionOf(record),
    categoryId: categoryIdOf(record),
    npmPackage,
    displayCommand: displayCommand || (npmPackage ? `dsh plugin --profile web add ${npmPackage}` : ""),
    revision: fromMethods.revision,
    stars: num(record.stars),
    installs: num(record.installCount),
    added: text(record.added),
    pushedAt: text(record.pushedAt),
    sourceId,
  };
}

function normalizeCategories(raw: unknown): MarketCategory[] {
  if (!Array.isArray(raw)) return [];
  const out: MarketCategory[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = text(record.id);
    if (!id) continue;
    out.push({
      id,
      en: text(record.en) || text(record.label_en) || id,
      zh: text(record.zh) || text(record.label_zh) || id,
      count: num(record.count),
    });
  }
  return out;
}

/**
 * Normalize any DSH 1024Store listing payload: the v2 catalog
 * (`plugins`), the frozen v1 projection (`packages`) and the search endpoint
 * (`results`) all land in one shape.
 * @param payload - the parsed JSON body.
 * @param sourceId - the source id to stamp on entries.
 * @returns one normalized page.
 */
export function normalizeDsh1024Page(payload: unknown, sourceId = DSH1024_SOURCE.id): MarketPage {
  const record = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const rows = [record.plugins, record.packages, record.results].find(Array.isArray) as unknown[] | undefined;
  const meta = (record.meta && typeof record.meta === "object" ? record.meta : {}) as Record<string, unknown>;
  const entries = (rows ?? []).map((row) => normalizeEntry(row, sourceId));
  return {
    entries,
    categories: normalizeCategories(record.categories),
    page: num(record.page) || 1,
    totalPages: num(record.totalPages),
    total: num(record.total) || entries.length,
    catalogTotal: num(record.catalogTotal) || num(meta.catalogTotal) || entries.length,
  };
}

/**
 * Normalize a `custom` source speaking the market's open schema, so a
 * self-hosted catalog (for example a fork of the 1024Store site, or a JSON
 * file on GitHub Pages) can be added without code changes:
 *
 * ```json
 * { "name": "My Market",
 *   "categories": [{ "id": "ui", "en": "UI", "zh": "界面" }],
 *   "entries": [{ "id": "me/plugin", "name": "plugin", "npmPackage": "dsh-plugin",
 *                 "description": { "en": "…", "zh": "…" }, "category": "ui",
 *                 "repoUrl": "https://github.com/me/plugin" }] }
 * ```
 *
 * Entries may also carry `installCommand` instead of `npmPackage`; the same
 * plain-`add` rule applies.
 * @param payload - the parsed JSON body.
 * @param sourceId - the source id to stamp on entries.
 * @returns one normalized page.
 */
export function normalizeCustomPage(payload: unknown, sourceId: string): MarketPage {
  const record = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const rows = Array.isArray(record.entries) ? record.entries : Array.isArray(record.plugins) ? record.plugins : [];
  const entries = rows.map((row) => {
    const raw = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
    const explicit = text(raw.npmPackage) || text(raw.package);
    const command = text(raw.installCommand) || text(raw.install);
    const npmPackage = looksLikeNpmName(explicit) ? explicit : npmPackageFromCommand(command);
    // Keep the provider command as display text even when it cannot be installed:
    // the detail view still shows the exact manual command the source published.
    const merged = npmPackage || command
      ? { ...raw, install: command || `dsh plugin --profile web add ${npmPackage}` }
      : raw;
    return normalizeEntry(merged, sourceId);
  });
  return { ...EMPTY_PAGE, entries, categories: normalizeCategories(record.categories), total: entries.length, catalogTotal: entries.length };
}

/** One row from the self-hosted market API. */
export function dshMarketEntry(raw: Record<string, unknown>, sourceId: string): MarketEntry {
  const id = text(raw.id);
  const npmPackage = text(raw.npmPackage);
  const capabilities = Array.isArray(raw.capabilities) ? (raw.capabilities as unknown[]).map((item) => text(item)).filter(Boolean) : [];
  const redLines = Array.isArray(raw.redLines) ? (raw.redLines as unknown[]).map((item) => text(item)).filter(Boolean) : [];
  const peers = Array.isArray(raw.peers) ? (raw.peers as unknown[]).map((item) => text(item)).filter(Boolean) : [];
  return {
    id,
    name: text(raw.name) || id.split("/").pop() || id,
    owner: text(raw.owner) || text(raw.publisher),
    repoUrl: text(raw.repoUrl) || text(raw.repository),
    description: descriptionOf(raw),
    categoryId: text(raw.categoryId) || text(raw.category) || "other",
    npmPackage,
    displayCommand: npmPackage ? `dsh plugin --profile web add ${npmPackage}` : "",
    revision: text(raw.version),
    stars: num(raw.stars),
    installs: num(raw.installs),
    added: text(raw.firstSeen),
    pushedAt: "",
    sourceId,
    topCategory: text(raw.topCategory),
    downloads: num(raw.downloads),
    likes: num(raw.likes),
    favorites: num(raw.favorites),
    hot: num(raw.hot),
    verified: raw.verified === true,
    capabilities,
    redLines,
    license: text(raw.license),
    unpackedSize: num(raw.unpackedSize),
    peers,
    firstSeen: text(raw.firstSeen),
    hasZh: raw.hasZh === true,
    version: text(raw.version),
  };
}

/**
 * Normalize one page of the self-hosted market API (`/market/v1/catalog`).
 * The payload is already bilingual, pre-ranked and categorized server-side;
 * this maps it one-to-one onto MarketPage.
 * @param payload - the parsed JSON body.
 * @param sourceId - the source id to stamp on entries.
 * @returns one normalized page.
 */
export function normalizeDshMarketPage(payload: unknown, sourceId: string): MarketPage {
  const record = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const rows = Array.isArray(record.entries) ? (record.entries as Record<string, unknown>[]) : [];
  const entries = rows.filter((row) => row && typeof row === "object").map((row) => dshMarketEntry(row, sourceId));
  return {
    entries,
    categories: normalizeCategories(record.categories),
    page: num(record.page) || 1,
    totalPages: num(record.totalPages),
    total: num(record.total) || entries.length,
    catalogTotal: num(record.catalogTotal) || entries.length,
  };
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^(fc|fd|fe80)/i.test(host.replace(/:/g, ""))) return true;
  return false;
}

/** Reasons a source or entry request can fail before any JSON is parsed. */
export class MarketFetchError extends Error {}

export interface FetchJsonOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Fetch JSON from a catalog source with the market's safety envelope:
 * HTTPS only, no credentials, a hard byte cap, a timeout, and no private
 * network destinations. A failure is returned as an error, never as an empty
 * catalog, so the UI can tell "source down" apart from "no results".
 * @param url - the source URL.
 * @param options - injectable fetch and bounds.
 * @returns the parsed body.
 */
export async function fetchCatalogJson(url: string, options: FetchJsonOptions = {}): Promise<unknown> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MarketFetchError(`数据源地址无效：${url}`);
  }
  if (parsed.protocol !== "https:") throw new MarketFetchError("数据源必须是 HTTPS 地址");
  if (parsed.username || parsed.password) throw new MarketFetchError("数据源地址不能带凭据");
  if (isPrivateHost(parsed.hostname)) throw new MarketFetchError("数据源不能指向内网地址");
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "follow",
      credentials: "omit",
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new MarketFetchError(`数据源返回 HTTP ${response.status}`);
    const cap = options.maxBytes ?? 8 * 1024 * 1024;
    const body = await response.text();
    if (body.length > cap) throw new MarketFetchError("数据源响应过大");
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new MarketFetchError("数据源返回的不是 JSON");
    }
  } catch (error) {
    if (error instanceof MarketFetchError) throw error;
    // A bare "fetch failed" is useless in the window; name the host and the cause.
    const reason = error instanceof Error && error.name === "AbortError" ? "请求超时" : error instanceof Error ? error.message : String(error);
    throw new MarketFetchError(`无法访问数据源 ${parsed.hostname}（${reason}）`);
  } finally {
    clearTimeout(timer);
  }
}

/** Build the browse URL for a source and page. */
export function browseUrl(source: CatalogSource, page: number): string {
  if (source.kind === "custom") return source.url;
  if (source.kind === "dshMarket") return marketCatalogUrl(source, { page });
  const origin = source.url.replace(/\/+$/, "");
  return `${origin}/api/v2/plugins?page=${Math.max(1, Math.floor(page))}&pageSize=60&sort=installs`;
}

/**
 * Build a catalog URL for the self-hosted market API. Pagination, sorting and
 * the query all run server-side, so the desktop never downloads the whole
 * catalog (it is far past the JSON size cap).
 * @param source - a `dshMarket` source.
 * @param input - page, pageSize, sort (hot|stars|new|downloads), category, q.
 * @returns the absolute URL.
 */
export function marketCatalogUrl(
  source: CatalogSource,
  input: { page?: number; pageSize?: number; sort?: string; category?: string; q?: string },
): string {
  const origin = source.url.replace(/\/+$/, "");
  const params = new URLSearchParams();
  params.set("page", String(Math.max(1, Math.floor(input.page ?? 1))));
  params.set("pageSize", String(Math.min(Math.max(1, Math.floor(input.pageSize ?? 60)), 120)));
  params.set("sort", input.sort ?? "hot");
  if (input.category) params.set("category", String(input.category).slice(0, 60));
  if (input.q) params.set("q", String(input.q).slice(0, 200));
  return `${origin}/market/v1/catalog?${params.toString()}`;
}

/** Build a detail URL for the self-hosted market API. */
export function marketDetailUrl(source: CatalogSource, entryId: string): string {
  const origin = source.url.replace(/\/+$/, "");
  return `${origin}/market/v1/plugin/${encodeURIComponent(entryId)}`;
}

/** Build an arbitrary market API URL (`path` is appended after `/market/v1/`). */
export function marketApiUrl(source: CatalogSource, path: string): string {
  const origin = source.url.replace(/\/+$/, "");
  return `${origin}/market/v1/${String(path).replace(/^\/+/, "")}`;
}

/**
 * POST JSON to the market API with the same safety envelope as
 * fetchCatalogJson — HTTPS only, no credentials, a byte cap and no private
 * hosts — but a longer default timeout for AI-backed endpoints.
 * @param url - the endpoint URL.
 * @param body - the JSON body.
 * @param options - injectable fetch and bounds.
 * @returns the parsed body.
 */
export async function postMarketJson(url: string, body: unknown, options: FetchJsonOptions = {}): Promise<unknown> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MarketFetchError(`接口地址无效：${url}`);
  }
  if (parsed.protocol !== "https:") throw new MarketFetchError("接口必须是 HTTPS 地址");
  if (parsed.username || parsed.password) throw new MarketFetchError("接口地址不能带凭据");
  if (isPrivateHost(parsed.hostname)) throw new MarketFetchError("接口不能指向内网地址");
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 90000);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      signal: controller.signal,
      redirect: "follow",
      credentials: "omit",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    if (!response.ok) throw new MarketFetchError(`接口返回 HTTP ${response.status}`);
    const cap = options.maxBytes ?? 2 * 1024 * 1024;
    const text = await response.text();
    if (text.length > cap) throw new MarketFetchError("接口响应过大");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new MarketFetchError("接口返回的不是 JSON");
    }
  } catch (error) {
    if (error instanceof MarketFetchError) throw error;
    const reason = error instanceof Error && error.name === "AbortError" ? "请求超时" : error instanceof Error ? error.message : String(error);
    throw new MarketFetchError(`无法访问 ${parsed.hostname}（${reason}）`);
  } finally {
    clearTimeout(timer);
  }
}

/** Build the search URL for a source. */
export function searchUrl(source: CatalogSource, query: string, category: string): string {
  const params = new URLSearchParams({ q: query.slice(0, 120), sortBy: "stars" });
  if (category) params.set("category", category);
  if (source.kind === "custom") {
    // The open schema is a static document: search locally, never remotely.
    return source.url;
  }
  if (source.kind === "dshMarket") {
    return marketCatalogUrl(source, { q: query, category, page: 1 });
  }
  return `${DSH1024_SEARCH_ENDPOINT}?${params.toString()}`;
}

/** Build the detail URL for a source entry. */
export function detailUrl(source: CatalogSource, entryId: string): string {
  if (source.kind === "custom") return source.url;
  if (source.kind === "dshMarket") return marketDetailUrl(source, entryId);
  const origin = source.url.replace(/\/+$/, "");
  const path = entryId
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${origin}/api/v1/plugins/${path}`;
}

/** Filter entries by a case-insensitive query across the fields a user can see. */
export function filterEntries(entries: MarketEntry[], query: string, category: string): MarketEntry[] {
  const needle = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (category && entry.categoryId !== category) return false;
    if (!needle) return true;
    return (
      entry.name.toLowerCase().includes(needle) ||
      entry.owner.toLowerCase().includes(needle) ||
      entry.npmPackage.toLowerCase().includes(needle) ||
      entry.description.en.toLowerCase().includes(needle) ||
      entry.description.zh.toLowerCase().includes(needle)
    );
  });
}

/** Entries that expose a plain npm identity, i.e. what the Installable view shows. */
export function installableEntries(entries: MarketEntry[]): MarketEntry[] {
  return entries.filter((entry) => entry.npmPackage.length > 0);
}
