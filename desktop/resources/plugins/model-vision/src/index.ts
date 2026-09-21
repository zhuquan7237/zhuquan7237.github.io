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
 * for the rest — with every value carrying the source it came from, additions
 * applied automatically, corrections offered as a diff for confirmation, and the
 * whole thing re-checked daily.
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
export const CATALOGUE_URL = 'https://openrouter.ai/api/v1/models'

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

/** Structural slice of `settings` this plugin uses. */
export interface SettingsLike {
  section(ns: string): unknown
  get(ns: string): unknown
  mutate(ns: string, ops: unknown, expectedRevision?: number): Promise<unknown>
}

/** Structural slice of `llm` this plugin uses. */
export interface LlmLike {
  listModels(provider: string): Promise<readonly { id: string; name?: string; inputModalities?: readonly string[] }[]>
  discoverModels?(settingsNs: string, request: unknown, signal?: AbortSignal): Promise<readonly unknown[]>
}

/** Persisted, machine-local state (catalogue cache + sync bookkeeping). */
interface PluginState {
  catalogue?: Catalogue
  catalogueFetchedAt?: number
  lastSync?: Record<string, { at: string; summary: string; applied: number }>
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
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 60_000)
      const response = await fetch(CATALOGUE_URL, { signal: controller.signal })
      clearTimeout(timer)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const keys = catalogueFromModels(await response.json())
      const count = Object.keys(keys).length
      if (count === 0) throw new Error('目录为空（结构可能变了）')
      catalogue = { version: 1, generatedAt: new Date().toISOString(), source: CATALOGUE_URL, keys }
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
  const storedRoutes = (): Record<string, Record<string, unknown>> => {
    const resolved = settings.get(SETTINGS_NS)
    return isRecord(resolved) && isRecord(resolved.providers)
      ? (resolved.providers as Record<string, Record<string, unknown>>)
      : {}
  }

  const storedModels = (route: string): Record<string, unknown>[] => {
    const section = settings.section(SETTINGS_NS)
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
    return planRoute({ route, models, stored: storedModels(route), catalogue, upstream })
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
        pendingCorrections: plan?.counts.correctable ?? 0,
        summary: plan ? summarizePlan(plan) : '',
        lastSync: state.lastSync?.[route] ?? null,
        error,
      })
    }
    return { ok: true, catalogue: catalogueStatus(), routes: out }
  }

  const applyRoute = async (route: string, accepted: readonly string[]): Promise<unknown> => {
    const plan = await planFor(route)
    const next = applyPlan({ stored: storedModels(route), plan, accepted })
    const written = plan.models.filter(
      (model) => model.changes.some((change) => change.verdict !== 'correct' || accepted.includes(model.id)),
    ).length
    if (written > 0) {
      await settings.mutate(SETTINGS_NS, [{ op: 'set', path: ['providers', route, 'models'], value: next }], undefined)
    }
    const summary = summarizePlan(plan)
    state.lastSync = { ...(state.lastSync ?? {}), [route]: { at: new Date().toISOString(), summary, applied: written } }
    persist()
    log(`应用模型能力：${route} — 写入 ${written} 个模型（${summary}）`)
    return { ok: true, route, applied: written, summary, plan: await planFor(route) }
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
      const accepted = Array.isArray(body.accepted) ? body.accepted.filter((v): v is string => typeof v === 'string') : []
      if (route === '') {
        sendJson(res, 400, { ok: false, message: '缺少 provider' })
        return
      }
      sendJson(res, 200, await applyRoute(route, accepted))
    },
    [ROUTE_SYNC]: async (req, res) => {
      const body = await readBody(req)
      const refresh = body.refresh !== false
      const report = refresh
        ? await refreshCatalogue('手动同步')
        : { ok: true, count: catalogueStatus().count, message: '跳过刷新' }
      const results = []
      for (const route of Object.keys(storedRoutes())) {
        try {
          results.push(await applyRoute(route, []))
        } catch (error) {
          results.push({ ok: false, route, message: error instanceof Error ? error.message : String(error) })
        }
      }
      sendJson(res, 200, { ok: true, catalogue: catalogueStatus(), refresh: report, results })
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
      const next = storedModels(route).map((entry) => ({ ...entry }))
      let index = next.findIndex((entry) => entry.id === model)
      if (index < 0) {
        index = next.length
        next.push({ id: model })
      }
      const current = { ...next[index] }
      if (field === 'input') {
        const raw = Array.isArray(body.value) ? body.value : []
        const kept = raw.filter((v): v is Modality => MODALITIES.includes(v as Modality))
        current.input = kept.length > 0 ? [...new Set(kept)] : ['text']
      } else if (body.value === null) {
        delete current[field]
      } else {
        const value = Number(body.value)
        if (!Number.isFinite(value) || value <= 0) {
          sendJson(res, 400, { ok: false, message: `${field} 必须是正数` })
          return
        }
        current[field] = Math.floor(value)
      }
      next[index] = current
      await settings.mutate(SETTINGS_NS, [{ op: 'set', path: ['providers', route, 'models'], value: next }], undefined)
      log(`手动覆盖：${route} / ${model} ${field}`)
      sendJson(res, 200, { ok: true, plan: await planFor(route) })
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
      const value: CapabilityOverride = { input: body.image === true ? ['text', 'image'] : ['text'] }
      const next: Record<string, unknown>[] = storedModels(route).map((entry) =>
        entry.id === model ? { ...entry, input: [...(value.input ?? [])] } : { ...entry },
      )
      if (!next.some((entry) => entry.id === model)) next.push({ id: model, input: [...(value.input ?? [])] })
      await settings.mutate(SETTINGS_NS, [{ op: 'set', path: ['providers', route, 'models'], value: next }], undefined)
      log(`手动设置图片能力：${route} / ${model} = ${body.image === true ? '支持' : '不支持'}`)
      sendJson(res, 200, { ok: true, plan: await planFor(route) })
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
