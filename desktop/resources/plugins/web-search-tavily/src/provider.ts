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

import { createRequire } from 'node:module'

/** Stable id this provider registers under (also the searchProvider config value). */
export const TAVILY_PROVIDER_ID = 'tavily'

/** Default Tavily endpoint; `/search` is the operation. */
export const TAVILY_DEFAULT_BASE_URL = 'https://api.tavily.com'

/** Default retrieval depth. `advanced` is slower but ranks better on hard queries. */
export const TAVILY_DEFAULT_SEARCH_DEPTH: TavilySearchDepth = 'basic'

/** Default result count when a request carries no `maxResults`. */
export const TAVILY_DEFAULT_MAX_RESULTS = 8

/** Attribution header sent on every request. */
export const TAVILY_USER_AGENT = 'deepseek-desktop-tavily/0.1.0'

export type TavilySearchDepth = 'basic' | 'advanced'

/** One Tavily result entry. */
export interface TavilyResult {
  title?: string | null
  url?: string | null
  content?: string | null
  published_date?: string | null
  score?: number
}

/** Parsed `POST /search` response envelope. */
export interface TavilySearchResponse {
  answer?: string | null
  results?: TavilyResult[]
}

/** Provider-neutral source vocabulary (structural match of `WebSearchSource`). */
export interface WebSearchSourceLike {
  url: string
  title?: string
  snippet?: string
  publishedAt?: string
}

/** Provider-neutral result vocabulary (structural match of `WebSearchResult`). */
export interface WebSearchResultLike {
  content?: string
  sources: WebSearchSourceLike[]
  truncated: boolean
}

/** Provider-neutral request vocabulary (structural match of `WebSearchRequest`). */
export interface WebSearchRequestLike {
  query: string
  maxResults?: number
}

type WebErrorCtor = new (message: string, code: string, options?: { cause?: unknown }) => Error & { code: string }

/** Same wire shape as the seam's `WebError` when the host class cannot be found. */
export class WebErrorFallback extends Error {
  readonly code: string

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions)
    this.code = code
  }
}

let cachedWebError: WebErrorCtor | null | undefined

/**
 * Resolve the host's `WebError` class so the seam's `instanceof` routing sees
 * the real class. Anchors, in order: the engine root the desktop app exports,
 * then this process's entry script (the engine's `bin.js`).
 */
export function webErrorConstructor(anchor?: string): WebErrorCtor | null {
  if (cachedWebError !== undefined) return cachedWebError
  cachedWebError = null
  const anchors = [process.env.DSH_ENGINE_ROOT, anchor, process.argv[1]]
  for (const base of anchors) {
    if (typeof base !== 'string' || base.length === 0) continue
    try {
      const require = createRequire(base.endsWith('.json') || base.endsWith('.js') ? base : `${base}/package.json`)
      const mod = require('@deepseek-ai/dsh-web') as { WebError?: unknown }
      if (typeof mod.WebError === 'function') {
        cachedWebError = mod.WebError as WebErrorCtor
        break
      }
    } catch {
      // try the next anchor
    }
  }
  return cachedWebError
}

/** Throw a web error carrying the host class when available. */
function raiseWebError(message: string, code: string, options?: { cause?: unknown }): never {
  const ctor = webErrorConstructor()
  throw ctor !== null ? new ctor(message, code, options) : new WebErrorFallback(message, code, options)
}

/** True for a fetch/`AbortSignal` abort. */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/**
 * Map one Tavily result to a normalized source, or `undefined` when it carries
 * no URL or no content to derive a snippet from (inventing one would lie).
 */
export function mapTavilyResult(result: TavilyResult): WebSearchSourceLike | undefined {
  if (typeof result.url !== 'string' || result.url.length === 0) return undefined
  const snippet = typeof result.content === 'string' ? result.content.trim() : ''
  if (snippet.length === 0) return undefined
  return {
    url: result.url,
    ...(typeof result.title === 'string' && result.title.length > 0 ? { title: result.title } : {}),
    snippet,
    ...(typeof result.published_date === 'string' && result.published_date.length > 0
      ? { publishedAt: result.published_date }
      : {}),
  }
}

/** Map a Tavily response to the normalized search result; snippet-less entries drop. */
export function mapTavilyResponse(response: TavilySearchResponse): WebSearchResultLike {
  const sources = (response.results ?? [])
    .map(mapTavilyResult)
    .filter((source): source is WebSearchSourceLike => source !== undefined)
  const answer = typeof response.answer === 'string' ? response.answer.trim() : ''
  // The web service owns the final maxResults truncation, so this provider
  // reports `truncated: false` (same contract as the official providers).
  return { ...(answer.length > 0 ? { content: answer } : {}), sources, truncated: false }
}

/** Resolved provider options (the plugin's `apply` supplies env-var and constant defaults). */
export interface TavilySearchProviderOptions {
  /** Tavily API key. Empty/absent makes the provider unavailable. */
  apiKey: string
  /** Endpoint base; `/search` is appended. */
  baseURL?: string
  /** Default result count when a request carries no `maxResults`. */
  maxResults?: number
  /** Retrieval depth sent as Tavily's `search_depth`. */
  searchDepth?: TavilySearchDepth
  /** Ask Tavily for a generated answer, mapped to the result's `content`. */
  includeAnswer?: boolean
  /** Injectable for tests. */
  fetchImpl?: typeof fetch
}

/** The Tavily-backed search provider; HTTP failures surface as `WEB_PROVIDER_ERROR`. */
export class TavilySearchProvider {
  readonly id = TAVILY_PROVIDER_ID

  constructor(private readonly options: TavilySearchProviderOptions) {}

  private get baseURL(): string {
    const configured = this.options.baseURL?.trim()
    return configured && configured.length > 0 ? configured : TAVILY_DEFAULT_BASE_URL
  }

  available(): boolean {
    return this.options.apiKey.trim().length > 0 && URL.canParse(this.baseURL)
  }

  async search(request: WebSearchRequestLike, signal?: AbortSignal): Promise<WebSearchResultLike> {
    const maxResults = request.maxResults ?? this.options.maxResults
    let response: Response
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
      })
    } catch (error) {
      if (isAbortError(error)) raiseWebError('Tavily search aborted', 'WEB_ABORTED', { cause: error })
      raiseWebError(`Tavily search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Tavily API error (HTTP ${status})`
      try {
        const parsed = (await response.json()) as { detail?: unknown; message?: unknown }
        const detail = parsed.detail ?? parsed.message
        if (typeof detail === 'string' && detail.length > 0) message = detail
      } catch (error) {
        if (isAbortError(error)) raiseWebError('Tavily search aborted', 'WEB_ABORTED', { cause: error })
        // Otherwise the HTTP status is already captured; a non-JSON error body
        // (gateway 5xx/429) can only cost a richer message, never the real error.
      }
      raiseWebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      return mapTavilyResponse((await response.json()) as TavilySearchResponse)
    } catch (error) {
      if (isAbortError(error)) raiseWebError('Tavily search aborted', 'WEB_ABORTED', { cause: error })
      raiseWebError(`Tavily returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}
