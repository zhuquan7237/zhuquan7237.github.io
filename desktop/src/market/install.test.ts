import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import type { MarketEntry } from "./catalog";
import {
  MARKET_BLOCK_BEGIN,
  MARKET_BLOCK_END,
  buildInventory,
  declaresBundlePatch,
  lastMeaningfulLine,
  mergeMarketBlock,
  parseMarketDisabled,
  pluginAddArgs,
  pluginRemoveArgs,
  qualifyEntry,
  renderMarketBlock,
  runPluginCommand,
} from "./install";

function entry(overrides: Partial<MarketEntry> = {}): MarketEntry {
  return {
    id: "o/r/packages/p",
    name: "p",
    owner: "o",
    repoUrl: "https://github.com/o/r",
    description: { en: "", zh: "" },
    categoryId: "ui",
    npmPackage: "dsh-pet",
    displayCommand: "dsh plugin --profile web add dsh-pet",
    revision: "1.0.0",
    stars: 0,
    installs: 0,
    added: "",
    pushedAt: "",
    sourceId: "dsh1024",
    ...overrides,
  };
}

function npmReply(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

/** spawn stand-in that emits the given output and exit code. */
function fakeSpawn(code: number, stdout: string, stderr = "") {
  const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const impl = ((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    calls.push({ command, args, env: options.env });
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setTimeout(() => {
      child.stdout.write(stdout);
      if (stderr) child.stderr.write(stderr);
      child.emit("close", code);
    }, 0);
    return child;
  }) as unknown as typeof spawn;
  return { impl, calls };
}

describe("qualification", () => {
  it("accepts a stable package that declares dsh.bundle.patch", async () => {
    const result = await qualifyEntry(entry(), {
      fetchImpl: npmReply({ name: "dsh-pet", version: "2.3.4", dsh: { bundle: { patch: "cordis.patch.yml" } } }),
    });
    expect(result).toEqual({ ok: true, packageName: "dsh-pet", version: "2.3.4", spec: "dsh-pet@2.3.4" });
  });

  it("refuses a browse-only entry without contacting npm", async () => {
    let contacted = false;
    const spy = (async () => {
      contacted = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await qualifyEntry(entry({ npmPackage: "" }), { fetchImpl: spy });
    expect(result.ok).toBe(false);
    expect(contacted).toBe(false);
  });

  it("refuses name mismatches, unstable versions and missing bundle patches", async () => {
    await expect(qualifyEntry(entry(), { fetchImpl: npmReply({ name: "other", version: "1.0.0" }) })).resolves.toMatchObject(
      { ok: false },
    );
    await expect(
      qualifyEntry(entry(), { fetchImpl: npmReply({ name: "dsh-pet", version: "1.0.0-beta.1", dsh: { bundle: { patch: "x" } } }) }),
    ).resolves.toMatchObject({ ok: false });
    const noBundle = await qualifyEntry(entry(), { fetchImpl: npmReply({ name: "dsh-pet", version: "1.0.0" }) });
    expect(noBundle).toEqual({ ok: false, reason: "该包没有声明 dsh.bundle.patch，装进 profile 也不会作为插件加载" });
  });

  it("reports npm transport failures as reasons", async () => {
    await expect(qualifyEntry(entry(), { fetchImpl: npmReply({}, 404) })).resolves.toMatchObject({
      reason: "npm 上没有 dsh-pet 这个包",
    });
    await expect(qualifyEntry(entry(), { fetchImpl: npmReply({}, 500) })).resolves.toMatchObject({
      reason: "npm 返回 HTTP 500",
    });
    const boom = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(qualifyEntry(entry(), { fetchImpl: boom })).resolves.toMatchObject({ reason: expect.stringContaining("offline") });
  });

  it("requires a real patch declaration shape", () => {
    expect(declaresBundlePatch({ dsh: { bundle: { patch: "cordis.patch.yml" } } })).toBe(true);
    expect(declaresBundlePatch({ dsh: { bundle: {} } })).toBe(false);
    expect(declaresBundlePatch({ dsh: {} })).toBe(false);
    expect(declaresBundlePatch({})).toBe(false);
    expect(declaresBundlePatch({ dsh: { bundle: { patch: "   " } } })).toBe(false);
  });
});

describe("engine CLI arguments", () => {
  it("always targets the desktop's own profile", () => {
    expect(pluginAddArgs("dsh-pet@1.2.3")).toEqual(["plugin", "--profile", "web", "add", "dsh-pet@1.2.3"]);
    expect(pluginRemoveArgs("@linxin666/dsh-doctor")).toEqual([
      "plugin",
      "--profile",
      "web",
      "remove",
      "@linxin666/dsh-doctor",
    ]);
  });

  it("runs the engine with DSH_HOME pointing at the desktop home", async () => {
    const { impl, calls } = fakeSpawn(0, "Progress: resolved 12\nDone in 4s\n");
    const seen: string[] = [];
    const result = await runPluginCommand({
      nodePath: "node.exe",
      engineBin: "C:/engine/lib/bin.js",
      dshHome: "C:/home",
      args: pluginAddArgs("dsh-pet@1.2.3"),
      spawnImpl: impl,
      onOutput: (chunk) => seen.push(chunk),
    });
    expect(result.code).toBe(0);
    expect(result.output).toContain("Done in 4s");
    expect(seen.join("")).toContain("Progress");
    expect(calls[0].command).toBe("node.exe");
    expect(calls[0].args).toEqual(["C:/engine/lib/bin.js", "plugin", "--profile", "web", "add", "dsh-pet@1.2.3"]);
    expect(calls[0].env.DSH_HOME).toBe("C:/home");
  });

  it("keeps the tail of a failing run and names the last real line", async () => {
    const { impl } = fakeSpawn(1, "Progress: resolved 3\nnpm ERR! 404 Not Found\n", "ERR_PNPM_FETCH_404");
    const result = await runPluginCommand({
      nodePath: "node.exe",
      engineBin: "C:/engine/lib/bin.js",
      dshHome: "C:/home",
      args: pluginRemoveArgs("dsh-pet"),
      spawnImpl: impl,
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("ERR_PNPM_FETCH_404");
    expect(lastMeaningfulLine("Progress: resolved 3\n\n*** ERR_PNPM_FETCH_404 ***\n")).toBe("*** ERR_PNPM_FETCH_404 ***");
    expect(lastMeaningfulLine("")).toBe("");
  });

  it("bounds the output tail", async () => {
    const { impl } = fakeSpawn(0, "x".repeat(40000));
    const result = await runPluginCommand({
      nodePath: "node.exe",
      engineBin: "B",
      dshHome: "H",
      args: pluginAddArgs("p"),
      spawnImpl: impl,
    });
    expect(result.output.length).toBeLessThanOrEqual(16000);
  });
});

describe("inventory", () => {
  const manifest = {
    dependencies: { "@linxin666/dsh-doctor": "^0.3.24", "dsh-pet": "1.2.3" },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@linxin666/dsh-doctor", "dsh-pet"] } },
  };

  it("marks dependencies removable, in-box bundles read-only, and disabled rows", () => {
    const patch = `${MARKET_BLOCK_BEGIN}\n- id: dsh-pet\n  disabled: true\n${MARKET_BLOCK_END}\n`;
    const inventory = buildInventory("/home", manifest, patch);
    const byName = Object.fromEntries(inventory.plugins.map((plugin) => [plugin.packageName, plugin]));
    expect(byName["@linxin666/dsh-doctor"]).toMatchObject({ version: "^0.3.24", bundle: true, removable: true, core: false });
    expect(byName["dsh-pet"]).toMatchObject({ removable: true, disabled: true });
    expect(byName["@deepseek-ai/dsh-base"]).toMatchObject({ removable: false, core: true, bundle: true });
    expect(inventory.disabled).toEqual(["dsh-pet"]);
    expect(inventory.manifestPath.replace(/\\/g, "/")).toBe("/home/profiles/web/package.json");
  });

  it("survives a missing or malformed profile", () => {
    expect(buildInventory("/home", null, "").plugins).toEqual([]);
    expect(buildInventory("/home", { dependencies: [] as unknown as Record<string, unknown> }, "").plugins).toEqual([]);
  });

  it("ignores disabled rows outside the market block", () => {
    const handWritten = "- id: someone-else\n  disabled: true\n";
    expect(parseMarketDisabled(handWritten)).toEqual([]);
    expect(parseMarketDisabled(`${MARKET_BLOCK_BEGIN}\n- id: a\n  disabled: true\n- id: b\n  disabled: false\n${MARKET_BLOCK_END}`)).toEqual(["a"]);
  });
});

describe("patch block", () => {
  const skinRows = ["# managed by DeepSeek desktop", "- id: maid-atelier", "  enabled: true"].join("\n");

  it("renders nothing when nothing is disabled, without breaking the array document", () => {
    expect(renderMarketBlock([])).toBe("");
    // A body that is already a valid empty YAML array stays valid: the engine
    // parses this file on every boot, so it is never left empty.
    expect(mergeMarketBlock("[]\n", [])).toBe("[]\n");
    expect(mergeMarketBlock("", [])).toBe("");
  });

  it("inserts a block while preserving the skin writer's rows and user rows", () => {
    const existing = `${skinRows}\n\n- id: hand-written\n  config:\n    keep: true\n`;
    const next = mergeMarketBlock(existing, ["dsh-pet", "@linxin666/dsh-doctor"]);
    expect(next).toContain("- id: maid-atelier");
    expect(next).toContain("- id: hand-written");
    expect(next).toContain(MARKET_BLOCK_BEGIN);
    expect(next).toContain("- id: dsh-pet\n  disabled: true");
    expect(next).toContain("- id: @linxin666/dsh-doctor\n  disabled: true");
    // Sorted and deduplicated so the file is stable across runs.
    expect(next.indexOf("@linxin666/dsh-doctor")).toBeLessThan(next.indexOf("- id: dsh-pet"));
  });

  it("is idempotent and removable", () => {
    const once = mergeMarketBlock(`${skinRows}\n`, ["dsh-pet"]);
    expect(mergeMarketBlock(once, ["dsh-pet"])).toBe(once);
    const cleared = mergeMarketBlock(once, []);
    expect(cleared).not.toContain(MARKET_BLOCK_BEGIN);
    expect(cleared).toContain("- id: maid-atelier");
  });

  it("replaces a stale block instead of appending a second one", () => {
    const existing = `${MARKET_BLOCK_BEGIN}\n- id: old\n  disabled: true\n${MARKET_BLOCK_END}\n`;
    const next = mergeMarketBlock(existing, ["new"]);
    expect(next.match(/desktop plugin market >>>/g)?.length).toBe(1);
    expect(next).not.toContain("- id: old");
    expect(next).toContain("- id: new");
  });
});
