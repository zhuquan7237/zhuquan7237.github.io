import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  compareVersions,
  formatByteProgress,
  resolveDownloadTotal,
  shouldLogDownloadProgress,
  shouldPromptHarnessUpdate,
} from "./util";

export const DESKTOP_GITHUB_REPO = "zhuquan7237/zhuquan7237.github.io";
export const DESKTOP_RELEASES_LATEST = `https://api.github.com/repos/${DESKTOP_GITHUB_REPO}/releases/latest`;
export const DESKTOP_DOWNLOAD_PAGE = "https://dsh.zhuquan.xyz/";
export const DOWNLOAD_IDLE_MS = 45_000;

export type HttpFetcher = (
  url: string,
  init?: { headers?: Record<string, string>; redirect?: "follow" | "error" | "manual"; signal?: AbortSignal },
) => Promise<Response>;

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

export function downloadStallMessage(): string {
  return `下载停住了：GitHub 安装包连不上或中途没有新数据。请用浏览器打开 ${DESKTOP_DOWNLOAD_PAGE} 下载（浏览器会走系统代理）。`;
}

function abortError(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(new Error(downloadStallMessage()));
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
}

export async function fetchLatestDesktopRelease(fetcher: HttpFetcher = fetch): Promise<DesktopRelease> {
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
  fetcher: HttpFetcher = fetch,
  options: { knownSize?: number; stallMs?: number } = {},
): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  const stallMs = options.stallMs ?? DOWNLOAD_IDLE_MS;
  const ac = new AbortController();
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => ac.abort(), stallMs);
  };
  const stopStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = undefined;
  };

  onLog(`开始下载 ${path.basename(dest)}`);
  const aborted = abortError(ac.signal);
  void aborted.catch(() => undefined);
  armStall();
  try {
    const response = await Promise.race([
      fetcher(url, {
        headers: { "User-Agent": "DeepSeek-Desktop", Accept: "application/octet-stream" },
        redirect: "follow",
        signal: ac.signal,
      }),
      aborted,
    ]);
    if (!response.ok || !response.body) {
      throw new Error(`下载失败 ${response.status}: ${url}`);
    }
    const total = resolveDownloadTotal(Number(response.headers.get("content-length") || 0), options.knownSize);
    onLog(`已连接，准备写入 ${formatByteProgress(0, total)}`);
    const file = createWriteStream(dest);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    let downloaded = 0;
    let lastLoggedBytes = 0;
    try {
      while (true) {
        armStall();
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        if (!value) continue;
        const buf = Buffer.from(value);
        await new Promise<void>((resolve, reject) => {
          file.write(buf, (error) => (error ? reject(error) : resolve()));
        });
        downloaded += buf.length;
        if (shouldLogDownloadProgress(downloaded, total, lastLoggedBytes)) {
          lastLoggedBytes = downloaded;
          onLog(`下载进度 ${formatByteProgress(downloaded, total)}`);
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        file.end((error: NodeJS.ErrnoException | null) => (error ? reject(error) : resolve()));
      });
    }
    if (downloaded > 0 && lastLoggedBytes !== downloaded) {
      onLog(`下载进度 ${formatByteProgress(downloaded, total)}`);
    }
  } catch (error) {
    await rm(dest, { force: true }).catch(() => undefined);
    if (ac.signal.aborted) throw new Error(downloadStallMessage());
    throw error;
  } finally {
    stopStall();
  }
}

export function desktopUpdateNewer(current: string, latest: string): boolean {
  return compareVersions(current, latest) < 0;
}
