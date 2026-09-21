/**
 * Plugin market service: the main-process half of the market window.
 *
 * It owns the source list, a small response cache (the public catalog is
 * rate-limited anonymously, so browsing and searching are cached and
 * de-duplicated), the profile inventory, and every mutation — install,
 * uninstall and enable/disable — which all run through the engine's own
 * `dsh plugin` CLI. The renderer never sends a package name or a command for
 * execution: it sends a source id plus a catalog id, and this layer resolves
 * the npm identity it normalized earlier.
 *
 * @module market/service
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DSH1024_SOURCE,
  EMPTY_PAGE,
  fetchCatalogJson,
  browseUrl,
  detailUrl,
  filterEntries,
  normalizeCustomPage,
  normalizeDsh1024Page,
  normalizeEntry,
  searchUrl,
  type CatalogSource,
  type MarketEntry,
  type MarketPage,
} from "./catalog";
import {
  ENGINE_PROFILE,
  lastMeaningfulLine,
  mergeMarketBlock,
  pluginAddArgs,
  pluginRemoveArgs,
  qualifyEntry,
  readInventory,
  runPluginCommand,
  type ProfileInventory,
} from "./install";
import { homePatchFile } from "../skins";

/** Types the preload surface exposes to the market window. */
export type { CatalogSource, MarketEntry, MarketPage } from "./catalog";
export type { InstalledPlugin, ProfileInventory } from "./install";

/** How long a catalog response stays fresh. The anonymous quota is 50/day. */
export const CATALOG_TTL_MS = 10 * 60 * 1000;

/** Where a plugin installed by this market lands: a direct profile dependency. */
export interface InstallOutcome {
  ok: boolean;
  message: string;
  packageName: string;
  version: string;
  /** True when the engine must restart before the plugin loads. */
  restartRequired: boolean;
  output: string;
}

export interface MarketService {
  sources(): Promise<CatalogSource[]>;
  saveSources(sources: CatalogSource[]): Promise<CatalogSource[]>;
  browse(input: { sourceId: string; page?: number; query?: string; category?: string }): Promise<MarketPage>;
  detail(input: { sourceId: string; id: string }): Promise<MarketEntry | null>;
  inventory(): Promise<ProfileInventory>;
  install(input: { sourceId: string; id: string }): Promise<InstallOutcome>;
  uninstall(packageName: string): Promise<InstallOutcome>;
  setDisabled(packageName: string, disabled: boolean): Promise<InstallOutcome>;
}

export interface MarketServiceOptions {
  userData: string;
  /** The engine home; read on every call so a legacy-home migration is picked up. */
  dshHome: () => string;
  /** The running engine's runtime paths, or null before the first install. */
  engine: () => { nodePath: string; engineBin: string } | null;
  onLog: (line: string) => void;
  /** Streamed stdout/stderr of an install, for the progress pane. */
  onProgress?: (chunk: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Accepted shape of the persisted source list; anything else is ignored. */
function sanitizeSources(raw: unknown): CatalogSource[] {
  if (!Array.isArray(raw)) return [];
  const out: CatalogSource[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const label = typeof record.label === "string" ? record.label.trim() : "";
    const url = typeof record.url === "string" ? record.url.trim() : "";
    const kind = record.kind === "custom" ? "custom" : record.kind === "dsh1024" ? "dsh1024" : null;
    if (!id || !url || !kind) continue;
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/i.test(id)) continue;
    out.push({ id, label: label || id, kind, url });
  }
  return out;
}

/**
 * Build the market service bound to one desktop profile.
 * @param options - paths, engine accessor, logging sinks.
 * @returns the service used by the IPC handlers.
 */
export function createMarketService(options: MarketServiceOptions): MarketService {
  const sourcesFile = path.join(options.userData, "market-sources.json");
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, { at: number; page: MarketPage }>();
  const inFlight = new Map<string, Promise<MarketPage>>();

  async function sources(): Promise<CatalogSource[]> {
    try {
      const parsed = JSON.parse(await readFile(sourcesFile, "utf8")) as unknown;
      const saved = sanitizeSources(parsed);
      if (saved.length > 0) return saved;
    } catch {
      // first run: no file yet
    }
    return [DSH1024_SOURCE];
  }

  async function saveSources(next: unknown): Promise<CatalogSource[]> {
    const clean = sanitizeSources(next);
    const list = clean.length > 0 ? clean : [DSH1024_SOURCE];
    await mkdir(path.dirname(sourcesFile), { recursive: true });
    await writeFile(sourcesFile, JSON.stringify(list, null, 2), "utf8");
    cache.clear();
    return list;
  }

  async function sourceById(id: string): Promise<CatalogSource> {
    const list = await sources();
    return list.find((source) => source.id === id) ?? list[0] ?? DSH1024_SOURCE;
  }

  /** One cached provider read, de-duplicated so a burst of clicks costs one request. */
  async function readPage(
    key: string,
    url: string,
    normalize: (payload: unknown) => MarketPage,
  ): Promise<MarketPage> {
    const cached = cache.get(key);
    if (cached && now() - cached.at < CATALOG_TTL_MS) return cached.page;
    const pending = inFlight.get(key);
    if (pending) return await pending;
    const request = (async () => {
      try {
        const payload = await fetchCatalogJson(url, { fetchImpl: options.fetchImpl });
        const page = normalize(payload);
        cache.set(key, { at: now(), page });
        return page;
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, request);
    return await request;
  }

  async function fullCatalog(source: CatalogSource): Promise<MarketPage> {
    const key = `${source.id}:browse`;
    return await readPage(key, browseUrl(source, 1), (payload) =>
      source.kind === "custom" ? normalizeCustomPage(payload, source.id) : normalizeDsh1024Page(payload, source.id),
    );
  }

  async function browse(input: {
    sourceId: string;
    page?: number;
    query?: string;
    category?: string;
  }): Promise<MarketPage> {
    const source = await sourceById(input.sourceId);
    const query = (input.query ?? "").trim();
    const category = (input.category ?? "").trim();
    if (source.kind === "custom") {
      // A custom source is one static document: browse and search are local.
      const page = await fullCatalog(source);
      const entries = filterEntries(page.entries, query, category);
      return { ...page, entries, total: entries.length };
    }
    if (!query) {
      const page = await fullCatalog(source);
      const entries = filterEntries(page.entries, "", category);
      return { ...page, entries, total: entries.length };
    }
    const key = `${source.id}:search:${query.toLowerCase()}:${category}`;
    const searched = await readPage(key, searchUrl(source, query, category), (payload) =>
      normalizeDsh1024Page(payload, source.id),
    );
    const base = await fullCatalog(source).catch(() => EMPTY_PAGE);
    return { ...searched, categories: searched.categories.length > 0 ? searched.categories : base.categories };
  }

  async function detail(input: { sourceId: string; id: string }): Promise<MarketEntry | null> {
    const source = await sourceById(input.sourceId);
    const page = await fullCatalog(source).catch(() => EMPTY_PAGE);
    const known = page.entries.find((entry) => entry.id === input.id);
    if (source.kind === "custom") return known ?? null;
    try {
      const payload = await fetchCatalogJson(detailUrl(source, input.id), { fetchImpl: options.fetchImpl });
      const entry = normalizeEntry(payload, source.id);
      return entry.npmPackage || entry.displayCommand ? entry : known ?? entry;
    } catch (error) {
      options.onLog(`插件详情读取失败：${error instanceof Error ? error.message : String(error)}`);
      return known ?? null;
    }
  }

  async function inventory(): Promise<ProfileInventory> {
    return await readInventory(options.dshHome());
  }

  /** Run one engine CLI invocation, resolving the runtime lazily. */
  async function runEngine(args: string[]): Promise<{ code: number; output: string }> {
    const engine = options.engine();
    if (!engine) throw new Error("引擎尚未安装完成，请等启动结束后再试");
    return await runPluginCommand({
      nodePath: engine.nodePath,
      engineBin: engine.engineBin,
      dshHome: options.dshHome(),
      args,
      timeoutMs: 15 * 60 * 1000,
      onOutput: options.onProgress,
    });
  }

  async function install(input: { sourceId: string; id: string }): Promise<InstallOutcome> {
    const entry = await detail(input);
    const empty = { packageName: "", version: "", restartRequired: true, output: "" };
    if (!entry) return { ok: false, message: "在目录里找不到这个插件（数据源可能已更新）", ...empty };
    const qualified = await qualifyEntry(entry, { fetchImpl: options.fetchImpl });
    if (!qualified.ok) return { ok: false, message: qualified.reason, ...empty, packageName: entry.npmPackage };
    options.onLog(`安装插件 ${qualified.spec}（引擎 profile ${ENGINE_PROFILE}）`);
    const result = await runEngine(pluginAddArgs(qualified.spec));
    if (result.code !== 0) {
      const line = lastMeaningfulLine(result.output);
      options.onLog(`插件 ${qualified.packageName} 安装失败：${line || `退出码 ${result.code}`}`);
      return {
        ok: false,
        message: line ? `安装失败：${line}` : `安装失败（退出码 ${result.code}）`,
        packageName: qualified.packageName,
        version: qualified.version,
        restartRequired: false,
        output: result.output,
      };
    }
    options.onLog(`插件 ${qualified.packageName}@${qualified.version} 已安装`);
    const after = await readInventory(options.dshHome());
    const activated = after.plugins.some(
      (plugin) => plugin.packageName === qualified.packageName && plugin.bundle,
    );
    return {
      ok: true,
      message: activated
        ? `${qualified.packageName}@${qualified.version} 已安装并加入 profile 层`
        : `${qualified.packageName}@${qualified.version} 已安装，但它没有声明 dsh.bundle，不会作为插件加载`,
      packageName: qualified.packageName,
      version: qualified.version,
      restartRequired: true,
      output: result.output,
    };
  }

  async function uninstall(packageName: string): Promise<InstallOutcome> {
    const current = await inventory();
    const plugin = current.plugins.find((item) => item.packageName === packageName);
    if (!plugin) {
      return { ok: false, message: "这个插件不在当前 profile 里", packageName, version: "", restartRequired: false, output: "" };
    }
    if (!plugin.removable) {
      return {
        ok: false,
        message: "这是 profile 自带的层，桌面端不会卸载它",
        packageName,
        version: plugin.version,
        restartRequired: false,
        output: "",
      };
    }
    options.onLog(`卸载插件 ${packageName}`);
    const result = await runEngine(pluginRemoveArgs(packageName));
    if (result.code !== 0) {
      const line = lastMeaningfulLine(result.output);
      return {
        ok: false,
        message: line ? `卸载失败：${line}` : `卸载失败（退出码 ${result.code}）`,
        packageName,
        version: plugin.version,
        restartRequired: false,
        output: result.output,
      };
    }
    if (plugin.disabled) await setDisabled(packageName, false);
    return {
      ok: true,
      message: `${packageName} 已卸载`,
      packageName,
      version: "",
      restartRequired: true,
      output: result.output,
    };
  }

  /**
   * Enable or disable a plugin by writing a row into the home patch layer,
   * which is the engine's own mechanism and re-applies on every boot. The
   * market owns exactly one delimited block in that file, so skin rows and
   * hand-written rows are preserved byte for byte.
   */
  async function setDisabled(packageName: string, disabled: boolean): Promise<InstallOutcome> {
    const file = homePatchFile(options.dshHome());
    let existing = "";
    try {
      existing = await readFile(file, "utf8");
    } catch {
      existing = "[]\n";
    }
    const current = await readInventory(options.dshHome());
    const next = new Set(current.disabled.filter((name) => name !== packageName));
    if (disabled) next.add(packageName);
    const body = mergeMarketBlock(existing, [...next]);
    await mkdir(options.dshHome(), { recursive: true });
    await writeFile(file, body, "utf8");
    options.onLog(disabled ? `已停用插件 ${packageName}（下次启动生效）` : `已启用插件 ${packageName}（下次启动生效）`);
    return {
      ok: true,
      message: disabled ? `${packageName} 已停用，重启引擎后生效` : `${packageName} 已启用，重启引擎后生效`,
      packageName,
      version: "",
      restartRequired: true,
      output: "",
    };
  }

  return { sources, saveSources, browse, detail, inventory, install, uninstall, setDisabled };
}
