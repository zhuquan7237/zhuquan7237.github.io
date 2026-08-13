import type { ToolHost } from "./agent";
import { loadFiles, saveFiles } from "./storage";
import { normalizePath, type WorkspaceSnapshot } from "./workspace";

export async function probeLocal(): Promise<boolean> {
  try {
    const response = await fetch("/__dsh/health");
    if (!response.ok) return false;
    const data = (await response.json()) as { ok?: boolean };
    return Boolean(data.ok);
  } catch {
    return false;
  }
}

export function createMemoryHost(snapshot: WorkspaceSnapshot, persist = true): ToolHost {
  const files = { ...snapshot.files };
  return {
    local: false,
    getFiles: () => files,
    setFile(path, content) {
      files[normalizePath(path)] = content;
      if (persist) saveFiles({ files });
    },
  };
}

export function restoreMemoryHost(): { host: ToolHost; snapshot: WorkspaceSnapshot } {
  const snapshot = loadFiles();
  return { host: createMemoryHost(snapshot), snapshot };
}

export function createLocalDiskHost(root: string, files: Record<string, string>): ToolHost {
  const current = { ...files };
  return {
    local: true,
    getFiles: () => current,
    async setFile(path, content) {
      const rel = normalizePath(path);
      current[rel] = content;
      const response = await fetch("/__dsh/fs/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root, path: rel, content }),
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail);
      }
    },
    async runBash(command) {
      const response = await fetch("/__dsh/bash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root, command }),
      });
      const data = (await response.json()) as { output?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "bash failed");
      return data.output ?? "";
    },
    async fetchUrl(url) {
      const response = await fetch("/__dsh/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, method: "GET", headers: {} }),
      });
      return await response.text();
    },
  };
}

export async function loadLocalDisk(root: string): Promise<{ host: ToolHost; files: Record<string, string> }> {
  const response = await fetch("/__dsh/fs/list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root }),
  });
  if (!response.ok) throw new Error(await response.text());
  const data = (await response.json()) as { files: Record<string, string> };
  return { files: data.files, host: createLocalDiskHost(root, data.files) };
}

interface DirectoryHandle {
  name: string;
  values(): AsyncIterable<FileSystemHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandle>;
}

interface FileSystemHandle {
  kind: "file" | "directory";
  name: string;
}

interface FileSystemFileHandle {
  getFile(): Promise<File>;
  createWritable(): Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }>;
}

export async function openNativeFolder(): Promise<{ name: string; host: ToolHost; files: Record<string, string> } | null> {
  const picker = (window as Window & { showDirectoryPicker?: () => Promise<DirectoryHandle> }).showDirectoryPicker;
  if (!picker) return null;
  const root = await picker();
  const files = await readDirectory(root, "");
  return {
    name: root.name,
    files,
    host: {
      local: false,
      getFiles: () => files,
      async setFile(rel, content) {
        const path = normalizePath(rel);
        files[path] = content;
        await writeNativeFile(root, path, content);
      },
    },
  };
}

async function readDirectory(dir: DirectoryHandle, prefix: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for await (const handle of dir.values()) {
    const rel = prefix ? `${prefix}/${handle.name}` : handle.name;
    if (handle.kind === "directory") {
      if (["node_modules", ".git", "dist"].includes(handle.name)) continue;
      Object.assign(files, await readDirectory(handle as unknown as DirectoryHandle, rel));
    } else {
      const file = await (handle as unknown as FileSystemFileHandle).getFile();
      if (file.size > 1_000_000) continue;
      const text = await file.text();
      if (text.includes("\u0000")) continue;
      files[rel] = text;
    }
  }
  return files;
}

async function writeNativeFile(root: DirectoryHandle, rel: string, content: string): Promise<void> {
  const parts = rel.split("/").filter(Boolean);
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  const fileName = parts.at(-1);
  if (!fileName) throw new Error("Invalid path");
  const handle = await dir.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}
