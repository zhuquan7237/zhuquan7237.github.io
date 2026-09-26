import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_DOWNLOAD_ORIGIN,
  DESKTOP_DOWNLOAD_PAGE,
  DESKTOP_LATEST_MANIFEST,
  DESKTOP_RELEASES_LATEST,
  domainInstallerUrl,
  downloadDesktopAsset,
  downloadDesktopAssetFromMirrors,
  downloadStallMessage,
  fetchLatestDesktopRelease,
  githubInstallerUrl,
  installerDownloadUrls,
  parseDesktopReleaseTag,
  parseGithubRelease,
  parseLatestManifest,
  pickDesktopAsset,
  scoreDesktopAsset,
  shouldPromptDesktopUpdate,
} from "./desktop-update";

const releaseAssets = [
  "DeepSeek-0.1.8-win.exe",
  "DeepSeek-0.1.8-win-x64.exe",
  "DeepSeek-0.1.8-win-arm64.exe",
  "DeepSeek-0.1.8-win-x64.zip",
  "DeepSeek-0.1.8-mac-arm64.dmg",
  "DeepSeek-0.1.8-mac-arm64.zip",
  "DeepSeek-0.1.8-mac-x64.dmg",
  "DeepSeek-0.1.8-linux-x64.tar.gz",
  "DeepSeek-0.1.8-linux-amd64.deb",
  "DeepSeek-0.1.8-linux-x86_64.AppImage",
  "DeepSeek-0.1.8-linux-arm64.tar.gz",
].map((name) => ({ name, url: `https://example.test/${name}`, size: 1 }));

describe("domain installer URLs", () => {
  it("puts the file on dsh.zhuquan.xyz and keeps GitHub as fallback", () => {
    expect(domainInstallerUrl("DeepSeek-0.1.16-win.exe")).toBe(
      "https://dsh.zhuquan.xyz/dl/DeepSeek-0.1.16-win.exe",
    );
    expect(githubInstallerUrl("0.1.16", "DeepSeek-0.1.16-win.exe")).toContain(
      "/releases/download/desktop-v0.1.16/DeepSeek-0.1.16-win.exe",
    );
    expect(installerDownloadUrls("DeepSeek-0.1.16-win.exe", "0.1.16")).toEqual([
      "https://dsh.zhuquan.xyz/dl/DeepSeek-0.1.16-win.exe",
      "https://github.com/zhuquan7237/zhuquan7237.github.io/releases/download/desktop-v0.1.16/DeepSeek-0.1.16-win.exe",
    ]);
    expect(DESKTOP_LATEST_MANIFEST).toBe("https://dsh.zhuquan.xyz/dl/latest.json");
    expect(DESKTOP_DOWNLOAD_ORIGIN).toBe("https://dsh.zhuquan.xyz");
  });

  it("reads the domain latest.json manifest", () => {
    const release = parseLatestManifest({
      version: "0.1.16",
      tag: "desktop-v0.1.16",
      assets: [
        {
          name: "DeepSeek-0.1.16-win.exe",
          url: "https://dsh.zhuquan.xyz/dl/DeepSeek-0.1.16-win.exe",
          github: "https://github.com/zhuquan7237/zhuquan7237.github.io/releases/download/desktop-v0.1.16/DeepSeek-0.1.16-win.exe",
          size: 12,
        },
      ],
    });
    expect(release.version).toBe("0.1.16");
    expect(release.assets[0]?.url).toContain("dsh.zhuquan.xyz/dl/");
  });

  it("falls through to the next mirror when the first host fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-mirror-"));
    const dest = path.join(dir, "DeepSeek-0.1.16-win.exe");
    const logs: string[] = [];
    try {
      await downloadDesktopAssetFromMirrors(
        ["https://example.test/down", "https://example.test/ok"],
        dest,
        (line) => logs.push(line),
        async (url) => {
          if (url.includes("/down")) throw new Error("blocked");
          return bytesResponse([new Uint8Array(8).fill(3)], { "content-length": "8" });
        },
      );
      expect(logs.some((line) => line.includes("example.test"))).toBe(true);
      expect(logs.some((line) => line.includes("备用地址"))).toBe(true);
      expect(await readFile(dest)).toHaveLength(8);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("desktop GitHub release picker", () => {
  it("reads desktop-v tags", () => {
    expect(parseDesktopReleaseTag("desktop-v0.1.9")).toBe("0.1.9");
    expect(parseDesktopReleaseTag("v0.1.9")).toBe("0.1.9");
    expect(parseDesktopReleaseTag("0.1.9")).toBe("0.1.9");
  });

  it("asks once per newer desktop version", () => {
    expect(shouldPromptDesktopUpdate("0.1.8", "0.1.9", "")).toBe(true);
    expect(shouldPromptDesktopUpdate("0.1.9", "0.1.9", "")).toBe(false);
    expect(shouldPromptDesktopUpdate("0.1.8", "0.1.9", "0.1.9")).toBe(false);
    expect(shouldPromptDesktopUpdate("0.1.9", "0.1.8", "")).toBe(false);
  });

  it("picks the installer for the running OS, not a zip", () => {
    expect(pickDesktopAsset(releaseAssets, "win32", "x64")?.name).toBe("DeepSeek-0.1.8-win.exe");
    expect(pickDesktopAsset(releaseAssets, "win32", "arm64")?.name).toBe("DeepSeek-0.1.8-win-arm64.exe");
    expect(pickDesktopAsset(releaseAssets, "darwin", "arm64")?.name).toBe("DeepSeek-0.1.8-mac-arm64.dmg");
    expect(pickDesktopAsset(releaseAssets, "darwin", "x64")?.name).toBe("DeepSeek-0.1.8-mac-x64.dmg");
    expect(pickDesktopAsset(releaseAssets, "linux", "x64")?.name).toBe("DeepSeek-0.1.8-linux-x64.tar.gz");
    expect(pickDesktopAsset(releaseAssets, "linux", "arm64")?.name).toBe("DeepSeek-0.1.8-linux-arm64.tar.gz");
  });

  it("does not pick a Windows build on macOS", () => {
    expect(scoreDesktopAsset("DeepSeek-0.1.8-win.exe", "darwin", "arm64")).toBe(-1);
    expect(pickDesktopAsset(releaseAssets.filter((a) => a.name.includes("win")), "darwin", "arm64")).toBeNull();
  });

  it("parses a GitHub release payload", () => {
    const release = parseGithubRelease({
      tag_name: "desktop-v0.1.9",
      html_url: "https://github.com/zhuquan7237/zhuquan7237.github.io/releases/tag/desktop-v0.1.9",
      body: "notes",
      assets: [{ name: "DeepSeek-0.1.9-mac-arm64.dmg", browser_download_url: "https://example.test/a.dmg", size: 12 }],
    });
    expect(release.version).toBe("0.1.9");
    expect(release.assets[0]?.name).toContain("mac-arm64.dmg");
  });
});

function bytesResponse(
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
  delayMs = 0,
): Response {
  let index = 0;
  return {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    body: {
      getReader() {
        return {
          async read() {
            if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
            if (index >= chunks.length) return { done: true as const, value: undefined };
            const value = chunks[index];
            index += 1;
            return { done: false as const, value };
          },
        };
      },
    },
  } as unknown as Response;
}

describe("desktop installer download", () => {
  it("reports start, first bytes, and 1% steps instead of sitting on 0%", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-update-"));
    const dest = path.join(dir, "DeepSeek-0.1.15-win.exe");
    const total = 10 * 1048576;
    const logs: string[] = [];
    const first = 100_000;
    const chunks = [new Uint8Array(first).fill(1), new Uint8Array(total - first).fill(2)];
    try {
      await downloadDesktopAsset(
        "https://example.test/DeepSeek-0.1.15-win.exe",
        dest,
        (line) => logs.push(line),
        async () => bytesResponse(chunks, { "content-length": String(total) }),
      );
      expect(logs[0]).toContain("开始下载 DeepSeek-0.1.15-win.exe");
      expect(logs.some((line) => line.includes("已连接"))).toBe(true);
      expect(logs.some((line) => line.includes("0%（0.1 MB"))).toBe(true);
      expect(logs.some((line) => line.includes("100%"))).toBe(true);
      expect(await readFile(dest)).toHaveLength(total);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses the GitHub asset size when the 302 hop has no Content-Length", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-update-"));
    const dest = path.join(dir, "DeepSeek-0.1.15-win.exe");
    const knownSize = 4 * 1048576;
    const logs: string[] = [];
    try {
      await downloadDesktopAsset(
        "https://example.test/DeepSeek-0.1.15-win.exe",
        dest,
        (line) => logs.push(line),
        async () => bytesResponse([new Uint8Array(knownSize).fill(7)]),
        { knownSize },
      );
      expect(logs.some((line) => line.includes("100%（4.0 MB / 4.0 MB）"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("times out a hung GitHub connect and a hung first chunk", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-update-"));
    const dest = path.join(dir, "DeepSeek-0.1.15-win.exe");
    try {
      await expect(
        downloadDesktopAsset(
          "https://example.test/DeepSeek-0.1.15-win.exe",
          dest,
          () => undefined,
          async () => new Promise(() => undefined),
          { stallMs: 40 },
        ),
      ).rejects.toThrow(downloadStallMessage());
      await expect(
        downloadDesktopAsset(
          "https://example.test/DeepSeek-0.1.15-win.exe",
          dest,
          () => undefined,
          async () => bytesResponse([new Uint8Array(16).fill(1)], {}, 200),
          { stallMs: 40 },
        ),
      ).rejects.toThrow(downloadStallMessage());
      expect(downloadStallMessage()).toContain(DESKTOP_DOWNLOAD_PAGE);
      await expect(stat(dest)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("GitHub latest release", () => {
  it("points at the public repo and can read the current latest tag", async () => {
    expect(DESKTOP_RELEASES_LATEST).toContain("zhuquan7237/zhuquan7237.github.io");
    const latest = await fetchLatestDesktopRelease();
    expect(latest.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(pickDesktopAsset(latest.assets, "darwin", "arm64")?.name).toMatch(/mac-arm64\.dmg$/);
    expect(pickDesktopAsset(latest.assets, "win32", "x64")?.name).toMatch(/win.*\.exe$/);
    expect(pickDesktopAsset(latest.assets, "linux", "x64")?.name).toMatch(/linux-x64\.tar\.gz$/);
  });

  it("serves a published Windows installer from the custom domain", async () => {
    const response = await fetch("https://dsh.zhuquan.xyz/dl/DeepSeek-0.1.15-win.exe", { method: "HEAD" });
    expect(response.ok).toBe(true);
    expect(Number(response.headers.get("content-length") || 0)).toBeGreaterThan(10_000_000);
    expect(response.headers.get("content-disposition") || "").toContain("DeepSeek-0.1.15-win.exe");
  });
});
