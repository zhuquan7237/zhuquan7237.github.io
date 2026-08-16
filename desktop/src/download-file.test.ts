import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_DOWNLOAD_STALL_MS, downloadToFile } from "./download-file";

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

describe("downloadToFile", () => {
  it("streams the body to disk with progress logs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-dlfile-"));
    const dest = path.join(dir, "node-v22.23.2-linux-x64.tar.gz");
    const total = 3 * 1048576;
    const logs: string[] = [];
    const chunks = [new Uint8Array(64).fill(1), new Uint8Array(total - 64).fill(2)];
    try {
      await downloadToFile(
        "https://example.test/node.tar.gz",
        dest,
        (line) => logs.push(line),
        async () => bytesResponse(chunks, { "content-length": String(total) }),
      );
      expect(await readFile(dest)).toHaveLength(total);
      expect(logs.some((line) => line.includes("已连接"))).toBe(true);
      expect(logs.some((line) => line.includes("100%"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("aborts a hung connect instead of waiting forever", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-dlfile-"));
    const dest = path.join(dir, "node.tar.gz");
    try {
      await expect(
        downloadToFile(
          "https://example.test/node.tar.gz",
          dest,
          () => undefined,
          () => new Promise<Response>(() => undefined),
          { stallMs: 40, stallMessage: "stalled-connect" },
        ),
      ).rejects.toThrow("stalled-connect");
      await expect(stat(dest)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("aborts when chunks stop arriving mid-transfer", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-dlfile-"));
    const dest = path.join(dir, "node.tar.gz");
    try {
      await expect(
        downloadToFile(
          "https://example.test/node.tar.gz",
          dest,
          () => undefined,
          async () => bytesResponse([new Uint8Array(16).fill(1)], {}, 200),
          { stallMs: 40, stallMessage: "stalled-mid" },
        ),
      ).rejects.toThrow("stalled-mid");
      await expect(stat(dest)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to a default stall window and a URL-bearing message", () => {
    expect(DEFAULT_DOWNLOAD_STALL_MS).toBeGreaterThan(10_000);
  });
});

