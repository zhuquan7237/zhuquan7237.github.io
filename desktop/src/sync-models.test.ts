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
    expect(providers[0].models).toContain("minimax-m3");
  });

  it("skips sync when no providers are configured", async () => {
    writeSettings(tmpDir, { "agent-default-model": { provider: "x" } });
    const res = await syncAllProviderModels(tmpDir, makePrefix(tmpDir, "opencode-go"));
    expect(res.success).toBe(true);
    expect(res.count).toBe(0);
  });

  it("merges remote models: catalog-known stay minimal, unknown carry api and baseURL", async () => {
    writeSettings(tmpDir, {
      "llm-pi-ai": { providers: { "opencode-go": { apiKeyEnv: "TEST_GATEWAY_KEY" } } },
    });
    process.env.TEST_GATEWAY_KEY = "sk-test";
    const prefix = makePrefix(tmpDir, "opencode-go");

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/models")) {
        return {
          ok: true,
          json: async () => ({
            object: "list",
            data: [
              { id: "minimax-m3" }, // already in catalog
              { id: "minimax-m2.5" }, // brand new on the gateway
              { id: "glm-5.2" }, // already in catalog (openai group)
            ],
          }),
        } as any;
      }
      return { ok: false } as any;
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await syncAllProviderModels(tmpDir, prefix);
    expect(res.success).toBe(true);
    expect(res.count).toBe(1);

    const provider = readSettings(tmpDir)["llm-pi-ai"].providers["opencode-go"];
    const ids = provider.models.map((m: any) => m.id);
    expect(ids).toEqual(["minimax-m3", "kimi-k3", "glm-5.2", "minimax-m2.5"]);
    const added = provider.models.find((m: any) => m.id === "minimax-m2.5");
    expect(added).toEqual({
      id: "minimax-m2.5",
      name: "minimax-m2.5",
      api: "anthropic-messages", // dominant catalog api (2 of 3 models)
      baseURL: "https://gateway.example/go",
    });
    // request carried the key resolved from the env var named by apiKeyEnv
    expect(fetchMock.mock.calls[0][0]).toBe("https://gateway.example/go/v1/models");
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
      auths.push(init?.headers?.Authorization || init?.headers?.["x-api-key"] || "");
      return { ok: false } as any;
    }));
    await syncAllProviderModels(tmpDir, prefix);
    expect(auths[0]).toBe("Bearer sk-from-file");
  });

  it("only appends to a user-curated models list and keeps other settings intact", async () => {
    writeSettings(tmpDir, {
      "ui-onboarding": { welcomeNoticeVersion: "1" },
      "llm-pi-ai": {
        providers: {
          "opencode-go": {
            apiKeyEnv: "TEST_GATEWAY_KEY",
            models: [{ id: "my-custom-model", name: "Custom" }],
          },
        },
      },
      "agent-default-model": { provider: "opencode-go", model: "my-custom-model" },
    });
    process.env.TEST_GATEWAY_KEY = "sk-test";
    const prefix = makePrefix(tmpDir, "opencode-go");
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "my-custom-model" }, { id: "kimi-k3" }] }),
    } as any)));

    const res = await syncAllProviderModels(tmpDir, prefix);
    expect(res.count).toBe(1);
    const settings = readSettings(tmpDir);
    const models = settings["llm-pi-ai"].providers["opencode-go"].models;
    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({ id: "my-custom-model", name: "Custom" }); // untouched
    expect(settings["agent-default-model"].model).toBe("my-custom-model"); // untouched
  });

  it("does not rewrite settings.yaml when nothing new arrives", async () => {
    writeSettings(tmpDir, {
      "llm-pi-ai": { providers: { "opencode-go": { apiKeyEnv: "TEST_GATEWAY_KEY" } } },
    });
    const prefix = makePrefix(tmpDir, "opencode-go");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false } as any)));
    const before = fs.readFileSync(path.join(tmpDir, "settings.yaml"), "utf8");
    const res = await syncAllProviderModels(tmpDir, prefix);
    expect(res.count).toBe(0);
    expect(fs.readFileSync(path.join(tmpDir, "settings.yaml"), "utf8")).toBe(before);
  });

  it("skips providers without any resolvable baseURL", async () => {
    writeSettings(tmpDir, {
      "llm-pi-ai": { providers: { "mystery-provider": { apiKeyEnv: "TEST_GATEWAY_KEY" } } },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await syncAllProviderModels(tmpDir, makePrefix(tmpDir, "opencode-go"));
    expect(res.count).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
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
