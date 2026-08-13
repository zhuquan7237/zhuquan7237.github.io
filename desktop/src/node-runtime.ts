import { spawn } from "node:child_process";
import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { NODE_VERSION, nodeDistFile, nodeMeetsEngine } from "./util";

export interface NodeRuntime {
  node: string;
  npm: string;
  version: string;
}

export async function resolveNodeRuntime(
  cacheDir: string,
  onLog: (line: string) => void,
): Promise<NodeRuntime> {
  const system = await detectSystemNode();
  if (system && nodeMeetsEngine(system.version)) {
    onLog(`Using system Node ${system.version}`);
    return system;
  }
  onLog(`Need Node >= 22.19; downloading official Node ${NODE_VERSION} sidecar`);
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
    version: version.trim(),
  };
}

async function installNodeSidecar(cacheDir: string, onLog: (line: string) => void): Promise<NodeRuntime> {
  const dist = nodeDistFile(process.platform, process.arch);
  const unpacked = path.join(cacheDir, dist.dir);
  const nodePath = path.join(unpacked, dist.binary);
  if (await exists(nodePath)) {
    const version = (await runCapture(nodePath, ["-v"])).trim();
    return { node: nodePath, npm: companionNpm(nodePath), version };
  }

  await mkdir(cacheDir, { recursive: true });
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${dist.archive}`;
  const archivePath = path.join(cacheDir, dist.archive);
  onLog(`Downloading ${url}`);
  await downloadFile(url, archivePath);
  onLog("Unpacking Node runtime");
  if (dist.archive.endsWith(".zip")) {
    await runCapture("powershell", ["-NoProfile", "-Command", `Expand-Archive -Force '${archivePath}' '${cacheDir}'`]);
  } else {
    await runCapture("tar", ["-xJf", archivePath, "-C", cacheDir]);
  }
  if (process.platform !== "win32") {
    await chmod(nodePath, 0o755);
  }
  await rm(archivePath, { force: true });
  const version = (await runCapture(nodePath, ["-v"])).trim();
  return { node: nodePath, npm: companionNpm(nodePath), version };
}

function companionNpm(nodePath: string): string {
  if (process.platform === "win32") return path.join(path.dirname(nodePath), "npm.cmd");
  return path.join(path.dirname(nodePath), "npm");
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Download failed ${response.status}: ${url}`);
  await pipeline(response.body as unknown as NodeJS.ReadableStream, createWriteStream(dest));
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
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
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
