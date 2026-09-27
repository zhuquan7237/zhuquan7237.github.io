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
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { decodeFrames } from './ws.js';
/** Exact WebSocket route carrying every Typert Remote stream. */
const MUX_PATH = '/api/remote.mux';
/** Gateway-internal logical stream carrying application-selected Cordis events. */
const EVENTS_ENDPOINT = '$events';
/** Gateway-internal unary endpoint returning one Remote event outcome. */
const RESULT_ENDPOINT = '$events/result';
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Encode one client-to-server frame (RFC 6455 requires clients to mask). */
export function encodeClientFrame(opcode, payload) {
    const mask = randomBytes(4);
    const length = payload.length;
    let header;
    if (length < 126) {
        header = Buffer.alloc(2);
        header[1] = 0x80 | length;
    }
    else if (length < 65536) {
        header = Buffer.alloc(4);
        header[1] = 0x80 | 126;
        header.writeUInt16BE(length, 2);
    }
    else {
        header = Buffer.alloc(10);
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode;
    const masked = Buffer.alloc(length);
    for (let i = 0; i < length; i += 1) {
        masked[i] = payload[i] ^ mask[i % 4];
    }
    return Buffer.concat([header, mask, masked]);
}
/**
 * One forwarded-events subscription over `/api/remote.mux`, with automatic
 * reconnect. After a reconnect the engine redelivers every still-pending
 * waterfall to the new client generation, so no local backfill is needed.
 */
export class QuestionsMuxClient {
    options;
    socket = null;
    leftover = Buffer.alloc(0);
    clientId = '';
    stopped = true;
    connecting = false;
    retryTimer = null;
    constructor(options) {
        this.options = options;
    }
    /** True while the subscription is open and the client generation is known. */
    get ready() {
        return this.socket !== null && this.clientId !== '';
    }
    /** Current client generation id presented with every answer. */
    get generation() {
        return this.clientId;
    }
    /** Begin connecting (idempotent; safe to call from plugin startup). */
    start() {
        this.stopped = false;
        void this.connect();
    }
    /** Stop for good: closes the socket and cancels any pending reconnect. */
    stop() {
        this.stopped = true;
        if (this.retryTimer !== null) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        this.closeSocket();
    }
    /** One answer, submitted over the connection RPC. Resolves `{ok}`. */
    async submitResult(args) {
        let cookie;
        try {
            cookie = await this.options.cookie();
        }
        catch (error) {
            return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } };
        }
        const body = JSON.stringify({
            type: 'client-request',
            rpcId: randomUUID(),
            method: RESULT_ENDPOINT,
            payload: { args },
        });
        return await new Promise((resolve) => {
            const request = httpRequest({
                host: '127.0.0.1',
                port: this.options.port(),
                path: `/api/${RESULT_ENDPOINT}`,
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(body),
                    Cookie: cookie,
                },
            }, (response) => {
                let text = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => {
                    text += chunk;
                });
                response.on('end', () => {
                    try {
                        const parsed = JSON.parse(text);
                        const result = isRecord(parsed.result) ? parsed.result : {};
                        if (result.ok === true) {
                            resolve({ ok: true });
                            return;
                        }
                        const error = isRecord(result.error) ? result.error : {};
                        resolve({
                            ok: false,
                            error: {
                                ...(typeof error.code === 'string' ? { code: error.code } : {}),
                                ...(typeof error.message === 'string' ? { message: error.message } : {}),
                            },
                        });
                    }
                    catch {
                        resolve({ ok: false, error: { message: `回执无法解析（HTTP ${response.statusCode ?? 0}）` } });
                    }
                });
            });
            request.on('error', (error) => resolve({ ok: false, error: { message: error.message } }));
            request.setTimeout(15000, () => {
                request.destroy(new Error('提交答案超时'));
            });
            request.write(body);
            request.end();
        });
    }
    closeSocket() {
        const socket = this.socket;
        this.socket = null;
        this.clientId = '';
        this.leftover = Buffer.alloc(0);
        if (socket !== null) {
            try {
                socket.destroy();
            }
            catch {
                // already gone
            }
        }
    }
    fail(reason) {
        this.closeSocket();
        if (this.stopped)
            return;
        this.options.handlers.onDown(reason);
        if (this.retryTimer !== null)
            return;
        const delay = this.options.retryDelayMs ?? 3000;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            void this.connect();
        }, delay);
    }
    async connect() {
        if (this.stopped || this.connecting || this.socket !== null)
            return;
        this.connecting = true;
        const port = this.options.port();
        let cookie;
        try {
            cookie = await this.options.cookie();
        }
        catch (error) {
            this.connecting = false;
            this.fail(`登录引擎失败：${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        const key = randomBytes(16).toString('base64');
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
        });
        request.on('upgrade', (response, socket, head) => {
            this.connecting = false;
            if (this.stopped) {
                socket.destroy();
                return;
            }
            void response;
            this.socket = socket;
            this.leftover = Buffer.alloc(0);
            this.attach(socket);
            if (head.length > 0)
                this.feed(head);
            this.sendJson({ type: 'open', streamId: 'events', endpoint: EVENTS_ENDPOINT, payload: { args: {} } });
        });
        request.on('response', (response) => {
            this.connecting = false;
            response.resume();
            const status = response.statusCode ?? 0;
            if (status === 401 || status === 403) {
                // The cached cookie was rejected (e.g. engine secret rotated): force
                // a fresh token exchange on the next attempt.
                void this.options.cookie(true).catch(() => undefined);
            }
            if (!this.stopped && this.socket === null)
                this.fail(`mux 拒绝连接：HTTP ${status}`);
        });
        request.on('error', (error) => {
            this.connecting = false;
            if (!this.stopped && this.socket === null)
                this.fail(`mux 连接失败：${error.message}`);
        });
        request.end();
    }
    attach(socket) {
        socket.on('data', (chunk) => {
            if (this.socket === socket)
                this.feed(chunk);
        });
        const finish = () => {
            if (this.socket === socket)
                this.fail('mux 连接断开');
        };
        socket.on('close', finish);
        socket.on('end', finish);
        socket.on('error', finish);
    }
    feed(chunk) {
        let decoded;
        try {
            decoded = decodeFrames(this.leftover, chunk);
        }
        catch {
            this.fail('mux 帧解析失败');
            return;
        }
        this.leftover = decoded.rest;
        for (const frame of decoded.frames) {
            if (frame.opcode === 0x8) {
                this.fail('mux 关闭帧');
                return;
            }
            if (frame.opcode === 0x9) {
                this.sendRaw(encodeClientFrame(0xa, frame.payload));
                continue;
            }
            if (frame.opcode !== 0x1)
                continue;
            let parsed;
            try {
                parsed = JSON.parse(frame.payload.toString('utf8'));
            }
            catch {
                continue;
            }
            if (!isRecord(parsed) || parsed.type !== 'item')
                continue;
            const value = parsed.value;
            if (!isRecord(value))
                continue;
            if (value.type === 'ready') {
                this.clientId = typeof value.clientId === 'string' ? value.clientId : '';
                if (this.clientId !== '')
                    this.options.handlers.onReady(this.clientId);
                continue;
            }
            this.options.handlers.onFrame(value);
        }
    }
    sendRaw(frame) {
        if (this.socket === null)
            return false;
        try {
            this.socket.write(frame);
            return true;
        }
        catch {
            return false;
        }
    }
    sendJson(value) {
        return this.sendRaw(encodeClientFrame(0x1, Buffer.from(JSON.stringify(value), 'utf8')));
    }
}
