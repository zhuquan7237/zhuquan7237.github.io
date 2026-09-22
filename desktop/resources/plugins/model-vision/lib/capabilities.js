/**
 * Capability resolution for one model id: which request modalities it accepts,
 * how much context it takes and how much it may answer with.
 *
 * NO GATEWAY CAN BE ASKED. Measured on this machine's six routes, `/v1/models`
 * returns `id/object/created/owned_by` and little else (`wb2api` adds
 * `context_length` + `max_output_tokens`; `clinepass` returns nothing at all),
 * so "ask the provider" answers almost nothing. Every tool that looks like it
 * auto-detects is reading a model→capability catalogue it maintains, which is
 * what this module does:
 *
 *   1. an explicit user override wins outright ("manual");
 *   2. whatever the endpoint does publish ("upstream");
 *   3. a cross-vendor catalogue snapshot, refreshed from the network and cached
 *      ("catalogue") — a normalized id index over OpenRouter's public model list,
 *      which carries `architecture.input_modalities` + `context_length` and
 *      matches ~95% of this machine's 516 declared models;
 *   4. a family rule for the remainder ("rule") — image generators, codex
 *      models, `*-agent` variants of a known family;
 *   5. nothing, which leaves the engine's own default in place ("unknown").
 *
 * Every field keeps the source it came from, so the UI can show it and a wrong
 * guess stays correctable. Nothing here writes configuration; it only answers
 * what a model's capabilities are.
 *
 * @module @dsh-desktop/dsh-model-vision/capabilities
 */
/** Request modalities the engine understands (dsh-llm-pi-ai MODALITIES). */
export const MODALITIES = ['text', 'image'];
/**
 * Reasoning levels the engine's selector understands, in escalation order —
 * dsh-llm-pi-ai's own THINKING_LEVELS. A level is the selector's identity; what
 * is actually sent is the spelling stored beside it, so a gateway that names its
 * levels differently still receives what it expects.
 */
export const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const SUFFIXES = /-(thinking|reasoning|non-thinking|high|low|medium|extra-low|mini-high|preview|beta|alpha|exp|experimental|free|latest|instruct|chat|turbo)$/i;
/**
 * Normalize one model id into the catalogue's key space: vendor prefixes and
 * channel suffixes carry no capability meaning, and a gateway routinely renames
 * the same model (`cline-pass/deepseek-v4.1-flash`, `~openai/gpt-astra-latest`).
 * @param id - raw model id.
 * @returns the normalized key.
 */
export function normalizeModelId(id) {
    let s = String(id || '').trim().toLowerCase();
    s = s.replace(/^[~@]+/, '');
    // A routing decoration is not part of the model's identity: `:free`, `:batch`
    // and friends route the same weights, so they must not hide a catalogue hit.
    s = s.replace(/:.*$/, '');
    const parts = s.split('/');
    s = parts[parts.length - 1] || s;
    let previous = '';
    while (previous !== s) {
        previous = s;
        s = s.replace(SUFFIXES, '');
    }
    return s.replace(/[._\s]+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
}
/**
 * Family rules for models no catalogue describes.
 *
 * Deliberately modality-only: context and output sizes vary per deployment, so
 * inventing them would be worse than leaving the engine's default. Ordered —
 * the first match wins, and the image-generation rule must stay first because
 * `gpt-image-*` shares the `gpt-*` prefix while accepting no image input.
 */
export const FAMILY_RULES = [
    {
        name: 'image-generation',
        test: /(^|[-/])(gpt-image|dall-e|imagen|seedream|flux|stable-diffusion|sd-xl|sdxl|midjourney|nano-banana|qwen-image|kolors)/,
        input: ['text'],
        note: '生图模型：接收文字、产出图片，不接收图片输入',
    },
    {
        name: 'text-only-special',
        test: /(^|[-/])(codex|o[1-4]-mini|embed|embedding|rerank|moderation|whisper|tts|guard|classifier)([-/]|$)/,
        input: ['text'],
        note: '专用/文本模型',
    },
    {
        name: 'vision-family',
        // Rules run against the normalised id, where every dot has become a dash:
        // a family written as `gpt-4.1` or `kimi-k2.7` must accept both spellings or
        // it silently matches nothing.
        test: /(gemini|claude|gpt-4o|gpt-4[.-]1|gpt-5|gpt-6|glm-4[.-]5v|glm-5|qwen[0-9.-]*-?vl|minimax-m|kimi-k(2[.-][5-9]|[3-9])|grok-[2-9]|mimo.*omni|internvl|pixtral|llava|moondream|llama-4|phi-4-multimodal|yi-vl|step-1v|doubao.*vision|seed.*vision)/,
        input: ['text', 'image'],
        note: '该家族普遍支持图片输入',
    },
    {
        name: 'multimodal-name',
        test: /(vl-|vlm|multimodal|omni|-vision|vision-|^vision)/,
        input: ['text', 'image'],
        note: '名称含视觉/多模态标识',
    },
];
/** Look one id up in a family rule. */
export function ruleFor(id) {
    const key = normalizeModelId(id);
    return FAMILY_RULES.find((rule) => rule.test.test(key));
}
/** Parse a catalogue document (bundled snapshot or a refreshed one). */
export function parseCatalogue(raw) {
    if (typeof raw !== 'object' || raw === null)
        return undefined;
    const doc = raw;
    if (typeof doc.keys !== 'object' || doc.keys === null)
        return undefined;
    return {
        version: typeof doc.version === 'number' ? doc.version : 1,
        generatedAt: typeof doc.generatedAt === 'string' ? doc.generatedAt : '',
        source: typeof doc.source === 'string' ? doc.source : '',
        keys: doc.keys,
    };
}
/**
 * Build a catalogue index from an OpenRouter-shaped `/api/v1/models` reply.
 * Keeps only fields this plugin can act on, and indexes both the full and the
 * short (vendor-stripped) id.
 * @param raw - parsed reply.
 * @returns the index, or an empty one when the shape is unexpected.
 */
export function catalogueFromModels(raw) {
    const list = raw?.data;
    if (!Array.isArray(list))
        return {};
    const keys = {};
    for (const item of list) {
        if (typeof item !== 'object' || item === null)
            continue;
        const row = item;
        const id = typeof row.id === 'string' ? row.id : '';
        if (id === '')
            continue;
        const modalities = Array.isArray(row.architecture?.input_modalities)
            ? row.architecture.input_modalities.filter((m) => typeof m === 'string')
            : undefined;
        const context = numberOr(row.context_length ?? row.top_provider?.context_length);
        const output = numberOr(row.top_provider?.max_completion_tokens ?? row.per_request_limits?.max_completion_tokens);
        const entry = { i: id };
        if (modalities && modalities.length > 0)
            entry.m = modalities;
        if (context !== undefined)
            entry.c = context;
        if (output !== undefined)
            entry.o = output;
        keys[normalizeModelId(id)] = entry;
        const short = id.split('/').pop();
        if (short && normalizeModelId(short) !== normalizeModelId(id))
            keys[normalizeModelId(short)] ??= entry;
    }
    return keys;
}
/**
 * The capability fields one `/v1/models` row publishes, if any. Gateways that
 * describe models at all use a handful of different spellings; this reads the
 * ones seen in the wild plus the OpenRouter shape.
 * @param row - one row of a `/v1/models` reply.
 * @returns the capabilities it states (empty when the row states none).
 */
export function upstreamCapabilities(row) {
    if (typeof row !== 'object' || row === null)
        return {};
    const item = row;
    const raw = item.architecture?.input_modalities ?? item.input_modalities ?? item.capabilities?.input ?? item.modalities;
    const input = Array.isArray(raw)
        ? raw.filter((m) => MODALITIES.includes(String(m))).map(String)
        : undefined;
    const contextWindow = numberOr(item.context_length ?? item.context_window ?? item.max_context_length ?? item.max_input_tokens);
    const maxTokens = numberOr(item.max_output_tokens ?? item.max_tokens ?? item.top_provider?.max_completion_tokens);
    const out = {};
    if (input && input.length > 0)
        out.input = [...new Set(input)];
    if (contextWindow !== undefined)
        out.contextWindow = contextWindow;
    if (maxTokens !== undefined)
        out.maxTokens = maxTokens;
    const reasoning = upstreamReasoning(item);
    if (reasoning !== undefined)
        out.reasoning = reasoning;
    return out;
}
/** Keep only the spellings the engine's selector can name. */
export function engineReasoningLevels(value) {
    if (!Array.isArray(value))
        return [];
    const kept = value
        .map((level) => String(level ?? '').trim().toLowerCase())
        .filter((level) => REASONING_LEVELS.includes(level));
    return [...new Set(kept)];
}
/**
 * Reasoning a catalogue entry states. A list is only useful when at least one of
 * its spellings is a level the engine can offer; a list of unknown spellings is
 * treated as "reasons, no selectable levels" rather than as no information.
 * @param entry - one catalogue entry.
 * @returns the capability, or `undefined` when the entry says nothing.
 */
export function reasoningFromEntry(entry) {
    if (!entry || entry.r === undefined)
        return undefined;
    if (typeof entry.r === 'number')
        return entry.r === 0 ? { kind: 'none' } : { kind: 'toggle' };
    const levels = engineReasoningLevels(entry.r);
    return levels.length > 0 ? { kind: 'efforts', levels } : { kind: 'toggle' };
}
/**
 * Reasoning an endpoint's own `/v1/models` row states. Gateways that publish
 * anything at all use one of a handful of shapes; this reads those.
 * @param item - one row of such a reply.
 * @returns the capability, or `undefined` when the row says nothing usable.
 */
export function upstreamReasoning(item) {
    if (typeof item !== 'object' || item === null)
        return undefined;
    const list = item.reasoning_options ?? item.reasoning_efforts ?? item.reasoningEfforts ?? item.capabilities?.reasoning_options;
    if (Array.isArray(list)) {
        const flattened = list.flatMap((entry) => typeof entry === 'string' ? [entry] : Array.isArray(entry?.values) ? entry.values : []);
        const levels = engineReasoningLevels(flattened);
        if (levels.length > 0)
            return { kind: 'efforts', levels };
        if (list.length > 0)
            return { kind: 'toggle' };
    }
    const flag = item.reasoning ?? item.capabilities?.reasoning;
    if (flag === false)
        return { kind: 'none' };
    if (flag === true)
        return { kind: 'toggle' };
    return undefined;
}
/**
 * The value to write into a model entry's `reasoningEfforts`, or `undefined`
 * when there is nothing this plugin may write.
 *
 * The engine accepts either `false` (this model does not reason) or a dict of
 * level → wire spelling, and refuses an empty dict; levels are offered only when
 * known, and each one sends its own name because that is the spelling the
 * catalogue source recorded for that model.
 * @param cap - the resolved capability.
 * @returns the entry value, or `undefined` for "write nothing".
 */
export function wireReasoning(cap) {
    if (cap === undefined)
        return undefined;
    if (cap.kind === 'toggle')
        return undefined;
    if (cap.kind === 'none')
        return false;
    const map = {};
    for (const level of cap.levels)
        map[level] = level;
    return map;
}
function numberOr(value) {
    const n = typeof value === 'string' ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
/** Modalities the engine can act on, from any list a source publishes. */
export function engineModalities(value) {
    if (!Array.isArray(value))
        return undefined;
    const kept = value.filter((part) => MODALITIES.includes(part));
    return kept.length === 0 ? undefined : [...new Set(kept)];
}
/**
 * Resolve one model's capabilities from every source, in authority order.
 *
 * A user override is never second-guessed. Beyond that the endpoint outranks the
 * catalogue, the catalogue outranks a family rule, and an absent answer stays
 * absent — the engine reads "no declaration" as text-only, and declaring a
 * guess would either block an image it could have sent or let one through that
 * the provider then refuses mid-turn.
 *
 * Modality lists are narrowed to the engine's own vocabulary: a catalogue entry
 * that also lists `file`, `audio` or `video` must not hand `file` to a schema
 * that accepts only `text` and `image`, or the whole write is refused.
 *
 * @param id - model id.
 * @param options - the layers to consult.
 * @returns per-field values with their provenance.
 */
export function resolveCapabilities(id, options = {}) {
    const key = normalizeModelId(id);
    const entry = options.catalogue?.keys?.[key];
    const rule = ruleFor(id);
    const override = options.override;
    const declared = options.declared;
    const upstream = options.upstream;
    const pick = (manual, chain) => {
        if (manual !== undefined)
            return { value: manual, source: 'manual' };
        for (const [value, source] of chain)
            if (value !== undefined)
                return { value, source };
        return { value: undefined, source: 'unknown' };
    };
    const input = pick(engineModalities(override?.input), [
        [engineModalities(upstream?.input), 'upstream'],
        [engineModalities(entry?.m), 'catalogue'],
        [engineModalities(rule?.input), 'rule'],
        [engineModalities(declared?.input), 'declared'],
    ]);
    const contextWindow = pick(override?.contextWindow, [
        [upstream?.contextWindow, 'upstream'],
        [entry?.c, 'catalogue'],
    ]);
    const maxTokens = pick(override?.maxTokens, [
        [upstream?.maxTokens, 'upstream'],
        [entry?.o, 'catalogue'],
    ]);
    const reasoning = pick(override?.reasoning, [
        [upstream?.reasoning, 'upstream'],
        [reasoningFromEntry(entry), 'catalogue'],
        [declared?.reasoning, 'declared'],
    ]);
    const out = { id, input, contextWindow, maxTokens, reasoning };
    if (input.source === 'catalogue' && entry?.i)
        out.matched = entry.i;
    return out;
}
/** Whether a resolved capability set accepts images. */
export function acceptsImages(caps) {
    return (caps.input.value ?? ['text']).includes('image');
}
/** Human label for a source, for the UI. */
export function sourceLabel(source) {
    switch (source) {
        case 'manual':
            return '手动';
        case 'upstream':
            return '上游';
        case 'catalogue':
            return '目录';
        case 'rule':
            return '推断';
        case 'declared':
            return '已有声明';
        default:
            return '未知';
    }
}
