import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import { getProvidersInfo, syncAllProviderModels } from "./sync-models";

describe("sync-models", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-sync-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty providers when settings.yaml is absent", async () => {
    const providers = await getProvidersInfo(tmpDir);
    expect(providers).toEqual([]);
  });

  it("parses providers and model counts correctly", async () => {
    const settings = {
      models: {
        providers: [
          {
            id: "opencode",
            name: "OpenCode Go",
            baseURL: "https://opencode.ai/zen/go/v1",
            models: [{ id: "minimax-m3" }, { id: "gpt-4o" }],
          },
        ],
      },
    };
    fs.writeFileSync(path.join(tmpDir, "settings.yaml"), yaml.dump(settings), "utf8");

    const providers = await getProvidersInfo(tmpDir);
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe("opencode");
    expect(providers[0].name).toBe("OpenCode Go");
    expect(providers[0].modelCount).toBe(2);
    expect(providers[0].models).toEqual(["minimax-m3", "gpt-4o"]);
  });

  it("handles missing settings file gracefully during sync", async () => {
    const result = await syncAllProviderModels(tmpDir);
    expect(result.success).toBe(false);
    expect(result.count).toBe(0);
  });
});
