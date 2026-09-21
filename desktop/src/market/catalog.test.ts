import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DSH1024_SOURCE,
  EMPTY_PAGE,
  MarketFetchError,
  browseUrl,
  detailUrl,
  fetchCatalogJson,
  filterEntries,
  installableEntries,
  looksLikeNpmName,
  normalizeCustomPage,
  normalizeDsh1024Page,
  normalizeEntry,
  npmPackageFromCommand,
  searchUrl,
} from "./catalog";

const fixtures = path.join(__dirname, "__fixtures__");
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(fixtures, name), "utf8")) as unknown;
}

/** The first entry of a normalized page, failing loudly when the page is empty. */
function first(payload: unknown) {
  const page = normalizeDsh1024Page(payload, "dsh1024");
  expect(page.entries.length).toBeGreaterThan(0);
  return page;
}

describe("npm identity", () => {
  it("accepts plain scoped and unscoped names", () => {
    expect(looksLikeNpmName("dshmarket")).toBe(true);
    expect(looksLikeNpmName("@liustack/modlens")).toBe(true);
    expect(looksLikeNpmName("@dsh-desktop/dsh-vision-aux")).toBe(true);
  });

  it("rejects specs, protocols and ranges", () => {
    expect(looksLikeNpmName("github:owner/repo")).toBe(false);
    expect(looksLikeNpmName("file:../plugin")).toBe(false);
    expect(looksLikeNpmName("dsh-pet@1.2.3")).toBe(false);
    expect(looksLikeNpmName("dsh-pet@latest")).toBe(false);
    expect(looksLikeNpmName("../plugin")).toBe(false);
  });

  it("extracts the package from a plain add command only", () => {
    expect(npmPackageFromCommand("dsh plugin --profile web add @linxin666/dsh-doctor")).toBe("@linxin666/dsh-doctor");
    expect(npmPackageFromCommand("dsh plugin --profile web add dshmarket")).toBe("dshmarket");
    expect(
      npmPackageFromCommand("dsh plugin --profile web add --allow-build=x github:o/r#path:packages/p"),
    ).toBe("");
    expect(npmPackageFromCommand("dsh plugin --profile web add github:o/r#path:p")).toBe("");
    expect(npmPackageFromCommand("dsh plugin --profile web add dsh-pet@1.2.3")).toBe("");
    expect(npmPackageFromCommand("")).toBe("");
  });
});

describe("1024Store normalization", () => {
  it("reads the v2 catalog page", () => {
    const page = first(fixture("catalog-v2.json"));
    expect(page.page).toBe(1);
    expect(page.totalPages).toBeGreaterThan(0);
    expect(page.catalogTotal).toBeGreaterThan(1000);
    const entry = page.entries.find((item) => item.id === "nexu-io/open-design/packages/dsh-runtime");
    expect(entry).toBeDefined();
    expect(entry?.owner).toBe("nexu-io");
    expect(entry?.categoryId).toBe("ui");
    expect(entry?.repoUrl).toBe("https://github.com/nexu-io/open-design");
    expect(entry?.stars).toBeGreaterThan(0);
    expect(entry?.installs).toBeGreaterThan(0);
    expect(entry?.description.zh.length).toBeGreaterThan(0);
    // This entry's install command is a github spec, so it stays browse-only.
    expect(entry?.npmPackage).toBe("");
    expect(entry?.displayCommand).toContain("github:");
  });

  it("reads search results and their npm commands", () => {
    const payload = fixture("catalog-search.json") as { total: number; results: unknown[] };
    const page = first(payload);
    expect(page.total).toBe(payload.total);
    const doctor = page.entries.find((item) => item.name === "dsh-doctor");
    expect(doctor?.npmPackage).toBe("@linxin666/dsh-doctor");
    expect(doctor?.installable ?? false).toBe(false);
    expect(installableEntries(page.entries).some((item) => item.npmPackage === "@linxin666/dsh-doctor")).toBe(true);
  });

  it("reads the frozen v1 projection and its categories", () => {
    const page = first(fixture("catalog-list.json"));
    expect(page.categories.length).toBeGreaterThan(2);
    const ui = page.categories.find((item) => item.id === "ui");
    expect(ui?.zh).toBe("UI 增强");
    expect(ui?.en).toBe("UI Enhancements");
    expect(ui?.count).toBeGreaterThan(0);
    // The v1 view only serves installable plugins, so each row has a command.
    expect(page.entries.every((entry) => entry.displayCommand.startsWith("dsh plugin"))).toBe(true);
    expect(installableEntries(page.entries).length).toBeGreaterThan(0);
  });

  it("prefers installMethods and keeps the provider revision informational", () => {
    // A detail payload is one entry object, not a page: normalize it directly.
    const entry = normalizeEntry(fixture("catalog-detail.json"), "dsh1024");
    expect(entry.id).toBe("zhu1090093659/dsh-web-ui/packages/dsh-doctor");
    expect(entry.npmPackage).toBe("@linxin666/dsh-doctor");
    expect(entry.revision).toBe("0.3.24");
    expect(entry.categoryId).toBe("ui");
    expect(entry.description.zh.length).toBeGreaterThan(0);
    expect(normalizeDsh1024Page(fixture("catalog-detail.json")).entries).toEqual([]);
  });
});

describe("custom source schema", () => {
  it("normalizes entries, categories and command-derived packages", () => {
    const page = normalizeCustomPage(
      {
        name: "我的市场",
        categories: [{ id: "ui", en: "UI", zh: "界面" }],
        entries: [
          { id: "me/alpha", name: "alpha", npmPackage: "dsh-alpha", category: "ui", repoUrl: "https://github.com/me/alpha" },
          { id: "me/beta", name: "beta", installCommand: "dsh plugin --profile web add dsh-beta" },
          { id: "me/gamma", name: "gamma", installCommand: "dsh plugin --profile web add github:me/gamma" },
        ],
      },
      "custom-1",
    );
    expect(page.entries.map((entry) => entry.npmPackage)).toEqual(["dsh-alpha", "dsh-beta", ""]);
    expect(page.entries[0].sourceId).toBe("custom-1");
    expect(page.categories[0]).toEqual({ id: "ui", en: "UI", zh: "界面", count: 0 });
    expect(page.entries[2].displayCommand).toContain("github:");
  });

  it("never throws on junk payloads", () => {
    for (const payload of [null, 42, "nope", [], { entries: "x" }]) {
      const page = normalizeCustomPage(payload, "custom-1");
      expect(page.entries).toEqual([]);
    }
    expect(normalizeDsh1024Page(undefined).entries).toEqual([]);
    expect(normalizeDsh1024Page({ plugins: [null, 7] }).entries.length).toBe(2);
  });
});

describe("urls", () => {
  it("addresses the paginated catalog for browsing", () => {
    expect(browseUrl(DSH1024_SOURCE, 2)).toBe("https://deepseek1024.com/api/v2/plugins?page=2&pageSize=60&sort=installs");
  });

  it("addresses search with the required query and optional category", () => {
    const url = new URL(searchUrl(DSH1024_SOURCE, "pet 桌宠", "ui"));
    expect(url.origin).toBe("https://api.deepseek1024.com");
    expect(url.searchParams.get("q")).toBe("pet 桌宠");
    expect(url.searchParams.get("category")).toBe("ui");
    expect(url.searchParams.get("sortBy")).toBe("stars");
  });

  it("percent-encodes every detail path segment", () => {
    expect(detailUrl(DSH1024_SOURCE, "zhu1090093659/dsh-web-ui/packages/dsh-doctor")).toBe(
      "https://deepseek1024.com/api/v1/plugins/zhu1090093659/dsh-web-ui/packages/dsh-doctor",
    );
    expect(detailUrl(DSH1024_SOURCE, "@me/plugin")).toContain("%40me");
  });

  it("treats a custom source as one static document for every view", () => {
    const custom = { id: "c", label: "c", kind: "custom" as const, url: "https://example.com/market.json" };
    expect(browseUrl(custom, 3)).toBe(custom.url);
    expect(searchUrl(custom, "x", "")).toBe(custom.url);
    expect(detailUrl(custom, "a/b")).toBe(custom.url);
  });
});

describe("fetch safety envelope", () => {
  const okFetch = (async () =>
    new Response(JSON.stringify({ plugins: [] }), { status: 200 })) as unknown as typeof fetch;

  it("refuses non-HTTPS, credentialed and private destinations", async () => {
    await expect(fetchCatalogJson("http://deepseek1024.com/x")).rejects.toBeInstanceOf(MarketFetchError);
    await expect(fetchCatalogJson("https://u:p@deepseek1024.com/x")).rejects.toThrow(/凭据/);
    for (const url of [
      "https://127.0.0.1/x",
      "https://localhost/x",
      "https://10.0.0.5/x",
      "https://192.168.1.9/x",
      "https://172.20.0.1/x",
      "https://169.254.1.1/x",
      "https://[::1]/x",
    ]) {
      await expect(fetchCatalogJson(url)).rejects.toThrow(/内网/);
    }
  });

  it("surfaces HTTP failures instead of an empty catalog", async () => {
    const failing = (async () => new Response("nope", { status: 502 })) as unknown as typeof fetch;
    await expect(fetchCatalogJson("https://example.com/a.json", { fetchImpl: failing })).rejects.toThrow(/HTTP 502/);
    const notJson = (async () => new Response("<html>proxy</html>", { status: 200 })) as unknown as typeof fetch;
    await expect(fetchCatalogJson("https://example.com/a.json", { fetchImpl: notJson })).rejects.toThrow(/不是 JSON/);
  });

  it("names the host when the network fails", async () => {
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(fetchCatalogJson("https://deepseek1024.com/x", { fetchImpl: offline })).rejects.toThrow(
      /无法访问数据源 deepseek1024\.com（fetch failed）/,
    );
    const slow = (async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }) as unknown as typeof fetch;
    await expect(fetchCatalogJson("https://deepseek1024.com/x", { fetchImpl: slow })).rejects.toThrow(/请求超时/);
  });

  it("caps the response size", async () => {
    const big = (async () => new Response("[" + "1,".repeat(5000) + "1]", { status: 200 })) as unknown as typeof fetch;
    await expect(fetchCatalogJson("https://example.com/a.json", { fetchImpl: big, maxBytes: 1000 })).rejects.toThrow(
      /过大/,
    );
  });

  it("returns parsed JSON on the happy path", async () => {
    await expect(fetchCatalogJson("https://api.deepseek1024.com/v1/health", { fetchImpl: okFetch })).resolves.toEqual({
      plugins: [],
    });
  });
});

describe("views", () => {
  const entries = normalizeDsh1024Page(fixture("catalog-search.json"), "dsh1024").entries;

  it("filters by query across name, owner, package and both descriptions", () => {
    expect(filterEntries(entries, "dsh-doctor", "").length).toBeGreaterThan(0);
    expect(filterEntries(entries, "@linxin666", "").length).toBeGreaterThan(0);
    expect(filterEntries(entries, "任务板", "").length).toBeGreaterThan(0);
    expect(filterEntries(entries, "zzz-nothing", "")).toEqual([]);
    expect(filterEntries(entries, "", "ui").every((entry) => entry.categoryId === "ui")).toBe(true);
  });

  it("keeps only npm-identified entries in the installable view", () => {
    const installable = installableEntries(entries);
    expect(installable.length).toBeGreaterThan(0);
    expect(installable.every((entry) => looksLikeNpmName(entry.npmPackage))).toBe(true);
  });

  it("exposes an empty page constant for the first render", () => {
    expect(EMPTY_PAGE.entries).toEqual([]);
    expect(EMPTY_PAGE.catalogTotal).toBe(0);
  });
});
