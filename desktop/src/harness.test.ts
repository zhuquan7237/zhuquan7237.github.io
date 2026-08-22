import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { completeEnginePeers, missingEnginePeers, peerRepairSpecs } from "./harness";

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writePkg(prefix: string, name: string, peerDependencies?: Record<string, string>): Promise<void> {
  const dir = path.join(prefix, "node_modules", ...name.split("/"));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name, peerDependencies }), "utf8");
}

async function makeEnginePrefix(root: string, withPeers: boolean): Promise<string> {
  const prefix = path.join(root, withPeers ? "complete" : "incomplete");
  await writePkg(prefix, "@deepseek-ai/dsh");
  await writePkg(prefix, "@deepseek-ai/dsh-agent-presets", {
    "@deepseek-ai/dsh-scope": "^0.1.1-rc.2",
    "@deepseek-ai/cordis-plugin-group": "^1.0.0",
  });
  if (withPeers) {
    await writePkg(prefix, "@deepseek-ai/dsh-scope");
    await writePkg(prefix, "@deepseek-ai/cordis-plugin-group");
  }
  return prefix;
}

function noopRuntime(root: string): { node: string; npm: string; npmCli: string } {
  // A no-op "npm" that exits 0 without installing anything, so repair runs
  // appear to succeed and the still-missing check is what fires.
  const noopCli = path.join(root, "noop-npm-cli.cjs");
  return { node: process.execPath, npm: "npm", npmCli: noopCli };
}

describe("engine peer completion", () => {
  it("lists declared peers that are absent from the tree", async () => {
    const root = await tempDir("ds-peers-missing-");
    const prefix = await makeEnginePrefix(root, false);
    expect(await missingEnginePeers(prefix)).toEqual([
      "@deepseek-ai/cordis-plugin-group",
      "@deepseek-ai/dsh-scope",
    ]);
  });

  it("reports nothing when every declared peer is installed", async () => {
    const root = await tempDir("ds-peers-complete-");
    const prefix = await makeEnginePrefix(root, true);
    expect(await missingEnginePeers(prefix)).toEqual([]);
  });

  it("survives an engine prefix without a @deepseek-ai scope", async () => {
    const root = await tempDir("ds-peers-empty-");
    expect(await missingEnginePeers(path.join(root, "nothing"))).toEqual([]);
  });

  it("pins dsh-family peers to the engine version and leaves the rest unpinned", () => {
    expect(
      peerRepairSpecs(
        ["@deepseek-ai/dsh-scope", "@deepseek-ai/cordis-plugin-group", "node-addon-api"],
        "0.1.1-rc.2",
      ),
    ).toEqual(["@deepseek-ai/dsh-scope@0.1.1-rc.2", "@deepseek-ai/cordis-plugin-group", "node-addon-api"]);
  });

  it("completion is a no-op that never spawns npm when nothing is missing", async () => {
    const root = await tempDir("ds-peers-noop-");
    await writeFile(path.join(root, "noop-npm-cli.cjs"), "process.exit(0)\n", "utf8");
    const prefix = await makeEnginePrefix(root, true);
    const logs: string[] = [];
    await completeEnginePeers(noopRuntime(root), { version: "0.1.1-rc.2", prefix }, "", (line) => logs.push(line));
    expect(logs).toEqual([]);
  });

  it("completion fails loudly when peers are still missing after the install run", async () => {
    const root = await tempDir("ds-peers-fail-");
    await writeFile(path.join(root, "noop-npm-cli.cjs"), "process.exit(0)\n", "utf8");
    const prefix = await makeEnginePrefix(root, false);
    await expect(
      completeEnginePeers(noopRuntime(root), { version: "0.1.1-rc.2", prefix }, "", () => undefined),
    ).rejects.toThrow(/仍缺/);
  });
});
