import { spawn } from "node:child_process";
import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import {
  NODE_VERSION,
  formatByteProgress,
  hostTimeZone,
  localePrefersChina,
  nodeDistFile,
  nodeDownloadUrls,
  nodeMeetsEngine,
} from "./util";

export interface NodeRuntime {
  node: string;
  npm: string;
  /** Path to npm-cli.js when npm must be run through node instead of its shell wrapper. */
  npmCli: string | null;
  version: string;
}

export async function resolveNodeRuntime(
  cacheDir: string,
  onLog: (line: string) => void,
): Promise<NodeRuntime> {
  const system = await detectSystemNode();
  if (system && nodeMeetsEngine(system.version)) {
    onLog(`使用本机 Node ${system.version}`);
    return system;
  }
  onLog(`系统 Node 低于 22.19，改为下载官方 Node ${NODE_VERSION}（仅首次）`);
  return await installNodeSidecar(cacheDir, onLog);
}

async function detectSystemNode(): Promise<NodeRuntime | null> {
  const version = await runCapture(process.platform === "win32" ? "node.exe" : "node", ["-v"]).catch(() => "");
  if (!version) return null;
  const npm = await runCapture(process.platform === "win32" ? "npm.cmd" : "npm", ["-v"]).catch(() => "");
  if (!npm) return null;
  return {
    node: process.platform === "win32" ? "node.exe" : "node",
    npm: process.platform === "win32" ? "npm.cmd" : "npm",
    npmCli: null,
    version: version.trim(),
  };
}

async function installNodeSidecar(cacheDir: string, onLog: (line: string) => void): Promise<NodeRuntime> {
  const dist = nodeDistFile(process.platform, process.arch);
  const unpacked = path.join(cacheDir, dist.dir);
  const nodePath = path.join(unpacked, dist.binary);

  const cached = await usableSidecar(nodePath);
  if (cached) return cached;
  if (await exists(unpacked)) {
    onLog("缓存的 Node 无法运行，正在重新下载");
    await rm(unpacked, { recursive: true, force: true });
  }

  await mkdir(cacheDir, { recursive: true });
  const archivePath = path.join(cacheDir, dist.archive);
  const urls = nodeDownloadUrls(dist.archive, localePrefersChina(process.env, process.env.TZ || hostTimeZone()));
  await downloadFromMirrors(urls, archivePath, onLog);
  onLog("正在解压 Node 运行时");
  if (dist.archive.endsWith(".zip")) {
    await runCapture("powershell", ["-NoProfile", "-Command", `Expand-Archive -Force '${archivePath}' '${cacheDir}'`]);
  } else {
    await runCapture("tar", ["-xJf", archivePath, "-C", cacheDir]);
  }
  await rm(archivePath, { force: true });
  const runtime = await usableSidecar(nodePath);
  if (!runtime) throw new Error("Node 运行时解压后仍无法执行，请检查磁盘权限后重试。");
  return runtime;
}

/**
 * Archives extracted with a restrictive umask, or interrupted extractions, leave
 * a node binary that cannot be executed (EACCES). Restore the exec bit and prove
 * the binary actually runs before trusting the cache.
 */
async function usableSidecar(nodePath: string): Promise<NodeRuntime | null> {
  if (!(await exists(nodePath))) return null;
  if (process.platform !== "win32") {
    await chmod(nodePath, 0o755).catch(() => undefined);
  }
  const version = await runCapture(nodePath, ["-v"]).catch(() => "");
  if (!version.trim().startsWith("v")) return null;
  return {
    node: nodePath,
    npm: companionNpm(nodePath),
    npmCli: await companionNpmCli(nodePath),
    version: version.trim(),
  };
}

function companionNpm(nodePath: string): string {
  if (process.platform === "win32") return path.join(path.dirname(nodePath), "npm.cmd");
  return path.join(path.dirname(nodePath), "npm");
}

/**
 * The npm shell wrapper needs its own exec bit and a node on PATH. Running
 * npm-cli.js through our node binary avoids both.
 */
async function companionNpmCli(nodePath: string): Promise<string | null> {
  const prefix = process.platform === "win32" ? path.dirname(nodePath) : path.dirname(path.dirname(nodePath));
  const cli = path.join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  return (await exists(cli)) ? cli : null;
}

async function downloadFromMirrors(
  urls: string[],
  dest: string,
  onLog: (line: string) => void,
): Promise<void> {
  let lastError: unknown;
  for (const url of urls) {
    try {
      onLog(`正在下载 Node.js：${url}`);
      await downloadFile(url, dest, onLog);
      return;
    } catch (error) {
      lastError = error;
      onLog("这个地址下载失败，正在换一个镜像…");
      await rm(dest, { force: true }).catch(() => undefined);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("下载 Node.js 失败");
}

async function downloadFile(
  url: string,
  dest: string,
  onLog: (line: string) => void,
): Promise<void> {
  const response = await fetch(url);
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

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export async function runCapture(
  command: string,
  args: string[],
  cwd?: string,
  extraEnv?: NodeJS.ProcessEnv,
  onLog?: (line: string) => void,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    let out = "";
    let err = "";
    const take = (chunk: unknown, toErr: boolean) => {
      const text = String(chunk);
      if (toErr) err += text;
      else out += text;
      if (!onLog) return;
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) onLog(trimmed);
      }
    };
    child.stdout.on("data", (chunk) => take(chunk, false));
    child.stderr.on("data", (chunk) => take(chunk, true));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out || err);
      else reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${err || out}`));
    });
  });
}

export async function writeMarker(dir: string, name: string, value: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), value, "utf8");
}
