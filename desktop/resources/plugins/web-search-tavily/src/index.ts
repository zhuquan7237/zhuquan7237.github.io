/**
 * `@dsh-desktop/dsh-web-search-tavily`: registers a Tavily-backed
 * `WebSearchProvider` with `ctx.web`. A function/namespace plugin (NOT a
 * default-export service): a search provider does not own the `ctx.web` key —
 * it registers INTO the seam's provider registry, exactly as the official
 * `@deepseek-ai/dsh-web-search-exa` does. The key is owned by
 * `@deepseek-ai/dsh-web`.
 *
 * Select this provider by setting the `web` row's `searchProvider: tavily`
 * (the desktop app writes that patch row from its engine settings).
 *
 * @module @dsh-desktop/dsh-web-search-tavily
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-web'
import {
  TAVILY_DEFAULT_BASE_URL,
  TAVILY_DEFAULT_MAX_RESULTS,
  TAVILY_DEFAULT_SEARCH_DEPTH,
  TavilySearchProvider,
  type TavilySearchDepth,
} from './provider.js'

export {
  TAVILY_DEFAULT_BASE_URL,
  TAVILY_DEFAULT_MAX_RESULTS,
  TAVILY_DEFAULT_SEARCH_DEPTH,
  TAVILY_PROVIDER_ID,
  TavilySearchProvider,
  WebErrorFallback,
  isAbortError,
  mapTavilyResponse,
  mapTavilyResult,
  webErrorConstructor,
} from './provider.js'
export type {
  TavilyResult,
  TavilySearchDepth,
  TavilySearchProviderOptions,
  TavilySearchResponse,
  WebSearchRequestLike,
  WebSearchResultLike,
  WebSearchSourceLike,
} from './provider.js'

/** Cordis plugin name used by loader diagnostics and the patch row id. */
export const name = 'web-search-tavily'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Tavily API key. Falls back to `$DSH_TAVILY_API_KEY`. Empty → provider unavailable. */
  apiKey?: string
  /** Endpoint base; `/search` is appended. Defaults to the public API. */
  baseURL?: string
  /** Default result count when a request carries no `maxResults`. */
  maxResults?: number
  /** Retrieval depth sent as Tavily's `search_depth`. */
  searchDepth?: TavilySearchDepth
  /** Ask Tavily for a generated answer, mapped to the result's `content`. */
  includeAnswer?: boolean
}

/** Register the Tavily search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.web.registerSearchProvider(
    new TavilySearchProvider({
      apiKey: (config.apiKey ?? process.env.DSH_TAVILY_API_KEY ?? '').trim(),
      baseURL: config.baseURL,
      maxResults: config.maxResults ?? TAVILY_DEFAULT_MAX_RESULTS,
      searchDepth: config.searchDepth ?? TAVILY_DEFAULT_SEARCH_DEPTH,
      includeAnswer: config.includeAnswer === true,
    }),
  )
}
