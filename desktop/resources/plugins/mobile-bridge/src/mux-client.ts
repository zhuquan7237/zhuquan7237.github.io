/**
 * Dependency-free client for the engine's own Remote stream mux.
 *
 * The engine forwards selected Cordis events — notably the
 * `user-questions/request` waterfall behind `ask_user_question` — to every
 * connected "Remote" client. The web UI is one such client; this module makes
 * the bridge another. Being a first-class Remote client is what lets a phone
 * see a pending question even while the desktop is open, and answer it with the
 * same authority the desktop UI has: the engine fans one question out to all
 * clients, the first answer settles it, and every other holder receives a
 * `cancel` frame so its UI can dismiss the card.
 *
 * Transport, in protocol order:
 *
 *   1. The owner exchanges the engine's launch token for the signed
 *      browser-session cookie (`dsh-auth-…`) that every later request and the
 *      WebSocket upgrade must carry. The token is read from the engine's own
 *      connection service, so no credential is copied anywhere.
 *   2. WebSocket upgrade to `/api/remote.mux`; one text frame
 *      `{type:'open', streamId, endpoint:'$events', payload:{args:{}}}` opens
 *      the forwarded-event subscription. Values arrive wrapped as
 *      `{type:'item', streamId, value}` where value is `ready` / `emit` /
 *      `waterfall` / `cancel`.
 *   3. Answers travel over the connection RPC as
 *      `POST /api/$events/result` with
 *      `{type:'client-request', rpcId, method:'$events/result', payload:{args:{clientId, eventId, outcome:{kind:'result', value}}}}`.
 *
 * Written on node builtins only — out-of-tree plugins may not import host
 * runtime values (same rationale as ws.ts, whose frame decoder is reused).
 *
 * @module @dsh-desktop/dsh-mobile-bridge/mux-client
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { decodeFrames } from './ws.js'

/** Exact WebSocket route carrying every Typert Remote stream. */
const MUX_PATH = '/api/remote.mux'

/** Gateway-internal logical stream carrying application-selected Cordis events. */
const EVENTS_ENDPOINT = '$events'

/** Gateway-internal unary endpoint returning one Remote event outcome. */
const RESULT_ENDPOINT = '$events/result'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Encode one client-to-server frame (RFC 6455 requires clients to mask). */
export function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4)
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = 0x80 | length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  const masked = Buffer.alloc(length)
  for (let i = 0; i < length; i += 1) {
    masked[i] = (payload[i] as number) ^ (mask[i % 4] as number)
  }
  return Buffer.concat([header, mask, masked])
}

/** What the owner does with connection and frame events. */
export interface MuxHandlers {
  /** The engine accepted the subscription; carries this client generation id. */
  onReady(clientId: string): void
  /** One forwarded value frame: `{type:'emit'|'waterfall'|'cancel', …}`. */
  onFrame(frame: Record<string, unknown>): void
  /** The socket is down; the client reconnects on its own afterwards. */
  onDown(reason: string): void
}

/** Client options; everything injected so the class stays testable. */
export interface MuxOptions {
  /** Current engine port (re-read on every attempt: restarts may move it). */
  port: () => number
  /** Current signed browser cookie; `refresh` forces a new token exchange. */
  cookie: (refresh?: boolean) => Promise<string>
  handlers: MuxHandlers
  /** Delay before a reconnect attempt; defaults to 3000 ms. */
  retryDelayMs?: number
}

/**
 * One forwarded-events subscription over `/api/remote.mux`, with automatic
 * reconnect. After a reconnect the engine redelivers every still-pending
 * waterfall to the new client generation, so no local backfill is needed.
 */
export class QuestionsMuxClient {
  private socket: Duplex | null = null
  private leftover: Buffer = Buffer.alloc(0)
  private clientId = ''
  private stopped = true
  private connecting = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: MuxOptions) {}

  /** True while the subscription is open and the client generation is known. */
  get ready(): boolean {
    return this.socket !== null && this.clientId !== ''
  }

  /** Current client generation id presented with every answer. */
  get generation(): string {
    return this.clientId
  }

  /** Begin connecting (idempotent; safe to call from plugin startup). */
  start(): void {
    this.stopped = false
    void this.connect()
  }

  /** Stop for good: closes the socket and cancels any pending reconnect. */
  stop(): void {
    this.stopped = true
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.closeSocket()
  }

  /** One answer, submitted over the connection RPC. Resolves `{ok}`. */
  async submitResult(args: {
    clientId: string
    eventId: string
    outcome: Record<string, unknown>
  }): Promise<{ ok: boolean; error?: { code?: string; message?: string } }> {
    let cookie: string
    try {
      cookie = await this.options.cookie()
    } catch (error) {
      return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
    }
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: randomUUID(),
      method: RESULT_ENDPOINT,
      payload: { args },
    })
    return await new Promise((resolve) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port: this.options.port(),
          path: `/api/${RESULT_ENDPOINT}`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            Cookie: cookie,
          },
        },
        (response: IncomingMessage) => {
          let text = ''
          response.setEncoding('utf8')
          response.on('data', (chunk: string) => {
            text += chunk
          })
          response.on('end', () => {
            try {
              const parsed = JSON.parse(text) as Record<string, unknown>
              const result = isRecord(parsed.result) ? parsed.result : {}
              if (result.ok === true) {
                resolve({ ok: true })
                return
              }
              const error = isRecord(result.error) ? result.error : {}
              resolve({
                ok: false,
                error: {
                  ...(typeof error.code === 'string' ? { code: error.code } : {}),
                  ...(typeof error.message === 'string' ? { message: error.message } : {}),
                },
              })
            } catch {
              resolve({ ok: false, error: { message: `回执无法解析（HTTP ${response.statusCode ?? 0}）` } })
            }
          })
        },
      )
      request.on('error', (error: Error) => resolve({ ok: false, error: { message: error.message } }))
      request.setTimeout(15000, () => {
        request.destroy(new Error('提交答案超时'))
      })
      request.write(body)
      request.end()
    })
  }

  private closeSocket(): void {
    const socket = this.socket
    this.socket = null
    this.clientId = ''
    this.leftover = Buffer.alloc(0)
    if (socket !== null) {
      try {
        socket.destroy()
      } catch {
        // already gone
      }
    }
  }

  private fail(reason: string): void {
    this.closeSocket()
    if (this.stopped) return
    this.options.handlers.onDown(reason)
    if (this.retryTimer !== null) return
    const delay = this.options.retryDelayMs ?? 3000
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.connect()
    }, delay)
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting || this.socket !== null) return
    this.connecting = true
    const port = this.options.port()
    let cookie: string
    try {
      cookie = await this.options.cookie()
    } catch (error) {
      this.connecting = false
      this.fail(`登录引擎失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const key = randomBytes(16).toString('base64')
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path: MUX_PATH,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        Cookie: cookie,
      },
    })
    request.on('upgrade', (response: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.connecting = false
      if (this.stopped) {
        socket.destroy()
        return
      }
      void response
      this.socket = socket
      this.leftover = Buffer.alloc(0)
      this.attach(socket)
      if (head.length > 0) this.feed(head)
      this.sendJson({ type: 'open', streamId: 'events', endpoint: EVENTS_ENDPOINT, payload: { args: {} } })
    })
    request.on('response', (response: IncomingMessage) => {
      this.connecting = false
      response.resume()
      const status = response.statusCode ?? 0
      if (status === 401 || status === 403) {
        // The cached cookie was rejected (e.g. engine secret rotated): force
        // a fresh token exchange on the next attempt.
        void this.options.cookie(true).catch(() => undefined)
      }
      if (!this.stopped && this.socket === null) this.fail(`mux 拒绝连接：HTTP ${status}`)
    })
    request.on('error', (error: Error) => {
      this.connecting = false
      if (!this.stopped && this.socket === null) this.fail(`mux 连接失败：${error.message}`)
    })
    request.end()
  }

  private attach(socket: Duplex): void {
    socket.on('data', (chunk: Buffer) => {
      if (this.socket === socket) this.feed(chunk)
    })
    const finish = (): void => {
      if (this.socket === socket) this.fail('mux 连接断开')
    }
    socket.on('close', finish)
    socket.on('end', finish)
    socket.on('error', finish)
  }

  private feed(chunk: Buffer): void {
    let decoded: { frames: { opcode: number; payload: Buffer }[]; rest: Buffer }
    try {
      decoded = decodeFrames(this.leftover, chunk)
    } catch {
      this.fail('mux 帧解析失败')
      return
    }
    this.leftover = decoded.rest
    for (const frame of decoded.frames) {
      if (frame.opcode === 0x8) {
        this.fail('mux 关闭帧')
        return
      }
      if (frame.opcode === 0x9) {
        this.sendRaw(encodeClientFrame(0xa, frame.payload))
        continue
      }
      if (frame.opcode !== 0x1) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(frame.payload.toString('utf8'))
      } catch {
        continue
      }
      if (!isRecord(parsed) || parsed.type !== 'item') continue
      const value = parsed.value
      if (!isRecord(value)) continue
      if (value.type === 'ready') {
        this.clientId = typeof value.clientId === 'string' ? value.clientId : ''
        if (this.clientId !== '') this.options.handlers.onReady(this.clientId)
        continue
      }
      this.options.handlers.onFrame(value)
    }
  }

  private sendRaw(frame: Buffer): boolean {
    if (this.socket === null) return false
    try {
      this.socket.write(frame)
      return true
    } catch {
      return false
    }
  }

  private sendJson(value: Record<string, unknown>): boolean {
    return this.sendRaw(encodeClientFrame(0x1, Buffer.from(JSON.stringify(value), 'utf8')))
  }
}
