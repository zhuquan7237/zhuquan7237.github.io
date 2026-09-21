/**
 * Plugin market install layer: npm identity qualification, the engine's own
 * `dsh plugin` CLI as the only installer, profile inventory, and the
 * `cordis.patch.yml` rows that enable or disable a plugin.
 *
 * Installing is deliberately narrow. The renderer sends a catalog id; the host
 * resolves the npm package it already normalized, confirms npm `latest`
 * declares `dsh.bundle.patch`, and runs `add <package>@<version>`. A removed
 * plugin and an enable/disable toggle are the only other mutations, and both
 * are scoped to plugins this profile installed as direct dependencies — core
 * profile bundles stay read-only.
 *
 * @module market/install
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { MarketEntry } from "./catalog";

/** The profile the desktop's engine runs (`dsh web` boots the `web` profile). */
export const ENGINE_PROFILE = "web";

/** npm registry used to establish the version authority. */
export const NPM_LATEST_ENDPOINT = "https://registry.npmjs.org";

/** Marker pair around the rows this market owns inside `cordis.patch.yml`. */
export const MARKET_BLOCK_BEGIN = "# >>> desktop plugin market >>>";
export const MARKET_BLOCK_END = "# <<< desktop plugin market <<<";

/** One plugin as the active profile currently has it installed. */
export interface InstalledPlugin {
  /** npm package name (the profile dependency key). */
  packageName: string;
  /** Version range as recorded in the profile manifest. */
  version: string;
  /** True when the package is a profile layer (`dsh.profile.bundles`). */
  bundle: boolean;
  /** True when it is a direct dependency the market may uninstall. */
  removable: boolean;
  /** True when it is loaded but not a dependency — an in-box profile bundle. */
  core: boolean;
  /** True when a market row disables it at boot. */
  disabled: boolean;
}

/** Result of qualifying one catalog entry for installation. */
export type Qualification =
  | { ok: true; packageName: string; version: string; spec: string }
  | { ok: false; reason: string };

/** Profile inventory read from the manifest and the patch file. */
export interface ProfileInventory {
  plugins: InstalledPlugin[];
  /** Which plugins the market rows currently disable. */
  disabled: string[];
  manifestPath: string;
}

/**
 * Read a JSON file, returning null when it is missing or unreadable. The market
 * treats "no profile yet" as an empty inventory rather than an error.
 * @param file - absolute path.
 * @returns the parsed value, or null.
 */
async function readJsonOrNull(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Parse the market's disabled list out of a `cordis.patch.yml` body. Only rows
 * inside the market block with `disabled: true` count, so a hand-written row
 * elsewhere in the file is never silently claimed by the market.
 * @param patch - the file body (may be empty).
 * @returns the disabled package names.
 */
export function parseMarketDisabled(patch: string): string[] {
  const begin = patch.indexOf(MARKET_BLOCK_BEGIN);
  if (begin < 0) return [];
  const end = patch.indexOf(MARKET_BLOCK_END, begin);
  const block = patch.slice(begin + MARKET_BLOCK_BEGIN.length, end < 0 ? undefined : end);
  const disabled: string[] = [];
  let current = "";
  for (const line of block.split(/\r?\n/)) {
    const rowId = /^\s*-\s*id:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
    if (rowId) {
      current = rowId[1];
      continue;
    }
    if (/^\s*disabled:\s*(?:true|'true'|"true")\s*$/.test(line) && current) {
      disabled.push(current);
      current = "";
    }
  }
  return disabled;
}

/**
 * Render the market block for the current disabled set. An empty set renders no
 * block at all, so a profile with nothing disabled keeps a clean patch file.
 * @param disabled - package names to disable at boot.
 * @returns the block including its markers, or "".
 */
export function renderMarketBlock(disabled: readonly string[]): string {
  const unique = [...new Set(disabled.map((name) => name.trim()).filter(Boolean))].sort();
  if (unique.length === 0) return "";
  const rows = unique.flatMap((name) => ["- id: " + name, "  disabled: true"]);
  return [MARKET_BLOCK_BEGIN, ...rows, MARKET_BLOCK_END].join("\n");
}

/**
 * Replace the market block in a patch file body, preserving every other byte of
 * the file — including the rows the desktop's skin writer manages and any row
 * the user wrote by hand.
 * @param existing - current file body.
 * @param disabled - package names to disable.
 * @returns the next file body.
 */
export function mergeMarketBlock(existing: string, disabled: readonly string[]): string {
  const begin = existing.indexOf(MARKET_BLOCK_BEGIN);
  const end = existing.indexOf(MARKET_BLOCK_END);
  let rest = existing;
  if (begin >= 0) {
    const cutEnd = end >= 0 ? end + MARKET_BLOCK_END.length : existing.length;
    rest = `${existing.slice(0, begin)}${existing.slice(cutEnd)}`;
  }
  const block = renderMarketBlock(disabled);
  const trimmed = rest.replace(/\s+$/, "");
  if (!block) return trimmed ? `${trimmed}\n` : "";
  if (!trimmed || trimmed.trim() === "[]") return `${block}\n`;
  return `${trimmed}\n\n${block}\n`;
}

/**
 * Build the profile inventory: dependencies are the plugins the market may
 * remove, bundle rows without a dependency are the profile's own in-box layers.
 * @param dshHome - the engine home.
 * @param patch - the home `cordis.patch.yml` body, or "" when absent.
 * @returns the inventory.
 */
export function buildInventory(
  dshHome: string,
  manifest: Record<string, unknown> | null,
  patch: string,
): ProfileInventory {
  const manifestPath = path.join(dshHome, "profiles", ENGINE_PROFILE, "package.json");
  const dependencies = (manifest?.dependencies && typeof manifest.dependencies === "object"
    ? manifest.dependencies
    : {}) as Record<string, unknown>;
  const dsh = (manifest?.dsh && typeof manifest.dsh === "object" ? manifest.dsh : {}) as Record<string, unknown>;
  const profile = (dsh.profile && typeof dsh.profile === "object" ? dsh.profile : {}) as Record<string, unknown>;
  const bundles = Array.isArray(profile.bundles) ? profile.bundles.map(String) : [];
  const disabledSet = new Set(parseMarketDisabled(patch));

  const names = new Set<string>([...Object.keys(dependencies), ...bundles]);
  const plugins: InstalledPlugin[] = [];
  for (const packageName of names) {
    const inDeps = Object.prototype.hasOwnProperty.call(dependencies, packageName);
    const isBundle = bundles.includes(packageName);
    plugins.push({
      packageName,
      version: inDeps ? String(dependencies[packageName] ?? "") : "",
      bundle: isBundle,
      removable: inDeps && isBundle,
      core: !inDeps,
      disabled: disabledSet.has(packageName),
    });
  }
  plugins.sort((left, right) => left.packageName.localeCompare(right.packageName));
  return { plugins, disabled: [...disabledSet].sort(), manifestPath };
}

/**
 * Read the profile inventory from disk.
 * @param dshHome - the engine home.
 * @returns the inventory; an absent profile yields an empty plugin list.
 */
export async function readInventory(dshHome: string): Promise<ProfileInventory> {
  const manifestPath = path.join(dshHome, "profiles", ENGINE_PROFILE, "package.json");
  const manifest = await readJsonOrNull(manifestPath);
  let patch = "";
  try {
    patch = await readFile(path.join(dshHome, "cordis.patch.yml"), "utf8");
  } catch {
    patch = "";
  }
  return buildInventory(dshHome, manifest, patch);
}

/** A single npm registry reply, reduced to the fields qualification needs. */
interface NpmLatest {
  name?: unknown;
  version?: unknown;
  dsh?: unknown;
}

/**
 * Decide whether an npm manifest declares a Cordis bundle patch. The engine's
 * own reconciler requires `dsh.bundle.patch`, so a package without it would
 * install as a plain library and never load as a plugin.
 * @param manifest - the npm `latest` document.
 * @returns true when the declaration is present.
 */
export function declaresBundlePatch(manifest: NpmLatest): boolean {
  const dsh = manifest.dsh;
  if (!dsh || typeof dsh !== "object") return false;
  const bundle = (dsh as Record<string, unknown>).bundle;
  if (!bundle || typeof bundle !== "object") return false;
  const patch = (bundle as Record<string, unknown>).patch;
  return typeof patch === "string" ? patch.trim().length > 0 : patch !== undefined;
}

/**
 * Qualify one catalog entry for installation: the entry must expose an npm
 * package, npm `latest` must return that same package with an exact stable
 * version, and its manifest must declare `dsh.bundle.patch`.
 * @param entry - the catalog entry the user selected.
 * @param options - injectable fetch and registry origin.
 * @returns the exact install spec, or the reason it was refused.
 */
export async function qualifyEntry(
  entry: MarketEntry,
  options: { fetchImpl?: typeof fetch; registry?: string; timeoutMs?: number } = {},
): Promise<Qualification> {
  if (!entry.npmPackage) return { ok: false, reason: "这条目录只提供源码安装，桌面端不会自动执行它的命令" };
  const fetchImpl = options.fetchImpl ?? fetch;
  const registry = (options.registry ?? NPM_LATEST_ENDPOINT).replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  let manifest: NpmLatest;
  try {
    const response = await fetchImpl(`${registry}/${entry.npmPackage}/latest`, {
      signal: controller.signal,
      credentials: "omit",
      headers: { accept: "application/json" },
    });
    if (response.status === 404) return { ok: false, reason: `npm 上没有 ${entry.npmPackage} 这个包` };
    if (!response.ok) return { ok: false, reason: `npm 返回 HTTP ${response.status}` };
    manifest = JSON.parse(await response.text()) as NpmLatest;
  } catch (error) {
    return { ok: false, reason: `无法访问 npm：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
  const name = typeof manifest.name === "string" ? manifest.name : "";
  const version = typeof manifest.version === "string" ? manifest.version : "";
  if (name !== entry.npmPackage) return { ok: false, reason: `npm 上的包名不匹配（${name || "空"}）` };
  if (!/^\d+\.\d+\.\d+$/.test(version)) return { ok: false, reason: `npm 的 latest 不是稳定版本（${version || "空"}）` };
  if (!declaresBundlePatch(manifest)) return { ok: false, reason: "该包没有声明 dsh.bundle.patch，装进 profile 也不会作为插件加载" };
  return { ok: true, packageName: entry.npmPackage, version, spec: `${entry.npmPackage}@${version}` };
}

/** Arguments for the engine CLI, whose `plugin` command forwards to pnpm. */
export function pluginAddArgs(spec: string): string[] {
  return ["plugin", "--profile", ENGINE_PROFILE, "add", spec];
}

/** Arguments that remove one profile plugin. */
export function pluginRemoveArgs(packageName: string): string[] {
  return ["plugin", "--profile", ENGINE_PROFILE, "remove", packageName];
}

/** One command result, with the output tail kept for the failure dialog. */
export interface CommandResult {
  code: number;
  output: string;
}

export interface PluginCommandOptions {
  /** Node runtime that runs the engine (bundled runtime or the system node). */
  nodePath: string;
  /** The engine's `lib/bin.js`. */
  engineBin: string;
  /** `DSH_HOME` for the child — the desktop's own engine home. */
  dshHome: string;
  args: string[];
  onOutput?: (chunk: string) => void;
  timeoutMs?: number;
  /** Node's child_process.spawn, injectable for tests. */
  spawnImpl?: typeof spawn;
  /** Working directory; defaults to the engine directory. */
  cwd?: string;
}

/**
 * Run one `dsh plugin` invocation through the engine's own CLI. pnpm forwards
 * through this path, so profile reconciliation and the layer list stay the
 * engine's business rather than the shell's.
 * @param options - runtime paths, arguments and output sink.
 * @returns the exit code and the bounded output tail.
 */
export async function runPluginCommand(options: PluginCommandOptions): Promise<CommandResult> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const argv = [options.engineBin, ...options.args];
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawnImpl(options.nodePath, argv, {
      cwd: options.cwd ?? path.dirname(options.engineBin),
      env: { ...process.env, DSH_HOME: options.dshHome, CI: "1" },
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: string[] = [];
    let tail = "";
    const push = (buffer: Buffer) => {
      const text = buffer.toString("utf8");
      chunks.push(text);
      tail = `${tail}${text}`.slice(-16000);
      options.onOutput?.(text);
    };
    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => child.kill(), options.timeoutMs)
        : undefined;
    child.stdout?.on("data", push);
    child.stderr?.on("data", push);
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, output: tail || chunks.join("").slice(-16000) });
    });
  });
}

/** Final line of a failed run, so the UI can show one actionable sentence. */
export function lastMeaningfulLine(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (/^(progress|downloaded|reused|resolved|\.+)/i.test(line)) continue;
    return line.slice(0, 400);
  }
  return "";
}
