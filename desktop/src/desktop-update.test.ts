import { describe, expect, it } from "vitest";
import {
  DESKTOP_RELEASES_LATEST,
  fetchLatestDesktopRelease,
  parseDesktopReleaseTag,
  parseGithubRelease,
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

describe("GitHub latest release", () => {
  it("points at the public repo and can read the current latest tag", async () => {
    expect(DESKTOP_RELEASES_LATEST).toContain("zhuquan7237/zhuquan7237.github.io");
    const latest = await fetchLatestDesktopRelease();
    expect(latest.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(pickDesktopAsset(latest.assets, "darwin", "arm64")?.name).toMatch(/mac-arm64\.dmg$/);
    expect(pickDesktopAsset(latest.assets, "win32", "x64")?.name).toMatch(/win.*\.exe$/);
    expect(pickDesktopAsset(latest.assets, "linux", "x64")?.name).toMatch(/linux-x64\.tar\.gz$/);
  });
});
