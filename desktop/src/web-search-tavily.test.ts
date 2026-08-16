import { describe, expect, it } from "vitest";
import {
  TAVILY_DEFAULT_BASE_URL,
  TAVILY_PROVIDER_ID,
  TavilySearchProvider,
  mapTavilyResponse,
  mapTavilyResult,
} from "../resources/plugins/web-search-tavily/src/provider";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("tavily response mapping", () => {
  it("maps results with snippets and the generated answer", () => {
    expect(
      mapTavilyResponse({
        answer: "  DeepSeek is an AI lab. ",
        results: [
          { url: "https://a", title: "A", content: " about a", published_date: "2026-01-02", score: 0.9 },
          { url: "https://b", content: "  " },
          { title: "no url", content: "x" },
        ],
      }),
    ).toEqual({
      content: "DeepSeek is an AI lab.",
      sources: [{ url: "https://a", title: "A", snippet: "about a", publishedAt: "2026-01-02" }],
      truncated: false,
    });
  });

  it("drops entries without content instead of inventing a snippet", () => {
    expect(mapTavilyResult({ url: "https://x", title: "T" })).toBeUndefined();
    expect(mapTavilyResult({ url: "https://x", content: "ok" })).toEqual({ url: "https://x", snippet: "ok" });
  });
});

describe("TavilySearchProvider", () => {
  it("registers under the tavily id and is unavailable without a key", () => {
    const provider = new TavilySearchProvider({ apiKey: "  " });
    expect(provider.id).toBe(TAVILY_PROVIDER_ID);
    expect(provider.available()).toBe(false);
    expect(new TavilySearchProvider({ apiKey: "tvly-x" }).available()).toBe(true);
  });

  it("posts the documented body and maps the response", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const provider = new TavilySearchProvider({
      apiKey: "tvly-key",
      maxResults: 5,
      searchDepth: "advanced",
      includeAnswer: true,
      fetchImpl: (async (url: unknown, init: unknown) => {
        calls.push({ url: String(url), init: init as RequestInit });
        return jsonResponse({ answer: "ans", results: [{ url: "https://r", content: "snippet" }] });
      }) as unknown as typeof fetch,
    });
    const result = await provider.search({ query: "deepseek harness", maxResults: 3 });
    expect(result).toEqual({ content: "ans", sources: [{ url: "https://r", snippet: "snippet" }], truncated: false });
    expect(calls[0]?.url).toBe(`${TAVILY_DEFAULT_BASE_URL}/search`);
    const init = calls[0]?.init as { headers: Record<string, string>; body: string };
    expect(init.headers.authorization).toBe("Bearer tvly-key");
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body.query).toBe("deepseek harness");
    expect(body.max_results).toBe(3); // per-request bound wins
    expect(body.search_depth).toBe("advanced");
    expect(body.include_answer).toBe(true);
  });

  it("surfaces HTTP errors as WEB_PROVIDER_ERROR with the API detail", async () => {
    const provider = new TavilySearchProvider({
      apiKey: "bad",
      fetchImpl: (async () => jsonResponse({ detail: "Invalid API key" }, 401)) as unknown as typeof fetch,
    });
    await expect(provider.search({ query: "x" })).rejects.toMatchObject({ code: "WEB_PROVIDER_ERROR" });
    await expect(provider.search({ query: "x" })).rejects.toThrow("Invalid API key");
  });

  it("classifies aborts as WEB_ABORTED", async () => {
    const provider = new TavilySearchProvider({
      apiKey: "k",
      fetchImpl: (async () => {
        throw new DOMException("The operation was aborted.", "AbortError");
      }) as unknown as typeof fetch,
    });
    await expect(provider.search({ query: "x" })).rejects.toMatchObject({ code: "WEB_ABORTED" });
  });

  it("reports network failures as WEB_PROVIDER_ERROR", async () => {
    const provider = new TavilySearchProvider({
      apiKey: "k",
      fetchImpl: (async () => {
        throw new Error("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(provider.search({ query: "x" })).rejects.toMatchObject({ code: "WEB_PROVIDER_ERROR" });
  });
});
