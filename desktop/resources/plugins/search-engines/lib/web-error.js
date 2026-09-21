/**
 * The host's `WebError`, resolved lazily so thrown errors keep its class identity.
 *
 * The web seam routes on `instanceof WebError`, so an error raised from
 * out-of-tree plugin code must be the same class the engine uses; host packages
 * are therefore imported as types only and the single runtime value is located
 * through the engine's module path. If the engine cannot be located the fallback
 * carries the same `message` + `code` wire shape.
 *
 * @module @dsh-desktop/dsh-search-engines/web-error
 */
import { createRequire } from 'node:module';
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
 * Resolve the host's `WebError` class.
 *
 * @param anchor - optional extra module anchor to try first.
 * @returns the class, or null when no anchor resolved one.
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
/** Throw an error carrying the host class when it is available. */
export function raiseWebError(message, code, options) {
    const ctor = webErrorConstructor();
    throw ctor !== null ? new ctor(message, code, options) : new WebErrorFallback(message, code, options);
}
/** True for a fetch/`AbortSignal` abort. */
export function isAbortError(error) {
    return error instanceof DOMException && error.name === 'AbortError';
}
