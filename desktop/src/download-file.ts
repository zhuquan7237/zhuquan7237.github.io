import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { formatByteProgress, resolveDownloadTotal, shouldLogDownloadProgress } from "./util";

export const DEFAULT_DOWNLOAD_STALL_MS = 45_000;

export type DownloadFetcher = (
  input: string,
  init?: { headers?: Record<string, string>; redirect?: "follow" | "error" | "manual"; signal?: AbortSignal },
) => Promise<Response>;

export interface DownloadToFileOptions {
  /** Fallback total when the response has no Content-Length (GitHub 302 hops report 0). */
  knownSize?: number;
  /** Abort when no new bytes arrive for this long, so a hung connect or a
   *  stalled transfer cannot leave the splash on "downloading" forever. */
  stallMs?: number;
  /** Error thrown when the transfer stalls. */
  stallMessage?: string;
}

function stalledRejection(signal: AbortSignal, message: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(new Error(message));
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
}

/**
 * Stream a URL to disk with write backpressure, progress logs, and a stall
 * abort. Shared by the Node sidecar download and the desktop installer updater;
 * a stalled mirror is reported as an error so the caller can try the next one.
 */
export async function downloadToFile(
  url: string,
  dest: string,
  onLog: (line: string) => void,
  fetcher: DownloadFetcher,
  options: DownloadToFileOptions = {},
): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  const stallMs = options.stallMs ?? DEFAULT_DOWNLOAD_STALL_MS;
  const stallMessage =
    options.stallMessage ?? `下载停住了：${url} 超过 ${Math.round(stallMs / 1000)} 秒没有新数据`;
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

  const aborted = stalledRejection(ac.signal, stallMessage);
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
    if (ac.signal.aborted) throw new Error(stallMessage);
    throw error;
  } finally {
    stopStall();
  }
}
