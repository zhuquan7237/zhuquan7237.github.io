/**
 * Tavily-backed `WebSearchProvider` for the dsh web capability seam.
 *
 * Mirrors the official `@deepseek-ai/dsh-web-search-exa` plugin shape, but
 * ships out-of-tree with the desktop app: host packages are imported as types
 * only, and the single runtime host value (`WebError`) is resolved lazily from
 * the running engine so thrown errors keep the host's class identity for its
 * `instanceof` routing. If the engine cannot be located the provider falls
 * back to an error with the same `message` + `code` shape.
 *
 * @module @dsh-desktop/dsh-web-search-tavily/provider
 */
import { createRequire } from 'node:module';
/** Stable id this provider registers under (also the searchProvider config value). */
export const TAVILY_PROVIDER_ID = 'tavily';
/** Default Tavily endpoint; `/search` is the operation. */
export const TAVILY_DEFAULT_BASE_URL = 'https://api.tavily.com';
/** Default retrieval depth. `advanced` is slower but ranks better on hard queries. */
export const TAVILY_DEFAULT_SEARCH_DEPTH = 'basic';
/** Default result count when a request carries no `maxResults`. */
export const TAVILY_DEFAULT_MAX_RESULTS = 8;
/** Attribution header sent on every request. */
export const TAVILY_USER_AGENT = 'deepseek-desktop-tavily/0.1.0';
/** Same wire shape as the seam's `WebError` when the host class cannot be found. */
export class WebErrorFallback extends Error {
    code;
    constructor(message, code, options) {
        super(message, options);
        this.code = code;
    }
}
let cachedWebError;
/**
 * Resolve the host's `WebError` class so the seam's `instanceof` routing sees
 * the real class. Anchors, in order: the engine root the desktop app exports,
 * then this process's entry script (the engine's `bin.js`).
 */
export function webErrorConstructor(anchor) {
    if (cachedWebError !== undefined)
        return cachedWebError;
    cachedWebError = null;
    const anchors = [process.env.DSH_ENGINE_ROOT, anchor, process.argv[1]];
    for (const base of anchors) {
        if (typeof base !== 'string' || base.length === 0)
            continue;
        try {
            const require = createRequire(base.endsWith('.json') || base.endsWith('.js') ? base : `${base}/package.json`);
            const mod = require('@deepseek-ai/dsh-web');
            if (typeof mod.WebError === 'function') {
                cachedWebError = mod.WebError;
                break;
            }
        }
        catch {
            // try the next anchor
        }
    }
    return cachedWebError;
}
/** Throw a web error carrying the host class when available. */
function raiseWebError(message, code, options) {
    const ctor = webErrorConstructor();
    throw ctor !== null ? new ctor(message, code, options) : new WebErrorFallback(message, code, options);
}
/** True for a fetch/`AbortSignal` abort. */
export function isAbortError(error) {
    return error instanceof DOMException && error.name === 'AbortError';
}
/**
 * Map one Tavily result to a normalized source, or `undefined` when it carries
 * no URL or no content to derive a snippet from (inventing one would lie).
 */
export function mapTavilyResult(result) {
    if (typeof result.url !== 'string' || result.url.length === 0)
        return undefined;
    const snippet = typeof result.content === 'string' ? result.content.trim() : '';
    if (snippet.length === 0)
        return undefined;
    return {
        url: result.url,
        ...(typeof result.title === 'string' && result.title.length > 0 ? { title: result.title } : {}),
        snippet,
        ...(typeof result.published_date === 'string' && result.published_date.length > 0
            ? { publishedAt: result.published_date }
            : {}),
    };
}
/** Map a Tavily response to the normalized search result; snippet-less entries drop. */
export function mapTavilyResponse(response) {
    const sources = (response.results ?? [])
        .map(mapTavilyResult)
        .filter((source) => source !== undefined);
    const answer = typeof response.answer === 'string' ? response.answer.trim() : '';
    // The web service owns the final maxResults truncation, so this provider
    // reports `truncated: false` (same contract as the official providers).
    return { ...(answer.length > 0 ? { content: answer } : {}), sources, truncated: false };
}
/** The Tavily-backed search provider; HTTP failures surface as `WEB_PROVIDER_ERROR`. */
export class TavilySearchProvider {
    options;
    id = TAVILY_PROVIDER_ID;
    constructor(options) {
        this.options = options;
    }
    get baseURL() {
        const configured = this.options.baseURL?.trim();
        return configured && configured.length > 0 ? configured : TAVILY_DEFAULT_BASE_URL;
    }
    available() {
        return this.options.apiKey.trim().length > 0 && URL.canParse(this.baseURL);
    }
    async search(request, signal) {
        const maxResults = request.maxResults ?? this.options.maxResults;
        let response;
        try {
            response = await (this.options.fetchImpl ?? fetch)(`${this.baseURL}/search`, {
                method: 'POST',
                redirect: 'error',
                headers: {
                    'authorization': `Bearer ${this.options.apiKey}`,
                    'content-type': 'application/json',
                    'accept': 'application/json',
                    'user-agent': TAVILY_USER_AGENT,
                },
                body: JSON.stringify({
                    query: request.query,
                    ...(maxResults !== undefined ? { max_results: maxResults } : {}),
                    search_depth: this.options.searchDepth ?? TAVILY_DEFAULT_SEARCH_DEPTH,
                    include_answer: this.options.includeAnswer === true,
                }),
                ...(signal !== undefined ? { signal } : {}),
            });
        }
        catch (error) {
            if (isAbortError(error))
                raiseWebError('Tavily search aborted', 'WEB_ABORTED', { cause: error });
            raiseWebError(`Tavily search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error });
        }
        if (!response.ok) {
            const status = response.status;
            let message = `Tavily API error (HTTP ${status})`;
            try {
                const parsed = (await response.json());
                const detail = parsed.detail ?? parsed.message;
                if (typeof detail === 'string' && detail.length > 0)
                    message = detail;
            }
            catch (error) {
                if (isAbortError(error))
                    raiseWebError('Tavily search aborted', 'WEB_ABORTED', { cause: error });
                // Otherwise the HTTP status is already captured; a non-JSON error body
                // (gateway 5xx/429) can only cost a richer message, never the real error.
            }
            raiseWebError(message, 'WEB_PROVIDER_ERROR');
        }
        try {
            return mapTavilyResponse((await response.json()));
        }
        catch (error) {
            if (isAbortError(error))
                raiseWebError('Tavily search aborted', 'WEB_ABORTED', { cause: error });
            raiseWebError(`Tavily returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error });
        }
    }
}
