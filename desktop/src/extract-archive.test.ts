import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractNodeArchive, extractTarGz } from "./extract-archive";
import { unzipTo } from "./unzip-zip";
import { cleanStaleNodeArchives } from "./node-runtime";

const temps: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dsh-extract-"));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("extract Node archives without system xz", () => {
  it("unpacks a gzip tarball that contains a file and a symlink", async () => {
    const root = await tempDir();
    const src = path.join(root, "src", "node-v1-linux-x64");
    await mkdir(path.join(src, "bin"), { recursive: true });
    await writeFile(path.join(src, "bin", "node"), "#!/bin/sh\necho v22\n", { mode: 0o755 });
    execFileSync("ln", ["-s", "node", "npm"], { cwd: path.join(src, "bin") });
    const archive = path.join(root, "node.tgz");
    execFileSync("tar", ["-czf", archive, "-C", path.join(root, "src"), "node-v1-linux-x64"]);
    const dest = path.join(root, "out");
    const names = await extractTarGz(await readFile(archive), dest);
    expect(names.some((name) => name.endsWith("bin/node"))).toBe(true);
    expect(await readFile(path.join(dest, "node-v1-linux-x64", "bin", "node"), "utf8")).toContain("v22");
  });

  it("routes zip and tar.gz by file name", async () => {
    const root = await tempDir();
    const zipDest = path.join(root, "zip");
    await expect(extractNodeArchive(Buffer.from("not-a-zip"), zipDest, "node.zip")).rejects.toThrow(/zip|small/i);
    await expect(extractNodeArchive(Buffer.from("nope"), root, "node.tar.xz")).rejects.toThrow("不支持");
  });

  it("writes a no-fuse launcher next to each AppImage", async () => {
    const root = await tempDir();
    const appImage = path.join(root, "DeepSeek-0.1.18-linux-x86_64.AppImage");
    await writeFile(appImage, "fake-appimage");
    const writeAppImageLauncher = require("../scripts/write-appimage-launcher.cjs") as (context: {
      artifactPaths: string[];
    }) => Promise<string[]>;
    const extra = await writeAppImageLauncher({ artifactPaths: [appImage] });
    expect(extra[0]).toMatch(/linux-x86_64-no-fuse\.sh$/);
    const body = await readFile(extra[0], "utf8");
    expect(body).toContain("APPIMAGE_EXTRACT_AND_RUN=1");
    expect(body).toContain("DeepSeek-0.1.18-linux-x86_64.AppImage");
  });

  it("deletes leftover Node archives from a failed first run", async () => {
    const cache = await tempDir();
    await writeFile(path.join(cache, "node-v22.23.2-linux-x64.tar.xz"), "half");
    await writeFile(path.join(cache, "node-v22.23.2-linux-x64.tar.gz"), "half");
    await writeFile(path.join(cache, "keep.txt"), "ok");
    await cleanStaleNodeArchives(cache);
    await expect(readFile(path.join(cache, "keep.txt"), "utf8")).resolves.toBe("ok");
    await expect(readFile(path.join(cache, "node-v22.23.2-linux-x64.tar.gz"), "utf8")).rejects.toThrow();
  });
});

describe("unzip still works for Windows Node zips", () => {
  it("exports unzipTo", () => {
    expect(typeof unzipTo).toBe("function");
  });
});
