/**
 * `@dsh-desktop/dsh-model-vision` — declare which models accept image input,
 * from the Models settings page.
 *
 * The engine refuses an image before it is attached unless the selected model
 * declares `image` in its input modalities
 * (`dsh-llm-pi-ai` resolves a model entry's `input`, then the installed
 * catalog entry, then the route's `defaultInput`, which is `[text]`), and the
 * shipped Models page has no field for `input`. On a hand-declared route —
 * any private gateway, and ours — nothing declares it, so every model is
 * judged text-only and the composer answers 当前模型不支持图片.
 *
 * This plugin adds the missing surface: a per-model toggle on every pi-ai
 * provider card (the `settings.models.provider-card` seat, keyed by
 * `settingsNs`), plus the HTTP routes its browser half reads and writes
 * through. Writes go through the engine's own settings service, so the
 * document is validated, persisted, and announced exactly like a change made
 * in the shipped editor.
 *
 * Modalities are a claim about the endpoint, not a check of it: nothing can
 * interrogate a gateway for what it accepts, so the UI states that over-claiming
 * is refused downstream mid-turn.
 *
 * @module @dsh-desktop/dsh-model-vision
 */
/** Cordis plugin name — the patch row id and the client bundle id both use it. */
export const name = 'dsh-model-vision';
/** Services the host half needs; a missing one leaves the client half inert. */
export const inject = ['settings', 'llm', 'webServer'];
/** Settings namespace that owns pi-ai provider routes. */
export const SETTINGS_NS = 'llm-pi-ai';
/** Slot key this plugin's browser half registers under (the pi-ai namespace). */
export const PROVIDER_CARD_KEY = 'llm-pi-ai';
export const ROUTE_STATE = '/dsh-model-vision/state';
export const ROUTE_SET = '/dsh-model-vision/set';
export const ROUTE_SEAT = '/dsh-model-vision/seat';
/** Every modality a pi-ai profile may declare (mirrors dsh-llm-pi-ai MODALITIES). */
export const MODALITIES = ['text', 'image'];
/** Normalize one declared `input` value: junk filtered, empty means "declares nothing". */
export function normalizeDeclared(value) {
    if (!Array.isArray(value))
        return null;
    const kept = value.filter((part) => MODALITIES.includes(part));
    return kept.length === 0 ? null : [...new Set(kept)];
}
/** Declared modalities per model id, read from a raw user section. */
export function declaredInputsOf(section, provider) {
    const out = new Map();
    const entries = modelsArrayOf(section, provider);
    for (const entry of entries) {
        const id = typeof entry.id === 'string' ? entry.id : undefined;
        if (id !== undefined)
            out.set(id, normalizeDeclared(entry.input));
    }
    return out;
}
/** The user layer's model array for one route, or `[]` when it declares none. */
export function modelsArrayOf(section, provider) {
    const providers = isRecord(section) && isRecord(section.providers) ? section.providers : {};
    const route = isRecord(providers[provider]) ? providers[provider] : undefined;
    const models = route?.models;
    if (!Array.isArray(models))
        return [];
    return models.filter(isRecord);
}
/**
 * The next `models` array with one model's declaration replaced.
 *
 * Path ops in the settings service walk plain objects only — an array element
 * cannot be addressed — so the whole array is restated. A route that declares
 * no list (its models come from the installed catalog) is materialized from the
 * catalog with every model's current effective modalities spelled out, so the
 * write cannot narrow or silently re-declare the catalog's other models
 * whichever way the profile resolves.
 *
 * @param current - the array to restate (the user's own when it has one).
 * @param modelId - model whose declaration changes.
 * @param image - whether the model should declare image input.
 * @returns the restated array.
 */
export function withModelInput(current, modelId, image) {
    const input = image ? ['text', 'image'] : ['text'];
    let seen = false;
    const next = current.map((entry) => {
        if (entry.id !== modelId)
            return { ...entry };
        seen = true;
        return { ...entry, input: [...input] };
    });
    if (!seen)
        next.push({ id: modelId, input: [...input] });
    return next;
}
/** Whether a raw user section declares this route's model list. */
export function routeDeclaresList(section, provider) {
    return modelsArrayOf(section, provider).length > 0;
}
/** Build the state rows: the engine's own model list joined with the stored declarations. */
export function buildRows(models, declared) {
    return models.map((model) => {
        const effective = (model.inputModalities ?? ['text']).filter((part) => MODALITIES.includes(part));
        return {
            id: model.id,
            name: model.name ?? model.id,
            declared: declared.get(model.id) ?? null,
            effective: [...effective],
            supportsImage: effective.includes('image'),
        };
    });
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function sendJson(res, status, body) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
}
async function readBody(req, cap = 64 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > cap)
            throw new Error(`请求体超过 ${cap} 字节`);
        chunks.push(Buffer.from(chunk));
    }
    if (chunks.length === 0)
        return {};
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!isRecord(parsed))
        throw new Error('请求体必须是 JSON 对象');
    return parsed;
}
/** Host half entry point. */
export function apply(ctx) {
    const log = (line) => {
        console.log(`[dsh-model-vision] ${line}`);
        ctx.logger?.info?.(line);
    };
    const settings = ctx.get('settings');
    const llm = ctx.get('llm');
    if (!settings || !llm) {
        log(`服务缺失（settings=${settings !== undefined} llm=${llm !== undefined}），模型能力开关不可用`);
        return;
    }
    const stateOf = async (provider) => {
        const section = settings.section(SETTINGS_NS);
        const resolved = settings.get(SETTINGS_NS);
        const declared = declaredInputsOf(section, provider);
        const models = await llm.listModels(provider);
        const route = isRecord(isRecord(resolved) ? resolved.providers : undefined)
            ? resolved.providers[provider]
            : undefined;
        return {
            ok: true,
            provider,
            configured: route !== undefined,
            declaredList: routeDeclaresList(section, provider),
            models: buildRows(models, declared),
        };
    };
    const setOne = async (provider, modelId, image) => {
        const section = settings.section(SETTINGS_NS);
        const current = modelsArrayOf(section, provider);
        const source = current.length > 0 ? current : (await llm.listModels(provider)).map((model) => ({
            id: model.id,
            input: [...(model.inputModalities ?? ['text'])],
        }));
        const next = withModelInput(source, modelId, image);
        await settings.mutate(SETTINGS_NS, [{ op: 'set', path: ['providers', provider, 'models'], value: next }], undefined);
        const state = await stateOf(provider);
        if (current.length === 0) {
            state.note = `该路由原先不声明模型列表（用内置目录），已按目录把 ${next.length} 个模型写进配置`;
        }
        log(`${image ? '声明' : '取消'}「支持图片输入」：${provider} / ${modelId}（共 ${next.length} 条模型条目）`);
        return state;
    };
    const webServer = ctx.get('webServer');
    if (!webServer) {
        log('webServer 服务不可用，仅保留客户端界面（模型能力开关不可用）');
        return;
    }
    const handlers = {
        [ROUTE_STATE]: async (req, res, url) => {
            const provider = url.searchParams.get('provider') ?? '';
            if (provider === '') {
                sendJson(res, 400, { ok: false, message: '缺少 provider 参数', code: 'provider-required' });
                return;
            }
            sendJson(res, 200, await stateOf(provider));
        },
        [ROUTE_SET]: async (req, res) => {
            const body = await readBody(req);
            const provider = typeof body.provider === 'string' ? body.provider : '';
            const model = typeof body.model === 'string' ? body.model : '';
            const image = body.image === true;
            if (provider === '' || model === '') {
                sendJson(res, 400, { ok: false, message: '缺少 provider / model', code: 'target-required' });
                return;
            }
            const models = await llm.listModels(provider);
            if (!models.some((entry) => entry.id === model)) {
                sendJson(res, 404, {
                    ok: false,
                    message: `路由 ${provider} 没有名为 ${model} 的模型`,
                    code: 'model-unknown',
                });
                return;
            }
            sendJson(res, 200, await setOne(provider, model, image));
        },
        [ROUTE_SEAT]: async (req, res) => {
            const body = await readBody(req);
            const provider = typeof body.provider === 'string' ? body.provider : '?';
            const rendered = typeof body.rendered === 'number' ? body.rendered : -1;
            const failure = typeof body.failure === 'string' ? body.failure : '';
            log(`客户端已就座：provider=${provider} 模型=${rendered} 失败=${failure === '' ? '无' : failure}`);
            sendJson(res, 200, { ok: true, seats: 'settings.models.provider-card' });
        },
    };
    ctx.effect(() => {
        const disposers = Object.entries(handlers).map(([routePath, handler]) => webServer.register({
            kind: 'exact',
            path: routePath,
            handler: async (req, res) => {
                const url = new URL(String(req.url ?? routePath), 'http://127.0.0.1');
                try {
                    await handler(req, res, url);
                }
                catch (error) {
                    sendJson(res, 500, {
                        ok: false,
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            },
        }));
        return () => {
            for (const dispose of disposers)
                dispose();
        };
    }, 'dsh-model-vision: routes');
}
