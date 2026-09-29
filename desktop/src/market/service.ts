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
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  DSH1024_SOURCE,
  DSH_MARKET_SOURCE,
  EMPTY_PAGE,
  fetchCatalogJson,
  browseUrl,
  detailUrl,
  filterEntries,
  marketApiUrl,
  marketCatalogUrl,
  marketDetailUrl,
  normalizeCustomPage,
  normalizeDsh1024Page,
  normalizeDshMarketPage,
  normalizeEntry,
  postMarketJson,
  dshMarketEntry,
  searchUrl,
  type CatalogSource,
  type MarketEntry,
  type MarketPage,
} from "./catalog";
import {
  ENGINE_PROFILE,
  NPM_LATEST_ENDPOINT,
  lastMeaningfulLine,
  mergeMarketBlock,
  pluginAddArgs,
  pluginRemoveArgs,
  qualifyEntry,
  readBuiltinPlugins,
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
  browse(input: { sourceId: string; page?: number; query?: string; category?: string; sort?: string }): Promise<MarketPage>;
  detail(input: { sourceId: string; id: string }): Promise<MarketEntry | null>;
  inventory(): Promise<ProfileInventory>;
  install(input: { sourceId: string; id: string }): Promise<InstallOutcome>;
  uninstall(packageName: string): Promise<InstallOutcome>;
  setDisabled(packageName: string, disabled: boolean): Promise<InstallOutcome>;
  /** AI 需求识别推荐（仅 dshMarket 源；服务端调用模型，桌面端不见凭据）。 */
  recommend(input: { sourceId: string; need: string }): Promise<RecommendOutcome>;
  /** 今日插件日报（仅 dshMarket 源）。 */
  daily(input: { sourceId: string }): Promise<DailyReport | null>;
  /** 点赞/收藏/安装计数（仅 dshMarket 源；匿名 clientId 去重）。 */
  interact(input: { sourceId: string; id: string; action: "like" | "favorite" | "install" }): Promise<InteractOutcome>;
  /** 已装插件更新检查（对比 npm registry 的 latest）。 */
  updates(): Promise<UpdatesOutcome>;
  /** 一键打包：把可移动的已装插件整理成一份可迁移的清单。 */
  exportPack(): Promise<ExportPackOutcome>;
  /** 一键迁移：把清单里的插件在本机逐个安装回来。 */
  importPack(input: { pack: MigrationPack }): Promise<ImportPackOutcome>;
}

/** AI 推荐的一条结果。 */
export interface RecommendPick {
  entry: MarketEntry;
  reason: string;
}

export interface RecommendOutcome {
  ok: boolean;
  message: string;
  picks: RecommendPick[];
  model: string | null;
  took: number;
}

/** 日报数据（服务器原样透传，字段随服务器演进）。 */
export interface DailyReport {
  date: string | null;
  headline?: string;
  editorNote?: string;
  stats?: { total?: number; installable?: number; newToday?: number; updatedToday?: number };
  newPlugins?: MarketEntry[];
  updated?: (MarketEntry & { prevVersion?: string })[];
  hotTop?: MarketEntry[];
  note?: string;
}

export interface InteractOutcome {
  ok: boolean;
  likes?: number;
  favorites?: number;
  installs?: number;
}

export interface PluginUpdate {
  packageName: string;
  current: string;
  latest: string;
}

export interface UpdatesOutcome {
  ok: boolean;
  updates: PluginUpdate[];
  checked: number;
  failed: string[];
}

/** 一份可迁移的插件清单。 */
export interface MigrationPack {
  kind: "dsh-market-migration";
  version: 1;
  exportedAt: string;
  profile: string;
  plugins: { packageName: string; version: string; disabled: boolean }[];
}

export interface ExportPackOutcome {
  ok: boolean;
  message: string;
  pack: MigrationPack | null;
  filePath: string;
}

export interface ImportPackOutcome {
  ok: boolean;
  message: string;
  results: { packageName: string; ok: boolean; message: string }[];
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
    const kind = record.kind === "custom" ? "custom" : record.kind === "dsh1024" ? "dsh1024" : record.kind === "dshMarket" ? "dshMarket" : null;
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
    // 首次运行默认进自建市场（每日聚合 1.3 万+ 插件、AI 推荐、日报）；
    // 1024Store 作为可选源保留，用户可在「数据源」里切换。
    return [DSH_MARKET_SOURCE, DSH1024_SOURCE];
  }

  async function saveSources(next: unknown): Promise<CatalogSource[]> {
    const clean = sanitizeSources(next);
    const list = clean.length > 0 ? clean : [DSH_MARKET_SOURCE, DSH1024_SOURCE];
    await mkdir(path.dirname(sourcesFile), { recursive: true });
    await writeFile(sourcesFile, JSON.stringify(list, null, 2), "utf8");
    cache.clear();
    return list;
  }

  async function sourceById(id: string): Promise<CatalogSource> {
    const list = await sources();
    return list.find((source) => source.id === id) ?? list[0] ?? DSH_MARKET_SOURCE;
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
    sort?: string;
  }): Promise<MarketPage> {
    const source = await sourceById(input.sourceId);
    const query = (input.query ?? "").trim();
    const category = (input.category ?? "").trim();
    if (source.kind === "dshMarket") {
      // Server-side browse: pagination, sorting and search all run remotely,
      // so the desktop never pulls the whole (13k-entry) catalog.
      const url = marketCatalogUrl(source, {
        page: input.page ?? 1,
        pageSize: 60,
        sort: input.sort ?? "hot",
        category,
        q: query,
      });
      return await readPage(`${source.id}:page:${url}`, url, (payload) => normalizeDshMarketPage(payload, source.id));
    }
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
    if (source.kind === "dshMarket") {
      try {
        const payload = await fetchCatalogJson(marketDetailUrl(source, input.id), { fetchImpl: options.fetchImpl });
        return dshMarketEntry((payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>, source.id);
      } catch (error) {
        options.onLog(`插件详情读取失败：${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    }
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
    const base = await readInventory(options.dshHome());
    const builtins = await readBuiltinPlugins(path.join(options.userData, "plugins"));
    if (builtins.length === 0) return base;
    const known = new Set(base.plugins.map((plugin) => plugin.packageName));
    for (const plugin of builtins) {
      if (!known.has(plugin.packageName)) base.plugins.push(plugin);
    }
    base.plugins.sort((left, right) => left.packageName.localeCompare(right.packageName));
    return base;
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

  /* -------------------------------------------------- 自建市场扩展接口 */

  /** Anonymous per-install id (persisted locally) for like/favorite de-dup. */
  async function clientId(): Promise<string> {
    const file = path.join(options.userData, "market-client.json");
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as { id?: string };
      if (parsed?.id && typeof parsed.id === "string") return parsed.id;
    } catch {
      // first run
    }
    const id = randomUUID();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ id }), "utf8");
    return id;
  }

  /** Guard: the feature needs the house market source. */
  async function marketSource(sourceId: string): Promise<CatalogSource> {
    const source = await sourceById(sourceId);
    if (source.kind !== "dshMarket") throw new Error("这个功能需要「DSH 插件市场」数据源");
    return source;
  }

  async function recommend(input: { sourceId: string; need: string }): Promise<RecommendOutcome> {
    const source = await marketSource(input.sourceId);
    const need = input.need.trim();
    if (need.length < 2) return { ok: false, message: "多描述一点你的需求", picks: [], model: null, took: 0 };
    options.onLog(`AI 推荐：${need.slice(0, 60)}`);
    const payload = await postMarketJson(marketApiUrl(source, "recommend"), { need }, { fetchImpl: options.fetchImpl });
    const record = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    const picks: RecommendPick[] = [];
    for (const raw of Array.isArray(record.picks) ? (record.picks as Record<string, unknown>[]) : []) {
      const entryRaw = raw && typeof raw === "object" ? (raw.entry as Record<string, unknown> | undefined) : undefined;
      if (!entryRaw || typeof entryRaw !== "object") continue;
      picks.push({ entry: dshMarketEntry(entryRaw, source.id), reason: typeof raw.reason === "string" ? raw.reason : "" });
    }
    return {
      ok: picks.length > 0,
      message: picks.length > 0 ? `为你挑了 ${picks.length} 个插件` : "没有找到合适的，换个说法再试",
      picks,
      model: typeof record.model === "string" ? record.model : null,
      took: Number(record.took ?? 0) || 0,
    };
  }

  async function daily(input: { sourceId: string }): Promise<DailyReport | null> {
    const source = await marketSource(input.sourceId);
    const payload = await fetchCatalogJson(marketApiUrl(source, "daily"), { fetchImpl: options.fetchImpl, timeoutMs: 20000 });
    if (!payload || typeof payload !== "object") return null;
    const record = payload as Record<string, unknown>;
    const asEntry = (raw: unknown): MarketEntry =>
      dshMarketEntry((raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>, source.id);
    return {
      date: typeof record.date === "string" ? record.date : null,
      headline: typeof record.headline === "string" ? record.headline : "",
      editorNote: typeof record.editorNote === "string" ? record.editorNote : "",
      stats: (record.stats && typeof record.stats === "object" ? record.stats : {}) as DailyReport["stats"],
      newPlugins: Array.isArray(record.newPlugins) ? record.newPlugins.map(asEntry) : [],
      updated: Array.isArray(record.updated)
        ? (record.updated as Record<string, unknown>[]).map((raw) => ({
            ...asEntry(raw),
            prevVersion: typeof raw.prevVersion === "string" ? raw.prevVersion : "",
          }))
        : [],
      hotTop: Array.isArray(record.hotTop) ? record.hotTop.map(asEntry) : [],
      note: typeof record.note === "string" ? record.note : "",
    };
  }

  async function interact(input: {
    sourceId: string;
    id: string;
    action: "like" | "favorite" | "install";
  }): Promise<InteractOutcome> {
    const source = await marketSource(input.sourceId);
    const payload = await postMarketJson(
      marketApiUrl(source, "interactions"),
      { id: input.id, action: input.action, clientId: await clientId() },
      { fetchImpl: options.fetchImpl, timeoutMs: 20000 },
    );
    const record = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
    return { ok: record.ok === true, likes: num(record.likes), favorites: num(record.favorites), installs: num(record.installs) };
  }

  /** Strip a semver range down to the plain version for display/compare. */
  function plainVersion(range: string): string {
    return range.replace(/^[\s^~>=<v]+/, "").split(" ")[0] || range;
  }

  async function updates(): Promise<UpdatesOutcome> {
    const current = await inventory();
    const targets = current.plugins.filter((plugin) => plugin.removable && plugin.packageName);
    const found: PluginUpdate[] = [];
    const failed: string[] = [];
    const queue = [...targets];
    const workers = Array.from({ length: Math.max(1, Math.min(5, queue.length)) }, async () => {
      for (;;) {
        const plugin = queue.shift();
        if (!plugin) return;
        try {
          const payload = await fetchCatalogJson(`${NPM_LATEST_ENDPOINT}/${plugin.packageName}/latest`, {
            fetchImpl: options.fetchImpl,
            timeoutMs: 15000,
          });
          const latest =
            payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).version === "string"
              ? String((payload as Record<string, unknown>).version)
              : "";
          if (latest && plainVersion(plugin.version) !== latest) {
            found.push({ packageName: plugin.packageName, current: plainVersion(plugin.version) || plugin.version, latest });
          }
        } catch {
          failed.push(plugin.packageName);
        }
      }
    });
    await Promise.all(workers);
    found.sort((a, b) => a.packageName.localeCompare(b.packageName));
    return { ok: true, updates: found, checked: targets.length, failed };
  }

  async function exportPack(): Promise<ExportPackOutcome> {
    const current = await inventory();
    const pack: MigrationPack = {
      kind: "dsh-market-migration",
      version: 1,
      exportedAt: new Date().toISOString(),
      profile: ENGINE_PROFILE,
      plugins: current.plugins
        .filter((plugin) => plugin.removable && !plugin.core && plugin.packageName)
        .map((plugin) => ({ packageName: plugin.packageName, version: plugin.version, disabled: plugin.disabled })),
    };
    const dir = path.join(options.userData, "market-packs");
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const filePath = path.join(dir, `dsh-plugins-${stamp}.json`);
    await writeFile(filePath, JSON.stringify(pack, null, 2), "utf8");
    options.onLog(`插件打包：${pack.plugins.length} 个 → ${filePath}`);
    return { ok: true, message: `已打包 ${pack.plugins.length} 个插件`, pack, filePath };
  }

  async function importPack(input: { pack: MigrationPack }): Promise<ImportPackOutcome> {
    const pack = input.pack;
    if (!pack || pack.kind !== "dsh-market-migration" || !Array.isArray(pack.plugins)) {
      return { ok: false, message: "这不是一份有效的插件迁移包", results: [] };
    }
    const results: { packageName: string; ok: boolean; message: string }[] = [];
    for (const item of pack.plugins) {
      const packageName = String(item?.packageName ?? "").trim();
      if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(packageName)) continue;
      try {
        const result = await runEngine(pluginAddArgs(packageName));
        if (result.code === 0) {
          if (item.disabled) await setDisabled(packageName, true);
          results.push({ packageName, ok: true, message: item.disabled ? "已安装（保持停用）" : "已安装" });
        } else {
          results.push({ packageName, ok: false, message: lastMeaningfulLine(result.output) || `退出码 ${result.code}` });
        }
      } catch (error) {
        results.push({ packageName, ok: false, message: error instanceof Error ? error.message : String(error) });
      }
    }
    const okCount = results.filter((row) => row.ok).length;
    return {
      ok: results.length > 0 && okCount === results.length,
      message: `迁移完成：${okCount}/${results.length} 个插件成功`,
      results,
    };
  }

  return { sources, saveSources, browse, detail, inventory, install, uninstall, setDisabled, recommend, daily, interact, updates, exportPack, importPack };
}
