/**
 * Device pairing for the mobile bridge: codes a person can read aloud, tokens a
 * phone keeps, and the scope table that decides what each token may call.
 *
 * Tokens are stored as SHA-256 hashes and compared in constant time, so the
 * desktop file never contains a usable credential and a timing difference cannot
 * confirm a guess. The scope table is fail-closed: a method that is not listed is
 * refused, which means a new engine method is never silently reachable from a
 * device that was never granted it.
 *
 * @module @dsh-desktop/dsh-mobile-bridge/devices
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** What one paired phone is allowed to do. */
export type Scope = 'read' | 'prompt' | 'config' | 'admin'

/** Every scope, for the pairing UI. */
export const SCOPES: readonly Scope[] = ['read', 'prompt', 'config', 'admin']

/** Human labels used by the pairing page. */
export const SCOPE_LABELS: Record<Scope, string> = {
  read: '查看会话与历史、搜索、读取模型配置',
  prompt: '发消息、继续对话、停止生成、新建会话、切换模型',
  config: '修改模型配置与凭据',
  admin: '管理已绑定的设备',
}

/** One paired device as stored on the desktop. */
export interface DeviceRecord {
  id: string
  name: string
  platform: string
  /** SHA-256 of the bearer token; the token itself is never written here. */
  tokenHash: string
  scopes: Scope[]
  createdAt: number
  lastSeenAt: number
  /** Push subscriptions (Web Push), one per browser install. */
  push?: { endpoint: string; keys: { p256dh: string; auth: string } }[]
}

/** A live pairing code. */
export interface PairingState {
  code: string
  expiresAt: number
  attempts: number
}

/** The whole store. */
export interface BridgeStore {
  version: 1
  /** Monotonic counter behind every event frame's `seq`. */
  seq: number
  pairing?: PairingState
  devices: DeviceRecord[]
  /**
   * Public base URL the pairing QR points at. Stored here (rather than only in
   * the profile config) so the settings page can change it without an engine
   * restart; the profile's `publicUrl` stays the fallback.
   */
  publicUrl?: string
  /**
   * Mobile-side model metadata the engine's configuration has no field for
   * (display name, enabled, tags, order). Kept here so no invented key ever
   * reaches the engine's schema-validated namespace.
   */
  models?: Record<string, unknown>
}

/**
 * Trim a public base URL and refuse anything that cannot be one. Empty means
 * "not configured"; a missing scheme would produce a QR that fails silently on
 * the phone, so it is rejected with a message instead.
 */
export function normalizePublicUrl(value: unknown): string {
  const raw = String(value ?? '').trim().replace(/\/+$/, '')
  if (raw === '') return ''
  return /^https?:\/\/[^\s]+$/i.test(raw) ? raw : ''
}


/** How long a pairing code stays valid. */
export const PAIR_CODE_TTL_MS = 5 * 60 * 1000

/** Failed attempts before the code stops answering. */
export const PAIR_ATTEMPT_LIMIT = 5

/** Where the store lives. */
export function storePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = (env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  return join(home, 'mobile-bridge.json')
}

/** An empty store. */
export function emptyStore(): BridgeStore {
  return { version: 1, seq: 0, devices: [] }
}

/** Read the store, tolerating an absent or damaged file. */
export function readStore(env: NodeJS.ProcessEnv = process.env): BridgeStore {
  try {
    const raw = JSON.parse(readFileSync(storePath(env), 'utf8')) as Partial<BridgeStore>
    return {
      version: 1,
      seq: typeof raw.seq === 'number' ? raw.seq : 0,
      ...(raw.pairing !== undefined ? { pairing: raw.pairing } : {}),
      devices: Array.isArray(raw.devices) ? (raw.devices as DeviceRecord[]) : [],
      ...(typeof raw.publicUrl === 'string' ? { publicUrl: raw.publicUrl } : {}),
      ...(raw.models !== undefined ? { models: raw.models } : {}),
    }
  } catch {
    return emptyStore()
  }
}

/** Write the store atomically. */
export function writeStore(store: BridgeStore, env: NodeJS.ProcessEnv = process.env): void {
  const file = storePath(env)
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

/** Whether the store file exists (the pairing page shows a hint when it does not). */
export function storeExists(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(storePath(env))
}

/** A fresh eight-character code, shown in two groups so it reads aloud cleanly. */
export function newPairCode(): string {
  // Unambiguous alphabet: no O/0, no I/1.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < 8; i += 1) out += alphabet[randomInt(alphabet.length)]
  return `${out.slice(0, 4)}-${out.slice(4)}`
}

/** Normalize what the user typed: case and separators must not matter. */
export function normalizeCode(value: unknown): string {
  const raw = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw
}

/** Issue a new code, replacing any previous one. */
export function issuePairing(store: BridgeStore, now = Date.now()): PairingState {
  const pairing: PairingState = { code: newPairCode(), expiresAt: now + PAIR_CODE_TTL_MS, attempts: 0 }
  store.pairing = pairing
  return pairing
}

/** Consume a pairing attempt: expired, exhausted and wrong all refuse. */
export function consumePairing(store: BridgeStore, typed: unknown, now = Date.now()): { ok: true } | { ok: false; reason: string } {
  const pairing = store.pairing
  if (pairing === undefined) return { ok: false, reason: '电脑端还没有生成配对码' }
  if (now > pairing.expiresAt) return { ok: false, reason: '配对码已过期，请在电脑端重新生成' }
  if (pairing.attempts >= PAIR_ATTEMPT_LIMIT) return { ok: false, reason: '尝试次数过多，请在电脑端重新生成配对码' }
  if (normalizeCode(typed) !== normalizeCode(pairing.code)) {
    pairing.attempts += 1
    return { ok: false, reason: '配对码不对' }
  }
  delete store.pairing
  return { ok: true }
}

/** A new bearer token and its stored hash. */
export function newToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, tokenHash: hashToken(token) }
}

/** Hash a bearer token exactly as the store expects. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Constant-time token comparison. */
export function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** Find the device a bearer token belongs to, if any. */
export function deviceForToken(store: BridgeStore, token: string): DeviceRecord | undefined {
  const hash = hashToken(token)
  return store.devices.find((device) => sameToken(device.tokenHash, hash))
}

/**
 * Which scope one engine method requires.
 *
 * Deliberately exhaustive and fail-closed: `undefined` means "this bridge does
 * not expose it", so an engine method added tomorrow is not reachable until it is
 * listed and a scope is chosen for it.
 */
export const METHOD_SCOPES: Record<string, Scope> = {
  'session.list': 'read',
  'session.search': 'read',
  'session.history': 'read',
  'session.page': 'read',
  'session.models': 'read',
  'llm.models': 'read',
  'llm.providers': 'read',
  'session.create': 'prompt',
  'session.prompt': 'prompt',
  'session.cancel': 'prompt',
  'session.selectModel': 'prompt',
  'session.rename': 'prompt',
  'session.fork': 'prompt',
  'session.updateQueue': 'prompt',
  'session.attachment': 'prompt',
  'settings.describe': 'config',
  'settings.mutate': 'config',
  'settings.update': 'config',
  'settings.replace': 'config',
  'credentials.describe': 'config',
  'credentials.set': 'config',
  'credentials.unset': 'config',
  'llm.discoverModels': 'config',
}

/** Whether a device holding these scopes may call this method. */
export function scopeAllows(scopes: readonly Scope[], method: string): boolean {
  const needed = METHOD_SCOPES[method]
  if (needed === undefined) return false
  if (scopes.includes(needed)) return true
  // Anything with config or admin implies prompt and read: a device trusted to
  // rewrite model configuration is not less trusted with a message.
  if (needed === 'read') return scopes.some((scope) => scope === 'prompt' || scope === 'config' || scope === 'admin')
  if (needed === 'prompt') return scopes.some((scope) => scope === 'config' || scope === 'admin')
  return scopes.includes('admin')
}

/** A device as the phone and the pairing page see it. */
export function deviceView(device: DeviceRecord): Record<string, unknown> {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    scopes: device.scopes,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    pushSubscriptions: device.push?.length ?? 0,
  }
}
