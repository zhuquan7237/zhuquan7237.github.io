/**
 * `@dsh-desktop/dsh-vision-aux`: when the model selected for a step cannot
 * accept images (`ctx.llm.resolveModelInfo().inputModalities` lacks `image`),
 * replace each image block of the entering user messages with a text
 * description produced by an OpenAI-compatible vision model. Models that do
 * accept images see the original blocks untouched.
 *
 * The rewrite happens in the `agent/pre-step` waterfall — the one sanctioned
 * place that decides what the model sees — so the replaced content becomes the
 * logged `user/message` (model-visible means logged). Message identity
 * (`id`) and `source` are preserved.
 *
 * @module @dsh-desktop/dsh-vision-aux
 */
import { DEFAULT_SKIP_WHEN_UNKNOWN, DEFAULT_VISION_PROMPT, DEFAULT_VISION_TIMEOUT_MS, describeImage, renderImageDescription, renderImageFailure, } from './vision.js';
export { DEFAULT_SKIP_WHEN_UNKNOWN, DEFAULT_VISION_PROMPT, DEFAULT_VISION_TIMEOUT_MS, describeImage, renderImageDescription, renderImageFailure, } from './vision.js';
/** Cordis plugin name used by loader diagnostics and the patch row id. */
export const name = 'vision-aux';
/** Host services this plugin consumes. */
export const inject = ['llm', 'attachments'];
function blockIsImage(block) {
    return block.type === 'image';
}
/**
 * True when the selected model accepts images. Results are cached per
 * provider/model; unknown metadata follows `skipWhenUnknown`.
 */
export async function modelSeesImages(llm, agent, cache, skipWhenUnknown, signal) {
    const provider = agent?.options?.provider;
    const model = agent?.options?.model;
    if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) {
        return skipWhenUnknown;
    }
    const key = `${provider}::${model}`;
    const cached = cache.get(key);
    if (cached !== undefined)
        return cached;
    let sees;
    try {
        const info = await llm.resolveModelInfo(provider, model, signal);
        const modalities = info?.inputModalities;
        sees = Array.isArray(modalities) ? modalities.includes('image') : skipWhenUnknown;
    }
    catch {
        sees = skipWhenUnknown;
    }
    cache.set(key, sees);
    return sees;
}
/** Replace every image block of one message, preserving `id` and `source`. */
export async function rewriteMessageImages(attachments, message, options, signal) {
    if (!message.content.some(blockIsImage))
        return message;
    const images = message.content.filter(blockIsImage);
    const total = images.length;
    let index = 0;
    const content = await Promise.all(message.content.map(async (block) => {
        if (!blockIsImage(block))
            return block;
        const current = (index += 1);
        try {
            const stored = await attachments.readImage(block.attachment, signal);
            const description = await describeImage(options, stored, signal);
            return { type: 'text', text: renderImageDescription(current, total, block.attachment, options.model, description) };
        }
        catch (error) {
            return { type: 'text', text: renderImageFailure(current, total, block.attachment, error) };
        }
    }));
    return { ...message, content };
}
/** Register the pre-step rewrite. */
export function apply(ctx, config = {}) {
    const options = {
        baseURL: (config.baseURL ?? '').trim(),
        apiKey: (config.apiKey ?? process.env.DSH_VISION_AUX_API_KEY ?? '').trim(),
        model: (config.model ?? '').trim(),
        prompt: config.prompt?.trim() || DEFAULT_VISION_PROMPT,
        timeoutMs: config.timeoutMs ?? DEFAULT_VISION_TIMEOUT_MS,
    };
    const skipWhenUnknown = config.skipWhenUnknown ?? DEFAULT_SKIP_WHEN_UNKNOWN;
    const capability = new Map();
    ctx.on('agent/pre-step', async (payload, next) => {
        const decision = (await next());
        if (decision.kind !== 'enter')
            return decision;
        if (options.model.length === 0 || options.baseURL.length === 0 || options.apiKey.length === 0)
            return decision;
        if (!decision.messages.some((message) => message.content.some(blockIsImage)))
            return decision;
        const sees = await modelSeesImages(ctx.llm, payload.agent, capability, skipWhenUnknown, payload.signal);
        if (sees)
            return decision;
        const messages = await Promise.all(decision.messages.map((message) => rewriteMessageImages(ctx.attachments, message, options, payload.signal)));
        return { kind: 'enter', messages };
    });
}
