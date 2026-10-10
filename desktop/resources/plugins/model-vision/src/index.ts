/**
 * `@dsh-desktop/dsh-model-vision` — model capabilities that look after
 * themselves.
 *
 * The engine refuses an image before it is attached unless the selected model
 * declares `image` in its input modalities, and it sizes a model's context from
 * declarations too (`dsh-llm-pi-ai` resolves an entry's own fields, then the
 * installed catalog, then route fallbacks of `[text]` / 128k / 32k). The shipped
 * Models page edits none of that, so on a hand-declared route — every private
 * gateway, all six of ours — a user fills in a URL and a key and then hand-typing
 * every model entry is the only path to their real capabilities.
 *
 * This plugin resolves them instead: an endpoint's own `/v1/models` metadata when
 * it publishes any, a cross-vendor catalogue snapshot refreshed from the network
 * (which matches ~95% of the models declared on this machine), and family rules
 * for the rest — then applies the answer with no ceremony. There is exactly one
 * button («立即同步»): on first import the capabilities arrive on their own
 * (boot sync + a settings-change listener), and when a provider's line-up moves
 * upstream, one click re-reads everything. Nothing waits for confirmation;
 * a value set by hand is stored as an explicit override so sync never touches it.
 *
 * @module @dsh-desktop/dsh-model-vision
 */

import type { Context } from '@deepseek-ai/cordis'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  type CapabilityOverride,
  type Catalogue,
  type CatalogueEntry,
  type Modality,
  MODALITIES,
  catalogueFromModels,
  normalizeModelId,
  parseCatalogue,
  sourceLabel,
  upstreamCapabilities,
} from './capabilities.js'
import { type RoutePlan, applyPlan, normalizedInput, planRoute, summarizePlan } from './sync.js'

export * from './capabilities.js'
export * from './sync.js'

/** Cordis plugin name — the patch row id and the client bundle id both use it. */
export const name = 'dsh-model-vision'

/** Services the host half needs. */
export const inject = ['settings', 'llm', 'webServer']

/** Settings namespace that owns pi-ai provider routes. */
export const SETTINGS_NS = 'llm-pi-ai'

/** Where a refreshed catalogue comes from (public, no key, capability metadata included). */
/**
 * The catalogue this client prefers: built once a day by the repository's own
 * scheduled job, merged from several public directories, and served from the
 * project's domain. Every client therefore resolves the same model the same way.
 */
export const CATALOGUE_URL = 'https://dsh.zhuquan.xyz/dl/capabilities.json'
/**
 * Fallback for a machine that cannot reach the project domain (restricted
 * network, offline mirror): the same public directory the daily job reads,
 * fetched directly and merged by this plugin instead.
 */
export const CATALOGUE_FALLBACK_URL = 'https://openrouter.ai/api/v1/models'

/** How long a fetched catalogue is trusted before a refresh is offered. */
export const CATALOGUE_MAX_AGE_MS = 24 * 60 * 60 * 1000

export const ROUTE_OVERVIEW = '/dsh-model-vision/overview'
export const ROUTE_PLAN = '/dsh-model-vision/plan'
export const ROUTE_APPLY = '/dsh-model-vision/apply'
export const ROUTE_SYNC = '/dsh-model-vision/sync'
export const ROUTE_OVERRIDE = '/dsh-model-vision/override'
export const ROUTE_CATALOGUE = '/dsh-model-vision/catalogue'
export const ROUTE_STATE = '/dsh-model-vision/state'
export const ROUTE_SET = '/dsh-model-vision/set'
export const ROUTE_SEAT = '/dsh-model-vision/seat'

export { MODALITIES, normalizeModelId, sourceLabel }
export type { Catalogue, Modality, RoutePlan }

/**
 * Structural slice of `settings` this plugin uses. Engines ≥0.1.7 replaced the
 * `get`/`section` read pair with `describe()` — one descriptor per namespace
 * (`value` = live resolved view, `user` = raw user layer, `revision` = CAS
 * token); older engines expose both shapes, so reads prefer `describe` and
 * fall back to the legacy accessors. Writes use `mutate` on every era.
 */
export interface SettingsLike {
  describe?(options?: { redactSecrets?: boolean }): unknown
  section?(ns: string): unknown
  get?(ns: string): unknown
  mutate(ns: string, ops: unknown, expectedRevision?: number): Promise<unknown>
}

/** Structural slice of `llm` this plugin uses. */
export interface LlmLike {
  listModels(provider: string): Promise<readonly { id: string; name?: string; inputModalities?: readonly string[] }[]>
  discoverModels?(settingsNs: string, request: unknown, signal?: AbortSignal): Promise<readonly unknown[]>
}

/** Persisted, machine-local state (catalogue cache, sync bookkeeping, overrides). */
interface PluginState {
  catalogue?: Catalogue
  catalogueFetchedAt?: number
  lastSync?: Record<string, { at: string; summary: string; applied: number }>
  /**
   * Hand-set capability values, keyed route → model id. An override is applied
   * to the settings entry once, and from then on the resolver reads it back as
   * the `manual` source — so every later sync agrees with it instead of
   * rewriting it. This is the only thing sync never touches.
   */
  overrides?: Record<string, Record<string, CapabilityOverride>>
}

/** One route's outcome inside a sync run, as reported to callers. */
interface SyncRouteResult {
  ok: boolean
  route: string
  applied: number
  summary?: string
  message?: string
}

/** The full result of one sync pass (catalogue + per-route outcomes). */
interface SyncOutcome {
  catalogue: { origin: string; generatedAt: string; source: string; count: number; fetchedAt: number; stale: boolean; refreshing: boolean }
  refresh: { ok: boolean; count: number; message: string }
  results: SyncRouteResult[]
  applied: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sendJson(
  res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (body?: string) => void },
  status: number,
  body: unknown,
): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

async function readBody(req: AsyncIterable<Buffer>, cap = 512 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > cap) throw new Error(`请求体超过 ${cap} 字节`)
    chunks.push(Buffer.from(chunk))
  }
  if (chunks.length === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (!isRecord(parsed)) throw new Error('请求体必须是 JSON 对象')
  return parsed
}

/** Path of the bundled catalogue snapshot shipped inside this plugin. */
export function bundledCataloguePath(): string {
  return fileURLToPath(new URL('../data/catalogue.json', import.meta.url))
}

/** Where the refreshed catalogue and sync bookkeeping live for this dsh home. */
export function statePath(): string {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'model-vision-state.json')
}

/** Host half entry point. */
export function apply(ctx: Context): void {
  const log = (line: string): void => {
    console.log(`[dsh-model-vision] ${line}`)
    ;(ctx as unknown as { logger?: { info?: (message: string) => void } }).logger?.info?.(line)
  }

  const settings = ctx.get('settings') as SettingsLike | undefined
  const llm = ctx.get('llm') as LlmLike | undefined
  if (!settings || !llm) {
    log(`服务缺失（settings=${settings !== undefined} llm=${llm !== undefined}），模型能力不可用`)
    return
  }

  // ---------------------------------------------------------------- catalogue
  let state: PluginState = {}
  try {
    state = JSON.parse(readFileSync(statePath(), 'utf8')) as PluginState
  } catch {
    state = {}
  }
  let catalogue: Catalogue | undefined = parseCatalogue(state.catalogue)
  let catalogueOrigin = 'cache'
  if (!catalogue) {
    try {
      catalogue = parseCatalogue(JSON.parse(readFileSync(bundledCataloguePath(), 'utf8')))
      catalogueOrigin = 'bundled'
    } catch (error) {
      log(`内置能力目录读取失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (!catalogue) {
    // Last resort: an empty catalogue. Family rules still answer a lot.
    catalogue = { version: 1, generatedAt: '', source: 'empty', keys: {} }
    catalogueOrigin = 'empty'
  }
  let refreshing = false

  const AUTO_SYNC_DEBOUNCE_MS = 2000
  /**
   * Pending auto-sync, and the pump that runs it — the pump is started in this
   * plugin's own (clean) async context rather than by the settings listener.
   *
   * Why the indirection: the engine serialises configuration writes through
   * HMR's `runExclusive`, and `settings/document-updated` is emitted INSIDE that
   * transaction. Node's AsyncLocalStorage — which HMR uses to detect nesting —
   * bleeds into timers created while inside it, so a sync scheduled with
   * setTimeout from the listener wakes up flagged as "inside an HMR
   * transaction" and every settings write it makes is refused with "HMR
   * transactions cannot be nested". A flag read by a pump started outside the
   * context carries no such baggage (measured: an interval created outside
   * stays outside, a timer created inside does not).
   */
  let autoPending: { at: number; reason: string } | undefined
  /** Our own settings write is about to echo — drop exactly that one event. */
  let swallowEcho = false

  const persist = (): void => {
    try {
      mkdirSync(dirname(statePath()), { recursive: true })
      writeFileSync(statePath(), JSON.stringify(state), 'utf8')
    } catch (error) {
      log(`状态写入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const catalogueStatus = () => ({
    origin: catalogueOrigin,
    generatedAt: catalogue?.generatedAt ?? '',
    source: catalogue?.source ?? '',
    count: Object.keys(catalogue?.keys ?? {}).length,
    fetchedAt: state.catalogueFetchedAt ?? 0,
    stale: Date.now() - (state.catalogueFetchedAt ?? 0) > CATALOGUE_MAX_AGE_MS,
    refreshing,
  })

  const refreshCatalogue = async (reason: string): Promise<{ ok: boolean; count: number; message: string }> => {
    if (refreshing) return { ok: false, count: Object.keys(catalogue?.keys ?? {}).length, message: '已在刷新中' }
    refreshing = true
    try {
      const attempt = async (url: string, parse: (raw: unknown) => Record<string, CatalogueEntry>) => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 60_000)
        try {
          const response = await fetch(url, { signal: controller.signal })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const keys = parse(await response.json())
          const total = Object.keys(keys).length
          if (total === 0) throw new Error('目录为空（结构可能变了）')
          return { url, keys, total }
        } finally {
          clearTimeout(timer)
        }
      }

      // The project's own catalogue is a merged one, so a client that reaches it
      // resolves more models than the fallback can — but never fewer, and never
      // nothing: an unreachable or reshaped artifact falls through to the public
      // directory instead of leaving the machine with only the bundled snapshot.
      let picked: { url: string; keys: Record<string, CatalogueEntry>; total: number }
      const failures: string[] = []
      try {
        picked = await attempt(CATALOGUE_URL, (raw) => parseCatalogue(raw)?.keys ?? {})
      } catch (error) {
        failures.push(`${CATALOGUE_URL}: ${error instanceof Error ? error.message : String(error)}`)
        log(`自有能力目录不可用，改用公共目录兜底：${failures[0]}`)
        picked = await attempt(CATALOGUE_FALLBACK_URL, catalogueFromModels)
      }
      const { keys, total: count, url } = picked
      catalogue = { version: 1, generatedAt: new Date().toISOString(), source: url, keys }
      state.catalogue = catalogue
      state.catalogueFetchedAt = Date.now()
      catalogueOrigin = 'network'
      persist()
      log(`能力目录已刷新（${reason}）：${count} 条`)
      return { ok: true, count, message: `已更新 ${count} 条` }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`能力目录刷新失败（${reason}）：${message}`)
      return { ok: false, count: Object.keys(catalogue?.keys ?? {}).length, message }
    } finally {
      refreshing = false
    }
  }

  // ------------------------------------------------------------------- routes

  /**
   * One namespace's descriptor on either engine era. ≥0.1.7 serves settings
   * reads through `describe()` (`get`/`section` were removed there); if a
   * future engine reshapes it again this returns undefined and callers fall
   * through to the legacy accessors — an unreadable namespace reads as empty,
   * never a crash at activation time.
   */
  const descriptorFor = (ns: string): { user?: unknown; value?: unknown; revision?: number } | undefined => {
    if (typeof settings.describe !== 'function') return undefined
    try {
      const described = settings.describe({})
      const rows = Array.isArray(described)
        ? described
        : isRecord(described) && Array.isArray(described.namespaces)
          ? (described.namespaces as unknown[])
          : []
      const row = rows.find((candidate) => isRecord(candidate) && candidate.ns === ns)
      return row === undefined ? undefined : (row as { user?: unknown; value?: unknown; revision?: number })
    } catch (error) {
      log(`settings.describe 读取失败：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  const storedRoutes = (): Record<string, Record<string, unknown>> => {
    const row = descriptorFor(SETTINGS_NS)
    const resolved = row?.value ?? row?.user ?? (typeof settings.get === 'function' ? settings.get(SETTINGS_NS) : undefined)
    return isRecord(resolved) && isRecord(resolved.providers)
      ? (resolved.providers as Record<string, Record<string, unknown>>)
      : {}
  }

  const storedModels = (route: string): Record<string, unknown>[] => {
    const row = descriptorFor(SETTINGS_NS)
    const section = row?.user ?? row?.value ?? (typeof settings.section === 'function' ? settings.section(SETTINGS_NS) : undefined)
    const providers = isRecord(section) && isRecord(section.providers) ? section.providers : {}
    const entry = isRecord(providers[route]) ? (providers[route] as Record<string, unknown>) : undefined
    return entry && Array.isArray(entry.models) ? (entry.models as Record<string, unknown>[]) : []
  }

  /** Best effort: a gateway that publishes nothing simply contributes nothing. */
  const upstreamFor = async (
    route: string,
  ): Promise<Record<string, { input?: Modality[]; contextWindow?: number; maxTokens?: number }>> => {
    const out: Record<string, { input?: Modality[]; contextWindow?: number; maxTokens?: number }> = {}
    if (typeof llm.discoverModels !== 'function') return out
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 20_000)
      const discovered = await llm.discoverModels(SETTINGS_NS, { provider: route }, controller.signal)
      clearTimeout(timer)
      for (const row of discovered ?? []) {
        if (!isRecord(row)) continue
        const id = typeof row.id === 'string' ? row.id : undefined
        if (id === undefined) continue
        const caps = upstreamCapabilities(row)
        if (Object.keys(caps).length > 0) out[id] = caps
      }
    } catch {
      /* the endpoint needs a key this plugin must not hold, or publishes nothing */
    }
    return out
  }

  const planFor = async (route: string): Promise<RoutePlan> => {
    const models = await llm.listModels(route)
    const upstream = storedModels(route).length > 0 ? await upstreamFor(route) : {}
    return planRoute({
      route,
      models,
      stored: storedModels(route),
      catalogue,
      upstream,
      overrides: state.overrides?.[route],
    })
  }

  const overview = async (): Promise<unknown> => {
    const routes = storedRoutes()
    if (catalogueStatus().stale && !refreshing) void refreshCatalogue('目录过期')
    const out = []
    for (const [route, entry] of Object.entries(routes)) {
      let plan: RoutePlan | undefined
      let error = ''
      try {
        plan = await planFor(route)
      } catch (problem) {
        error = problem instanceof Error ? problem.message : String(problem)
      }
      const models = plan?.models ?? []
      const vision = models.filter((model) => (model.capabilities.input.value ?? ['text']).includes('image')).length
      out.push({
        route,
        displayName: typeof entry.displayName === 'string' ? entry.displayName : route,
        baseURL: typeof entry.baseURL === 'string' ? entry.baseURL : '',
        total: models.length,
        vision,
        unknown: models.filter((model) => model.unknown).length,
        summary: plan ? summarizePlan(plan) : '',
        lastSync: state.lastSync?.[route] ?? null,
        error,
      })
    }
    return { ok: true, catalogue: catalogueStatus(), routes: out }
  }

  /**
   * Apply one route's plan — every change, corrections included. A hand-set
   * value is not held back here; it is protected by being an override in
   * `state.overrides`, which the resolver reads back as the `manual` source
   * (so the plan agrees with it and there is nothing to write over).
   *
   * Writing settings is a document update the whole app hears; remember that
   * moment so the change listener does not schedule a follow-up sync for our
   * own write.
   */
  const applyRoute = async (route: string): Promise<{ ok: boolean; route: string; applied: number; summary: string }> => {
    const plan = await planFor(route)
    const next = applyPlan({ stored: storedModels(route), plan })
    const written = plan.models.filter((model) => model.changes.length > 0).length
    if (written > 0) {
      swallowEcho = true
      try {
        await settings.mutate(SETTINGS_NS, [{ op: 'set', path: ['providers', route, 'models'], value: next }], undefined)
      } finally {
        swallowEcho = false
      }
    }
    const summary = summarizePlan(plan)
    state.lastSync = { ...(state.lastSync ?? {}), [route]: { at: new Date().toISOString(), summary, applied: written } }
    persist()
    log(`应用模型能力：${route} — 写入 ${written} 个模型（${summary}）`)
    return { ok: true, route, applied: written, summary }
  }

  // ------------------------------------------------------------- 同步与触发
  // 能力同步一共四个入口：启动兜底、设置变更监听、界面「立即同步」、手机桥接。
  // 同一时刻只跑一次（runSync 合并并发调用）；自己的写入由一次性回声开关吞掉，
  // 不会反弹成下一次同步。
  let syncRun: Promise<SyncOutcome> | null = null

  const runSync = (refresh: boolean, reason: string): Promise<SyncOutcome> => {
    if (syncRun !== null) return syncRun
    syncRun = (async (): Promise<SyncOutcome> => {
      try {
        const report = refresh
          ? await refreshCatalogue(reason)
          : { ok: true, count: catalogueStatus().count, message: '跳过刷新' }
        const results: SyncRouteResult[] = []
        let applied = 0
        for (const route of Object.keys(storedRoutes())) {
          try {
            const row = await applyRoute(route)
            applied += row.applied
            results.push(row)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            log(`能力同步失败：${route} — ${message}`)
            results.push({ ok: false, route, applied: 0, message })
          }
        }
        log(`能力同步完成（${reason}）：写入 ${applied} 个模型，覆盖 ${results.length} 条路由`)
        return { catalogue: catalogueStatus(), refresh: report, results, applied }
      } finally {
        syncRun = null
      }
    })()
    return syncRun
  }

  /** Fire-and-forget one auto-sync pass. */
  const fireAutoSync = (reason: string): void => {
    void runSync(false, reason).catch((error) => log(`自动同步失败：${error instanceof Error ? error.message : String(error)}`))
  }

  /**
   * Queue one debounced auto-sync. The listener records intent only — execution
   * happens on the pump (see `autoPending` for why that distinction matters).
   */
  const requestAutoSync = (reason: string, delay = AUTO_SYNC_DEBOUNCE_MS): void => {
    autoPending = { at: Date.now() + delay, reason }
  }

  // ----------------------------------------------------------------- overrides
  type OverrideField = 'input' | 'contextWindow' | 'maxTokens'

  /**
   * Remember a hand-set value (or forget one) so every later sync treats it as
   * the answer. Overrides live in this plugin's own state, not in the settings
   * file — a settings value cannot be told apart from one a sync just wrote,
   * while an override is unambiguous, and that is what lets sync be aggressive
   * without ever eating a user's decision.
   */
  const recordOverride = (route: string, model: string, field: OverrideField, value: Modality[] | number | undefined): void => {
    const all = { ...(state.overrides ?? {}) }
    const forRoute = { ...(all[route] ?? {}) }
    const entry: CapabilityOverride = { ...(forRoute[model] ?? {}) }
    if (value === undefined) delete entry[field]
    else if (field === 'input') entry.input = value as Modality[]
    else if (field === 'contextWindow') entry.contextWindow = value as number
    else entry.maxTokens = value as number
    if (Object.keys(entry).length > 0) forRoute[model] = entry
    else delete forRoute[model]
    if (Object.keys(forRoute).length > 0) all[route] = forRoute
    else delete all[route]
    state.overrides = all
    persist()
  }

  /**
   * Mirror an override into the route's settings entry so the engine honours it
   * right now. A set swallows its own echo (sync must not argue with a value the
   * user just chose); a clear deliberately lets the echo through, so the field
   * comes straight back from the resolver on the next auto sync — exactly what
   * "恢复自动" means.
   */
  const writeOverride = async (
    route: string,
    model: string,
    field: OverrideField,
    value: Modality[] | number | undefined,
  ): Promise<void> => {
    const next = storedModels(route).map((entry) => ({ ...entry }))
    let index = next.findIndex((entry) => entry.id === model)
    if (index < 0) {
      // Clearing a model the route does not have is a no-op — never conjure an
      // entry just to delete a field from it.
      if (value === undefined) return
      index = next.length
      next.push({ id: model })
    }
    const entry = { ...next[index] }
    if (value === undefined) delete entry[field]
    else entry[field] = Array.isArray(value) ? [...value] : value
    next[index] = entry
    swallowEcho = value !== undefined
    try {
      await settings.mutate(SETTINGS_NS, [{ op: 'set', path: ['providers', route, 'models'], value: next }], undefined)
    } finally {
      swallowEcho = false
    }
  }

  const handlers: Record<string, (req: any, res: any, url: URL) => Promise<void>> = {
    [ROUTE_OVERVIEW]: async (_req, res) => {
      sendJson(res, 200, await overview())
    },
    [ROUTE_PLAN]: async (_req, res, url) => {
      const route = url.searchParams.get('provider') ?? url.searchParams.get('route') ?? ''
      if (route === '') {
        sendJson(res, 400, { ok: false, message: '缺少 provider 参数' })
        return
      }
      sendJson(res, 200, { ok: true, plan: await planFor(route), catalogue: catalogueStatus() })
    },
    [ROUTE_APPLY]: async (req, res) => {
      const body = await readBody(req)
      const route = typeof body.provider === 'string' ? body.provider : typeof body.route === 'string' ? body.route : ''
      if (route === '') {
        sendJson(res, 400, { ok: false, message: '缺少 provider' })
        return
      }
      sendJson(res, 200, await applyRoute(route))
    },
    [ROUTE_SYNC]: async (req, res) => {
      const body = await readBody(req)
      const refresh = body.refresh !== false
      const outcome = await runSync(refresh, '手动同步')
      sendJson(res, 200, { ok: true, catalogue: outcome.catalogue, refresh: outcome.refresh, results: outcome.results })
    },
    [ROUTE_OVERRIDE]: async (req, res) => {
      const body = await readBody(req)
      const route = typeof body.provider === 'string' ? body.provider : ''
      const model = typeof body.model === 'string' ? body.model : ''
      const field =
        body.field === 'contextWindow' || body.field === 'maxTokens' || body.field === 'input' ? body.field : undefined
      if (route === '' || model === '' || field === undefined) {
        sendJson(res, 400, { ok: false, message: '缺少 provider / model / field' })
        return
      }
      let value: Modality[] | number | undefined
      if (field === 'input') {
        const raw = Array.isArray(body.value) ? body.value : []
        const kept = raw.filter((v): v is Modality => MODALITIES.includes(v as Modality))
        value = kept.length > 0 ? [...new Set(kept)] : ['text']
      } else if (body.value === null) {
        value = undefined
      } else {
        const number = Number(body.value)
        if (!Number.isFinite(number) || number <= 0) {
          sendJson(res, 400, { ok: false, message: `${field} 必须是正数` })
          return
        }
        value = Math.floor(number)
      }
      recordOverride(route, model, field, value)
      await writeOverride(route, model, field, value)
      log(`手动覆盖：${route} / ${model} ${field}${value === undefined ? '（恢复自动）' : ''}`)
      sendJson(res, 200, { ok: true })
    },
    [ROUTE_CATALOGUE]: async (req, res) => {
      if (req.method === 'POST') {
        const report = await refreshCatalogue('界面手动刷新')
        sendJson(res, report.ok ? 200 : 502, { ok: report.ok, catalogue: catalogueStatus(), message: report.message })
        return
      }
      sendJson(res, 200, { ok: true, catalogue: catalogueStatus() })
    },
    [ROUTE_STATE]: async (_req, res, url) => {
      const route = url.searchParams.get('provider') ?? ''
      const plan = await planFor(route)
      const stored = storedModels(route)
      sendJson(res, 200, {
        ok: true,
        provider: route,
        configured: storedRoutes()[route] !== undefined,
        declaredList: stored.length > 0,
        models: plan.models.map((model) => ({
          id: model.id,
          name: model.name,
          declared: normalizedInput(stored.find((entry) => entry.id === model.id)?.input) ?? null,
          effective: model.capabilities.input.value ?? ['text'],
          supportsImage: (model.capabilities.input.value ?? ['text']).includes('image'),
          source: model.capabilities.input.source,
          sourceLabel: sourceLabel(model.capabilities.input.source),
        })),
      })
    },
    [ROUTE_SET]: async (req, res) => {
      const body = await readBody(req)
      const route = typeof body.provider === 'string' ? body.provider : ''
      const model = typeof body.model === 'string' ? body.model : ''
      if (route === '' || model === '') {
        sendJson(res, 400, { ok: false, message: '缺少 provider / model' })
        return
      }
      const value: Modality[] = body.image === true ? ['text', 'image'] : ['text']
      recordOverride(route, model, 'input', value)
      await writeOverride(route, model, 'input', value)
      log(`手动设置图片能力：${route} / ${model} = ${body.image === true ? '支持' : '不支持'}`)
      sendJson(res, 200, { ok: true })
    },
    [ROUTE_SEAT]: async (req, res) => {
      const body = await readBody(req)
      log(`客户端已就座：${JSON.stringify(body).slice(0, 220)}`)
      sendJson(res, 200, { ok: true, seats: 'settings.section' })
    },
  }

  if (catalogueStatus().stale) void refreshCatalogue('启动时目录过期')
  const interval = setInterval(() => void refreshCatalogue('每日定时'), CATALOGUE_MAX_AGE_MS)
  ;(interval as unknown as { unref?: () => void }).unref?.()
  ctx.effect(() => () => clearInterval(interval), 'dsh-model-vision: catalogue timer')

  // 首次导入零操作：任何一次模型配置写入（引擎设置页、配置文件导入、手机桥接
  // 保存）都会走到这里，防抖后由下面的泵自动补一次能力。自己写入产生的回声事件
  // 被一次性开关精确吞掉（写→回声同步到达→只忽略这一个）。注意这里只记录意图，
  // 不在本回调里排定时器——事件是在 HMR 事务上下文里发出的，定时器会继承该上下
  // 文导致之后的写入被拒（见 autoPending 注释里的实测）。
  ctx.on(
    'settings/document-updated' as never,
    ((ns: unknown) => {
      if (ns !== SETTINGS_NS) return
      if (swallowEcho) {
        // Our own write's echo: drop just this event.
        swallowEcho = false
        return
      }
      requestAutoSync('模型配置变更')
    }) as never,
    { global: true },
  )

  // 启动兜底：导入也可能发生在引擎关闭期间（改配置文件、手机离线保存、桌面壳
  // 启动时的模型目录同步），开机几秒后自己补一次，同样不需要任何人按按钮。
  requestAutoSync('启动', 3000)

  // 泵：每 500ms 看一眼排队的自动同步，到点就执行。它在 apply() 的干净上下文里
  // 创建、每个 tick 都继承该上下文——自动同步的配置写入能通过 HMR 串行队列，
  // 靠的就是这一点。
  const pump = setInterval(() => {
    const pending = autoPending
    if (pending === undefined || Date.now() < pending.at) return
    autoPending = undefined
    fireAutoSync(pending.reason)
  }, 500)
  ;(pump as unknown as { unref?: () => void }).unref?.()
  ctx.effect(() => () => clearInterval(pump), 'dsh-model-vision: auto sync pump')

  const webServer = ctx.get('webServer') as { register: (route: unknown) => () => void } | undefined
  if (!webServer) {
    log('webServer 服务不可用，仅保留客户端界面')
    return
  }

  ctx.effect(() => {
    const disposers = Object.entries(handlers).map(([routePath, handler]) =>
      webServer.register({
        kind: 'exact',
        path: routePath,
        handler: async (req: any, res: any) => {
          const url = new URL(String(req.url ?? routePath), 'http://127.0.0.1')
          try {
            await handler(req, res, url)
          } catch (error) {
            sendJson(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    )
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-model-vision: routes')

  log(`已就绪：能力目录 ${catalogueStatus().count} 条（来源 ${catalogueOrigin}），路由 ${Object.keys(storedRoutes()).length} 条`)
}
