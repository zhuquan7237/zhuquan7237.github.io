import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NodeRuntime } from "./node-runtime";
import { runCapture } from "./node-runtime";
import {
  DSH_PACKAGE,
  NPM_REGISTRY,
  compareVersions,
  npmInvocation,
  npmSpec,
  parseDshWebUrl,
  type DesktopSettings,
} from "./util";

export interface HarnessInstall {
  version: string;
  bin: string;
  prefix: string;
}

export interface RunningHarness {
  process: ChildProcess;
  url: string;
  version: string;
}

export async function fetchPublishedVersion(registry: string, channel: string): Promise<string> {
  const distTag = channel === "latest" || channel === "next" ? channel : channel;
  const url = `${registry.replace(/\/$/, "")}/${DSH_PACKAGE}/${distTag}`;
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`npm registry ${response.status} for ${url}`);
  const data = (await response.json()) as { version?: string };
  if (!data.version) throw new Error(`No version in registry response for ${channel}`);
  return data.version;
}

export async function readInstalledVersion(prefix: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(
      await readFile(path.join(prefix, "node_modules", DSH_PACKAGE, "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export function dshBin(prefix: string): string {
  return path.join(prefix, "node_modules", DSH_PACKAGE, "lib", "bin.js");
}

export async function ensureHarness(
  settings: DesktopSettings,
  runtime: NodeRuntime,
  harnessRoot: string,
  onLog: (line: string) => void,
): Promise<HarnessInstall> {
  if (settings.localHarnessDir) {
    const localBin = path.join(settings.localHarnessDir, "apps", "cli", "lib", "bin.js");
    const pkgPath = path.join(settings.localHarnessDir, "apps", "cli", "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { version?: string };
    onLog(`使用本地 Harness：${settings.localHarnessDir}（${pkg.version ?? "unknown"}）`);
    return { version: pkg.version ?? "local", bin: localBin, prefix: settings.localHarnessDir };
  }

  const wanted = settings.channel === "latest" || settings.channel === "next"
    ? await fetchPublishedVersion(settings.registry || NPM_REGISTRY, settings.channel)
    : settings.channel.replace(/^@?deepseek-ai\/dsh@?/, "") || settings.channel;
  const prefix = path.join(harnessRoot, wanted);
  const installed = await readInstalledVersion(prefix);
  if (installed === wanted) {
    onLog(`引擎 ${wanted} 已安装，跳过下载`);
    return { version: wanted, bin: dshBin(prefix), prefix };
  }
  if (installed && !settings.autoUpdateHarness && compareVersions(installed, wanted) >= 0) {
    onLog(`保留已安装的引擎 ${installed}（已关闭自动更新）`);
    return { version: installed, bin: dshBin(prefix), prefix };
  }

  const registry = settings.registry || NPM_REGISTRY;
  onLog(`正在从 npm 安装 ${DSH_PACKAGE}@${wanted}`);
  await rm(prefix, { recursive: true, force: true });
  await mkdir(prefix, { recursive: true });
  await writeFile(
    path.join(prefix, "package.json"),
    JSON.stringify({ name: "dsh-engine", private: true, version: "0.0.0" }, null, 2),
  );
  const npm = npmInvocation(runtime, [
    "install",
    npmSpec(wanted),
    "--omit=dev",
    "--no-fund",
    "--no-audit",
    "--registry",
    registry,
  ]);
  await runCapture(
    npm.command,
    npm.args,
    prefix,
    {
      PATH: `${path.dirname(runtime.node)}${path.delimiter}${process.env.PATH ?? ""}`,
      npm_config_update_notifier: "false",
      npm_config_registry: registry,
    },
    onLog,
  );
  const version = (await readInstalledVersion(prefix)) ?? wanted;
  onLog(`引擎 ${version} 已就绪`);
  return { version, bin: dshBin(prefix), prefix };
}

export async function startHarnessWeb(options: {
  runtime: NodeRuntime;
  install: HarnessInstall;
  workspaceDir: string;
  dshHome: string;
  onLog: (line: string) => void;
}): Promise<RunningHarness> {
  await mkdir(options.dshHome, { recursive: true });
  await mkdir(options.workspaceDir, { recursive: true });
  options.onLog(`正在启动 dsh web（${options.install.version}）`);
  const { ELECTRON_RUN_AS_NODE: _electronNode, ...baseEnv } = process.env;
  const child = spawn(options.runtime.node, [options.install.bin, "web", "--host", "127.0.0.1", "--port", "0"], {
    cwd: options.workspaceDir,
    env: {
      ...baseEnv,
      DSH_HOME: options.dshHome,
      PATH: `${path.dirname(options.runtime.node)}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    windowsHide: true,
  });

  let buffer = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("等待 Harness 界面超时。请检查网络后重试，或查看下方日志。"));
    }, 120_000);
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      buffer += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) options.onLog(line.trim());
      }
      const found = parseDshWebUrl(buffer);
      if (found) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        resolve(found);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timer);
        reject(new Error(`dsh exited ${code}\n${buffer.slice(-2000)}`));
      }
    });
  });

  return { process: child, url, version: options.install.version };
}

export function stopHarness(running: RunningHarness | null): void {
  if (!running?.process.pid) return;
  running.process.kill("SIGTERM");
}
