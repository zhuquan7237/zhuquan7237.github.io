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
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCOPE_LABELS, SCOPES, consumePairing, deviceForToken, deviceView, issuePairing, newToken, normalizePublicUrl, readStore, scopeAllows, storePath, writeStore, } from './devices.js';
import { buildDoc, engineOps, mergeDocs, mergePhoneEditsOnto, overlayFor, } from './models.js';
import { qrSvg } from './qr.js';
import { directHosts } from './network.js';
import { startRelayLink } from './relay.js';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { normalizeSince } from './hello.js';
import { acceptUpgrade } from './ws.js';
export * from './devices.js';
export * from './hello.js';
export * from './models.js';
export * from './qr.js';
export * from './ws.js';
/** Cordis plugin name — the patch row id. */
export const name = 'dsh-mobile-bridge';
/** Services the host half needs. */
export const inject = ['webServer', 'credentials'];
/** Public prefix the tunnel forwards. */
export const PUBLIC_PREFIX = '/mobile';
/** Local-only prefix for pairing and device management. */
export const LOCAL_PREFIX = '/mobile-local';
/** Settings namespace that owns provider routes. */
export const MODEL_NS = 'llm-pi-ai';
/** How many event frames are kept for a reconnecting device. */
export const EVENT_BUFFER = 500;
/** Largest request body the bridge accepts. */
const MAX_BODY = 512 * 1024;
const log = (line) => {
    // console.log reaches the desktop shell's engine log reliably.
    console.log(`[dsh-mobile-bridge] ${line}`);
};
const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
    });
    res.end(body);
}
async function readJsonBody(req, limit = MAX_BODY) {
    const chunks = [];
    let size = 0;
    const iterator = req[Symbol.asyncIterator];
    if (iterator === undefined)
        return {};
    for await (const chunk of req) {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        size += buffer.length;
        if (size > limit)
            throw new Error('请求体过大');
        chunks.push(buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    return raw === '' ? {} : JSON.parse(raw);
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
function pathAfter(raw, prefix) {
    const path = String(raw ?? '/').split('?')[0] ?? '/';
    if (path === prefix || path === `${prefix}/`)
        return '/';
    if (path.startsWith(`${prefix}/`))
        return path.slice(prefix.length);
    return path.startsWith('/') ? path : `/${path}`;
}
/** Bearer token from the Authorization header, or `?token=` for WebSocket upgrades. */
function tokenOf(req) {
    const header = req.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    if (typeof value === 'string' && value.toLowerCase().startsWith('bearer '))
        return value.slice(7).trim();
    const url = String(req.url ?? '');
    const at = url.indexOf('?');
    if (at >= 0) {
        const params = new URLSearchParams(url.slice(at + 1));
        const token = params.get('token');
        if (token !== null && token !== '')
            return token;
    }
    return '';
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
export function endpointCandidates(method) {
    const at = method.indexOf('.');
    if (at < 0)
        return [method];
    const namespace = method.slice(0, at);
    const name = method.slice(at + 1);
    // The Remote namespace is the service's own key (`session`, `settings`,
    // `credentials`), so the dotted wire name maps to a slash endpoint directly.
    const candidates = [`${namespace}/${name}`, method];
    // The session control service is a second owner of the `session` namespace in
    // some builds; keeping it second costs one retry at most.
    if (namespace === 'session')
        candidates.push(`sessionController/${name}`);
    return [...new Set(candidates)];
}
/** Which endpoint and argument envelope served each method, once discovered. */
const discoveredEndpoints = new Map();
/**
 * Call one engine Remote method.
 *
 * `dispatchRpc` is the same entry the engine's own `/api` route uses, so values
 * are schema-validated and errors carry the engine's own codes; `invoke` is the
 * fallback for a build whose service exposes only that shape.
 */
async function callEngine(ctx, method, payload, signal) {
    const known = discoveredEndpoints.get(method);
    const endpoints = known !== undefined ? [known.endpoint] : endpointCandidates(method);
    const fields = known !== undefined ? [known.field] : [undefined, 'request', '_request', 'payload'];
    let lastError;
    let hint;
    for (const endpoint of endpoints) {
        for (const field of fields) {
            try {
                const value = await invokeEngine(ctx, endpoint, field === undefined ? payload : { [field]: payload }, signal);
                const found = { endpoint, ...(field !== undefined ? { field } : {}) };
                if (known === undefined) {
                    discoveredEndpoints.set(method, found);
                    if (endpoint !== method || field !== undefined) {
                        log(`端点解析：${method} → ${endpoint}${field !== undefined ? `（参数写在 ${field} 里）` : ''}`);
                    }
                }
                return value;
            }
            catch (error) {
                lastError = error;
                const message = error instanceof Error ? error.message : String(error);
                // A naming miss is worth retrying; a parameter-shape miss tells us the
                // field name the descriptor wants, so the next attempt wraps it that way.
                const missing = /missing \"([A-Za-z_][A-Za-z0-9_]*)\"/.exec(message);
                if (missing !== null) {
                    hint = missing[1];
                    if (!fields.includes(hint))
                        fields.push(hint);
                    continue;
                }
                if (!/endpoint|remote method/i.test(message))
                    throw error;
                break;
            }
        }
        void hint;
    }
    throw lastError;
}
/** Invoke one already-named endpoint. */
async function invokeEngine(ctx, endpoint, payload, signal) {
    const gateway = ctx.get('typertGateway');
    if (gateway === undefined)
        throw new Error('这个引擎没有提供 typertGateway，无法转发调用');
    if (typeof gateway.dispatchRpc === 'function') {
        // The carrier envelope is `{args}` — the gateway validates that a request
        // holds exactly one plain-object `args` field before it resolves anything.
        const result = await gateway.dispatchRpc(endpoint, { args: payload ?? {} }, signal);
        if (isRecord(result) && 'ok' in result) {
            if (result.ok === true)
                return result.value;
            throw new EngineCallError(endpoint, result);
        }
        return result;
    }
    if (typeof gateway.invoke === 'function') {
        return await gateway.invoke({ endpoint, args: payload ?? {}, ...(signal !== undefined ? { signal } : {}) });
    }
    throw new Error('typertGateway 的调用接口不认识，无法转发');
}
/** A failure the engine reported for one method call. */
class EngineCallError extends Error {
    method;
    detail;
    constructor(method, result) {
        const record = isRecord(result) ? result : {};
        const failure = isRecord(record.error) ? record.error : record;
        const message = (typeof failure.message === 'string' && failure.message) ||
            (typeof record.message === 'string' && record.message) ||
            `引擎拒绝了这个调用（${method}）`;
        super(message);
        this.name = 'EngineCallError';
        this.method = method;
        this.detail = failure;
    }
    /** The engine's own code, when it sent one. */
    get code() {
        const failure = isRecord(this.detail) ? this.detail : {};
        for (const field of ['code', 'type', 'reason']) {
            const value = failure[field];
            if (typeof value === 'string' && value !== '')
                return value;
        }
        return undefined;
    }
}
/** Map one engine failure onto the mobile error vocabulary. */
function failurePayload(error) {
    if (error instanceof EngineCallError) {
        const code = error.code ?? '';
        const revisionish = /revision|conflict|stale/i.test(`${code} ${error.message}`);
        return {
            code: revisionish ? 'E_REVISION' : /not found|missing/i.test(`${code} ${error.message}`) ? 'E_NOT_FOUND' : 'E_ENGINE',
            message: error.message,
            ...(error.detail !== undefined ? { detail: error.detail } : {}),
        };
    }
    if (error instanceof Error)
        return { code: 'E_BRIDGE', message: error.message };
    return { code: 'E_BRIDGE', message: String(error) };
}
/**
 * Register the bridge.
 *
 * @param ctx - host context; `webServer` and `credentials` are injected.
 * @param config - optional `publicUrl` shown in the pairing page.
 */
export function apply(ctx, config = {}) {
    const webServer = ctx.get('webServer');
    const credentials = ctx.get('credentials');
    // ------------------------------------------------------------------ the store
    const load = () => readStore();
    const save = (store) => writeStore(store);
    // 上一次的「重启电脑端」请求：引擎已经重启过一轮（新进程加载到这里）= 请求已兑现，清掉标记
    try {
        const booted = load();
        if (booted.network?.restartRequestedAt) {
            booted.network = { ...booted.network, restartRequestedAt: null };
            save(booted);
            log('网络路由：重启已完成，清除重启请求标记');
        }
    }
    catch {
        /* 存档坏了也不能挡住引擎启动 */
    }
    const FILES_STORE = join(dirname(storePath()), 'mobile-bridge-files.json');
    const ATTRIB_PAD_MS = 5_000;
    let filesState = null;
    const loadFileState = () => {
        if (filesState !== null)
            return filesState;
        try {
            const raw = JSON.parse(readFileSync(FILES_STORE, 'utf8'));
            filesState = isRecord(raw) && raw.version === 1 && isRecord(raw.sessions) ? raw : { version: 1, sessions: {} };
        }
        catch {
            filesState = { version: 1, sessions: {} };
        }
        return filesState;
    };
    /** 给 session.list / session.search 的结果附上「已生成文件数」——列表页的信息线索。
     *  只数记账条目、不做 stat；打开会话时 /files 会重新核对存在性。 */
    const withFileCounts = (payload) => {
        const out = (isRecord(payload) ? payload : { items: [] });
        const items = out.items;
        if (!Array.isArray(items))
            return out;
        const state = loadFileState();
        out.items = items.map((item) => {
            if (!isRecord(item))
                return item;
            const sid = sessionIdOf(item);
            const rec = sid !== '' ? state.sessions[sid] : undefined;
            if (!rec || !isRecord(rec.entries))
                return item;
            const count = Object.keys(rec.entries).length;
            return count > 0 ? { ...item, producedFiles: count } : item;
        });
        return out;
    };
    let filesSaveTimer = null;
    const saveFileStateSoon = () => {
        if (filesSaveTimer !== null)
            return;
        filesSaveTimer = setTimeout(() => {
            filesSaveTimer = null;
            const state = filesState;
            if (state === null)
                return;
            const ids = Object.keys(state.sessions);
            if (ids.length > 400) {
                ids.sort((a, b) => (state.sessions[a]?.updated ?? 0) - (state.sessions[b]?.updated ?? 0));
                for (const id of ids.slice(0, ids.length - 400))
                    delete state.sessions[id];
            }
            try {
                mkdirSync(dirname(FILES_STORE), { recursive: true });
                writeFileSync(FILES_STORE, JSON.stringify(state));
            }
            catch (error) {
                log(`文件归属库写入失败：${error instanceof Error ? error.message : String(error)}`);
            }
        }, 600);
    };
    const APPROVALS_STORE = join(dirname(storePath()), 'mobile-bridge-approvals.json');
    let approvalsState = null;
    const loadApprovals = () => {
        if (approvalsState !== null)
            return approvalsState;
        try {
            const raw = JSON.parse(readFileSync(APPROVALS_STORE, 'utf8'));
            approvalsState = isRecord(raw) && raw.version === 1 && isRecord(raw.pending) && Array.isArray(raw.recent)
                ? raw
                : { version: 1, pending: {}, recent: [] };
        }
        catch {
            approvalsState = { version: 1, pending: {}, recent: [] };
        }
        return approvalsState;
    };
    let approvalsSaveTimer = null;
    const saveApprovalsSoon = () => {
        if (approvalsSaveTimer !== null)
            return;
        approvalsSaveTimer = setTimeout(() => {
            approvalsSaveTimer = null;
            const state = approvalsState;
            if (state === null)
                return;
            if (state.recent.length > 50)
                state.recent.length = 50;
            try {
                mkdirSync(dirname(APPROVALS_STORE), { recursive: true });
                writeFileSync(APPROVALS_STORE, JSON.stringify(state));
            }
            catch (error) {
                log(`审批库写入失败：${error instanceof Error ? error.message : String(error)}`);
            }
        }, 600);
    };
    /** 概括文案：只暴露「要审批什么类型」，不携带任何参数原文。 */
    const approvalKindOf = (toolName) => {
        const name = toolName.toLowerCase();
        if (name === 'pwsh' || name === 'bash' || name.includes('shell') || name.includes('terminal'))
            return { kind: 'command', title: '执行命令需要审批' };
        if (name.includes('fs') || name.includes('file') || name.includes('editor') || name.includes('write'))
            return { kind: 'file', title: '修改文件需要审批' };
        if (name.includes('web') || name.includes('fetch') || name.includes('http'))
            return { kind: 'network', title: '联网访问需要审批' };
        return { kind: 'other', title: '执行操作需要审批' };
    };
    /** 返回新加入的审批标题；重复事件返回空串。 */
    const applyApprovalAsked = (state, sessionId, data, at) => {
        const id = typeof data.id === 'string' ? data.id.trim() : '';
        if (id === '' || state.pending[id] !== undefined)
            return '';
        const toolName = typeof data.toolName === 'string' ? data.toolName : '';
        const { kind, title } = approvalKindOf(toolName);
        state.pending[id] = { approvalId: id, sessionId, kind, title, toolName, status: 'pending', resolution: null, openedAt: at, closedAt: null };
        return title;
    };
    const applyApprovalDecided = (state, sessionId, data, at) => {
        const id = typeof data.id === 'string' ? data.id.trim() : '';
        if (id === '')
            return false;
        const outcome = typeof data.outcome === 'string' ? data.outcome : 'unavailable';
        const rec = state.pending[id];
        if (rec !== undefined) {
            delete state.pending[id];
            rec.status = 'closed';
            rec.resolution = outcome;
            rec.closedAt = at;
            state.recent.unshift(rec);
        }
        else if (!state.recent.some((item) => item.approvalId === id)) {
            state.recent.unshift({ approvalId: id, sessionId, kind: 'other', title: '执行操作需要审批', toolName: '', status: 'closed', resolution: outcome, openedAt: at, closedAt: at });
        }
        else {
            return false;
        }
        if (state.recent.length > 50)
            state.recent.length = 50;
        return true;
    };
    const noteApprovalAsked = (sessionId, data, at = Date.now()) => {
        const state = loadApprovals();
        const title = applyApprovalAsked(state, sessionId, data, at);
        if (title !== '')
            saveApprovalsSoon();
        return title;
    };
    const noteApprovalDecided = (sessionId, data, at = Date.now()) => {
        const state = loadApprovals();
        if (applyApprovalDecided(state, sessionId, data, at))
            saveApprovalsSoon();
    };
    const PROMPTS_STORE = join(dirname(storePath()), 'mobile-bridge-prompts.json');
    let promptsState = null;
    const loadPrompts = () => {
        if (promptsState !== null)
            return promptsState;
        try {
            const raw = JSON.parse(readFileSync(PROMPTS_STORE, 'utf8'));
            promptsState = isRecord(raw) && raw.version === 1 && isRecord(raw.receipts) ? raw : { version: 1, receipts: {} };
        }
        catch {
            promptsState = { version: 1, receipts: {} };
        }
        // 惰性清理：24h TTL + 上限 400
        const now = Date.now();
        const keep = {};
        for (const key of Object.keys(promptsState.receipts)) {
            const rec = promptsState.receipts[key];
            if (rec !== undefined && now - rec.at < 24 * 60 * 60 * 1000)
                keep[key] = rec;
        }
        const keys = Object.keys(keep);
        if (keys.length > 400) {
            keys.sort((a, b) => (keep[a]?.at ?? 0) - (keep[b]?.at ?? 0));
            for (const key of keys.slice(0, keys.length - 400))
                delete keep[key];
        }
        promptsState = { version: 1, receipts: keep };
        return promptsState;
    };
    const savePrompts = () => {
        const state = promptsState;
        if (state === null)
            return;
        try {
            mkdirSync(dirname(PROMPTS_STORE), { recursive: true });
            writeFileSync(PROMPTS_STORE, JSON.stringify(state));
        }
        catch (error) {
            log(`去重库写入失败：${error instanceof Error ? error.message : String(error)}`);
        }
    };
    const acceptPrompt = async (device, requestId, sessionId, mode, textBasis, dispatch) => {
        if (requestId === '')
            return { reused: false, result: await dispatch() };
        const key = `${device.id}:${requestId}`;
        const textSha = createHash('sha256').update(textBasis, 'utf8').digest('hex');
        const state = loadPrompts();
        const seen = state.receipts[key];
        if (seen !== undefined) {
            if (seen.textSha !== textSha || seen.sessionId !== sessionId || seen.mode !== mode) {
                const error = new Error('同一个 requestId 被用于了不同的消息内容');
                error.code = 'E_ID_REUSE';
                throw error;
            }
            return { reused: true, ...(seen.status === 'dispatching' ? { pending: true } : {}) };
        }
        state.receipts[key] = { sessionId, mode, textSha, status: 'dispatching', at: Date.now() };
        savePrompts();
        try {
            const result = await dispatch();
            const rec = state.receipts[key];
            if (rec !== undefined)
                rec.status = 'accepted';
            savePrompts();
            return { reused: false, result };
        }
        catch (error) {
            delete state.receipts[key];
            savePrompts();
            throw error;
        }
    };
    /** 顶层文件（带 mtime）——归属与列表共用同一条扫描。 */
    const topLevelFiles = (cwd) => {
        const out = [];
        try {
            for (const entry of readdirSync(cwd, { withFileTypes: true })) {
                if (!entry.isFile() || entry.name.startsWith('.'))
                    continue;
                try {
                    const stat = statSync(join(cwd, entry.name));
                    out.push({ name: entry.name, size: stat.size, mtime: stat.mtimeMs });
                }
                catch {
                    // 单个文件读不到就跳过，别让整个扫描失败
                }
            }
        }
        catch {
            return [];
        }
        return out;
    };
    /** 把若干时间窗内改动过的顶层文件记到会话账上；返回新增条数。 */
    const attributeWindows = (rec, cwd, windows) => {
        if (windows.length === 0)
            return 0;
        let added = 0;
        for (const file of topLevelFiles(cwd)) {
            for (const [start, end] of windows) {
                if (file.mtime >= start - ATTRIB_PAD_MS && file.mtime <= end + ATTRIB_PAD_MS) {
                    rec.entries[file.name] = { mtime: file.mtime, size: file.size, at: Date.now() };
                    added += 1;
                    break;
                }
            }
        }
        rec.updated = Date.now();
        return added;
    };
    const sessionRec = (sessionId, cwd) => {
        const state = loadFileState();
        let rec = state.sessions[sessionId];
        if (rec === undefined || rec.cwd !== cwd) {
            // 第一次见，或工作目录换过：旧条目没有意义，重新收集
            rec = { cwd, updated: Date.now(), entries: {} };
            state.sessions[sessionId] = rec;
        }
        return rec;
    };
    /** 单个回合（turn/end 时调用）。 */
    const rememberWindow = (sessionId, cwd, start, end) => {
        const rec = sessionRec(sessionId, cwd);
        const added = attributeWindows(rec, cwd, [[start, end]]);
        if (added > 0)
            saveFileStateSoon();
        return added;
    };
    /** 运行中的回合：sessionId → 起始时间（毫秒）。 */
    const liveTurns = new Map();
    /**
     * 历史会话回填：读它自己的历史页，抽出所有 turn 时间窗，认领目录里现有文件。
     * 两分钟内做过就跳过（新文件只可能出自新的回合，回合由事件钩子记账）。
     */
    const backfillSession = async (sessionId, cwd) => {
        const state = loadFileState();
        const existing = state.sessions[sessionId];
        if (existing !== undefined &&
            existing.cwd === cwd &&
            existing.backfilled === true &&
            Date.now() - existing.updated < 120_000) {
            return;
        }
        const windows = [];
        let beforeSeq;
        for (let pageNo = 0; pageNo < 6; pageNo += 1) {
            const base = { address: { kind: 'session', sessionId }, maxMessages: 300 };
            if (beforeSeq !== undefined)
                base.beforeSeq = beforeSeq;
            let result;
            try {
                result = await readPage(sessionId, base);
            }
            catch {
                break;
            }
            const records = isRecord(result) && Array.isArray(result.records) ? result.records : [];
            if (records.length === 0)
                break;
            let minSeq = Number.POSITIVE_INFINITY;
            let open = null;
            for (const raw of records) {
                const event = isRecord(raw) && isRecord(raw.event) ? raw.event : isRecord(raw) ? raw : {};
                const type = typeof event.type === 'string' ? event.type : '';
                const time = typeof event.time === 'number' ? event.time : 0;
                const seq = typeof event.seq === 'number' ? event.seq : isRecord(raw) && typeof raw.seq === 'number' ? raw.seq : 0;
                if (seq > 0 && seq < minSeq)
                    minSeq = seq;
                if (time <= 0)
                    continue;
                if (type === 'turn/start') {
                    open = time;
                }
                else if (type === 'turn/end' && open !== null) {
                    windows.push([open, time]);
                    open = null;
                }
            }
            if (open !== null)
                windows.push([open, Date.now()]);
            const more = isRecord(result) && result.hasMore === true;
            if (!more || !Number.isFinite(minSeq))
                break;
            beforeSeq = minSeq;
        }
        const rec = sessionRec(sessionId, cwd);
        attributeWindows(rec, cwd, windows);
        rec.backfilled = true;
        saveFileStateSoon();
    };
    const overlayOf = (store) => {
        const raw = store.models;
        return isRecord(raw)
            ? { revision: typeof raw.revision === 'number' ? raw.revision : 0, ...raw }
            : { revision: 0 };
    };
    // ------------------------------------------------------------------- events
    const frames = [];
    const clients = new Map();
    let seq = 0;
    /**
     * Names this counter's lifetime. `seq` restarts with the process, so a phone
     * whose stored watermark outlives a restart must not be trusted (see
     * `normalizeSince`); the epoch is what lets a client notice that happened.
     */
    const epoch = randomUUID();
    /** Highest event seq seen per session, from the live event stream. */
    const headSeqs = new Map();
    const publish = (frame) => {
        seq += 1;
        const full = { seq, epoch, time: Date.now(), ...frame };
        frames.push(full);
        if (frames.length > EVENT_BUFFER)
            frames.splice(0, frames.length - EVENT_BUFFER);
        const text = JSON.stringify(full);
        for (const [connection, state] of clients) {
            if (!connection.open) {
                clients.delete(connection);
                continue;
            }
            if (full.seq > state.since)
                connection.send(text);
        }
    };
    const sessionIdOf = (session) => {
        if (isRecord(session)) {
            for (const field of ['id', 'sessionId']) {
                const value = session[field];
                if (typeof value === 'string' && value !== '')
                    return value;
            }
            const header = session.header;
            if (isRecord(header) && typeof header.id === 'string')
                return header.id;
        }
        return '';
    };
    // One subscription drives both the phone's stream and its notifications.
    try {
        ctx.on('session/event', ((session, event) => {
            const record = isRecord(event) ? event : {};
            const type = typeof record.type === 'string' ? record.type : 'unknown';
            const sessionId = sessionIdOf(session);
            const sessionSeq = typeof record.seq === 'number' ? record.seq : 0;
            if (sessionId !== '' && sessionSeq > 0) {
                headSeqs.set(sessionId, Math.max(headSeqs.get(sessionId) ?? 0, sessionSeq));
            }
            publish({
                kind: 'event',
                ...(sessionId !== '' ? { sessionId } : {}),
                type,
                data: record.data ?? null,
                // The phone needs the turn/step boundary to place a message.
                ...(isRecord(record) && typeof record.seq === 'number' ? { data: { ...(isRecord(record.data) ? record.data : {}), eventSeq: record.seq } } : {}),
            });
            // 生成文件归属：记住每个回合的时间窗；turn/end 后把窗口内改动过的顶层文件
            // 记到这个会话账上（旁路记账，任何失败都不许影响事件流本身）。
            try {
                if (sessionId !== '') {
                    if (type === 'turn/start') {
                        liveTurns.set(sessionId, typeof record.time === 'number' ? record.time : Date.now());
                    }
                    else if (type === 'turn/end') {
                        const start = liveTurns.get(sessionId);
                        liveTurns.delete(sessionId);
                        const end = typeof record.time === 'number' ? record.time : Date.now();
                        if (start !== undefined) {
                            void (async () => {
                                try {
                                    const cwd = await sessionCwdOf(sessionId);
                                    if (cwd !== '')
                                        rememberWindow(sessionId, cwd, start, end);
                                }
                                catch {
                                    // 归属失败不影响任何其它功能
                                }
                            })();
                        }
                    }
                }
            }
            catch {
                // 同上：旁路记账
            }
            // 审批只读（K2-A）：把 approval/asked、approval/decided 累积成手机可查的脱敏
            // 记录；任何失败都不许影响事件流本身。
            try {
                if (type === 'approval/asked' && isRecord(record.data)) {
                    const at = typeof record.time === 'number' ? record.time : Date.now();
                    const title = noteApprovalAsked(sessionId, record.data, at);
                    if (title !== '') {
                        publish({ kind: 'notify', ...(sessionId !== '' ? { sessionId } : {}), level: 'info', title: '有操作等待电脑端审批', body: `${title} · 请在电脑上处理（手机端仅支持查看）` });
                    }
                }
                else if (type === 'approval/decided' && isRecord(record.data)) {
                    const at = typeof record.time === 'number' ? record.time : Date.now();
                    noteApprovalDecided(sessionId, record.data, at);
                }
            }
            catch {
                // 同上：旁路记账
            }
            if (type === 'turn/end') {
                const reason = isRecord(record.data) ? record.data.reason : undefined;
                const reasonKind = typeof reason === 'string' ? reason : isRecord(reason) && typeof reason.kind === 'string' ? reason.kind : 'ended';
                const failed = /error|fail/i.test(reasonKind);
                const truncated = /max-token/i.test(reasonKind);
                publish({
                    kind: 'notify',
                    ...(sessionId !== '' ? { sessionId } : {}),
                    level: failed ? 'error' : 'info',
                    title: failed ? '回合失败' : truncated ? '输出被截断' : '回合完成',
                    body: failed ? `原因：${reasonKind}` : truncated ? '达到输出长度上限，这一回合没能写完' : '电脑端已结束这次回合',
                });
            }
        }));
    }
    catch (error) {
        log(`订阅会话事件失败：${error instanceof Error ? error.message : String(error)}`);
    }
    // ------------------------------------------------------------------- helpers
    const authenticate = (req) => {
        const token = tokenOf(req);
        if (token === '')
            return { error: { code: 'E_UNAUTHORIZED', message: '缺少设备令牌' } };
        const store = load();
        const device = deviceForToken(store, token);
        if (device === undefined)
            return { error: { code: 'E_UNAUTHORIZED', message: '令牌无效或已被解除绑定' } };
        device.lastSeenAt = Date.now();
        try {
            save(store);
        }
        catch {
            // A read-only home must not turn a valid token into a failure.
        }
        return { device, store };
    };
    /**
     * Whether a device holds a scope, with the same implication the method table
     * uses: a device trusted with configuration is not less trusted with a message.
     */
    const holdsScope = (device, needed) => {
        if (device.scopes.includes(needed))
            return true;
        if (needed === 'read')
            return device.scopes.some((scope) => scope === 'prompt' || scope === 'config' || scope === 'admin');
        if (needed === 'prompt')
            return device.scopes.some((scope) => scope === 'config' || scope === 'admin');
        return false;
    };
    const requireScope = (device, needed) => holdsScope(device, needed)
        ? { ok: true }
        : { ok: false, code: 'E_FORBIDDEN', message: `这台设备没有被授予「${SCOPE_LABELS[needed]}」权限，请在电脑端重新配对并勾选` };
    /**
     * Read one page of a session's log through the engine's own paging method.
     *
     * `session.page` demands a `throughSeq` at or below the session's cursor, and a
     * reader that has not watched the session cannot know that cursor yet. The
     * engine names it in its refusal ("past cursor N"), so the cursor is learned
     * from that one error and then kept fresh by the event stream the bridge is
     * already subscribed to.
     */
    const readPage = async (sessionId, base) => {
        for (let tries = 0; tries < 3; tries += 1) {
            const through = headSeqs.get(sessionId) ?? Number.MAX_SAFE_INTEGER;
            try {
                return await callEngine(ctx, 'session.page', { ...base, throughSeq: through });
            }
            catch (error) {
                const match = /past cursor (\d+)/.exec(String(error?.message ?? error));
                if (match === null)
                    throw error;
                headSeqs.set(sessionId, Number(match[1]));
            }
        }
        throw new Error('无法确定会话游标');
    };
    /** 审批回填：待审批只可能出现在「运行中」的会话里；逐个扫描其最近一页历史，
     *  与内存记录合并。全部读取成功才认为集合完整（N2 §4.1 的一致性口径）。 */
    const backfillApprovals = async () => {
        try {
            const listed = (await callEngine(ctx, 'session.list', {}));
            const items = isRecord(listed) && Array.isArray(listed.items) ? listed.items : [];
            let complete = true;
            const state = loadApprovals();
            for (const item of items) {
                if (!isRecord(item) || item.running !== true)
                    continue;
                const sid = sessionIdOf(item);
                if (sid === '')
                    continue;
                try {
                    const page = (await readPage(sid, { address: { kind: 'session', sessionId: sid }, maxMessages: 160 }));
                    const records = isRecord(page) && Array.isArray(page.records) ? page.records : [];
                    for (const record of records) {
                        if (!isRecord(record))
                            continue;
                        const ev = isRecord(record.event) ? record.event : record;
                        const type = typeof ev.type === 'string' ? ev.type : '';
                        const data = isRecord(ev.data) ? ev.data : {};
                        const at = typeof ev.time === 'number' ? ev.time : Date.now();
                        if (type === 'approval/asked')
                            applyApprovalAsked(state, sid, data, at);
                        else if (type === 'approval/decided')
                            applyApprovalDecided(state, sid, data, at);
                    }
                }
                catch {
                    complete = false;
                }
            }
            saveApprovalsSoon();
            return complete;
        }
        catch {
            return false;
        }
    };
    /** The settings namespace view for the model document. */
    const modelNamespace = async () => {
        const described = (await callEngine(ctx, 'settings.describe', {}));
        const namespaces = isRecord(described) && Array.isArray(described.namespaces) ? described.namespaces : [];
        for (const view of namespaces) {
            if (isRecord(view) && view.ns === MODEL_NS)
                return view;
        }
        return undefined;
    };
    const buildModelDoc = async (store) => {
        const view = await modelNamespace();
        const refs = new Set();
        const value = isRecord(view?.value) ? view?.value : {};
        const providers = isRecord(value.providers) ? value.providers : {};
        for (const provider of Object.values(providers)) {
            if (isRecord(provider) && typeof provider.apiKeyEnv === 'string')
                refs.add(provider.apiKeyEnv);
        }
        const keyConfigured = {};
        for (const ref of refs) {
            try {
                const described = await credentials?.describe(ref);
                keyConfigured[ref] = described?.configured === true;
            }
            catch {
                keyConfigured[ref] = false;
            }
        }
        return buildDoc(view, overlayOf(store), keyConfigured, Date.now(), networkOf(store).routes ?? {});
    };
    const networkOf = (store) => store.network ?? {};
    /** provider id → baseURL（从 llm-pi-ai 命名空间视图里读）。 */
    const providerBaseUrls = async () => {
        const view = await modelNamespace();
        const value = isRecord(view?.value) ? view.value : {};
        const providers = isRecord(value.providers) ? value.providers : {};
        const out = {};
        for (const [pid, raw] of Object.entries(providers)) {
            if (isRecord(raw) && typeof raw.baseURL === 'string')
                out[pid] = raw.baseURL;
        }
        return out;
    };
    /**
     * 当前网络路由快照（含算好的直连主机列表，顺带持久化 noProxyHosts 供桌面壳读取）。
     */
    const networkSnapshot = async () => {
        const store = load();
        const network = networkOf(store);
        const baseUrls = await providerBaseUrls();
        const routes = network.routes ?? {};
        const hosts = directHosts(baseUrls, routes);
        if (JSON.stringify(hosts) !== JSON.stringify(network.noProxyHosts ?? [])) {
            store.network = { ...network, noProxyHosts: hosts };
            save(store);
        }
        const providers = Object.keys(baseUrls)
            .sort()
            .map((pid) => ({
            id: pid,
            host: (() => {
                try {
                    return new URL(baseUrls[pid]).hostname.toLowerCase();
                }
                catch {
                    return '';
                }
            })(),
            route: routes[pid] ?? null,
        }));
        return {
            proxyUrl: String(network.proxyUrl ?? ''),
            routes,
            noProxyHosts: hosts,
            providers,
            revision: network.revision ?? 0,
            restartRequestedAt: network.restartRequestedAt ?? null,
        };
    };
    /** Public URL from the profile config, before the store's own value wins. */
    const configuredPublicUrl = () => (config.publicUrl ?? '').trim().replace(/\/+$/, '');
    /**
     * Effective public base URL. The store's value wins over the profile config so
     * the settings page can change it without an engine restart; the config stays
     * as the fallback for machines that set it before this existed.
     */
    const publicUrl = () => {
        const stored = normalizePublicUrl(load().publicUrl);
        return stored !== '' ? stored : configuredPublicUrl();
    };
    const publicUrlSource = () => {
        if (normalizePublicUrl(load().publicUrl) !== '')
            return 'store';
        return configuredPublicUrl() !== '' ? 'config' : '';
    };
    // ---- 手机侧入口地址：中继 > 显式公网地址 > 局域网 ----
    // relayKey/lanAddress 的值由 apply 末尾的中继与局域网两块赋值；这里只声明引用，
    // 闭包在请求时才读取，所以顺序无关。
    let relayKey = '';
    let relayLink = null;
    let lanAddress = '';
    const LAN_PORT = 17732;
    /** 中继给手机用的入口（链路不在线就不给，避免把手机指到连不上的路）。 */
    const relayBase = () => {
        if (relayLink === null || relayKey === '')
            return '';
        if (relayLink.status() === 'offline')
            return '';
        const line = String(relayLink.current()?.url ?? '');
        // 自己正走国内直连才给直连入口；走 Cloudflare 就统一给隧道入口（哪都通）
        return line.includes('cn.')
            ? `https://cn.zhuquan.xyz:8443/m/${relayKey}`
            : `https://relay.zhuquan.xyz/m/${relayKey}`;
    };
    const lanBase = () => (lanAddress === '' ? '' : `http://${lanAddress}:${LAN_PORT}`);
    /** 配对二维码/链接用的基地址。 */
    const phoneBase = () => relayBase() || publicUrl() || lanBase();
    const pairingUrl = (code) => {
        const base = phoneBase();
        return base === '' ? code : `${base}/mobile/?pair=${encodeURIComponent(code)}`;
    };
    // -------------------------------------------------------------- local routes
    const localState = () => {
        const store = load();
        const pairing = store.pairing;
        const live = pairing !== undefined && pairing.expiresAt > Date.now();
        return {
            storePath: storePath(),
            pairCode: live ? pairing?.code : null,
            pairExpiresAt: live ? pairing?.expiresAt : null,
            pairUrl: live && pairing !== undefined ? pairingUrl(pairing.code) : null,
            publicUrl: publicUrl(),
            phoneUrl: phoneBase(),
            relay: {
                enabled: relayLink !== null,
                status: relayLink?.status() ?? 'off',
                path: relayBase() === '' ? '' : (String(relayLink?.current()?.url ?? '').includes('cn.') ? 'direct' : 'cloudflare'),
            },
            publicUrlSource: publicUrlSource(),
            publicUrlConfigured: configuredPublicUrl(),
            devices: store.devices.map(deviceView),
            scopes: SCOPES.map((scope) => ({ id: scope, label: SCOPE_LABELS[scope] })),
        };
    };
    const pairingPage = () => {
        const state = localState();
        const code = state.pairCode;
        const devices = state.devices;
        const url = state.pairUrl;
        const rows = devices
            .map((device) => `<li><strong>${String(device.name ?? '未命名')}</strong> · ${String(device.platform ?? '')} · ${device.scopes.join('/')} · 最后活跃 ${new Date(Number(device.lastSeenAt ?? 0)).toLocaleString('zh-CN')} · <button data-revoke="${String(device.id)}">解除</button></li>`)
            .join('');
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
  .netrow { display: flex; gap: 10px; align-items: center; justify-content: space-between; padding: 7px 0; border-bottom: 1px solid rgba(127,127,127,.15); flex-wrap: wrap; }
  .netrow:last-child { border-bottom: 0; }
  .netrow button { padding: 4px 10px; border-radius: 8px; }
  .netbtns { display: flex; gap: 6px; }
</style></head><body><main>
<h1>移动端配对</h1>
<p class="sub">${state.phoneUrl !== '' ? `手机扫码或打开 <code>${String(state.phoneUrl)}/mobile/</code> 即可配对（推荐用下面的二维码，地址自动带入）。` : '（云端中继尚未连上，也没配公网地址：下面这串码需要手机手填电脑地址）'}</p>
<div class="card">
  ${code !== null ? `<div class="muted">配对码（5 分钟有效）</div><div class="code">${code}</div>` : '<div class="muted">当前没有有效配对码。</div>'}
  ${url !== null ? `<code class="url">${url}</code>` : ''}
  <p><button class="primary" data-rotate="1">${code !== null ? '重新生成' : '生成配对码'}</button></p>
</div>
<div class="card">
  <div class="muted">已绑定的设备（${devices.length}）</div>
  <ul>${rows === '' ? '<li class="muted">还没有设备绑定</li>' : rows}</ul>
</div>
<div class="card">
  <div class="muted">模型网络 · 每个提供商可选「自动（代理）/ 直连」——有的提供商必须走代理才能用，有的必须直连。改动需重启电脑端后生效。</div>
  <div id="netRows" class="muted" style="margin-top:6px">加载中…</div>
  <p class="netrow" style="margin-top:12px"><span>代理地址</span><input id="netProxy" style="flex:1;min-width:200px;padding:6px 10px;border-radius:9px;border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;font:inherit" placeholder="http://127.0.0.1:7897（留空 = 全部直连）" /></p>
  <p style="margin:12px 0 0"><button data-netsave="1">保存网络设置</button> <button class="primary" data-netrestart="1">保存并重启电脑端</button></p>
  <p class="muted" id="netHint"></p>
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
<script>
const netRows = document.getElementById('netRows');
const netHint = document.getElementById('netHint');
const netProxy = document.getElementById('netProxy');
let net = null;
const netRender = () => {
  if (!net) return;
  netProxy.value = net.proxyUrl || '';
  const routes = net.routes || {};
  netRows.innerHTML = (net.providers || []).map(function (p) {
    const cur = routes[p.id] || '';
    const b = function (v, label) { return '<button data-netpick="' + p.id + '" data-route="' + v + '"' + (cur === v ? ' class="primary"' : '') + '>' + label + '</button>'; };
    return '<div class="netrow"><span>' + p.id + '<span class="muted">' + (p.host ? ' · ' + p.host : '') + '</span></span><span class="netbtns">' + b('', '自动') + b('proxy', '代理') + b('direct', '直连') + '</span></div>';
  }).join('');
  netHint.textContent = net.restartRequestedAt ? '已请求重启，电脑端将在数秒内自动重启…' : '"自动" = 默认走代理；直连的提供商会绕过代理（立即生效需重启电脑端）。';
};
const netSave = async (restart) => {
  await fetch('${LOCAL_PREFIX}/network', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proxyUrl: netProxy.value.trim(), routes: net.routes, restart: !!restart }) });
  net = (await (await fetch('${LOCAL_PREFIX}/network')).json()).network;
  netRender();
  if (restart) netHint.textContent = '已请求重启，电脑端将在数秒内自动重启…';
  else netHint.textContent = '已保存——重启电脑端后生效。';
};
document.addEventListener('click', async (event) => {
  const t = event.target;
  if (t && t.dataset && t.dataset.netpick) {
    net.routes = net.routes || {};
    if (t.dataset.route) net.routes[t.dataset.netpick] = t.dataset.route;
    else delete net.routes[t.dataset.netpick];
    netRender();
    return;
  }
  if (t && t.dataset && t.dataset.netsave) { await netSave(false); return; }
  if (t && t.dataset && t.dataset.netrestart) { await netSave(true); return; }
});
(async () => {
  try { net = (await (await fetch('${LOCAL_PREFIX}/network')).json()).network; netRender(); }
  catch (e) { netRows.textContent = '读取失败：' + e; }
})();
</script>
</main></body></html>`;
    };
    // Prefix routes must NOT end with a slash: the web server matches a prefix by
    // `pathname === prefix || pathname.startsWith(prefix + '/')`, so a trailing
    // slash matches nothing at all — the symptom is every exact route working
    // while the prefix routes look like they were never registered.
    webServer.register({
        kind: 'prefix',
        path: LOCAL_PREFIX,
        handler: (req, res) => {
            const path = pathAfter(req.url, LOCAL_PREFIX);
            if (path.startsWith('/state')) {
                sendJson(res, 200, localState());
                return;
            }
            if (path.startsWith('/rotate')) {
                const store = load();
                const pairing = issuePairing(store);
                save(store);
                log(`已生成配对码（5 分钟内有效）`);
                sendJson(res, 200, { ok: true, code: pairing.code, expiresAt: pairing.expiresAt });
                return;
            }
            // QR for the current pairing link, rendered server-side so the settings
            // page only needs an <img> and the shell and the plugin always draw the
            // same code for the same link.
            if (path.startsWith('/qr')) {
                const state = localState();
                const code = state.pairCode;
                const link = state.pairUrl;
                if (code === null || link === null) {
                    // Say which half is missing: "no code yet" and "no public address" are
                    // different fixes, and the old build reported the wrong one whenever
                    // both were missing.
                    const missingBase = publicUrl() === '';
                    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
                    res.end(missingBase
                        ? '还没有配置公网地址，二维码会指向不可达的地址：请在上方填入公网地址后重试。'
                        : '当前没有有效配对码：先生成配对码。');
                    return;
                }
                try {
                    const svg = qrSvg(link);
                    res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' });
                    res.end(svg);
                }
                catch (error) {
                    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
                    res.end(`二维码生成失败：${error instanceof Error ? error.message : String(error)}`);
                }
                return;
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
                    });
                    return;
                }
                void (async () => {
                    try {
                        const body = await readJsonBody(req);
                        const raw = String(body.publicUrl ?? '').trim();
                        const next = normalizePublicUrl(raw);
                        if (raw !== '' && next === '') {
                            sendJson(res, 200, {
                                ok: false,
                                code: 'E_PUBLIC_URL',
                                message: '公网地址需要以 http:// 或 https:// 开头，例如 https://m.example.com（留空表示清除）。',
                            });
                            return;
                        }
                        const store = load();
                        if (next === '') {
                            delete store.publicUrl;
                        }
                        else {
                            store.publicUrl = next;
                        }
                        save(store);
                        log(next === '' ? '已清除公网地址（回退为 profile 配置）' : `公网地址已更新：${next}`);
                        // A new base makes the previously scanned code point at the wrong
                        // host, so issue a fresh code and hand it back with the new link.
                        const rotated = load();
                        const pairing = issuePairing(rotated);
                        save(rotated);
                        sendJson(res, 200, {
                            ok: true,
                            publicUrl: publicUrl(),
                            publicUrlSource: publicUrlSource(),
                            pairCode: pairing.code,
                            pairExpiresAt: pairing.expiresAt,
                            pairUrl: pairingUrl(pairing.code),
                        });
                    }
                    catch (error) {
                        sendJson(res, 200, {
                            ok: false,
                            code: 'E_CONFIG',
                            message: error instanceof Error ? error.message : String(error),
                        });
                    }
                })();
                return;
            }
            // 模型网络路由（桌面设置页配置 + 外壳读取）。
            if (path.startsWith('/network')) {
                void (async () => {
                    try {
                        if (req.method === 'POST') {
                            const body = await readJsonBody(req);
                            const store = load();
                            const network = { ...networkOf(store) };
                            if (typeof body.proxyUrl === 'string') {
                                network.proxyUrl = String(body.proxyUrl).trim();
                            }
                            if (isRecord(body.routes)) {
                                const routes = { ...(network.routes ?? {}) };
                                for (const [pid, value] of Object.entries(body.routes)) {
                                    if (value === 'direct' || value === 'proxy')
                                        routes[pid] = value;
                                    else if (value === null)
                                        delete routes[pid];
                                }
                                network.routes = routes;
                            }
                            if (body.restart === true)
                                network.restartRequestedAt = Date.now();
                            network.revision = (network.revision ?? 0) + 1;
                            store.network = network;
                            save(store);
                        }
                        sendJson(res, 200, { ok: true, network: await networkSnapshot() });
                    }
                    catch (error) {
                        sendJson(res, 200, {
                            ok: false,
                            code: 'E_NETWORK',
                            message: error instanceof Error ? error.message : String(error),
                        });
                    }
                })();
                return;
            }
            // The settings section reports that it mounted, so a blank page has a
            // server-side trace instead of silence.
            if (path.startsWith('/seat')) {
                void (async () => {
                    try {
                        const body = await readJsonBody(req);
                        const stage = String(body.stage ?? '').trim();
                        const failure = String(body.failure ?? '').trim();
                        log(`设置页${stage === 'seated' ? '已挂载' : `挂载失败${failure === '' ? '' : `：${failure}`}`}`);
                    }
                    catch {
                        /* the seat ping is best-effort */
                    }
                    sendJson(res, 200, { ok: true });
                })();
                return;
            }
            const revoke = path.match(/^\/devices\/([^/?]+)/);
            if (revoke !== null) {
                const store = load();
                const before = store.devices.length;
                store.devices = store.devices.filter((device) => device.id !== decodeURIComponent(revoke[1]));
                save(store);
                log(`已解除绑定：${before - store.devices.length} 台设备`);
                sendJson(res, 200, { ok: true, devices: store.devices.map(deviceView) });
                return;
            }
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(pairingPage());
        },
    });
    // ------------------------------------------------------------- pairing route
    webServer.register({
        kind: 'exact',
        path: `${PUBLIC_PREFIX}/pair`,
        handler: (req, res) => {
            void (async () => {
                try {
                    const body = await readJsonBody(req);
                    const store = load();
                    const result = consumePairing(store, body.code);
                    if (!result.ok) {
                        save(store);
                        log(`配对失败：${result.reason}`);
                        sendJson(res, 200, { ok: false, code: 'E_PAIRING', message: result.reason });
                        return;
                    }
                    const { token, tokenHash } = newToken();
                    const requested = Array.isArray(body.scopes) ? body.scopes.filter((s) => SCOPES.includes(s)) : [];
                    const scopes = requested.length > 0 ? requested : ['read', 'prompt'];
                    const device = {
                        id: randomUUID(),
                        name: String(body.deviceName ?? '手机').slice(0, 60),
                        platform: String(body.platform ?? '').slice(0, 60),
                        tokenHash,
                        scopes,
                        createdAt: Date.now(),
                        lastSeenAt: Date.now(),
                    };
                    store.devices.push(device);
                    save(store);
                    log(`新设备已绑定：${device.name}（${scopes.join('/')}）`);
                    publish({ kind: 'notify', level: 'info', title: '新设备已绑定', body: `${device.name} 获得了 ${scopes.join('/')} 权限` });
                    sendJson(res, 200, { ok: true, device: deviceView(device), token, scopes });
                }
                catch (error) {
                    sendJson(res, 200, { ok: false, code: 'E_PAIRING', message: error instanceof Error ? error.message : String(error) });
                }
            })();
        },
    });
    // ------------------------------------------------------------------ API routes
    const guarded = (handler, bodyRequired = false) => {
        return (req, res) => {
            void (async () => {
                const auth = authenticate(req);
                if ('error' in auth) {
                    sendJson(res, 401, { ok: false, ...auth.error });
                    return;
                }
                try {
                    const body = bodyRequired ? await readJsonBody(req) : {};
                    await handler(req, res, auth.device, body);
                }
                catch (error) {
                    const payload = failurePayload(error);
                    log(`请求失败：${payload.code} ${payload.message}`);
                    sendJson(res, 200, { ok: false, ...payload });
                }
            })();
        };
    };
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
            });
        }),
    });
    webServer.register({
        kind: 'exact',
        path: `${PUBLIC_PREFIX}/sessions`,
        handler: guarded(async (req, res, device, body) => {
            const check = requireScope(device, 'read');
            if (!check.ok) {
                sendJson(res, 200, { ok: false, code: check.code, message: check.message });
                return;
            }
            if (req.method === 'GET') {
                const url = new URL(String(req.url ?? ''), 'http://localhost');
                const query = (url.searchParams.get('query') ?? '').trim();
                if (query !== '') {
                    const found = (await callEngine(ctx, 'session.search', { query }));
                    sendJson(res, 200, { ok: true, search: true, ...withFileCounts(found) });
                    return;
                }
                const listed = (await callEngine(ctx, 'session.list', {}));
                sendJson(res, 200, { ok: true, ...withFileCounts(listed) });
                return;
            }
            // POST: create a session, optionally on a chosen model.
            const check2 = requireScope(device, 'prompt');
            if (!check2.ok) {
                sendJson(res, 200, { ok: false, code: check2.code, message: check2.message });
                return;
            }
            const payload = {};
            if (typeof body.cwd === 'string' && body.cwd.trim() !== '')
                payload.cwd = body.cwd.trim();
            if (typeof body.agentPreset === 'string' && body.agentPreset.trim() !== '')
                payload.agentPreset = body.agentPreset.trim();
            const created = (await callEngine(ctx, 'session.create', payload));
            const sessionId = isRecord(created) && typeof created.sessionId === 'string' ? created.sessionId : '';
            if (sessionId !== '' && isRecord(body.model) && typeof body.model.provider === 'string' && typeof body.model.model === 'string') {
                await callEngine(ctx, 'session.selectModel', {
                    sessionId,
                    provider: body.model.provider,
                    model: body.model.model,
                });
            }
            log(`新建会话：${sessionId}`);
            sendJson(res, 200, { ok: true, sessionId, ...(isRecord(created) ? created : {}) });
        }),
    });
    webServer.register({
        kind: 'prefix',
        path: `${PUBLIC_PREFIX}/sessions`,
        handler: guarded(async (req, res, device, body) => {
            const rest = pathAfter(req.url, `${PUBLIC_PREFIX}/sessions`);
            const parts = rest.split('/').filter((part) => part !== '');
            const sessionId = decodeURIComponent(parts[0] ?? '');
            const action = parts[1] ?? '';
            if (sessionId === '') {
                sendJson(res, 200, { ok: false, code: 'E_BAD_REQUEST', message: '缺少会话 id' });
                return;
            }
            const needs = action === 'history' || action === 'files' || action === 'fsticket' ? 'read' : 'prompt';
            const check = requireScope(device, needs);
            if (!check.ok) {
                sendJson(res, 200, { ok: false, code: check.code, message: check.message });
                return;
            }
            if (action === 'history') {
                const params = new URLSearchParams(String(req.url ?? '').split('?')[1] ?? '');
                const maxMessages = Number(params.get('maxMessages') ?? 80);
                const beforeSeq = params.get('beforeSeq');
                // The engine pages its own log through `session.page`; records are
                // {event, view?} entries, the same shape a phone renders.
                const base = {
                    address: { kind: 'session', sessionId },
                    maxMessages: Number.isFinite(maxMessages) ? maxMessages : 80,
                };
                if (beforeSeq !== null && beforeSeq !== '')
                    base.beforeSeq = Number(beforeSeq);
                const page = (await readPage(sessionId, base));
                const records = isRecord(page) && Array.isArray(page.records) ? page.records : [];
                sendJson(res, 200, { ok: true, items: records, hasMore: isRecord(page) ? page.hasMore === true : false });
                return;
            }
            if (action === 'files') {
                // 生成的文件按会话归属：只有这个会话的回合时间窗里改动过的顶层文件才算。
                // 历史会话先按它自己的历史窗回填一次；运行中的回合现场合并。
                const cwd = await sessionCwdOf(sessionId);
                if (cwd === '') {
                    sendJson(res, 200, { ok: true, cwd: '', items: [] });
                    return;
                }
                try {
                    await backfillSession(sessionId, cwd);
                }
                catch {
                    // 回填失败不阻塞列表（最多暂时少几个文件）
                }
                const live = liveTurns.get(sessionId);
                if (live !== undefined) {
                    try {
                        rememberWindow(sessionId, cwd, live, Date.now());
                    }
                    catch {
                        // 同上
                    }
                }
                const rec = loadFileState().sessions[sessionId];
                const items = [];
                for (const name of Object.keys(rec?.entries ?? {})) {
                    try {
                        const stat = statSync(join(cwd, name));
                        if (!stat.isFile())
                            continue;
                        items.push({ path: name, name, size: stat.size, mtime: stat.mtimeMs });
                    }
                    catch {
                        // 文件已删除：不展示，也不清账（可能只是暂时挪走）
                    }
                }
                items.sort((a, b) => b.mtime - a.mtime);
                sendJson(res, 200, { ok: true, cwd, items: items.slice(0, 40) });
                return;
            }
            if (action === 'fsticket') {
                // WebView 的子资源请求带不了 Authorization 头，给文件 URL 发一张短票据
                // （首次响应再把它写成 cookie，vendor/three.min.js 这类相对请求也能带上）。
                const ticket = randomUUID().replace(/-/g, '');
                fileTickets.set(ticket, { sessionId, expires: Date.now() + FILE_TICKET_MS });
                sendJson(res, 200, {
                    ok: true,
                    ticket,
                    prefix: `${FS_PREFIX}/${encodeURIComponent(sessionId)}`,
                    expiresIn: Math.round(FILE_TICKET_MS / 1000),
                });
                return;
            }
            if (action === 'prompt') {
                // The phone sends the human shape ({text, mode}); the engine wants
                // `content: [{type:'text', text}]`, so the translation lives here rather
                // than in a phone that would have to know engine vocabulary.
                const extra = isRecord(body.payload) ? body.payload : {};
                const text = typeof body.text === 'string' ? body.text : typeof extra.text === 'string' ? extra.text : '';
                const mode = body.mode === 'steer' || extra.mode === 'steer' ? 'steer' : 'queue';
                if (text.trim() === '') {
                    sendJson(res, 200, { ok: false, code: 'E_BAD_REQUEST', message: '消息内容为空' });
                    return;
                }
                // 客户端提供的 requestId 优先：同一条消息的网络重试 / 草稿恢复复用同一 id，
                // 桥接按 (设备, requestId) 去重，避免一次消息被下发两次；老客户端没带就现生成。
                const clientId = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : '');
                const requestId = clientId(body.requestId) !== '' ? clientId(body.requestId) : clientId(extra.requestId);
                const dispatch = async () => {
                    const payload = {
                        sessionId,
                        mode,
                        content: [{ type: 'text', text }],
                        requestId: requestId !== '' ? requestId : randomUUID(),
                        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    };
                    return await callEngine(ctx, 'session.prompt', payload);
                };
                try {
                    const outcome = await acceptPrompt(device, requestId, sessionId, mode, text, dispatch);
                    if (outcome.reused) {
                        log(`prompt 去重命中：${sessionId}（${requestId.slice(0, 8)}…）`);
                        sendJson(res, 200, { ok: true, accepted: true, deduplicated: true, ...(outcome.pending === true ? { pending: true } : {}) });
                        return;
                    }
                    log(`已发送消息到 ${sessionId}（${mode}，${text.length} 字）`);
                    sendJson(res, 200, { ok: true, ...(isRecord(outcome.result) ? outcome.result : {}) });
                    return;
                }
                catch (error) {
                    if (isRecord(error) && error.code === 'E_ID_REUSE') {
                        sendJson(res, 200, { ok: false, code: 'E_ID_REUSE', message: '这次重试与第一次发送的内容不一致，请作为新消息发送' });
                        return;
                    }
                    throw error;
                }
            }
            if (action === 'cancel') {
                await callEngine(ctx, 'session.cancel', { sessionId, ...(body.payload ?? {}) });
                log(`已请求停止：${sessionId}`);
                sendJson(res, 200, { ok: true });
                return;
            }
            if (action === 'model') {
                // `session.selectModel` takes the selection flattened, not nested.
                const selection = isRecord(body.selection) ? body.selection : {};
                const provider = String(selection.provider ?? '');
                const model = String(selection.model ?? '');
                if (provider === '' || model === '') {
                    sendJson(res, 200, { ok: false, code: 'E_BAD_REQUEST', message: '缺少 provider 或 model' });
                    return;
                }
                const selected = await callEngine(ctx, 'session.selectModel', {
                    sessionId,
                    provider,
                    model,
                    ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}),
                });
                log(`切换模型：${sessionId} → ${provider}/${model}`);
                sendJson(res, 200, { ok: true, ...(isRecord(selected) ? selected : {}) });
                return;
            }
            if (action === 'rename') {
                const result = (await callEngine(ctx, 'session.rename', { sessionId, title: String(body.title ?? '') }));
                sendJson(res, 200, { ok: true, ...(isRecord(result) ? result : {}) });
                return;
            }
            sendJson(res, 200, { ok: false, code: 'E_BAD_REQUEST', message: `不认识的会话动作：${action}` });
        }, true),
    });
    // ------------------------------------------- 模型网络路由（每个提供商 直连/代理）
    // 引擎出站代理在进程启动时由桌面壳按这里的配置合成环境变量（dsh-http-proxy
    // 只认启动环境），所以改动后需要重启电脑端生效；App/设置页会引导「立即重启」。
    webServer.register({
        kind: 'exact',
        path: `${PUBLIC_PREFIX}/network`,
        handler: guarded(async (req, res, device, body) => {
            if (req.method === 'GET') {
                const check = requireScope(device, 'read');
                if (!check.ok) {
                    sendJson(res, 200, { ok: false, code: check.code, message: check.message });
                    return;
                }
                sendJson(res, 200, { ok: true, network: await networkSnapshot() });
                return;
            }
            const check = requireScope(device, 'config');
            if (!check.ok) {
                sendJson(res, 200, { ok: false, code: check.code, message: check.message });
                return;
            }
            const provider = String(body.provider ?? '').trim();
            if (provider === '') {
                sendJson(res, 200, { ok: false, code: 'E_BAD_REQUEST', message: '缺少 provider' });
                return;
            }
            const raw = body.route;
            const route = raw === 'direct' || raw === 'proxy' ? raw : null;
            const store = load();
            const network = { ...networkOf(store) };
            const routes = { ...(network.routes ?? {}) };
            if (route === null)
                delete routes[provider];
            else
                routes[provider] = route;
            network.routes = routes;
            network.revision = (network.revision ?? 0) + 1;
            store.network = network;
            save(store);
            const snapshot = await networkSnapshot();
            log(`网络路由：${provider} → ${route ?? '自动（代理）'}（重启电脑端后生效）`);
            sendJson(res, 200, { ok: true, network: snapshot, restartRequired: true });
        }, true),
    });
    webServer.register({
        kind: 'exact',
        path: `${PUBLIC_PREFIX}/network/restart`,
        handler: guarded(async (_req, res, device) => {
            const check = requireScope(device, 'config');
            if (!check.ok) {
                sendJson(res, 200, { ok: false, code: check.code, message: check.message });
                return;
            }
            const store = load();
            const network = { ...networkOf(store) };
            network.restartRequestedAt = Date.now();
            store.network = network;
            save(store);
            log('收到重启请求：桌面壳将在数秒内重启引擎（应用新的网络路由）');
            sendJson(res, 200, { ok: true, restartRequestedAt: network.restartRequestedAt });
        }),
    });
    webServer.register({
        kind: 'exact',
        path: `${PUBLIC_PREFIX}/models`,
        handler: guarded(async (req, res, device, body) => {
            if (req.method === 'GET') {
                const check = requireScope(device, 'read');
                if (!check.ok) {
                    sendJson(res, 200, { ok: false, code: check.code, message: check.message });
                    return;
                }
                const store = load();
                sendJson(res, 200, { ok: true, doc: await buildModelDoc(store) });
                return;
            }
            const check = requireScope(device, 'config');
            if (!check.ok) {
                sendJson(res, 200, { ok: false, code: check.code, message: check.message });
                return;
            }
            const store = load();
            const current = await buildModelDoc(store);
            const baseRevision = Number(body.baseRevision ?? -1);
            const overlayRevision = Number(body.overlayRevision ?? -1);
            const incoming = Array.isArray(body.items) ? body.items : [];
            // A phone that failed to load a document must not be able to erase every
            // provider by submitting an empty list — that is a wipe dressed as a save.
            // Deleting everything stays possible, but it has to be asked for.
            if (incoming.length === 0 && current.items.length > 0 && body.allowEmpty !== true) {
                log(`拒绝空文档提交（当前 ${current.items.length} 个模型）`);
                sendJson(res, 200, {
                    ok: false,
                    code: 'E_EMPTY_DOC',
                    message: `拒绝保存空列表：电脑端现在有 ${current.items.length} 个模型。请先重新读取，或显式传 allowEmpty 表示确实要清空。`,
                    doc: current,
                });
                return;
            }
            const wanted = { ...current, items: incoming };
            const force = body.force === true;
            if (!force && (baseRevision !== current.revision || overlayRevision !== current.overlayRevision)) {
                const merged = mergeDocs((body.base ?? incoming), current.items, incoming);
                if (!merged.merged) {
                    log(`模型配置冲突：${merged.conflicts.length} 处被两端同时修改`);
                    sendJson(res, 200, {
                        ok: false,
                        code: 'E_REVISION',
                        message: `电脑端也改过配置（引擎修订 ${current.revision}），有 ${merged.conflicts.length} 处冲突需要你选`,
                        conflicts: merged.conflicts,
                        incoming: merged.incoming,
                        doc: current,
                    });
                    return;
                }
                // 带 `base`（新客户端）→ 三方合并：只把手机**明确改过**的部分并入桌面当前
                // 文档，桌面侧的新增/改动一律保留（旧实现整表覆盖会在手机快照过期时静默丢
                // 掉桌面新增的模型——2026-09-24 实测过的数据丢失，别再退回去）。
                // 不带 `base`（老客户端）→ 维持原语义（手机列表整表为准），升级后自动享受合并。
                if (Array.isArray(body.base)) {
                    wanted.items = mergePhoneEditsOnto(current.items, body.base, incoming);
                    const kept = wanted.items.length - incoming.length;
                    if (kept > 0)
                        log(`模型配置保存（三方合并）：保住桌面侧 ${kept} 个手机未见的模型`);
                }
                else {
                    wanted.items = incoming;
                }
            }
            const ops = engineOps(current, wanted);
            if (ops.length > 0) {
                snapshotSettings();
                await callEngine(ctx, 'settings.mutate', { ns: MODEL_NS, ops, expectedRevision: current.revision });
            }
            const overlay = overlayFor(wanted, overlayOf(store));
            store.models = overlay;
            save(store);
            log(`模型配置已保存：${ops.length} 项引擎改动，overlay 修订 ${overlay.revision}`);
            publish({ kind: 'notify', level: 'info', title: '模型配置已更新', body: `${ops.length} 项改动` });
            sendJson(res, 200, { ok: true, doc: await buildModelDoc(load()) });
            // 手机端的这次保存可能带进全新模型：让能力补齐（上下文/视觉/思考档位）自己跟上
            // ——不论手机走后端哪个入口（App / PWA），都在这里统一兜住。
            scheduleVisionSync();
        }, true),
    });
    // ------------------------------------------------- 写前快照（settings.yaml 保险绳）
    // settings.yaml 是模型配置的唯一真源：任何一次保存前先留一份，写挂了能人工回滚。
    // 只保留最近 30 份，失败绝不影响保存本身。
    const snapshotSettings = () => {
        try {
            const source = join(dirname(storePath()), 'settings.yaml');
            if (!existsSync(source))
                return;
            const dir = join(dirname(source), 'backups');
            mkdirSync(dir, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            writeFileSync(join(dir, `settings-${stamp}.yaml`), readFileSync(source));
            const files = readdirSync(dir)
                .filter((name) => name.startsWith('settings-') && name.endsWith('.yaml'))
                .sort();
            for (const old of files.slice(0, Math.max(0, files.length - 30))) {
                try {
                    unlinkSync(join(dir, old));
                }
                catch {
                    /* 裁剪失败无所谓 */
                }
            }
        }
        catch (error) {
            log(`settings 快照失败：${error instanceof Error ? error.message : String(error)}`);
        }
    };
    // ------------------------------------------------- 模型能力同步（model-vision）
    // model-vision 只会每日刷新能力目录、从不主动写回各 route（桌面端要用户点
    // 「同步」才 apply）；手机加完提供商/模型后这里替它立刻触发一次。失败只记日志，
    // 绝不影响保存本身；任何调用方（App 的手动按钮 / 自动触发）共用这一个实现。
    let visionSyncTimer;
    const runVisionSync = () => new Promise((resolve) => {
        const payload = JSON.stringify({ refresh: false });
        let settled = false;
        const finish = (result) => {
            if (!settled) {
                settled = true;
                resolve(result);
            }
        };
        let outbound;
        try {
            outbound = httpRequest({
                host: '127.0.0.1',
                port: localPort,
                path: '/dsh-model-vision/sync',
                method: 'POST',
                headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
            }, (reply) => {
                let raw = '';
                reply.setEncoding('utf8');
                reply.on('data', (chunk) => {
                    raw += chunk;
                });
                reply.on('end', () => {
                    try {
                        const parsed = JSON.parse(raw);
                        const rows = Array.isArray(parsed.results) ? parsed.results : [];
                        const applied = rows.reduce((sum, row) => sum + (typeof row.applied === 'number' ? row.applied : 0), 0);
                        finish({ ok: true, applied, routes: rows.length, message: `补全 ${applied} 项能力（${rows.length} 条路由）` });
                    }
                    catch {
                        finish({ ok: false, applied: 0, routes: 0, message: '同步响应无法解析' });
                    }
                });
            });
        }
        catch (error) {
            finish({ ok: false, applied: 0, routes: 0, message: error instanceof Error ? error.message : String(error) });
            return;
        }
        outbound.on('error', (error) => finish({ ok: false, applied: 0, routes: 0, message: error.message }));
        outbound.setTimeout(90_000, () => {
            outbound.destroy();
            finish({ ok: false, applied: 0, routes: 0, message: '同步超时' });
        });
        outbound.end(payload);
    });
    /** 最后一次保存后 1.2 秒内没有新保存，才真正同步一次（防抖，连点开关不会连环触发）。 */
    const scheduleVisionSync = () => {
        if (visionSyncTimer !== undefined)
            clearTimeout(visionSyncTimer);
        visionSyncTimer = setTimeout(() => {
            visionSyncTimer = undefined;
            void runVisionSync().then((report) => {
                log(`模型能力自动同步：${report.ok ? report.message : `失败（${report.message}）`}`);
            });
        }, 1200);
    };
    webServer.register({
        kind: 'exact',
        path: `${PUBLIC_PREFIX}/models/sync`,
        handler: guarded(async (_req, res, device) => {
            const check = requireScope(device, 'config');
            if (!check.ok) {
                sendJson(res, 200, { ok: false, code: check.code, message: check.message });
                return;
            }
            // 手动请求就不必再等防抖：撤掉排队的自动同步，当场同步一次并回报结果。
            if (visionSyncTimer !== undefined) {
                clearTimeout(visionSyncTimer);
                visionSyncTimer = undefined;
            }
            const report = await runVisionSync();
            if (!report.ok)
                log(`模型能力手动同步失败：${report.message}`);
            sendJson(res, 200, {
                ok: report.ok,
                applied: report.applied,
                routes: report.routes,
                message: report.ok ? `已同步：${report.message}` : `同步失败：${report.message}`,
            });
        }, true),
    });
    // ------------------------------------------------- 从上游拉取模型清单
    // 手机端自己拉不了：key 只存在电脑端凭据库。这里 resolve 出密钥，
    // 请求上游 OpenAI 兼容的 GET {baseURL}/models，把模型 id 列表回给手机。
    const extractUpstreamModels = (data) => {
        const names = [];
        const pushOne = (entry) => {
            if (typeof entry === 'string') {
                if (entry.trim() !== '')
                    names.push(entry.trim());
                return;
            }
            if (isRecord(entry)) {
                const id = entry.id ?? entry.model ?? entry.name ?? entry.slug;
                if (typeof id === 'string' && id.trim() !== '')
                    names.push(id.trim());
            }
        };
        if (Array.isArray(data))
            for (const entry of data)
                pushOne(entry);
        else if (isRecord(data)) {
            const lists = [data.data, data.models, data.result, data.items];
            for (const list of lists) {
                if (Array.isArray(list)) {
                    for (const entry of list)
                        pushOne(entry);
                }
                else if (isRecord(list)) {
                    for (const key of ['models', 'data', 'items']) {
                        const inner = list[key];
                        if (Array.isArray(inner))
                            for (const entry of inner)
                                pushOne(entry);
                    }
                }
            }
        }
        return [...new Set(names)].sort((a, b) => a.localeCompare(b));
    };
    const pullUpstreamList = async (providerId) => {
        const view = await modelNamespace();
        const value = isRecord(view?.value) ? view?.value : {};
        const providers = isRecord(value.providers) ? value.providers : {};
        const raw = providers[providerId];
        if (!isRecord(raw))
            return { ok: false, code: 'E_NOT_FOUND', message: `电脑端的配置里没有提供商 ${providerId}` };
        const baseURL = typeof raw.baseURL === 'string' ? raw.baseURL.trim() : '';
        if (baseURL === '')
            return { ok: false, code: 'E_NO_URL', message: '这家提供商没有接口地址，无法从上游拉取' };
        const ref = typeof raw.apiKeyEnv === 'string' ? raw.apiKeyEnv.trim() : '';
        let key = '';
        let keySource = 'none';
        if (ref !== '') {
            const resolved = await credentials?.resolve?.(ref);
            key = typeof resolved?.value === 'string' ? resolved.value : '';
            keySource = typeof resolved?.source === 'string' ? resolved.source : key === '' ? 'none' : 'unknown';
            if (key === '') {
                return { ok: false, code: 'E_NO_KEY', message: `凭据 ${ref} 还没配置（或值为空），先写入密钥再同步` };
            }
        }
        let target;
        try {
            target = new URL(baseURL.replace(/\/+$/, '') + '/models');
        }
        catch {
            return { ok: false, code: 'E_BAD_URL', message: `接口地址无法解析：${baseURL}` };
        }
        const lib = target.protocol === 'http:' ? httpRequest : httpsRequest;
        const outcome = await new Promise((finish) => {
            let settled = false;
            const done = (result) => {
                if (!settled) {
                    settled = true;
                    finish(result);
                }
            };
            let outbound;
            try {
                outbound = lib({
                    host: target.hostname,
                    port: target.port !== '' ? Number(target.port) : target.protocol === 'http:' ? 80 : 443,
                    path: target.pathname + target.search,
                    method: 'GET',
                    headers: {
                        accept: 'application/json',
                        ...(key !== '' ? { authorization: `Bearer ${key}` } : {}),
                        'user-agent': 'dsh-mobile-bridge',
                    },
                }, (reply) => {
                    let raw = '';
                    reply.setEncoding('utf8');
                    reply.on('data', (chunk) => {
                        raw += chunk;
                    });
                    reply.on('end', () => done({ status: reply.statusCode ?? 0, body: raw }));
                });
            }
            catch (error) {
                done({ error: error instanceof Error ? error.message : String(error) });
                return;
            }
            outbound.on('error', (error) => done({ error: error.message }));
            outbound.setTimeout(30_000, () => {
                outbound.destroy();
                done({ error: '请求上游超时（30 秒）' });
            });
            outbound.end();
        });
        if ('error' in outcome) {
            return { ok: false, code: 'E_UPSTREAM', message: `请求上游失败：${outcome.error}` };
        }
        if (outcome.status < 200 || outcome.status >= 300) {
            const slice = outcome.body.replace(/\s+/g, ' ').slice(0, 200);
            return { ok: false, code: 'E_UPSTREAM', message: `上游返回 ${outcome.status}：${slice}` };
        }
        let parsed;
        try {
            parsed = JSON.parse(outcome.body);
        }
        catch {
            return { ok: false, code: 'E_UPSTREAM', message: '上游返回的不是 JSON（可能不是 OpenAI 兼容接口）' };
        }
        const models = extractUpstreamModels(parsed);
        if (models.length === 0)
            return { ok: false, code: 'E_EMPTY', message: '上游返回了空列表' };
        return { ok: true, models, keySource };
    };
    webServer.register({
        kind: 'exact',
        path: `${PUBLIC_PREFIX}/models/pull`,
        handler: guarded(async (_req, res, device, body) => {
            const check = requireScope(device, 'config');
            if (!check.ok) {
                sendJson(res, 200, { ok: false, code: check.code, message: check.message });
                return;
            }
            const providerId = String(body.provider ?? '').trim();
            if (providerId === '') {
                sendJson(res, 200, { ok: false, code: 'E_BAD_REQUEST', message: '缺少 provider 参数' });
                return;
            }
            const result = await pullUpstreamList(providerId);
            if (!result.ok) {
                log(`从上游拉取模型失败：${providerId} → ${result.message}`);
                sendJson(res, 200, { ok: false, code: result.code, message: result.message });
                return;
            }
            log(`从上游拉取模型：${providerId} → ${result.models.length} 个（key 来源 ${result.keySource}）`);
            sendJson(res, 200, {
                ok: true,
                provider: providerId,
                count: result.models.length,
                models: result.models,
                keySource: result.keySource,
            });
        }, true),
    });
    webServer.register({
        kind: 'exact',
        path: `${PUBLIC_PREFIX}/credentials`,
        handler: guarded(async (req, res, device, body) => {
            const check = requireScope(device, 'config');
            if (!check.ok) {
                sendJson(res, 200, { ok: false, code: check.code, message: check.message });
                return;
            }
            if (credentials === undefined) {
                sendJson(res, 200, { ok: false, code: 'E_BRIDGE', message: '这个引擎没有凭据服务' });
                return;
            }
            const ref = String(body.ref ?? '').trim();
            if (!/^[A-Z][A-Z0-9_]*$/.test(ref)) {
                sendJson(res, 200, { ok: false, code: 'E_BAD_REQUEST', message: '凭据名必须是 A-Z0-9_ 组成' });
                return;
            }
            const value = typeof body.value === 'string' ? body.value : '';
            if (value === '')
                await credentials.unset(ref);
            else
                await credentials.set(ref, value);
            // The value is never echoed back; only whether one now resolves.
            const described = await credentials.describe(ref);
            log(`凭据 ${ref} ${value === '' ? '已清除' : '已更新'}（值不回显）`);
            sendJson(res, 200, { ok: true, ref, configured: described?.configured === true });
        }, true),
    });
    webServer.register({
        kind: 'exact',
        path: `${PUBLIC_PREFIX}/devices`,
        handler: guarded(async (req, res, device) => {
            const check = requireScope(device, 'admin');
            if (!check.ok) {
                sendJson(res, 200, { ok: false, code: check.code, message: check.message });
                return;
            }
            if (req.method === 'GET') {
                sendJson(res, 200, { ok: true, devices: load().devices.map(deviceView), self: device.id });
                return;
            }
            sendJson(res, 200, { ok: false, code: 'E_BAD_REQUEST', message: '用 DELETE /mobile/devices/:id 解除绑定' });
        }),
    });
    webServer.register({
        kind: 'prefix',
        path: `${PUBLIC_PREFIX}/devices`,
        handler: guarded(async (req, res, device) => {
            const check = requireScope(device, 'admin');
            if (!check.ok) {
                sendJson(res, 200, { ok: false, code: check.code, message: check.message });
                return;
            }
            const target = decodeURIComponent(pathAfter(req.url, `${PUBLIC_PREFIX}/devices`).replace(/^\//, '').split('?')[0] ?? '');
            const store = load();
            const before = store.devices.length;
            store.devices = store.devices.filter((entry) => entry.id !== target);
            save(store);
            const removed = before !== store.devices.length;
            log(`设备解除绑定：${target}${removed ? '' : '（未找到）'}`);
            sendJson(res, 200, { ok: removed, devices: store.devices.map(deviceView), message: removed ? '已解除绑定' : '没有这台设备' });
        }),
    });
    // Generic passthrough: the phone can call any method the scope table allows,
    // which is how features arrive before a wrapper exists for them.
    webServer.register({
        kind: 'exact',
        path: `${PUBLIC_PREFIX}/approvals`,
        handler: guarded(async (_req, res, device) => {
            const check = requireScope(device, 'read');
            if (!check.ok) {
                sendJson(res, 200, { ok: false, code: check.code, message: check.message });
                return;
            }
            // 回填保证「运行中的待审批」不因桥接重启丢失；读不全就如实标 complete:false，
            // 客户端据此显示「状态待核实」，不把未知当空集（N2 §4.1）。
            const complete = await backfillApprovals();
            const state = loadApprovals();
            const pending = Object.values(state.pending).sort((a, b) => a.openedAt - b.openedAt);
            // sendJson 统一带 cache-control: no-store（N2 §4.3 要求）
            sendJson(res, 200, { ok: true, complete, pending, recent: state.recent.slice(0, 20), serverTime: Date.now() });
        }),
    });
    webServer.register({
        kind: 'exact',
        path: `${PUBLIC_PREFIX}/rpc`,
        handler: guarded(async (req, res, device, body) => {
            const method = String(body.method ?? '');
            if (method === '') {
                sendJson(res, 200, { ok: false, code: 'E_BAD_REQUEST', message: '缺少 method' });
                return;
            }
            if (!scopeAllows(device.scopes, method)) {
                log(`拒绝越权调用：${method}（设备权限 ${device.scopes.join('/')}）`);
                sendJson(res, 200, { ok: false, code: 'E_FORBIDDEN', message: `这台设备不能调用 ${method}` });
                return;
            }
            const payload = body.payload ?? {};
            if (method === 'session.prompt' && isRecord(payload)) {
                const requestId = typeof payload.requestId === 'string' && payload.requestId.trim() !== '' ? payload.requestId.trim() : '';
                if (requestId !== '') {
                    const sid = typeof payload.sessionId === 'string' ? payload.sessionId : '';
                    const mode = typeof payload.mode === 'string' ? payload.mode : '';
                    try {
                        const outcome = await acceptPrompt(device, requestId, sid, mode, JSON.stringify(payload.content ?? ''), async () => await callEngine(ctx, method, payload));
                        if (outcome.reused) {
                            log(`prompt 去重命中（rpc）：${sid}（${requestId.slice(0, 8)}…）`);
                            sendJson(res, 200, { ok: true, value: { accepted: true, deduplicated: true, ...(outcome.pending === true ? { pending: true } : {}) } });
                            return;
                        }
                        sendJson(res, 200, { ok: true, value: outcome.result });
                        return;
                    }
                    catch (error) {
                        if (isRecord(error) && error.code === 'E_ID_REUSE') {
                            sendJson(res, 200, { ok: false, code: 'E_ID_REUSE', message: '这次重试与第一次发送的内容不一致，请作为新消息发送' });
                            return;
                        }
                        throw error;
                    }
                }
            }
            const value = await callEngine(ctx, method, payload);
            sendJson(res, 200, { ok: true, value });
        }, true),
    });
    // ------------------------------------------------------------------ app files
    const MIME = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.webmanifest': 'application/manifest+json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon',
    };
    // -------------------------------------------------------------- session files
    // 手机看电脑端生成的文件：会话工作目录为根，`files` 列顶层、`fs` 取单个文件。
    // 票据（?t= + cookie）是为了 WebView —— HTML 页的相对子资源请求（vendor/x.js）
    // 带不了 Authorization 头，必须另有一条不需要请求头的授权路径。
    const FS_PREFIX = `${PUBLIC_PREFIX}/fs`;
    const FILE_TICKET_MS = 30 * 60 * 1000;
    const FS_MAX_BYTES = 128 * 1024 * 1024;
    const fileTickets = new Map();
    const FILE_MIME = {
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
    };
    const sessionCwdOf = async (sessionId) => {
        const listed = (await callEngine(ctx, 'session.list', {}));
        const items = isRecord(listed) && Array.isArray(listed.items) ? listed.items : [];
        for (const item of items) {
            if (isRecord(item) && sessionIdOf(item) === sessionId && typeof item.cwd === 'string' && item.cwd.trim() !== '') {
                return item.cwd.trim();
            }
        }
        return '';
    };
    /** 把相对路径锁进会话工作目录；越界（..、绝对路径、symlink 外逃）一律拒绝。 */
    const resolveInCwd = (cwd, rel) => {
        if (rel === '' || rel.includes('\0') || rel.startsWith('/') || rel.startsWith('\\') || /^[A-Za-z]:/.test(rel))
            return '';
        const full = resolve(cwd, rel);
        let root = cwd;
        try {
            root = realpathSync(cwd);
        }
        catch {
            // 目录缺失时保持原样，由后面的 existsSync 处理成 404
        }
        let real = full;
        try {
            real = realpathSync(full);
        }
        catch {
            // 目标不存在或是坏链接：用未解析路径做前缀比较
        }
        const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
        return real === root || real.startsWith(prefix) ? real : '';
    };
    const ticketFrom = (req) => {
        const url = new URL(String(req.url ?? ''), 'http://localhost');
        const fromQuery = url.searchParams.get('t') ?? '';
        if (fromQuery !== '')
            return fromQuery;
        const cookie = req.headers['cookie'];
        const raw = Array.isArray(cookie) ? cookie.join('; ') : String(cookie ?? '');
        for (const part of raw.split(';')) {
            const index = part.indexOf('=');
            if (index > 0 && part.slice(0, index).trim() === 'dsht')
                return part.slice(index + 1).trim();
        }
        return '';
    };
    webServer.register({
        kind: 'prefix',
        path: FS_PREFIX,
        handler: (req, res) => {
            void (async () => {
                const rest = pathAfter(req.url, FS_PREFIX);
                const parts = rest.split('/').filter((part) => part !== '');
                const sessionId = decodeURIComponent(parts[0] ?? '');
                const rel = parts.slice(1).map((part) => decodeURIComponent(part)).join('/');
                if (sessionId === '' || rel === '') {
                    sendJson(res, 404, { ok: false, code: 'E_NOT_FOUND', message: '文件路径不完整' });
                    return;
                }
                const ticket = ticketFrom(req);
                let allowed = false;
                if (ticket !== '') {
                    const record = fileTickets.get(ticket);
                    if (record !== undefined && record.expires > Date.now() && record.sessionId === sessionId)
                        allowed = true;
                }
                if (!allowed) {
                    const auth = authenticate(req);
                    if (!('error' in auth) && holdsScope(auth.device, 'read'))
                        allowed = true;
                }
                if (!allowed) {
                    sendJson(res, 401, { ok: false, code: 'E_UNAUTHORIZED', message: '文件访问未授权（票据无效或已过期）' });
                    return;
                }
                const cwd = await sessionCwdOf(sessionId);
                if (cwd === '') {
                    sendJson(res, 404, { ok: false, code: 'E_NOT_FOUND', message: '找不到会话的工作目录' });
                    return;
                }
                const file = resolveInCwd(cwd, rel);
                if (file === '' || !existsSync(file)) {
                    sendJson(res, 404, { ok: false, code: 'E_NOT_FOUND', message: '文件不存在' });
                    return;
                }
                try {
                    const stat = statSync(file);
                    if (!stat.isFile()) {
                        sendJson(res, 404, { ok: false, code: 'E_NOT_FOUND', message: '目标不是文件' });
                        return;
                    }
                    if (stat.size > FS_MAX_BYTES) {
                        sendJson(res, 413, { ok: false, code: 'E_TOO_LARGE', message: '文件超过 128 MB，请到电脑端打开' });
                        return;
                    }
                    // ETag/Last-Modified + 304：预览（尤其 WebView 的 HTML 子资源）重开时
                    // 只做一次廉价校验，不再整包重传 —— 经中继时这就是「打开很卡」的大头。
                    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
                    const inmRaw = req.headers['if-none-match'];
                    const inm = Array.isArray(inmRaw) ? inmRaw.join(', ') : String(inmRaw ?? '');
                    const imsRaw = req.headers['if-modified-since'];
                    const ims = Array.isArray(imsRaw) ? String(imsRaw[0] ?? '') : String(imsRaw ?? '');
                    const imsTime = ims === '' ? Number.NaN : Date.parse(ims);
                    const notModified = inm.split(',').some((tag) => tag.trim() === etag) || (!Number.isNaN(imsTime) && imsTime >= Math.floor(stat.mtimeMs));
                    if (notModified) {
                        res.writeHead(304, { etag, 'cache-control': 'private, no-cache' });
                        res.end();
                        return;
                    }
                    const headers = {
                        'content-type': FILE_MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
                        'cache-control': 'private, no-cache',
                        etag,
                        'last-modified': new Date(Math.floor(stat.mtimeMs)).toUTCString(),
                        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(basename(file))}`,
                        'x-content-type-options': 'nosniff',
                    };
                    if (ticket !== '')
                        headers['set-cookie'] = `dsht=${ticket}; Path=/; Max-Age=1800; HttpOnly; SameSite=Lax`;
                    res.writeHead(200, headers);
                    res.end(readFileSync(file));
                }
                catch (error) {
                    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
                    res.end(String(error));
                }
            })();
        },
    });
    webServer.register({
        kind: 'prefix',
        path: PUBLIC_PREFIX,
        handler: (req, res) => {
            let rel = pathAfter(req.url, PUBLIC_PREFIX);
            // API paths never fall through to static serving.
            if (/^\/(pair|meta|sessions|models|credentials|devices|rpc|events|fs)/.test(rel)) {
                sendJson(res, 404, { ok: false, code: 'E_NOT_FOUND', message: `没有这个接口：${rel}` });
                return;
            }
            if (rel === '' || rel === '/')
                rel = '/index.html';
            const file = join(APP_DIR, normalize(rel).replace(/^([/\\])+/, ''));
            if (!file.startsWith(APP_DIR) || !existsSync(file)) {
                res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('not found');
                return;
            }
            try {
                const body = readFileSync(file);
                res.writeHead(200, {
                    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
                    'cache-control': 'no-cache',
                });
                res.end(body);
            }
            catch (error) {
                res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
                res.end(String(error));
            }
        },
    });
    // ------------------------------------------------------------------- upgrade
    const registerUpgrade = webServer.registerUpgrade;
    if (typeof registerUpgrade === 'function') {
        registerUpgrade.call(webServer, {
            kind: 'exact',
            path: `${PUBLIC_PREFIX}/events`,
            handler: (req, socket, head) => {
                const auth = authenticate(req);
                if ('error' in auth) {
                    ;
                    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
                    return;
                }
                if (!scopeAllows(auth.device.scopes, 'session.list')) {
                    ;
                    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
                    return;
                }
                const connection = acceptUpgrade(req, socket, head, {
                    onMessage: (client, text) => {
                        try {
                            const parsed = JSON.parse(text);
                            if (parsed.type === 'hello') {
                                const state = clients.get(client);
                                const oldest = frames.length > 0 ? frames[0].seq : undefined;
                                const info = normalizeSince(Number(parsed.since ?? 0), seq, oldest);
                                if (state !== undefined)
                                    state.since = info.since;
                                const backlog = frames.filter((frame) => frame.seq > info.since);
                                client.send(JSON.stringify({ kind: 'hello', seq, time: Date.now(), data: { server: { bridge: 'dsh-mobile-bridge', version: 1, epoch }, replay: backlog.length, gap: info.gap } }));
                                for (const frame of backlog)
                                    client.send(JSON.stringify(frame));
                                return;
                            }
                            if (parsed.type === 'ping')
                                client.send(JSON.stringify({ kind: 'notify', seq, time: Date.now(), level: 'debug', title: 'pong' }));
                        }
                        catch {
                            // ignore malformed client frames
                        }
                    },
                    onClose: (client) => clients.delete(client),
                });
                if (connection !== undefined) {
                    clients.set(connection, { deviceId: auth.device.id, since: 0 });
                    connection.send(JSON.stringify({ kind: 'hello', seq, time: Date.now(), data: { server: { bridge: 'dsh-mobile-bridge', version: 1, epoch }, replay: 0, gap: false } }));
                    log(`设备已连接事件流：${auth.device.name}（当前 ${clients.size} 条连接）`);
                }
            },
        });
    }
    else {
        log('这个引擎的 webServer 不支持 registerUpgrade，事件流不可用（其余接口正常）');
    }
    // First run: make a pairing code so the page opens on something usable.
    const initial = load();
    if (initial.devices.length === 0 && initial.pairing === undefined) {
        issuePairing(initial);
        save(initial);
        log(`首次启动：已生成配对码，打开 http://127.0.0.1:<端口>${LOCAL_PREFIX}/ 查看`);
    }
    log(`已就绪：${initial.devices.length} 台设备已绑定 · 公开前缀 ${PUBLIC_PREFIX} · 本机配对页 ${LOCAL_PREFIX}/ · 存储 ${storePath()}`);
    log(`手机端静态资源目录：${APP_DIR}（${existsSync(join(APP_DIR, 'index.html')) ? '已找到 index.html' : '缺少 index.html，静态页面不可用'}）`);
    const effectiveUrl = publicUrl();
    log(`手机端地址：${effectiveUrl === '' ? '（未配置 publicUrl，手机可先用局域网地址）' : effectiveUrl}${PUBLIC_PREFIX}/`);
    // -------------------------------------------------------------- 远程中继
    // 桌面端主动拨出到中继（国内直连优先、Cloudflare 兜底），手机在任意网络都能回来。
    // key/secret 存桥接自己的 store，且每进程只生成一次 —— 生成两次会让中继上在线的
    // 是 A 键而配对页里是 B 键（全 502，踩过）。
    const relayStore = readStore();
    relayKey = typeof relayStore.relayKey === 'string' ? relayStore.relayKey : '';
    let relaySecret = typeof relayStore.relaySecret === 'string' ? relayStore.relaySecret : '';
    if (relayKey === '' || relaySecret === '') {
        relayKey = randomUUID().replace(/-/g, '');
        relaySecret = randomUUID().replace(/-/g, '');
        relayStore.relayKey = relayKey;
        relayStore.relaySecret = relaySecret;
        try {
            writeStore(relayStore);
        }
        catch (error) {
            log(`中继密钥写入失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const localPort = (() => {
        try {
            const server = ctx.get('webServer');
            if (server !== undefined && typeof server.port === 'number' && server.port > 0)
                return server.port;
        }
        catch {
            // 拿不到就用默认端口
        }
        return 17731;
    })();
    // 注意：握手端点是根路径的 /link?key=…（服务端只认这个），候选地址必须是根地址，
    // 不能再拼 /m/<key>（那样会拼成 /m/<key>/link，服务端不认 → WebSocket 非 101）
    const relayCandidates = [
        { url: 'wss://cn.zhuquan.xyz:8443', label: '国内直连' },
        { url: 'wss://relay.zhuquan.xyz', label: 'Cloudflare' },
    ];
    log(`远程中继：https://cn.zhuquan.xyz:8443/m/${relayKey.slice(0, 8)}…（首选国内直连，连不上自动回退 Cloudflare）`);
    try {
        relayLink = startRelayLink({ candidates: relayCandidates, deviceKey: relayKey, secret: relaySecret, localPort, log });
    }
    catch (error) {
        log(`中继启动失败：${error instanceof Error ? error.message : String(error)}`);
    }
    // -------------------------------------------------------------- 局域网直连
    // 手机与电脑同一 Wi-Fi 时走 http://<内网IP>:17732/mobile/，不绕公网。
    // 只转发 /mobile*：/mobile-local（配对码、设备管理）与桌面 UI 永不出局域网。
    const lanAllowed = (url) => url === PUBLIC_PREFIX || url.startsWith(`${PUBLIC_PREFIX}/`) || url.startsWith(`${PUBLIC_PREFIX}?`);
    lanAddress = (() => {
        // 范围打分：192.168 > 10 > 172.16；排除 169.254（Tailscale）、100.64（CGNAT）与虚拟网卡。
        let best = '';
        let bestScore = -1;
        for (const [name, addrs] of Object.entries(networkInterfaces())) {
            if (/virtual|vmware|vbox|wsl|tailscale|loopback/i.test(name))
                continue;
            for (const addr of addrs ?? []) {
                if (addr.family !== 'IPv4' || addr.internal)
                    continue;
                const ip = addr.address;
                if (ip.startsWith('169.254.') || ip.startsWith('100.64.'))
                    continue;
                const score = ip.startsWith('192.168.') ? 3 : ip.startsWith('10.') ? 2 : ip.startsWith('172.') ? 1 : 0;
                if (score > bestScore) {
                    bestScore = score;
                    best = ip;
                }
            }
        }
        return best;
    })();
    if (lanAddress !== '') {
        const lanServer = createHttpServer((req, res) => {
            const raw = String(req.url ?? '/');
            if (!lanAllowed(raw.split('?')[0] ?? '/')) {
                res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('forbidden');
                return;
            }
            const headers = {};
            for (const [key, value] of Object.entries(req.headers)) {
                if (value !== undefined && !['host', 'connection'].includes(key))
                    headers[key] = value;
            }
            headers.host = `127.0.0.1:${localPort}`;
            const upstream = httpRequest({ host: '127.0.0.1', port: localPort, path: raw, method: req.method, headers }, (reply) => {
                res.writeHead(reply.statusCode ?? 502, reply.headers);
                reply.pipe(res);
            });
            upstream.on('error', () => {
                try {
                    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
                    res.end('bridge unavailable');
                }
                catch {
                    // 已经回过头就随它去
                }
            });
            req.pipe(upstream);
        });
        lanServer.on('upgrade', (req, socket, head) => {
            const raw = String(req.url ?? '/');
            if (!lanAllowed(raw.split('?')[0] ?? '/')) {
                socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
                return;
            }
            const upstream = netConnect(localPort, '127.0.0.1', () => {
                const lines = [`GET ${raw} HTTP/1.1`];
                for (const [key, value] of Object.entries(req.headers)) {
                    if (value === undefined)
                        continue;
                    lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
                }
                lines.push('', '');
                upstream.write(lines.join('\r\n'));
                if (head !== undefined && head.length > 0)
                    upstream.write(head);
                socket.pipe(upstream);
                upstream.pipe(socket);
            });
            upstream.on('error', () => socket.destroy());
            socket.on('error', () => upstream.destroy());
        });
        lanServer.on('error', (error) => log(`局域网直连启动失败：${error instanceof Error ? error.message : String(error)}`));
        lanServer.listen(LAN_PORT, '0.0.0.0', () => {
            log(`局域网直连已开启：http://${lanAddress}:${LAN_PORT}${PUBLIC_PREFIX}/ （手机与电脑同一 Wi-Fi 时用它配对）`);
        });
    }
}
