import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import { getProvidersInfo, syncAllProviderModels, fetchRemoteModelIds } from "./sync-models";

function writeSettings(home: string, doc: Record<string, unknown>): void {
  fs.writeFileSync(path.join(home, "settings.yaml"), yaml.dump(doc), "utf8");
}

function readSettings(home: string): Record<string, any> {
  return (yaml.load(fs.readFileSync(path.join(home, "settings.yaml"), "utf8")) || {}) as Record<string, any>;
}

/** Fake engine prefix with a pi-ai catalog for one provider. */
function makePrefix(root: string, providerId: string): string {
  const prefix = path.join(root, "harness", "0.1.1-test");
  const dataDir = path.join(
    prefix, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data",
  );
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, `${providerId}.json`),
    JSON.stringify({
      "anthropic-messages": {
        "minimax-m3": { id: "minimax-m3", baseUrl: "https://gateway.example/go" },
        "kimi-k3": { id: "kimi-k3", baseUrl: "https://gateway.example/go" },
      },
      "openai-completions": {
        "glm-5.2": { id: "glm-5.2", baseUrl: "https://gateway.example/go/v1" },
      },
    }),
    "utf8",
  );
  return prefix;
}

const REMOTE_LIST = (data: unknown[]) => ({ ok: true, json: async () => ({ object: "list", data }) }) as any;

describe("sync-models", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-sync-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.TEST_GATEWAY_KEY;
  });

  it("returns empty providers when settings.yaml is absent", async () => {
    const providers = await getProvidersInfo(tmpDir);
    expect(providers).toEqual([]);
  });

  it("reads providers from the engine's llm-pi-ai schema", async () => {
    writeSettings(tmpDir, {
      "llm-pi-ai": { providers: { "opencode-go": { apiKeyEnv: "OPENCODE_GO_API_KEY" } } },
    });
    const prefix = makePrefix(tmpDir, "opencode-go");
    const providers = await getProvidersInfo(tmpDir, prefix);
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe("opencode-go");
    expect(providers[0].baseURL).toBe("https://gateway.example/go");
    expect(providers[0].modelCount).toBe(3); // catalog default when no models list
  });

  it("skips sync when no providers are configured", async () => {
    writeSettings(tmpDir, { "agent-default-model": { provider: "x" } });
    const res = await syncAllProviderModels(tmpDir, makePrefix(tmpDir, "opencode-go"));
    expect(res.success).toBe(true);
    expect(res.count).toBe(0);
  });

  it("puts catalog-unknown models on a companion route and leaves the parent untouched", async () => {
    writeSettings(tmpDir, {
      "llm-pi-ai": { providers: { "opencode-go": { apiKeyEnv: "TEST_GATEWAY_KEY" } } },
    });
    process.env.TEST_GATEWAY_KEY = "sk-test";
    const prefix = makePrefix(tmpDir, "opencode-go");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "https://gateway.example/go/v1/models") {
        return REMOTE_LIST([
          { id: "minimax-m3" }, // in catalog
          { id: "glm-5.2" }, // in catalog
          { id: "minimax-m2.5" }, // gateway-new
          { id: "kimi-k2.5" }, // gateway-new
        ]);
      }
      return { ok: false } as any;
    }));

    const res = await syncAllProviderModels(tmpDir, prefix);
    expect(res.success).toBe(true);
    expect(res.count).toBe(2);

    const providers = readSettings(tmpDir)["llm-pi-ai"].providers;
    // Parent route untouched: no models key injected, catalog keeps serving.
    expect(providers["opencode-go"]).toEqual({ apiKeyEnv: "TEST_GATEWAY_KEY" });
    // Companion route in the hand-declared shape the engine's UI writes.
    expect(providers["opencode-go-sync"]).toEqual({
      displayName: "opencode-go-sync",
      apiKeyEnv: "TEST_GATEWAY_KEY",
      api: "anthropic-messages", // dominant catalog protocol (2 of 3 fixture models)
      baseURL: "https://gateway.example/go", // that protocol's endpoint
      models: [{ id: "minimax-m2.5" }, { id: "kimi-k2.5" }],
    });
  });

  it("strips 0.2.5 poison: per-entry api/baseURL removed, unknown ids relocated", async () => {
    writeSettings(tmpDir, {
      "llm-pi-ai": {
        providers: {
          "opencode-go": {
            apiKeyEnv: "TEST_GATEWAY_KEY",
            models: [
              { id: "minimax-m3", api: "openai-completions", baseURL: "https://bad" }, // poisoned, catalog-known
              { id: "ghost-model", api: "openai-completions", baseURL: "https://bad" }, // poisoned, unknown
            ],
          },
        },
      },
    });
    const prefix = makePrefix(tmpDir, "opencode-go");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false } as any)));

    const res = await syncAllProviderModels(tmpDir, prefix);
    expect(res.success).toBe(true);
    const providers = readSettings(tmpDir)["llm-pi-ai"].providers;
    expect(providers["opencode-go"].models).toEqual([{ id: "minimax-m3" }]);
    expect(providers["opencode-go-sync"].models).toEqual([{ id: "ghost-model" }]);
  });

  it("appends unknown ids to a hand-declared provider's own models", async () => {
    writeSettings(tmpDir, {
      "llm-pi-ai": {
        providers: {
          "my-gateway": {
            apiKeyEnv: "TEST_GATEWAY_KEY",
            api: "openai-completions",
            baseURL: "https://my.example/v1",
            models: [{ id: "custom-one" }],
          },
        },
      },
    });
    process.env.TEST_GATEWAY_KEY = "sk-test";
    vi.stubGlobal("fetch", vi.fn(async () =>
      REMOTE_LIST([{ id: "custom-one" }, { id: "custom-two" }]),
    ));

    const res = await syncAllProviderModels(tmpDir, makePrefix(tmpDir, "opencode-go"));
    expect(res.count).toBe(1);
    const provider = readSettings(tmpDir)["llm-pi-ai"].providers["my-gateway"];
    expect(provider.models).toEqual([{ id: "custom-one" }, { id: "custom-two" }]);
    expect(provider.api).toBe("openai-completions");
    expect(provider.baseURL).toBe("https://my.example/v1");
  });

  it("never edits a user-curated models list on a catalog provider", async () => {
    writeSettings(tmpDir, {
      "llm-pi-ai": {
        providers: {
          "opencode-go": {
            apiKeyEnv: "TEST_GATEWAY_KEY",
            models: [{ id: "my-custom-model", name: "Custom" }],
          },
        },
      },
    });
    process.env.TEST_GATEWAY_KEY = "sk-test";
    const prefix = makePrefix(tmpDir, "opencode-go");
    vi.stubGlobal("fetch", vi.fn(async () => REMOTE_LIST([{ id: "my-custom-model" }, { id: "brand-new" }])));

    await syncAllProviderModels(tmpDir, prefix);
    const providers = readSettings(tmpDir)["llm-pi-ai"].providers;
    expect(providers["opencode-go"].models).toEqual([{ id: "my-custom-model", name: "Custom" }]);
    expect(providers["opencode-go-sync"].models).toEqual([{ id: "brand-new" }]);
  });

  it("resolves the api key from .credentials.yaml when the env var is unset", async () => {
    writeSettings(tmpDir, {
      "llm-pi-ai": { providers: { "opencode-go": { apiKeyEnv: "TEST_GATEWAY_KEY" } } },
    });
    fs.writeFileSync(
      path.join(tmpDir, ".credentials.yaml"),
      "version: 1\nrefs:\n  TEST_GATEWAY_KEY: sk-from-file\n",
      "utf8",
    );
    const prefix = makePrefix(tmpDir, "opencode-go");
    const auths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      auths.push(init?.headers?.Authorization || "");
      return { ok: false } as any;
    }));
    await syncAllProviderModels(tmpDir, prefix);
    expect(auths[0]).toBe("Bearer sk-from-file");
  });

  it("does not rewrite settings.yaml when nothing changes", async () => {
    writeSettings(tmpDir, {
      "llm-pi-ai": { providers: { "opencode-go": { apiKeyEnv: "TEST_GATEWAY_KEY" } } },
    });
    const prefix = makePrefix(tmpDir, "opencode-go");
    vi.stubGlobal("fetch", vi.fn(async () => REMOTE_LIST([{ id: "minimax-m3" }]))); // all catalog-known
    const before = fs.readFileSync(path.join(tmpDir, "settings.yaml"), "utf8");
    const res = await syncAllProviderModels(tmpDir, prefix);
    expect(res.count).toBe(0);
    expect(res.providers).toEqual([]);
    expect(fs.readFileSync(path.join(tmpDir, "settings.yaml"), "utf8")).toBe(before);
  });

  it("probes /models as fallback when /v1/models serves no JSON list", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "https://gw.example/v1/models") return { ok: true, json: async () => ({ hello: "html" }) } as any;
      if (url === "https://gw.example/models") {
        return { ok: true, json: async () => ({ models: [{ name: "via-openai-path" }] }) } as any;
      }
      return { ok: false } as any;
    }));
    const ids = await fetchRemoteModelIds("https://gw.example", "sk-k");
    expect(ids).toEqual(["via-openai-path"]);
  });
});
