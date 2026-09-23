/**
 * The mobile bridge: what a phone may ask the desktop harness to do, and on whose
 * authority.
 *
 * The engine already owns every capability the phone needs — sessions, history,
 * search, prompts, model selection, settings and credentials — exposed as Remote
 * methods behind `ctx.typertGateway`. It also refuses to bind beyond loopback,
 * because exposing its own API to a network would expose code execution with it.
 * So this plugin adds exactly two things and reimplements nothing:
 *
 *   1. **Authority**: pairing codes, per-device bearer tokens, a fail-closed scope
 *      table, and revocation. The engine's trust boundary stays untouched.
 *   2. **A mobile-shaped surface**: session/history/event endpoints plus a shared
 *      model document with revisions and a merge rule that reports conflicts
 *      instead of overwriting them. Everything else is available verbatim through
 *      `/mobile/rpc`, gated by the same scope table.
 *
 * Requests reach it through the project's tunnel, which forwards only `/mobile/*`;
 * pairing and device management live under `/mobile-local/*`, which the tunnel
 * does not forward, so a pairing code is never readable from the internet.
 *
 * @module @dsh-desktop/dsh-mobile-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type BridgeStore,
  type DeviceRecord,
  type Scope,
  SCOPE_LABELS,
  SCOPES,
  consumePairing,
  deviceForToken,
  deviceView,
  emptyStore,
  issuePairing,
  newToken,
  normalizeCode,
  normalizePublicUrl,
  readStore,
  scopeAllows,
  storePath,
  writeStore,
} from './devices.js'
import {
  type MobileModelDoc,
  type ModelOverlay,
  buildDoc,
  engineOps,
  mergeDocs,
  overlayFor,
} from './models.js'
import { qrSvg } from './qr.js'
import { normalizeSince } from './hello.js'
import { type WsConnection, acceptUpgrade } from './ws.js'

export * from './devices.js'
export * from './hello.js'
export * from './models.js'
export * from './qr.js'
export * from './ws.js'

/** Cordis plugin name — the patch row id. */
export const name = 'dsh-mobile-bridge'

/** Services the host half needs. */
export const inject = ['webServer', 'credentials']

/** Public prefix the tunnel forwards. */
export const PUBLIC_PREFIX = '/mobile'

/** Local-only prefix for pairing and device management. */
export const LOCAL_PREFIX = '/mobile-local'

/** Settings namespace that owns provider routes. */
export const MODEL_NS = 'llm-pi-ai'

/** How many event frames are kept for a reconnecting device. */
export const EVENT_BUFFER = 500

/** Largest request body the bridge accepts. */
const MAX_BODY = 512 * 1024

const log = (line: string): void => {
  // console.log reaches the desktop shell's engine log reliably.
  console.log(`[dsh-mobile-bridge] ${line}`)
}

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'app')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

interface HttpRequest {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  on(event: string, listener: (...args: unknown[]) => void): unknown
  [Symbol.asyncIterator]?: () => AsyncIterator<Buffer | string>
}

interface HttpResponse {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string | Buffer): void
}

/** One buffered event frame. */
interface EventFrame {
  seq: number
  kind: 'event' | 'notify' | 'hello'
  time: number
  sessionId?: string
  type?: string
  level?: string
  title?: string
  body?: string
  data?: unknown
}

function sendJson(res: HttpResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(body)
}

async function readJsonBody(req: HttpRequest, limit = MAX_BODY): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  const iterator = (req as unknown as AsyncIterable<Buffer | string>)[Symbol.asyncIterator]
  if (iterator === undefined) return {}
  for await (const chunk of req as unknown as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    size += buffer.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  return raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>)
}

/**
 * The part of a request path after a registered prefix.
 *
 * The web server may hand a prefix route either the full path or the path with
 * the prefix already removed, and getting this wrong looks like "the route does
 * not exist" while every exact route keeps working. Both shapes are therefore
 * accepted: strip the prefix when present, use the path as-is otherwise.
 *
 * @param raw - the request's url (with or without query).
 * @param prefix - the registered prefix.
 * @returns the remainder, always starting with `/`.
 */
function pathAfter(raw: unknown, prefix: string): string {
  const path = String(raw ?? '/').split('?')[0] ?? '/'
  if (path === prefix || path === `${prefix}/`) return '/'
  if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length)
  return path.startsWith('/') ? path : `/${path}`
}

/** Bearer token from the Authorization header, or `?token=` for WebSocket upgrades. */
function tokenOf(req: HttpRequest): string {
  const header = req.headers.authorization
  const value = Array.isArray(header) ? header[0] : header
  if (typeof value === 'string' && value.toLowerCase().startsWith('bearer ')) return value.slice(7).trim()
  const url = String(req.url ?? '')
  const at = url.indexOf('?')
  if (at >= 0) {
    const params = new URLSearchParams(url.slice(at + 1))
    const token = params.get('token')
    if (token !== null && token !== '') return token
  }
  return ''
}

/**
 * Endpoint names that could serve one wire method.
 *
 * A Remote method's endpoint is `${namespace}/${method}` where the namespace is
 * the owning service key — `session.*` is served by the `sessionController`
 * service, so `session.create` lives at `sessionController/create`. Guessing is
 * unnecessary and brittle: the candidates are tried in order and the one that
 * answers is remembered, which also survives a rename in a future engine.
 *
 * @param method - the dotted wire method (`session.create`).
 * @returns endpoint candidates, most likely first.
 */
export function endpointCandidates(method: string): string[] {
  const at = method.indexOf('.')
  if (at < 0) return [method]
  const namespace = method.slice(0, at)
  const name = method.slice(at + 1)
  // The Remote namespace is the service's own key (`session`, `settings`,
  // `credentials`), so the dotted wire name maps to a slash endpoint directly.
  const candidates = [`${namespace}/${name}`, method]
  // The session control service is a second owner of the `session` namespace in
  // some builds; keeping it second costs one retry at most.
  if (namespace === 'session') candidates.push(`sessionController/${name}`)
  return [...new Set(candidates)]
}

/** Which endpoint and argument envelope served each method, once discovered. */
const discoveredEndpoints = new Map<string, { endpoint: string; field?: string }>()

/**
 * Call one engine Remote method.
 *
 * `dispatchRpc` is the same entry the engine's own `/api` route uses, so values
 * are schema-validated and errors carry the engine's own codes; `invoke` is the
 * fallback for a build whose service exposes only that shape.
 */
async function callEngine(ctx: Context, method: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
  const known = discoveredEndpoints.get(method)
  const endpoints = known !== undefined ? [known.endpoint] : endpointCandidates(method)
  const fields = known !== undefined ? [known.field] : [undefined, 'request', '_request', 'payload']
  let lastError: unknown
  let hint: string | undefined
  for (const endpoint of endpoints) {
    for (const field of fields) {
      try {
        const value = await invokeEngine(ctx, endpoint, field === undefined ? payload : { [field]: payload }, signal)
        const found = { endpoint, ...(field !== undefined ? { field } : {}) }
        if (known === undefined) {
          discoveredEndpoints.set(method, found)
          if (endpoint !== method || field !== undefined) {
            log(`端点解析：${method} → ${endpoint}${field !== undefined ? `（参数写在 ${field} 里）` : ''}`)
          }
        }
        return value
      } catch (error) {
        lastError = error
        const message = error instanceof Error ? error.message : String(error)
        // A naming miss is worth retrying; a parameter-shape miss tells us the
        // field name the descriptor wants, so the next attempt wraps it that way.
        const missing = /missing \"([A-Za-z_][A-Za-z0-9_]*)\"/.exec(message)
        if (missing !== null) {
          hint = missing[1]
          if (!fields.includes(hint)) fields.push(hint)
          continue
        }
        if (!/endpoint|remote method/i.test(message)) throw error
        break
      }
    }
    void hint
  }
  throw lastError
}

/** Invoke one already-named endpoint. */
async function invokeEngine(ctx: Context, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
  const gateway = ctx.get('typertGateway') as unknown as
    | {
        dispatchRpc?: (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>
        invoke?: (request: { endpoint: string; args: unknown; signal?: AbortSignal }) => Promise<unknown>
      }
    | undefined
  if (gateway === undefined) throw new Error('这个引擎没有提供 typertGateway，无法转发调用')
  if (typeof gateway.dispatchRpc === 'function') {
    // The carrier envelope is `{args}` — the gateway validates that a request
    // holds exactly one plain-object `args` field before it resolves anything.
    const result = await gateway.dispatchRpc(endpoint, { args: payload ?? {} }, signal)
    if (isRecord(result) && 'ok' in result) {
      if (result.ok === true) return result.value
      throw new EngineCallError(endpoint, result)
    }
    return result
  }
  if (typeof gateway.invoke === 'function') {
    return await gateway.invoke({ endpoint, args: payload ?? {}, ...(signal !== undefined ? { signal } : {}) })
  }
  throw new Error('typertGateway 的调用接口不认识，无法转发')
}

/** A failure the engine reported for one method call. */
class EngineCallError extends Error {
  readonly method: string
  readonly detail: unknown

  constructor(method: string, result: unknown) {
    const record = isRecord(result) ? result : {}
    const failure = isRecord(record.error) ? record.error : record
    const message =
      (typeof failure.message === 'string' && failure.message) ||
      (typeof record.message === 'string' && record.message) ||
      `引擎拒绝了这个调用（${method}）`
    super(message)
    this.name = 'EngineCallError'
    this.method = method
    this.detail = failure
  }

  /** The engine's own code, when it sent one. */
  get code(): string | undefined {
    const failure = isRecord(this.detail) ? this.detail : {}
    for (const field of ['code', 'type', 'reason']) {
      const value = failure[field]
      if (typeof value === 'string' && value !== '') return value
    }
    return undefined
  }
}

/** Map one engine failure onto the mobile error vocabulary. */
function failurePayload(error: unknown): { code: string; message: string; detail?: unknown } {
  if (error instanceof EngineCallError) {
    const code = error.code ?? ''
    const revisionish = /revision|conflict|stale/i.test(`${code} ${error.message}`)
    return {
      code: revisionish ? 'E_REVISION' : /not found|missing/i.test(`${code} ${error.message}`) ? 'E_NOT_FOUND' : 'E_ENGINE',
      message: error.message,
      ...(error.detail !== undefined ? { detail: error.detail } : {}),
    }
  }
  if (error instanceof Error) return { code: 'E_BRIDGE', message: error.message }
  return { code: 'E_BRIDGE', message: String(error) }
}

/**
 * Register the bridge.
 *
 * @param ctx - host context; `webServer` and `credentials` are injected.
 * @param config - optional `publicUrl` shown in the pairing page.
 */
export function apply(ctx: Context, config: { publicUrl?: string } = {}): void {
  const webServer = ctx.get('webServer') as unknown as {
    register: (route: { kind: 'exact' | 'prefix'; path: string; handler: (req: HttpRequest, res: HttpResponse) => void }) => void
    registerUpgrade?: (route: { kind?: 'exact' | 'prefix'; path: string; handler: (req: HttpRequest, socket: unknown, head: Buffer) => void }) => void
  }
  const credentials = ctx.get('credentials') as unknown as
    | {
        describe: (ref: string) => Promise<{ configured?: boolean } | undefined>
        set: (ref: string, value: string) => Promise<void>
        unset: (ref: string) => Promise<void>
      }
    | undefined

  // ------------------------------------------------------------------ the store
  const load = (): BridgeStore => readStore()
  const save = (store: BridgeStore): void => writeStore(store)

  const overlayOf = (store: BridgeStore): ModelOverlay => {
    const raw = (store as unknown as { models?: unknown }).models
    return isRecord(raw)
      ? { revision: typeof raw.revision === 'number' ? raw.revision : 0, ...(raw as Record<string, unknown>) }
      : { revision: 0 }
  }

  // ------------------------------------------------------------------- events
  const frames: EventFrame[] = []
  const clients = new Map<WsConnection, { deviceId: string; since: number }>()
  let seq = 0
  /**
   * Names this counter's lifetime. `seq` restarts with the process, so a phone
   * whose stored watermark outlives a restart must not be trusted (see
   * `normalizeSince`); the epoch is what lets a client notice that happened.
   */
  const epoch = randomUUID()
  /** Highest event seq seen per session, from the live event stream. */
  const headSeqs = new Map<string, number>()

  const publish = (frame: Omit<EventFrame, 'seq' | 'time'>): void => {
    seq += 1
    const full: EventFrame = { seq, time: Date.now(), ...frame }
    frames.push(full)
    if (frames.length > EVENT_BUFFER) frames.splice(0, frames.length - EVENT_BUFFER)
    const text = JSON.stringify(full)
    for (const [connection, state] of clients) {
      if (!connection.open) {
        clients.delete(connection)
        continue
      }
      if (full.seq > state.since) connection.send(text)
    }
  }

  const sessionIdOf = (session: unknown): string => {
    if (isRecord(session)) {
      for (const field of ['id', 'sessionId']) {
        const value = session[field]
        if (typeof value === 'string' && value !== '') return value
      }
      const header = session.header
      if (isRecord(header) && typeof header.id === 'string') return header.id
    }
    return ''
  }

  // One subscription drives both the phone's stream and its notifications.
  try {
    ctx.on('session/event' as never, ((session: unknown, event: unknown) => {
      const record = isRecord(event) ? event : {}
      const type = typeof record.type === 'string' ? record.type : 'unknown'
      const sessionId = sessionIdOf(session)
      const sessionSeq = typeof record.seq === 'number' ? record.seq : 0
      if (sessionId !== '' && sessionSeq > 0) {
        headSeqs.set(sessionId, Math.max(headSeqs.get(sessionId) ?? 0, sessionSeq))
      }
      publish({
        kind: 'event',
        ...(sessionId !== '' ? { sessionId } : {}),
        type,
        data: record.data ?? null,
        // The phone needs the turn/step boundary to place a message.
        ...(isRecord(record) && typeof record.seq === 'number' ? { data: { ...(isRecord(record.data) ? record.data : {}), eventSeq: record.seq } } : {}),
      })
      if (type === 'turn/end') {
        const reasonRaw = isRecord(record.data) && typeof record.data.reason === 'string' ? record.data.reason : 'ended'
        const failed = /error|fail/i.test(reasonRaw)
        publish({
          kind: 'notify',
          ...(sessionId !== '' ? { sessionId } : {}),
          level: failed ? 'error' : 'info',
          title: failed ? '回合失败' : '回合完成',
          body: failed ? `原因：${reasonRaw}` : '电脑端已结束这次回合',
        })
      }
    }) as never)
  } catch (error) {
    log(`订阅会话事件失败：${error instanceof Error ? error.message : String(error)}`)
  }

  // ------------------------------------------------------------------- helpers
  const authenticate = (req: HttpRequest): { device: DeviceRecord; store: BridgeStore } | { error: { code: string; message: string } } => {
    const token = tokenOf(req)
    if (token === '') return { error: { code: 'E_UNAUTHORIZED', message: '缺少设备令牌' } }
    const store = load()
    const device = deviceForToken(store, token)
    if (device === undefined) return { error: { code: 'E_UNAUTHORIZED', message: '令牌无效或已被解除绑定' } }
    device.lastSeenAt = Date.now()
    try {
      save(store)
    } catch {
      // A read-only home must not turn a valid token into a failure.
    }
    return { device, store }
  }

  /**
   * Whether a device holds a scope, with the same implication the method table
   * uses: a device trusted with configuration is not less trusted with a message.
   */
  const holdsScope = (device: DeviceRecord, needed: Scope): boolean => {
    if (device.scopes.includes(needed)) return true
    if (needed === 'read') return device.scopes.some((scope) => scope === 'prompt' || scope === 'config' || scope === 'admin')
    if (needed === 'prompt') return device.scopes.some((scope) => scope === 'config' || scope === 'admin')
    return false
  }

  const requireScope = (
    device: DeviceRecord,
    needed: Scope,
  ): { ok: true } | { ok: false; code: string; message: string } =>
    holdsScope(device, needed)
      ? { ok: true }
      : { ok: false, code: 'E_FORBIDDEN', message: `这台设备没有被授予「${SCOPE_LABELS[needed]}」权限，请在电脑端重新配对并勾选` }

  /**
   * Read one page of a session's log through the engine's own paging method.
   *
   * `session.page` demands a `throughSeq` at or below the session's cursor, and a
   * reader that has not watched the session cannot know that cursor yet. The
   * engine names it in its refusal ("past cursor N"), so the cursor is learned
   * from that one error and then kept fresh by the event stream the bridge is
   * already subscribed to.
   */
  const readPage = async (sessionId: string, base: Record<string, unknown>): Promise<unknown> => {
    for (let tries = 0; tries < 3; tries += 1) {
      const through = headSeqs.get(sessionId) ?? Number.MAX_SAFE_INTEGER
      try {
        return await callEngine(ctx, 'session.page', { ...base, throughSeq: through })
      } catch (error) {
        const match = /past cursor (\d+)/.exec(String((error as Error)?.message ?? error))
        if (match === null) throw error
        headSeqs.set(sessionId, Number(match[1]))
      }
    }
    throw new Error('无法确定会话游标')
  }

  /** The settings namespace view for the model document. */
  const modelNamespace = async (): Promise<{ value?: unknown; revision?: number } | undefined> => {
    const described = (await callEngine(ctx, 'settings.describe', {})) as unknown
    const namespaces = isRecord(described) && Array.isArray(described.namespaces) ? described.namespaces : []
    for (const view of namespaces) {
      if (isRecord(view) && view.ns === MODEL_NS) return view as { value?: unknown; revision?: number }
    }
    return undefined
  }

  const buildModelDoc = async (store: BridgeStore): Promise<MobileModelDoc> => {
    const view = await modelNamespace()
    const refs = new Set<string>()
    const value = isRecord(view?.value) ? (view?.value as Record<string, unknown>) : {}
    const providers = isRecord(value.providers) ? (value.providers as Record<string, unknown>) : {}
    for (const provider of Object.values(providers)) {
      if (isRecord(provider) && typeof provider.apiKeyEnv === 'string') refs.add(provider.apiKeyEnv)
    }
    const keyConfigured: Record<string, boolean> = {}
    for (const ref of refs) {
      try {
        const described = await credentials?.describe(ref)
        keyConfigured[ref] = described?.configured === true
      } catch {
        keyConfigured[ref] = false
      }
    }
    return buildDoc(view, overlayOf(store), keyConfigured)
  }

  /** Public URL from the profile config, before the store's own value wins. */
  const configuredPublicUrl = (): string => (config.publicUrl ?? '').trim().replace(/\/+$/, '')

  /**
   * Effective public base URL. The store's value wins over the profile config so
   * the settings page can change it without an engine restart; the config stays
   * as the fallback for machines that set it before this existed.
   */
  const publicUrl = (): string => {
    const stored = normalizePublicUrl(load().publicUrl)
    return stored !== '' ? stored : configuredPublicUrl()
  }

  const publicUrlSource = (): 'store' | 'config' | '' => {
    if (normalizePublicUrl(load().publicUrl) !== '') return 'store'
    return configuredPublicUrl() !== '' ? 'config' : ''
  }

  const pairingUrl = (code: string): string => {
    const base = publicUrl()
    return base === '' ? code : `${base}/mobile/?pair=${encodeURIComponent(code)}`
  }

  // -------------------------------------------------------------- local routes
  const localState = (): Record<string, unknown> => {
    const store = load()
    const pairing = store.pairing
    const live = pairing !== undefined && pairing.expiresAt > Date.now()
    return {
      storePath: storePath(),
      pairCode: live ? pairing?.code : null,
      pairExpiresAt: live ? pairing?.expiresAt : null,
      pairUrl: live && pairing !== undefined ? pairingUrl(pairing.code) : null,
      publicUrl: publicUrl(),
      publicUrlSource: publicUrlSource(),
      publicUrlConfigured: configuredPublicUrl(),
      devices: store.devices.map(deviceView),
      scopes: SCOPES.map((scope) => ({ id: scope, label: SCOPE_LABELS[scope] })),
    }
  }

  const pairingPage = (): string => {
    const state = localState()
    const code = state.pairCode as string | null
    const devices = state.devices as Record<string, unknown>[]
    const url = state.pairUrl as string | null
    const rows = devices
      .map(
        (device) =>
          `<li><strong>${String(device.name ?? '未命名')}</strong> · ${String(device.platform ?? '')} · ${(device.scopes as string[]).join('/')} · 最后活跃 ${new Date(Number(device.lastSeenAt ?? 0)).toLocaleString('zh-CN')} · <button data-revoke="${String(device.id)}">解除</button></li>`,
      )
      .join('')
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>移动端配对 · DeepSeek Harness</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.7 system-ui, "Microsoft YaHei", sans-serif; margin: 0; padding: 28px; background: #f7f8fa; color: #1b1c1e; }
  @media (prefers-color-scheme: dark) { body { background: #17181b; color: #ececf1; } }
  main { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.sub { color: #6b6d73; margin: 0 0 20px; }
  .card { background: rgba(127,127,127,.08); border: 1px solid rgba(127,127,127,.2); border-radius: 14px; padding: 18px 20px; margin-bottom: 16px; }
  .code { font: 700 30px/1.2 ui-monospace, Consolas, monospace; letter-spacing: 3px; margin: 8px 0 2px; }
  .muted { color: #6b6d73; font-size: 12px; }
  code.url { display: block; word-break: break-all; font-size: 12px; margin-top: 8px; color: #6b6d73; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: 8px 0; border-bottom: 1px solid rgba(127,127,127,.15); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  li:last-child { border-bottom: 0; }
  button { font: inherit; padding: 6px 12px; border-radius: 9px; border: 1px solid rgba(127,127,127,.3); background: transparent; color: inherit; cursor: pointer; }
  button.primary { background: #4176e6; border-color: #4176e6; color: #fff; }
  a { color: #4176e6; }
</style></head><body><main>
<h1>移动端配对</h1>
<p class="sub">手机端打开 <code>${String(state.publicUrl ?? '（未配置公网地址）')}/mobile/</code> 后输入下面这串码，或直接点链接。</p>
<div class="card">
  ${code !== null ? `<div class="muted">配对码（5 分钟有效）</div><div class="code">${code}</div>` : '<div class="muted">当前没有有效配对码。</div>'}
  ${url !== null ? `<code class="url">${url}</code>` : ''}
  <p><button class="primary" data-rotate="1">${code !== null ? '重新生成' : '生成配对码'}</button></p>
</div>
<div class="card">
  <div class="muted">已绑定的设备（${devices.length}）</div>
  <ul>${rows === '' ? '<li class="muted">还没有设备绑定</li>' : rows}</ul>
</div>
<script>
const refresh = () => location.reload();
document.addEventListener('click', async (event) => {
  const target = event.target;
  if (target.dataset.rotate) { await fetch('${LOCAL_PREFIX}/rotate', { method: 'POST' }); refresh(); }
  if (target.dataset.revoke) {
    if (!confirm('解除这台设备？它会立刻失去访问权限。')) return;
    await fetch('${LOCAL_PREFIX}/devices/' + target.dataset.revoke, { method: 'DELETE' });
    refresh();
  }
});
</script>
</main></body></html>`
  }

  // Prefix routes must NOT end with a slash: the web server matches a prefix by
  // `pathname === prefix || pathname.startsWith(prefix + '/')`, so a trailing
  // slash matches nothing at all — the symptom is every exact route working
  // while the prefix routes look like they were never registered.
  webServer.register({
    kind: 'prefix',
    path: LOCAL_PREFIX,
    handler: (req, res) => {
      const path = pathAfter(req.url, LOCAL_PREFIX)
      if (path.startsWith('/state')) {
        sendJson(res, 200, localState())
        return
      }
      if (path.startsWith('/rotate')) {
        const store = load()
        const pairing = issuePairing(store)
        save(store)
        log(`已生成配对码（5 分钟内有效）`)
        sendJson(res, 200, { ok: true, code: pairing.code, expiresAt: pairing.expiresAt })
        return
      }
      // QR for the current pairing link, rendered server-side so the settings
      // page only needs an <img> and the shell and the plugin always draw the
      // same code for the same link.
      if (path.startsWith('/qr')) {
        const state = localState()
        const code = state.pairCode as string | null
        const link = state.pairUrl as string | null
        if (code === null || link === null) {
          // Say which half is missing: "no code yet" and "no public address" are
          // different fixes, and the old build reported the wrong one whenever
          // both were missing.
          const missingBase = publicUrl() === ''
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          res.end(
            missingBase
              ? '还没有配置公网地址，二维码会指向不可达的地址：请在上方填入公网地址后重试。'
              : '当前没有有效配对码：先生成配对码。',
          )
          return
        }
        try {
          const svg = qrSvg(link)
          res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' })
          res.end(svg)
        } catch (error) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(`二维码生成失败：${error instanceof Error ? error.message : String(error)}`)
        }
        return
      }
      // Public address used by the QR. Stored in the bridge's own store, so the
      // settings page can change it without an engine restart.
      if (path.startsWith('/config')) {
        if (req.method !== 'POST') {
          sendJson(res, 200, {
            ok: true,
            publicUrl: publicUrl(),
            publicUrlSource: publicUrlSource(),
            configuredUrl: configuredPublicUrl(),
            storePath: storePath(),
          })
          return
        }
        void (async () => {
          try {
            const body = await readJsonBody(req)
            const raw = String(body.publicUrl ?? '').trim()
            const next = normalizePublicUrl(raw)
            if (raw !== '' && next === '') {
              sendJson(res, 200, {
                ok: false,
                code: 'E_PUBLIC_URL',
                message: '公网地址需要以 http:// 或 https:// 开头，例如 https://m.example.com（留空表示清除）。',
              })
              return
            }
            const store = load()
            if (next === '') {
              delete store.publicUrl
            } else {
              store.publicUrl = next
            }
            save(store)
            log(next === '' ? '已清除公网地址（回退为 profile 配置）' : `公网地址已更新：${next}`)
            // A new base makes the previously scanned code point at the wrong
            // host, so issue a fresh code and hand it back with the new link.
            const rotated = load()
            const pairing = issuePairing(rotated)
            save(rotated)
            sendJson(res, 200, {
              ok: true,
              publicUrl: publicUrl(),
              publicUrlSource: publicUrlSource(),
              pairCode: pairing.code,
              pairExpiresAt: pairing.expiresAt,
              pairUrl: pairingUrl(pairing.code),
            })
          } catch (error) {
            sendJson(res, 200, {
              ok: false,
              code: 'E_CONFIG',
              message: error instanceof Error ? error.message : String(error),
            })
          }
        })()
        return
      }
      // The settings section reports that it mounted, so a blank page has a
      // server-side trace instead of silence.
      if (path.startsWith('/seat')) {
        void (async () => {
          try {
            const body = await readJsonBody(req)
            const stage = String(body.stage ?? '').trim()
            const failure = String(body.failure ?? '').trim()
            log(`设置页${stage === 'seated' ? '已挂载' : `挂载失败${failure === '' ? '' : `：${failure}`}`}`)
          } catch {
            /* the seat ping is best-effort */
          }
          sendJson(res, 200, { ok: true })
        })()
        return
      }
      const revoke = path.match(/^\/devices\/([^/?]+)/)
      if (revoke !== null) {
        const store = load()
        const before = store.devices.length
        store.devices = store.devices.filter((device) => device.id !== decodeURIComponent(revoke[1] as string))
        save(store)
        log(`已解除绑定：${before - store.devices.length} 台设备`)
        sendJson(res, 200, { ok: true, devices: store.devices.map(deviceView) })
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(pairingPage())
    },
  })

  // ------------------------------------------------------------- pairing route
  webServer.register({
    kind: 'exact',
    path: `${PUBLIC_PREFIX}/pair`,
    handler: (req, res) => {
      void (async () => {
        try {
          const body = await readJsonBody(req)
          const store = load()
          const result = consumePairing(store, body.code)
          if (!result.ok) {
            save(store)
            log(`配对失败：${result.reason}`)
            sendJson(res, 200, { ok: false, code: 'E_PAIRING', message: result.reason })
            return
          }
          const { token, tokenHash } = newToken()
          const requested = Array.isArray(body.scopes) ? (body.scopes as unknown[]).filter((s): s is Scope => SCOPES.includes(s as Scope)) : []
          const scopes: Scope[] = requested.length > 0 ? requested : ['read', 'prompt']
          const device: DeviceRecord = {
            id: randomUUID(),
            name: String(body.deviceName ?? '手机').slice(0, 60),
            platform: String(body.platform ?? '').slice(0, 60),
            tokenHash,
            scopes,
            createdAt: Date.now(),
            lastSeenAt: Date.now(),
          }
          store.devices.push(device)
          save(store)
          log(`新设备已绑定：${device.name}（${scopes.join('/')}）`)
          publish({ kind: 'notify', level: 'info', title: '新设备已绑定', body: `${device.name} 获得了 ${scopes.join('/')} 权限` })
          sendJson(res, 200, { ok: true, device: deviceView(device), token, scopes })
        } catch (error) {
          sendJson(res, 200, { ok: false, code: 'E_PAIRING', message: error instanceof Error ? error.message : String(error) })
        }
      })()
    },
  })

  // ------------------------------------------------------------------ API routes
  const guarded = (
    handler: (req: HttpRequest, res: HttpResponse, device: DeviceRecord, body: Record<string, unknown>) => Promise<void>,
    bodyRequired = false,
  ) => {
    return (req: HttpRequest, res: HttpResponse): void => {
      void (async () => {
        const auth = authenticate(req)
        if ('error' in auth) {
          sendJson(res, 401, { ok: false, ...auth.error })
          return
        }
        try {
          const body = bodyRequired ? await readJsonBody(req) : {}
          await handler(req, res, auth.device, body)
        } catch (error) {
          const payload = failurePayload(error)
          log(`请求失败：${payload.code} ${payload.message}`)
          sendJson(res, 200, { ok: false, ...payload })
        }
      })()
    }
  }

  webServer.register({
    kind: 'exact',
    path: `${PUBLIC_PREFIX}/meta`,
    handler: guarded(async (req, res, device) => {
      sendJson(res, 200, {
        ok: true,
        server: { product: 'DeepSeek Harness', bridge: 'dsh-mobile-bridge', version: 1 },
        device: deviceView(device),
        capabilities: {
          scopes: device.scopes,
          publicUrl: (config.publicUrl ?? '').trim(),
          modelNamespace: MODEL_NS,
          eventBuffer: EVENT_BUFFER,
        },
      })
    }),
  })

  webServer.register({
    kind: 'exact',
    path: `${PUBLIC_PREFIX}/sessions`,
    handler: guarded(async (req, res, device, body) => {
      const check = requireScope(device, 'read')
      if (!check.ok) {
        sendJson(res, 200, { ok: false, code: check.code, message: check.message })
        return
      }
      if (req.method === 'GET') {
        const url = new URL(String(req.url ?? ''), 'http://localhost')
        const query = (url.searchParams.get('query') ?? '').trim()
        if (query !== '') {
          const found = (await callEngine(ctx, 'session.search', { query })) as unknown
          sendJson(res, 200, { ok: true, search: true, ...(isRecord(found) ? found : { items: [] }) })
          return
        }
        const listed = (await callEngine(ctx, 'session.list', {})) as unknown
        sendJson(res, 200, { ok: true, ...(isRecord(listed) ? listed : { items: [] }) })
        return
      }
      // POST: create a session, optionally on a chosen model.
      const check2 = requireScope(device, 'prompt')
      if (!check2.ok) {
        sendJson(res, 200, { ok: false, code: check2.code, message: check2.message })
        return
      }
      const payload: Record<string, unknown> = {}
      if (typeof body.cwd === 'string' && body.cwd.trim() !== '') payload.cwd = body.cwd.trim()
      if (typeof body.agentPreset === 'string' && body.agentPreset.trim() !== '') payload.agentPreset = body.agentPreset.trim()
      const created = (await callEngine(ctx, 'session.create', payload)) as unknown
      const sessionId = isRecord(created) && typeof created.sessionId === 'string' ? created.sessionId : ''
      if (sessionId !== '' && isRecord(body.model) && typeof body.model.provider === 'string' && typeof body.model.model === 'string') {
        await callEngine(ctx, 'session.selectModel', {
          sessionId,
          provider: body.model.provider,
          model: body.model.model,
        })
      }
      log(`新建会话：${sessionId}`)
      sendJson(res, 200, { ok: true, sessionId, ...(isRecord(created) ? created : {}) })
    }),
  })

  webServer.register({
    kind: 'prefix',
    path: `${PUBLIC_PREFIX}/sessions`,
    handler: guarded(async (req, res, device, body) => {
      const rest = pathAfter(req.url, `${PUBLIC_PREFIX}/sessions`)
      const parts = rest.split('/').filter((part) => part !== '')
      const sessionId = decodeURIComponent(parts[0] ?? '')
      const action = parts[1] ?? ''
      if (sessionId === '') {
        sendJson(res, 200, { ok: false, code: 'E_BAD_REQUEST', message: '缺少会话 id' })
        return
      }
      const needs = action === 'history' || action === 'files' || action === 'fsticket' ? 'read' : 'prompt'
      const check = requireScope(device, needs)
      if (!check.ok) {
        sendJson(res, 200, { ok: false, code: check.code, message: check.message })
        return
      }
      if (action === 'history') {
        const params = new URLSearchParams(String(req.url ?? '').split('?')[1] ?? '')
        const maxMessages = Number(params.get('maxMessages') ?? 80)
        const beforeSeq = params.get('beforeSeq')
        // The engine pages its own log through `session.page`; records are
        // {event, view?} entries, the same shape a phone renders.
        const base: Record<string, unknown> = {
          address: { kind: 'session', sessionId },
          maxMessages: Number.isFinite(maxMessages) ? maxMessages : 80,
        }
        if (beforeSeq !== null && beforeSeq !== '') base.beforeSeq = Number(beforeSeq)
        const page = (await readPage(sessionId, base)) as unknown
        const records = isRecord(page) && Array.isArray(page.records) ? page.records : []
        sendJson(res, 200, { ok: true, items: records, hasMore: isRecord(page) ? page.hasMore === true : false })
        return
      }
      if (action === 'files') {
        // 最近生成的文件：非递归列会话工作目录，按修改时间倒序（前 40 个）。
        const cwd = await sessionCwdOf(sessionId)
        if (cwd === '') {
          sendJson(res, 200, { ok: true, cwd: '', items: [] })
          return
        }
        sendJson(res, 200, { ok: true, cwd, items: listSessionFiles(cwd) })
        return
      }
      if (action === 'fsticket') {
        // WebView 的子资源请求带不了 Authorization 头，给文件 URL 发一张短票据
        // （首次响应再把它写成 cookie，vendor/three.min.js 这类相对请求也能带上）。
        const ticket = randomUUID().replace(/-/g, '')
        fileTickets.set(ticket, { sessionId, expires: Date.now() + FILE_TICKET_MS })
        sendJson(res, 200, {
          ok: true,
          ticket,
          prefix: `${FS_PREFIX}/${encodeURIComponent(sessionId)}`,
          expiresIn: Math.round(FILE_TICKET_MS / 1000),
        })
        return
      }
      if (action === 'prompt') {
        // The phone sends the human shape ({text, mode}); the engine wants
        // `content: [{type:'text', text}]`, so the translation lives here rather
        // than in a phone that would have to know engine vocabulary.
        const extra = isRecord(body.payload) ? (body.payload as Record<string, unknown>) : {}
        const text = typeof body.text === 'string' ? body.text : typeof extra.text === 'string' ? extra.text : ''
        const mode = body.mode === 'steer' || extra.mode === 'steer' ? 'steer' : 'queue'
        if (text.trim() === '') {
          sendJson(res, 200, { ok: false, code: 'E_BAD_REQUEST', message: '消息内容为空' })
          return
        }
        const payload: Record<string, unknown> = {
          sessionId,
          mode,
          content: [{ type: 'text', text }],
          requestId: randomUUID(),
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }
        const result = await callEngine(ctx, 'session.prompt', payload)
        log(`已发送消息到 ${sessionId}（${mode}，${text.length} 字）`)
        sendJson(res, 200, { ok: true, ...(isRecord(result) ? result : {}) })
        return
      }
      if (action === 'cancel') {
        await callEngine(ctx, 'session.cancel', { sessionId, ...((body.payload ?? {}) as Record<string, unknown>) })
        log(`已请求停止：${sessionId}`)
        sendJson(res, 200, { ok: true })
        return
      }
      if (action === 'model') {
        // `session.selectModel` takes the selection flattened, not nested.
        const selection = isRecord(body.selection) ? body.selection : {}
        const provider = String(selection.provider ?? '')
        const model = String(selection.model ?? '')
        if (provider === '' || model === '') {
          sendJson(res, 200, { ok: false, code: 'E_BAD_REQUEST', message: '缺少 provider 或 model' })
          return
        }
        const selected = await callEngine(ctx, 'session.selectModel', {
          sessionId,
          provider,
          model,
          ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}),
        })
        log(`切换模型：${sessionId} → ${provider}/${model}`)
        sendJson(res, 200, { ok: true, ...(isRecord(selected) ? selected : {}) })
        return
      }
      if (action === 'rename') {
        const result = (await callEngine(ctx, 'session.rename', { sessionId, title: String(body.title ?? '') })) as unknown
        sendJson(res, 200, { ok: true, ...(isRecord(result) ? result : {}) })
        return
      }
      sendJson(res, 200, { ok: false, code: 'E_BAD_REQUEST', message: `不认识的会话动作：${action}` })
    }, true),
  })

  webServer.register({
    kind: 'exact',
    path: `${PUBLIC_PREFIX}/models`,
    handler: guarded(async (req, res, device, body) => {
      if (req.method === 'GET') {
        const check = requireScope(device, 'read')
        if (!check.ok) {
          sendJson(res, 200, { ok: false, code: check.code, message: check.message })
          return
        }
        const store = load()
        sendJson(res, 200, { ok: true, doc: await buildModelDoc(store) })
        return
      }
      const check = requireScope(device, 'config')
      if (!check.ok) {
        sendJson(res, 200, { ok: false, code: check.code, message: check.message })
        return
      }
      const store = load()
      const current = await buildModelDoc(store)
      const baseRevision = Number(body.baseRevision ?? -1)
      const overlayRevision = Number(body.overlayRevision ?? -1)
      const incoming = Array.isArray(body.items) ? body.items : []
      // A phone that failed to load a document must not be able to erase every
      // provider by submitting an empty list — that is a wipe dressed as a save.
      // Deleting everything stays possible, but it has to be asked for.
      if (incoming.length === 0 && current.items.length > 0 && body.allowEmpty !== true) {
        log(`拒绝空文档提交（当前 ${current.items.length} 个模型）`)
        sendJson(res, 200, {
          ok: false,
          code: 'E_EMPTY_DOC',
          message: `拒绝保存空列表：电脑端现在有 ${current.items.length} 个模型。请先重新读取，或显式传 allowEmpty 表示确实要清空。`,
          doc: current,
        })
        return
      }
      const wanted: MobileModelDoc = { ...current, items: incoming as MobileModelDoc['items'] }
      const force = body.force === true

      if (!force && (baseRevision !== current.revision || overlayRevision !== current.overlayRevision)) {
        const merged = mergeDocs((body.base ?? incoming) as MobileModelDoc['items'], current.items, incoming as MobileModelDoc['items'])
        if (!merged.merged) {
          log(`模型配置冲突：${merged.conflicts.length} 处被两端同时修改`)
          sendJson(res, 200, {
            ok: false,
            code: 'E_REVISION',
            message: `电脑端也改过配置（引擎修订 ${current.revision}），有 ${merged.conflicts.length} 处冲突需要你选`,
            conflicts: merged.conflicts,
            incoming: merged.incoming,
            doc: current,
          })
          return
        }
        // Different fields: merge silently, as designed.
        wanted.items = incoming as MobileModelDoc['items']
      }

      const ops = engineOps(current, wanted)
      if (ops.length > 0) {
        await callEngine(ctx, 'settings.mutate', { ns: MODEL_NS, ops, expectedRevision: current.revision })
      }
      const overlay = overlayFor(wanted, overlayOf(store))
      ;(store as unknown as { models?: ModelOverlay }).models = overlay
      save(store)
      log(`模型配置已保存：${ops.length} 项引擎改动，overlay 修订 ${overlay.revision}`)
      publish({ kind: 'notify', level: 'info', title: '模型配置已更新', body: `${ops.length} 项改动` })
      sendJson(res, 200, { ok: true, doc: await buildModelDoc(load()) })
    }, true),
  }),

  webServer.register({
    kind: 'exact',
    path: `${PUBLIC_PREFIX}/credentials`,
    handler: guarded(async (req, res, device, body) => {
      const check = requireScope(device, 'config')
      if (!check.ok) {
        sendJson(res, 200, { ok: false, code: check.code, message: check.message })
        return
      }
      if (credentials === undefined) {
        sendJson(res, 200, { ok: false, code: 'E_BRIDGE', message: '这个引擎没有凭据服务' })
        return
      }
      const ref = String(body.ref ?? '').trim()
      if (!/^[A-Z][A-Z0-9_]*$/.test(ref)) {
        sendJson(res, 200, { ok: false, code: 'E_BAD_REQUEST', message: '凭据名必须是 A-Z0-9_ 组成' })
        return
      }
      const value = typeof body.value === 'string' ? body.value : ''
      if (value === '') await credentials.unset(ref)
      else await credentials.set(ref, value)
      // The value is never echoed back; only whether one now resolves.
      const described = await credentials.describe(ref)
      log(`凭据 ${ref} ${value === '' ? '已清除' : '已更新'}（值不回显）`)
      sendJson(res, 200, { ok: true, ref, configured: described?.configured === true })
    }, true),
  })

  webServer.register({
    kind: 'exact',
    path: `${PUBLIC_PREFIX}/devices`,
    handler: guarded(async (req, res, device) => {
      const check = requireScope(device, 'admin')
      if (!check.ok) {
        sendJson(res, 200, { ok: false, code: check.code, message: check.message })
        return
      }
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, devices: load().devices.map(deviceView), self: device.id })
        return
      }
      sendJson(res, 200, { ok: false, code: 'E_BAD_REQUEST', message: '用 DELETE /mobile/devices/:id 解除绑定' })
    }),
  })

  webServer.register({
    kind: 'prefix',
    path: `${PUBLIC_PREFIX}/devices`,
    handler: guarded(async (req, res, device) => {
      const check = requireScope(device, 'admin')
      if (!check.ok) {
        sendJson(res, 200, { ok: false, code: check.code, message: check.message })
        return
      }
      const target = decodeURIComponent(pathAfter(req.url, `${PUBLIC_PREFIX}/devices`).replace(/^\//, '').split('?')[0] ?? '')
      const store = load()
      const before = store.devices.length
      store.devices = store.devices.filter((entry) => entry.id !== target)
      save(store)
      const removed = before !== store.devices.length
      log(`设备解除绑定：${target}${removed ? '' : '（未找到）'}`)
      sendJson(res, 200, { ok: removed, devices: store.devices.map(deviceView), message: removed ? '已解除绑定' : '没有这台设备' })
    }),
  })

  // Generic passthrough: the phone can call any method the scope table allows,
  // which is how features arrive before a wrapper exists for them.
  webServer.register({
    kind: 'exact',
    path: `${PUBLIC_PREFIX}/rpc`,
    handler: guarded(async (req, res, device, body) => {
      const method = String(body.method ?? '')
      if (method === '') {
        sendJson(res, 200, { ok: false, code: 'E_BAD_REQUEST', message: '缺少 method' })
        return
      }
      if (!scopeAllows(device.scopes, method)) {
        log(`拒绝越权调用：${method}（设备权限 ${device.scopes.join('/')}）`)
        sendJson(res, 200, { ok: false, code: 'E_FORBIDDEN', message: `这台设备不能调用 ${method}` })
        return
      }
      const value = await callEngine(ctx, method, body.payload ?? {})
      sendJson(res, 200, { ok: true, value })
    }, true),
  })

  // ------------------------------------------------------------------ app files
  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  }

  // -------------------------------------------------------------- session files
  // 手机看电脑端生成的文件：会话工作目录为根，`files` 列顶层、`fs` 取单个文件。
  // 票据（?t= + cookie）是为了 WebView —— HTML 页的相对子资源请求（vendor/x.js）
  // 带不了 Authorization 头，必须另有一条不需要请求头的授权路径。
  const FS_PREFIX = `${PUBLIC_PREFIX}/fs`
  const FILE_TICKET_MS = 30 * 60 * 1000
  const FS_MAX_BYTES = 128 * 1024 * 1024
  const fileTickets = new Map<string, { sessionId: string; expires: number }>()

  const FILE_MIME: Record<string, string> = {
    ...MIME,
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
    '.log': 'text/plain; charset=utf-8',
    '.jsonl': 'text/plain; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.pdf': 'application/pdf',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.zip': 'application/zip',
  }

  const sessionCwdOf = async (sessionId: string): Promise<string> => {
    const listed = (await callEngine(ctx, 'session.list', {})) as unknown
    const items = isRecord(listed) && Array.isArray(listed.items) ? listed.items : []
    for (const item of items) {
      if (isRecord(item) && sessionIdOf(item) === sessionId && typeof item.cwd === 'string' && item.cwd.trim() !== '') {
        return item.cwd.trim()
      }
    }
    return ''
  }

  const listSessionFiles = (cwd: string): Array<{ path: string; name: string; size: number; mtime: number }> => {
    const out: Array<{ path: string; name: string; size: number; mtime: number }> = []
    try {
      for (const entry of readdirSync(cwd, { withFileTypes: true })) {
        if (!entry.isFile() || entry.name.startsWith('.')) continue
        try {
          const stat = statSync(join(cwd, entry.name))
          out.push({ path: entry.name, name: entry.name, size: stat.size, mtime: stat.mtimeMs })
        } catch {
          // 单个文件读不到就跳过，别让整个列表失败
        }
      }
    } catch {
      return []
    }
    out.sort((a, b) => b.mtime - a.mtime)
    return out.slice(0, 40)
  }

  /** 把相对路径锁进会话工作目录；越界（..、绝对路径、symlink 外逃）一律拒绝。 */
  const resolveInCwd = (cwd: string, rel: string): string => {
    if (rel === '' || rel.includes('\0') || rel.startsWith('/') || rel.startsWith('\\') || /^[A-Za-z]:/.test(rel)) return ''
    const full = resolve(cwd, rel)
    let root = cwd
    try {
      root = realpathSync(cwd)
    } catch {
      // 目录缺失时保持原样，由后面的 existsSync 处理成 404
    }
    let real = full
    try {
      real = realpathSync(full)
    } catch {
      // 目标不存在或是坏链接：用未解析路径做前缀比较
    }
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`
    return real === root || real.startsWith(prefix) ? real : ''
  }

  const ticketFrom = (req: HttpRequest): string => {
    const url = new URL(String(req.url ?? ''), 'http://localhost')
    const fromQuery = url.searchParams.get('t') ?? ''
    if (fromQuery !== '') return fromQuery
    const cookie = req.headers['cookie']
    const raw = Array.isArray(cookie) ? cookie.join('; ') : String(cookie ?? '')
    for (const part of raw.split(';')) {
      const index = part.indexOf('=')
      if (index > 0 && part.slice(0, index).trim() === 'dsht') return part.slice(index + 1).trim()
    }
    return ''
  }

  webServer.register({
    kind: 'prefix',
    path: FS_PREFIX,
    handler: (req, res) => {
      void (async () => {
        const rest = pathAfter(req.url, FS_PREFIX)
        const parts = rest.split('/').filter((part) => part !== '')
        const sessionId = decodeURIComponent(parts[0] ?? '')
        const rel = parts.slice(1).map((part) => decodeURIComponent(part)).join('/')
        if (sessionId === '' || rel === '') {
          sendJson(res, 404, { ok: false, code: 'E_NOT_FOUND', message: '文件路径不完整' })
          return
        }
        const ticket = ticketFrom(req)
        let allowed = false
        if (ticket !== '') {
          const record = fileTickets.get(ticket)
          if (record !== undefined && record.expires > Date.now() && record.sessionId === sessionId) allowed = true
        }
        if (!allowed) {
          const auth = authenticate(req)
          if (!('error' in auth) && holdsScope(auth.device, 'read')) allowed = true
        }
        if (!allowed) {
          sendJson(res, 401, { ok: false, code: 'E_UNAUTHORIZED', message: '文件访问未授权（票据无效或已过期）' })
          return
        }
        const cwd = await sessionCwdOf(sessionId)
        if (cwd === '') {
          sendJson(res, 404, { ok: false, code: 'E_NOT_FOUND', message: '找不到会话的工作目录' })
          return
        }
        const file = resolveInCwd(cwd, rel)
        if (file === '' || !existsSync(file)) {
          sendJson(res, 404, { ok: false, code: 'E_NOT_FOUND', message: '文件不存在' })
          return
        }
        try {
          const stat = statSync(file)
          if (!stat.isFile()) {
            sendJson(res, 404, { ok: false, code: 'E_NOT_FOUND', message: '目标不是文件' })
            return
          }
          if (stat.size > FS_MAX_BYTES) {
            sendJson(res, 413, { ok: false, code: 'E_TOO_LARGE', message: '文件超过 128 MB，请到电脑端打开' })
            return
          }
          const headers: Record<string, string> = {
            'content-type': FILE_MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
            'cache-control': 'no-cache',
            'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(basename(file))}`,
            'x-content-type-options': 'nosniff',
          }
          if (ticket !== '') headers['set-cookie'] = `dsht=${ticket}; Path=/; Max-Age=1800; HttpOnly; SameSite=Lax`
          res.writeHead(200, headers)
          res.end(readFileSync(file))
        } catch (error) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(String(error))
        }
      })()
    },
  })

  webServer.register({
    kind: 'prefix',
    path: PUBLIC_PREFIX,
    handler: (req, res) => {
      let rel = pathAfter(req.url, PUBLIC_PREFIX)
      // API paths never fall through to static serving.
      if (/^\/(pair|meta|sessions|models|credentials|devices|rpc|events|fs)/.test(rel)) {
        sendJson(res, 404, { ok: false, code: 'E_NOT_FOUND', message: `没有这个接口：${rel}` })
        return
      }
      if (rel === '' || rel === '/') rel = '/index.html'
      const file = join(APP_DIR, normalize(rel).replace(/^([/\\])+/, ''))
      if (!file.startsWith(APP_DIR) || !existsSync(file)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }
      try {
        const body = readFileSync(file)
        res.writeHead(200, {
          'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': 'no-cache',
        })
        res.end(body)
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(String(error))
      }
    },
  })

  // ------------------------------------------------------------------- upgrade
  const registerUpgrade = webServer.registerUpgrade
  if (typeof registerUpgrade === 'function') {
    registerUpgrade.call(webServer, {
      kind: 'exact',
      path: `${PUBLIC_PREFIX}/events`,
      handler: (req, socket, head) => {
        const auth = authenticate(req)
        if ('error' in auth) {
          ;(socket as unknown as { end: (body: string) => void }).end('HTTP/1.1 401 Unauthorized\r\n\r\n')
          return
        }
        if (!scopeAllows(auth.device.scopes, 'session.list')) {
          ;(socket as unknown as { end: (body: string) => void }).end('HTTP/1.1 403 Forbidden\r\n\r\n')
          return
        }
        const connection = acceptUpgrade(
          req as never,
          socket as never,
          head,
          {
            onMessage: (client, text) => {
              try {
                const parsed = JSON.parse(text) as Record<string, unknown>
                if (parsed.type === 'hello') {
                  const state = clients.get(client)
                  const oldest = frames.length > 0 ? (frames[0] as EventFrame).seq : undefined
                  const info = normalizeSince(Number(parsed.since ?? 0), seq, oldest)
                  if (state !== undefined) state.since = info.since
                  const backlog = frames.filter((frame) => frame.seq > info.since)
                  client.send(JSON.stringify({ kind: 'hello', seq, time: Date.now(), data: { server: { bridge: 'dsh-mobile-bridge', version: 1, epoch }, replay: backlog.length, gap: info.gap } }))
                  for (const frame of backlog) client.send(JSON.stringify(frame))
                  return
                }
                if (parsed.type === 'ping') client.send(JSON.stringify({ kind: 'notify', seq, time: Date.now(), level: 'debug', title: 'pong' }))
              } catch {
                // ignore malformed client frames
              }
            },
            onClose: (client) => clients.delete(client),
          },
        )
        if (connection !== undefined) {
          clients.set(connection, { deviceId: auth.device.id, since: 0 })
          connection.send(JSON.stringify({ kind: 'hello', seq, time: Date.now(), data: { server: { bridge: 'dsh-mobile-bridge', version: 1, epoch }, replay: 0, gap: false } }))
          log(`设备已连接事件流：${auth.device.name}（当前 ${clients.size} 条连接）`)
        }
      },
    })
  } else {
    log('这个引擎的 webServer 不支持 registerUpgrade，事件流不可用（其余接口正常）')
  }

  // First run: make a pairing code so the page opens on something usable.
  const initial = load()
  if (initial.devices.length === 0 && initial.pairing === undefined) {
    issuePairing(initial)
    save(initial)
    log(`首次启动：已生成配对码，打开 http://127.0.0.1:<端口>${LOCAL_PREFIX}/ 查看`)
  }
  log(`已就绪：${initial.devices.length} 台设备已绑定 · 公开前缀 ${PUBLIC_PREFIX} · 本机配对页 ${LOCAL_PREFIX}/ · 存储 ${storePath()}`)
  log(`手机端静态资源目录：${APP_DIR}（${existsSync(join(APP_DIR, 'index.html')) ? '已找到 index.html' : '缺少 index.html，静态页面不可用'}）`)
  const effectiveUrl = publicUrl()
  log(`手机端地址：${effectiveUrl === '' ? '（未配置 publicUrl，手机可先用局域网地址）' : effectiveUrl}${PUBLIC_PREFIX}/`)
}
