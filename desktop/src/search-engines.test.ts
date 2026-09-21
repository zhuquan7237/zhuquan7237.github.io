import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENGINE_PRESETS,
  attemptOrder,
  buildRequest,
  clampResults,
  explainFailure,
  looksLikeWrongProtocol,
  mapResponse,
  parseHeaders,
  presetFor,
  readPath,
  summarizeFailures,
} from "../resources/plugins/search-engines/src/engines";

const pluginDir = path.resolve(__dirname, "../resources/plugins/search-engines");

describe("engine presets", () => {
  it("ships a preset for every engine the page offers, with a default address", () => {
    const kinds = ENGINE_PRESETS.map((preset) => preset.kind);
    expect(kinds).toEqual(["pool", "searxng", "tavily", "serper", "deepseek", "custom"]);
    for (const preset of ENGINE_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.hint.length).toBeGreaterThan(6);
      if (preset.kind !== "custom") expect(String(preset.defaults.baseURL ?? "")).toMatch(/^https?:\/\//);
    }
    // Self-hosted engines must not demand a credential, or the local pool is
    // unreachable by construction.
    expect(presetFor("pool")?.needsKey).toBe(false);
    expect(presetFor("searxng")?.needsKey).toBe(false);
    expect(presetFor("serper")?.needsKey).toBe(true);
  });
});

describe("request building", () => {
  it("asks the local pool the way the pool actually answers", () => {
    // The pool returns nothing for Tavily's POST body, so a provider that only
    // knows the Tavily shape reports a working endpoint as broken.
    const built = buildRequest("pool", { baseURL: "http://127.0.0.1:9876" }, "广东海洋大学", 5);
    expect(built.init.method).toBe("GET");
    expect(built.url).toBe(`http://127.0.0.1:9876/search?q=${encodeURIComponent("广东海洋大学")}&limit=5`);
    expect(built.needsKey).toBe(false);
  });

  it("asks SearXNG for its json format and sends filters", () => {
    const built = buildRequest("searxng", { baseURL: "http://127.0.0.1:18880", language: "zh-CN", safesearch: 1 }, "激光焊接", 8);
    expect(built.url).toContain("format=json");
    expect(built.url).toContain("language=zh-CN");
    expect(built.url).toContain("safesearch=1");
    expect(built.init.method).toBe("GET");
  });

  it("posts the shapes Tavily and Serper expect", () => {
    const tavily = buildRequest("tavily", { baseURL: "https://api.tavily.com" }, "deepseek", 3);
    expect(tavily.init.method).toBe("POST");
    expect(JSON.parse(String(tavily.init.body))).toMatchObject({ query: "deepseek", max_results: 3 });
    expect(tavily.keyRef).toBe("TAVILY_API_KEY");

    const serper = buildRequest("serper", { baseURL: "https://google.serper.dev" }, "deepseek", 4);
    expect(serper.init.method).toBe("POST");
    expect(JSON.parse(String(serper.init.body))).toMatchObject({ q: "deepseek", num: 4 });
    expect(serper.keyRef).toBe("SERPER_API_KEY");
  });

  it("posts the official engine as Anthropic Messages with a server-side search tool", () => {
    const built = buildRequest("deepseek", { baseURL: "https://api.deepseek.com/anthropic/v1", maxUses: 5 }, "今日新闻", 8);
    // The endpoint is ${base}/messages — the reason a search API's base URL
    // saves fine and then fails on every query.
    expect(built.url).toBe("https://api.deepseek.com/anthropic/v1/messages");
    expect(built.init.headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(String(built.init.body));
    expect(body.tools[0]).toMatchObject({ type: "web_search_20250305", name: "web_search", max_uses: 5 });
    expect(built.keyRef).toBe("DEEPSEEK_API_KEY");
  });

  it("substitutes the placeholder template for a custom endpoint", () => {
    const get = buildRequest(
      "custom",
      { method: "GET", urlTemplate: "https://example.com/api?q={query}&n={maxResults}" },
      "材料",
      7,
    );
    expect(get.url).toBe(`https://example.com/api?q=${encodeURIComponent("材料")}&n=7`);
    const post = buildRequest("custom", { method: "POST", urlTemplate: "https://example.com/api" }, "材料", 7);
    expect(post.init.method).toBe("POST");
    expect(JSON.parse(String(post.init.body))).toMatchObject({ query: "材料", maxResults: 7 });
  });

  it("clamps result counts into a range every engine accepts", () => {
    expect(clampResults(0)).toBe(1);
    expect(clampResults(999)).toBe(20);
    expect(clampResults(undefined, 6)).toBe(6);
    expect(clampResults("nonsense", 4)).toBe(4);
  });

  it("parses header lines and dot paths", () => {
    expect(parseHeaders("Authorization: Bearer x\n# note\n\nX-Team: core")).toEqual({
      Authorization: "Bearer x",
      "X-Team": "core",
    });
    expect(readPath({ data: { items: [1, 2] } }, "data.items")).toEqual([1, 2]);
    expect(readPath({ data: {} }, "data.items.0")).toBeUndefined();
  });
});

describe("response mapping", () => {
  it("reads the pool and Tavily result arrays", () => {
    const outcome = mapResponse("pool", {}, { answer: "答案", results: [{ url: "https://a", title: "A", content: "摘要" }] });
    expect(outcome.sources).toEqual([{ url: "https://a", title: "A", snippet: "摘要" }]);
    expect(outcome.content).toBe("答案");
  });

  it("reads SearXNG results and its first answer", () => {
    const outcome = mapResponse("searxng", {}, { answers: ["直接答案"], results: [{ url: "https://b", title: "B", content: "片" }] });
    expect(outcome.sources).toHaveLength(1);
    expect(outcome.content).toBe("直接答案");
  });

  it("reads Serper organic results", () => {
    const outcome = mapResponse("serper", {}, { organic: [{ link: "https://c", title: "C", snippet: "s" }] });
    expect(outcome.sources[0]).toMatchObject({ url: "https://c", title: "C", snippet: "s" });
  });

  it("reads the official engine's server-side search blocks, not the reply text", () => {
    const outcome = mapResponse("deepseek", {}, {
      content: [
        { type: "text", text: "我在回复里编了一个 https://fake.example" },
        {
          type: "web_search_tool_result",
          content: [{ type: "web_search_result", url: "https://real.example", title: "真的", page_age: "2026-09-01" }],
        },
      ],
    });
    expect(outcome.sources).toEqual([{ url: "https://real.example", title: "真的", publishedAt: "2026-09-01" }]);
  });

  it("refuses an official response that carries no search block", () => {
    expect(() => mapResponse("deepseek", {}, { content: [{ type: "text", text: "no search happened" }] })).toThrow(
      /web_search_tool_result/,
    );
  });

  it("maps a custom endpoint by the paths the user configured", () => {
    const outcome = mapResponse(
      "custom",
      { resultsPath: "data.items", urlPath: "link", titlePath: "name", snippetPath: "desc" },
      { data: { items: [{ link: "https://d", name: "D", desc: "摘要" }] } },
    );
    expect(outcome.sources).toEqual([{ url: "https://d", title: "D", snippet: "摘要" }]);
    expect(() => mapResponse("custom", { resultsPath: "missing" }, { data: {} })).toThrow(/missing/);
  });
});

describe("addresses and failures say what to do next", () => {
  it("catches a search API's address in the official engine's field", () => {
    // The real misconfiguration this page exists to prevent: a URL that parses,
    // saves, and then answers 411 on every search.
    const warning = looksLikeWrongProtocol("deepseek", { baseURL: "https://google.serper.dev" });
    expect(warning).toBeTruthy();
    expect(String(warning)).toContain("Anthropic");
    expect(looksLikeWrongProtocol("deepseek", { baseURL: "https://api.deepseek.com/anthropic/v1" })).toBeUndefined();
    expect(looksLikeWrongProtocol("deepseek", { baseURL: "https://api.deepseek.com/anthropic/v1/messages" })).toContain("/messages");
    expect(looksLikeWrongProtocol("searxng", { baseURL: "https://api.tavily.com" })).toBeTruthy();
    expect(looksLikeWrongProtocol("pool", { baseURL: "http://127.0.0.1:9876" })).toBeUndefined();
  });

  it("turns status codes into an instruction", () => {
    expect(explainFailure("serper", 401, '{"message":"invalid key"}')).toContain("Key");
    expect(explainFailure("deepseek", 411, "")).toContain("不是它的接口");
    expect(explainFailure("tavily", 429, "")).toContain("限流");
    expect(explainFailure("searxng", 500, "")).toContain("服务端出错");
    expect(explainFailure("pool", undefined, "fetch failed")).toContain("连不上");
    expect(explainFailure("pool", undefined, "timeout after 20000ms")).toContain("超时");
  });
});

describe("routing order", () => {
  const engines = {
    pool: { enabled: true },
    searxng: { enabled: true },
    tavily: { enabled: false },
    serper: { enabled: true },
  };

  it("tries the user's order first, then anything else enabled", () => {
    expect(attemptOrder(["serper", "pool"], engines)).toEqual(["serper", "pool", "searxng"]);
    expect(attemptOrder(undefined, engines)).toEqual(["pool", "searxng", "serper"]);
    expect(attemptOrder(["tavily"], engines)).toEqual(["pool", "searxng", "serper"]);
    expect(attemptOrder([], { pool: { enabled: false } })).toEqual([]);
  });

  it("names every engine's own failure when none of them answered", () => {
    const message = summarizeFailures([
      { kind: "pool", message: "pool 连不上" },
      { kind: "serper", message: "serper 拒绝了这个 Key" },
    ]);
    expect(message).toContain("本机搜索池");
    expect(message).toContain("Serper");
    expect(message).toContain("连不上");
  });
});

describe("client bundle", () => {
  const source = readFileSync(path.join(pluginDir, "client", "client.js"), "utf8");

  it("registers a settings section inside the loader contract", () => {
    expect(source).toContain("window.__ModuleLoader__.load");
    expect(source).toContain('"@dsh-desktop/dsh-search-engines"');
    expect(source).toContain("settings.section");
    expect(source).toContain('id: "search-engines"');
  });

  it("uses only theme variables that exist, with theme-neutral fallbacks", () => {
    const allowed = new Set([
      "--dsw-alias-label-primary",
      "--dsw-alias-label-secondary",
      "--dsw-alias-label-tertiary",
      "--dsw-alias-border-l1",
      "--dsw-alias-border-l2",
      "--dsw-alias-bg-layer-1",
      "--dsw-alias-bg-layer-2",
      "--dsw-alias-state-business-primary",
      "--dsw-alias-state-error-primary",
      "--dsw-alias-interactive-bg-hover",
    ]);
    const used = [...source.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]);
    expect(used.length).toBeGreaterThan(4);
    for (const name of used) expect(allowed.has(name)).toBe(true);
    // A dark literal fallback is how the desktop panel once painted black.
    for (const match of source.matchAll(/var\([^)]*?,\s*(#[0-9a-fA-F]{6})\)/g)) {
      const hex = match[1];
      const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
      expect((r + g + b) / 3).toBeGreaterThan(90);
    }
  });
});
