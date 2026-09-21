/**
 * One search provider that owns the user's engine list.
 *
 * The seam allows exactly one pinned provider and no priority chain: register two
 * usable providers and every search fails with `WEB_PROVIDER_AMBIGUOUS`. That is
 * why this package registers a single provider (`search-engines`) and does the
 * routing itself — trying the enabled engines in the user's order and reporting
 * every engine's own failure when none of them answers.
 *
 * Configuration lives in the `search-engines` settings namespace, read per search
 * (never cached across calls) so a saved change takes effect on the next query
 * without re-registering anything. Credentials are resolved through the
 * credentials service by reference, so a key typed on the page never has to be
 * echoed back to it.
 *
 * @module @dsh-desktop/dsh-search-engines
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ENGINE_PRESETS, attemptOrder, buildRequest, explainFailure, looksLikeWrongProtocol, mapResponse, presetFor, proxyFor, summarizeFailures, } from './engines.js';
import { isAbortError, raiseWebError } from './web-error.js';
export * from './engines.js';
export { isAbortError, WebErrorFallback } from './web-error.js';
/** Cordis plugin name — the patch row id and the client bundle id both use it. */
export const name = 'dsh-search-engines';
/** Services the host half needs. */
export const inject = ['web', 'webServer', 'credentials'];
/**
 * Where the engine list lives.
 *
 * A JSON document under DSH_HOME rather than a settings namespace: registering a
 * namespace requires the host's schema library, and this plugin ships
 * out-of-tree, where importing a host runtime value is exactly what the loader
 * contract forbids. The file is also what the settings page writes through this
 * plugin's own routes, so a saved change needs no schema round-trip.
 */
export function configPath(env = process.env) {
    const home = (env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh');
    return join(home, 'search-engines.json');
}
/** Stable id of the router; this is what `searchProvider` must pin. */
export const PROVIDER_ID = 'search-engines';
/** Default per-attempt budget. A search that takes longer than this has failed in practice. */
export const DEFAULT_TIMEOUT_MS = 20_000;
const log = (line) => {
    // console.log reaches the desktop shell's engine log; ctx.logger does not always.
    console.log(`[dsh-search-engines] ${line}`);
};
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Merge a preset's defaults under a saved config (saved wins, blanks do not). */
function withDefaults(kind, saved) {
    const defaults = presetFor(kind)?.defaults ?? {};
    const merged = { ...defaults };
    for (const [key, value] of Object.entries(saved ?? {})) {
        if (value === undefined || value === null || value === '')
            continue;
        merged[key] = value;
    }
    return merged;
}
/** The section as saved on disk, defaults applied per engine. */
function readSettings() {
    let raw;
    try {
        raw = JSON.parse(readFileSync(configPath(), 'utf8'));
    }
    catch {
        raw = undefined;
    }
    const section = isRecord(raw) ? raw : {};
    const engines = {};
    for (const preset of ENGINE_PRESETS) {
        engines[preset.kind] = withDefaults(preset.kind, isRecord(section.engines?.[preset.kind]) ? section.engines?.[preset.kind] : undefined);
    }
    const order = Array.isArray(section.order) ? section.order.filter((kind) => typeof kind === 'string') : [];
    const global = isRecord(section.global) ? section.global : {};
    return { engines, order, global };
}
/**
 * Fetch with a timeout, the caller's cancellation, and an optional proxy.
 *
 * `redirect: 'error'` is deliberate: a search endpoint that answers with a
 * redirect is a misconfigured endpoint, and silently following it is how a typo
 * turns into an unexplained empty result.
 */
async function requestWithPolicy(url, init, timeoutMs, signal, proxy) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    const forward = () => controller.abort(signal?.reason);
    if (signal) {
        if (signal.aborted)
            forward();
        else
            signal.addEventListener('abort', forward, { once: true });
    }
    try {
        const options = { ...init, signal: controller.signal, redirect: 'error' };
        // Never proxy a loopback/LAN engine: that is what makes a running local pool
        // look like a stopped one.
        const effectiveProxy = proxyFor(url, proxy);
        if (effectiveProxy !== undefined) {
            const dispatcher = await proxyDispatcher(effectiveProxy);
            if (dispatcher)
                options.dispatcher = dispatcher;
        }
        return await fetch(url, options);
    }
    finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', forward);
    }
}
let cachedDispatcher;
/**
 * A proxy dispatcher for engines that need one (Google-backed endpoints are not
 * reachable directly in some networks). Undici ships with the engine; when it is
 * unavailable the request simply goes direct.
 */
async function proxyDispatcher(proxy) {
    if (cachedDispatcher?.key === proxy)
        return cachedDispatcher.value;
    try {
        const undici = (await import('undici'));
        if (typeof undici.ProxyAgent === 'function') {
            const value = new undici.ProxyAgent(proxy);
            cachedDispatcher = { key: proxy, value };
            return value;
        }
    }
    catch {
        // No undici in this profile: go direct rather than refuse to search.
    }
    return undefined;
}
/** Resolve one engine's credential: the section's literal first, then the service. */
async function resolveKey(credentials, config, keyRef) {
    const literal = (config.apiKey ?? '').trim();
    if (literal !== '')
        return literal;
    if (keyRef) {
        if (credentials) {
            try {
                const resolved = await credentials.resolve(keyRef);
                const value = typeof resolved?.value === 'string' ? resolved.value.trim() : '';
                if (value !== '')
                    return value;
            }
            catch {
                // fall through to the environment
            }
        }
        // The launching environment last: an OS variable the user already exports
        // (SERPER_API_KEY), and the shell's own DSH_-prefixed injection carried over
        // from the version whose settings window owned the Tavily key.
        for (const name of [keyRef, `DSH_${keyRef}`]) {
            const value = (process.env[name] ?? '').trim();
            if (value !== '')
                return value;
        }
    }
    return undefined;
}
/** The provider the seam pins: routes one query across the enabled engines. */
class SearchEnginesProvider {
    resolveOptions;
    credentials;
    id = PROVIDER_ID;
    constructor(resolveOptions, credentials) {
        this.resolveOptions = resolveOptions;
        this.credentials = credentials;
    }
    /**
     * Cheap local check — no network. The provider is usable when at least one
     * engine is enabled, because whether that engine answers is what the attempt
     * itself reports.
     */
    available() {
        const { engines, order } = this.resolveOptions();
        return attemptOrder(order, engines).length > 0;
    }
    async search(request, signal) {
        const { engines, order, global } = this.resolveOptions();
        const kinds = attemptOrder(order, engines);
        if (kinds.length === 0) {
            raiseWebError('没有启用任何搜索引擎。打开 设置 → 搜索引擎 启用一个（本机搜索池不需要 Key）。', 'WEB_PROVIDER_UNAVAILABLE');
        }
        const timeoutMs = typeof global.timeoutMs === 'number' && global.timeoutMs > 0 ? global.timeoutMs : DEFAULT_TIMEOUT_MS;
        const maxResults = request.maxResults ?? global.maxResults ?? 8;
        const failures = [];
        for (const kind of kinds) {
            const config = engines[kind] ?? {};
            const outcome = await this.attempt(kind, config, request.query, maxResults, timeoutMs, global.proxy, signal);
            if (outcome.ok) {
                return outcome.result;
            }
            failures.push({ kind, message: outcome.message ?? '未知失败' });
            log(`引擎 ${kind} 失败：${outcome.message}`);
        }
        raiseWebError(summarizeFailures(failures), 'WEB_PROVIDER_ERROR');
    }
    /** One engine, one query, fully mapped — used by routing and by the test button. */
    async attempt(kind, config, query, maxResults, timeoutMs, proxy, signal) {
        const credentials = this.credentials;
        const built = buildRequest(kind, config, query, maxResults);
        const key = built.needsKey ? await resolveKey(credentials, config, built.keyRef) : undefined;
        if (built.needsKey && (key === undefined || key === '')) {
            return { ok: false, message: `缺少 Key —— 这张卡需要 ${built.keyRef ?? '一个 API Key'}，请在卡片里填好再测试。` };
        }
        const headers = { ...built.init.headers };
        if (key !== undefined) {
            if (kind === 'serper')
                headers['X-API-KEY'] = key;
            else if (kind === 'deepseek') {
                headers['x-api-key'] = key;
                headers.authorization = `Bearer ${key}`;
            }
            else
                headers.authorization = `Bearer ${key}`;
        }
        let response;
        try {
            response = await requestWithPolicy(built.url, { ...built.init, headers }, timeoutMs, signal, proxy);
        }
        catch (error) {
            if (isAbortError(error) && signal?.aborted)
                raiseWebError('搜索已取消', 'WEB_ABORTED', { cause: error });
            return { ok: false, message: explainFailure(kind, undefined, error instanceof Error ? error.message : String(error)) };
        }
        if (!response.ok) {
            let detail;
            try {
                const body = await response.text();
                detail = body.slice(0, 300);
            }
            catch {
                detail = undefined;
            }
            return { ok: false, message: explainFailure(kind, response.status, detail) };
        }
        let parsed;
        try {
            parsed = await response.json();
        }
        catch (error) {
            return { ok: false, message: `返回的不是 JSON（可能是登录页或错误页）：${error instanceof Error ? error.message : String(error)}` };
        }
        try {
            const outcome = mapResponse(kind, config, parsed);
            if (outcome.sources.length === 0) {
                return { ok: false, message: '接口通了但一条结果都没解析出来 —— 检查「结果字段路径」是否对得上，或换个关键词。' };
            }
            return {
                ok: true,
                count: outcome.sources.length,
                result: {
                    ...(outcome.content !== undefined ? { content: outcome.content } : {}),
                    sources: outcome.sources,
                    // The seam owns the final truncation; providers report false.
                    truncated: false,
                },
            };
        }
        catch (error) {
            return { ok: false, message: `返回结构不符合预期：${error instanceof Error ? error.message : String(error)}` };
        }
    }
}
/** Write the section atomically so a search never reads a half-written file. */
function writeSettings(section) {
    const file = configPath();
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(section, null, 2)}\n`, 'utf8');
    renameSync(temporary, file);
}
/** Attach a credential reference to every engine that needs one. */
function keyView(kind, config) {
    return (config.apiKeyEnv ?? presetFor(kind)?.keyRef ?? '').trim();
}
/** Build what the settings page renders. */
async function buildState(credentials) {
    const { engines, order, global } = readSettings();
    const views = [];
    for (const preset of ENGINE_PRESETS) {
        const config = engines[preset.kind] ?? {};
        const ref = keyView(preset.kind, config);
        let keyConfigured = false;
        let keyWritable = false;
        if (preset.needsKey && ref !== '' && credentials) {
            try {
                const described = await credentials.describe(ref);
                keyConfigured = described?.configured === true;
                keyWritable = described?.writable !== false;
            }
            catch {
                keyConfigured = false;
            }
        }
        views.push({
            kind: preset.kind,
            label: preset.label,
            hint: preset.hint,
            urlHint: preset.urlHint,
            needsKey: preset.needsKey,
            anthropicBase: preset.anthropicBase === true,
            keyRef: ref,
            keyConfigured,
            keyWritable,
            enabled: config.enabled === true,
            config,
            ...(looksLikeWrongProtocol(preset.kind, config) !== undefined ? { addressWarning: looksLikeWrongProtocol(preset.kind, config) } : {}),
        });
    }
    const enabled = views.filter((view) => view.enabled).map((view) => view.kind);
    const ordered = order.filter((kind) => enabled.includes(kind));
    return { engines: views, order: [...ordered, ...enabled.filter((kind) => !ordered.includes(kind))], global, active: ordered[0] ?? enabled[0] ?? '', anyEnabled: enabled.length > 0 };
}
/** Send one JSON response. */
function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
}
/** Read a JSON request body with a size cap. */
async function readJsonBody(req) {
    let raw = '';
    for await (const chunk of req) {
        raw += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (raw.length > 512 * 1024)
            throw new Error('请求体过大');
    }
    return raw.trim() === '' ? {} : JSON.parse(raw);
}
/**
 * Register the router and the settings page's routes.
 *
 * @param ctx - host context; `web`, `settings`, `credentials` and `webServer` are injected.
 * @param config - optional plugin config (`timeoutMs`, `proxy`) used as a fallback.
 */
export function apply(ctx, config = {}) {
    const credentials = ctx.get('credentials');
    const webServer = ctx.get('webServer');
    const resolveOptions = () => {
        const base = readSettings();
        if (config.timeoutMs !== undefined || config.proxy !== undefined) {
            base.global = {
                timeoutMs: base.global.timeoutMs ?? config.timeoutMs,
                proxy: base.global.proxy ?? config.proxy,
                maxResults: base.global.maxResults,
            };
        }
        return base;
    };
    ctx.get('web').registerSearchProvider(new SearchEnginesProvider(resolveOptions, credentials));
    // First run: write the defaults so the page opens on something real. A file
    // that is absent is the only signal needed — a present file is the user's.
    if (!existsSync(configPath())) {
        try {
            const engines = {};
            for (const preset of ENGINE_PRESETS)
                engines[preset.kind] = preset.defaults;
            writeSettings({
                engines,
                order: ENGINE_PRESETS.filter((preset) => preset.defaults.enabled === true).map((preset) => preset.kind),
                global: { timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxResults: 8, proxy: config.proxy ?? '' },
            });
            log(`已写入默认引擎配置：${configPath()}`);
        }
        catch (error) {
            log(`默认配置写入失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const base = '/dsh-search-engines';
    webServer.register({
        kind: 'exact',
        path: `${base}/state`,
        handler: (req, res) => {
            void (async () => {
                try {
                    sendJson(res, 200, await buildState(credentials));
                }
                catch (error) {
                    sendJson(res, 200, { error: error instanceof Error ? error.message : String(error) });
                }
            })();
        },
    });
    webServer.register({
        kind: 'exact',
        path: `${base}/test`,
        handler: (req, res) => {
            void (async () => {
                try {
                    const body = await readJsonBody(req);
                    const kind = String(body.kind ?? '');
                    if (presetFor(kind) === undefined) {
                        sendJson(res, 200, { ok: false, engine: kind, message: `未知引擎：${kind}` });
                        return;
                    }
                    const incoming = isRecord(body.config) ? body.config : {};
                    // A request that carries no fields (a card just loaded, or a scripted
                    // probe) tests what is actually saved rather than a preset default.
                    const config2 = withDefaults(kind, { ...(readSettings().engines[kind] ?? {}), ...incoming });
                    const { global } = readSettings();
                    const timeoutMs = typeof global.timeoutMs === 'number' && global.timeoutMs > 0 ? global.timeoutMs : DEFAULT_TIMEOUT_MS;
                    const query = String(body.query ?? '').trim() || 'DeepSeek Harness';
                    const built = buildRequest(kind, config2, query, typeof global.maxResults === 'number' ? global.maxResults : 8);
                    const started = Date.now();
                    const provider = new SearchEnginesProvider(resolveOptions, credentials);
                    const outcome = await provider.attempt(kind, { ...config2, apiKey: typeof body.apiKey === 'string' ? body.apiKey : config2.apiKey }, query, typeof global.maxResults === 'number' ? global.maxResults : 8, timeoutMs, global.proxy);
                    const ms = Date.now() - started;
                    if (outcome.ok) {
                        const first = (outcome.result.sources[0] ?? {});
                        sendJson(res, 200, {
                            ok: true,
                            engine: kind,
                            endpoint: built.url,
                            ms,
                            count: outcome.count,
                            first: first.title ?? first.url ?? '',
                            message: `成功：返回 ${outcome.count} 条，用时 ${ms} ms`,
                        });
                        return;
                    }
                    sendJson(res, 200, { ok: false, engine: kind, endpoint: built.url, ms, message: outcome.message });
                }
                catch (error) {
                    sendJson(res, 200, { ok: false, message: error instanceof Error ? error.message : String(error) });
                }
            })();
        },
    });
    webServer.register({
        kind: 'exact',
        path: `${base}/save`,
        handler: (req, res) => {
            void (async () => {
                try {
                    const body = await readJsonBody(req);
                    const current = readSettings();
                    const engines = { ...current.engines };
                    let fields = 0;
                    if (isRecord(body.engines)) {
                        for (const [kind, value] of Object.entries(body.engines)) {
                            if (presetFor(kind) === undefined || !isRecord(value))
                                continue;
                            const clean = {};
                            for (const [field, fieldValue] of Object.entries(value)) {
                                // A key belongs in the credentials service, not in this file.
                                if (field === 'apiKey')
                                    continue;
                                clean[field] = fieldValue;
                                fields += 1;
                            }
                            engines[kind] = clean;
                        }
                    }
                    const order = Array.isArray(body.order) ? body.order.filter((kind) => typeof kind === 'string') : current.order;
                    const global = isRecord(body.global) ? body.global : current.global;
                    writeSettings({ engines, order, global });
                    // A key typed on the page goes to the credentials service, never into
                    // the settings file, and is never read back out.
                    const secrets = isRecord(body.secrets) ? body.secrets : {};
                    let stored = 0;
                    for (const [ref, value] of Object.entries(secrets)) {
                        const literal = String(value ?? '').trim();
                        if (literal === '' || !/^[A-Z][A-Z0-9_]*$/.test(ref))
                            continue;
                        if (!credentials)
                            throw new Error('这个 profile 没有凭据服务，无法保存 Key');
                        await credentials.set(ref, literal);
                        stored += 1;
                    }
                    log(`保存引擎配置：${fields} 个字段${stored > 0 ? `，${stored} 个 Key 已写入凭据` : ''}`);
                    sendJson(res, 200, { ok: true, message: `已保存${stored > 0 ? `（含 ${stored} 个 Key）` : ''}` });
                }
                catch (error) {
                    sendJson(res, 200, { ok: false, message: error instanceof Error ? error.message : String(error) });
                }
            })();
        },
    });
    webServer.register({
        kind: 'exact',
        path: `${base}/seat`,
        handler: (req, res) => {
            log('客户端已就座：settings.section');
            sendJson(res, 200, { ok: true, seats: 'settings.section' });
        },
    });
    const { engines, order } = readSettings();
    log(`已就绪：${attemptOrder(order, engines).length} 个引擎已启用（提供方 id：${PROVIDER_ID}，配置 ${configPath()}）`);
}
