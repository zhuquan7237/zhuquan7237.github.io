import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { compareVersions, formatByteProgress, shouldPromptHarnessUpdate } from "./util";

export const DESKTOP_GITHUB_REPO = "zhuquan7237/zhuquan7237.github.io";
export const DESKTOP_RELEASES_LATEST = `https://api.github.com/repos/${DESKTOP_GITHUB_REPO}/releases/latest`;

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface DesktopRelease {
  version: string;
  tag: string;
  htmlUrl: string;
  notes: string;
  assets: ReleaseAsset[];
}

export function parseDesktopReleaseTag(tag: string): string {
  const trimmed = tag.trim();
  const desktop = trimmed.match(/^desktop-v?(.+)$/i);
  if (desktop?.[1]) return desktop[1];
  return trimmed.replace(/^v/i, "");
}

export function shouldPromptDesktopUpdate(current: string, latest: string, skipped: string): boolean {
  return shouldPromptHarnessUpdate(current, latest, skipped);
}

/** Prefer a real installer over zip/portable for the running OS/arch. */
export function pickDesktopAsset(
  assets: ReleaseAsset[],
  platform: NodeJS.Platform,
  arch: string,
): ReleaseAsset | null {
  const archTokens = arch === "arm64" ? ["arm64", "aarch64"] : ["x64", "x86_64", "amd64"];
  let best: ReleaseAsset | null = null;
  let bestScore = -1;
  for (const asset of assets) {
    const score = scoreDesktopAsset(asset.name, platform, arch, archTokens);
    if (score > bestScore) {
      best = asset;
      bestScore = score;
    }
  }
  return bestScore >= 0 ? best : null;
}

export function scoreDesktopAsset(
  name: string,
  platform: NodeJS.Platform,
  arch: string,
  archTokens = arch === "arm64" ? ["arm64", "aarch64"] : ["x64", "x86_64", "amd64"],
): number {
  const n = name.toLowerCase();
  if (platform === "win32") {
    if (!n.includes("win") || !n.endsWith(".exe")) return -1;
    let score = 10;
    if (/-win\.exe$/.test(n)) score += 50;
    if (arch === "arm64" && n.includes("arm64")) score += 80;
    if (arch !== "arm64" && n.includes("x64")) score += 30;
    return score;
  }
  if (platform === "darwin") {
    if (!n.includes("mac") && !n.includes("darwin")) return -1;
    if (n.endsWith(".dmg")) {
      /* preferred */
    } else if (n.endsWith(".zip")) {
      /* fallback */
    } else {
      return -1;
    }
    let score = n.endsWith(".dmg") ? 50 : 20;
    if (archTokens.some((token) => n.includes(token))) score += 40;
    else score -= 25;
    return score;
  }
  if (!n.includes("linux")) return -1;
  let score = 0;
  if (n.endsWith(".tar.gz")) score += 50;
  else if (n.endsWith(".deb")) score += 30;
  else if (n.endsWith(".appimage")) score += 10;
  else return -1;
  if (archTokens.some((token) => n.includes(token))) score += 40;
  else score -= 25;
  return score;
}

export function parseGithubRelease(data: {
  tag_name?: string;
  html_url?: string;
  body?: string;
  assets?: Array<{ name?: string; browser_download_url?: string; size?: number }>;
}): DesktopRelease {
  const tag = data.tag_name || "";
  const version = parseDesktopReleaseTag(tag);
  if (!version) throw new Error("GitHub Release 没有 desktop-v 版本号");
  return {
    version,
    tag,
    htmlUrl: data.html_url || `https://github.com/${DESKTOP_GITHUB_REPO}/releases/latest`,
    notes: (data.body || "").trim(),
    assets: (data.assets || [])
      .filter((asset) => asset.name && asset.browser_download_url)
      .map((asset) => ({
        name: asset.name as string,
        url: asset.browser_download_url as string,
        size: Number(asset.size || 0),
      })),
  };
}

export async function fetchLatestDesktopRelease(fetcher: typeof fetch = fetch): Promise<DesktopRelease> {
  const response = await fetcher(DESKTOP_RELEASES_LATEST, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "DeepSeek-Desktop",
    },
  });
  if (!response.ok) throw new Error(`GitHub Release ${response.status}`);
  return parseGithubRelease((await response.json()) as Parameters<typeof parseGithubRelease>[0]);
}

export async function downloadDesktopAsset(
  url: string,
  dest: string,
  onLog: (line: string) => void,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  const response = await fetcher(url, {
    headers: { "User-Agent": "DeepSeek-Desktop", Accept: "application/octet-stream" },
    redirect: "follow",
  });
  if (!response.ok || !response.body) {
    throw new Error(`下载失败 ${response.status}: ${url}`);
  }
  const total = Number(response.headers.get("content-length") || 0);
  const file = createWriteStream(dest);
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  let downloaded = 0;
  let lastBucket = -1;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const buf = Buffer.from(value);
      await new Promise<void>((resolve, reject) => {
        file.write(buf, (error) => (error ? reject(error) : resolve()));
      });
      downloaded += buf.length;
      const bucket = total > 0 ? Math.floor((downloaded / total) * 10) : Math.floor(downloaded / (5 * 1048576));
      if (bucket !== lastBucket) {
        lastBucket = bucket;
        onLog(`下载进度 ${formatByteProgress(downloaded, total)}`);
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      file.end((error: NodeJS.ErrnoException | null) => (error ? reject(error) : resolve()));
    });
  }
}

export function desktopUpdateNewer(current: string, latest: string): boolean {
  return compareVersions(current, latest) < 0;
}
