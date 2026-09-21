/**
 * `@dsh-desktop/dsh-desktop-panel` host half.
 *
 * The desktop shell owns facts the engine cannot see: which shell version is
 * running, where the desktop writes its logs, which engine port it launched,
 * and whether the packaged executable is available for a diagnostics export.
 * The shell hands those over as `DSH_DESKTOP_*` environment variables; this
 * plugin publishes them, plus the profile's plugin inventory, as a small
 * read-mostly HTTP surface under `/dsh-desktop`, which the panel's browser half
 * renders inside the DSH web UI.
 *
 * The only mutation is the plugin enable/disable toggle, and it writes the same
 * `cordis.patch.yml` block the desktop's own market window manages — one format,
 * one file, so the two surfaces cannot disagree about which plugins are off.
 *
 * @module @dsh-desktop/dsh-desktop-panel
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Context } from "@deepseek-ai/cordis";

/** Cordis plugin name; must equal the patch row id and the market block prefix. */
export const name = "dsh-desktop-panel";

/** Host services consumed: the HTTP server routes are registered against. */
export const inject = ["webServer"];

/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = "/dsh-desktop";

/** Profile the desktop boots; overridable through the patch row's `config`. */
export const DEFAULT_PROFILE = "web";

/** Marker pair around the toggle rows, shared with the desktop market window. */
export const MARKET_BLOCK_BEGIN = "# >>> desktop plugin market >>>";
export const MARKET_BLOCK_END = "# <<< desktop plugin market <<<";

/** Everything the shell tells the engine about itself. */
export interface DesktopFacts {
  shellVersion: string;
  executable: string;
  logDir: string;
  userData: string;
  workspace: string;
  channel: string;
  locale: string;
  trayAvailable: boolean;
  marketAvailable: boolean;
  packaged: boolean;
}

/** @param env - process environment. @returns the shell facts it carries. */
export function desktopFacts(env: NodeJS.ProcessEnv = process.env): DesktopFacts {
  return {
    shellVersion: env.DSH_DESKTOP_VERSION || "",
    executable: env.DSH_DESKTOP_EXE || "",
    logDir: env.DSH_DESKTOP_LOG_DIR || "",
    userData: env.DSH_DESKTOP_USER_DATA || "",
    workspace: env.DSH_DESKTOP_WORKSPACE || "",
    channel: env.DSH_DESKTOP_CHANNEL || "",
    locale: env.DSH_DESKTOP_LOCALE || "",
    trayAvailable: env.DSH_DESKTOP_TRAY === "1",
    marketAvailable: env.DSH_DESKTOP_MARKET === "1",
    packaged: env.DSH_DESKTOP_PACKAGED === "1",
  };
}

/** One plugin as the profile currently has it. */
export interface PanelPlugin {
  packageName: string;
  version: string;
  bundle: boolean;
  removable: boolean;
  core: boolean;
  disabled: boolean;
}

/** Parse the toggle rows this desktop owns out of a patch file body. */
export function parseDisabled(patch: string): string[] {
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

/** Render the managed block, or "" when nothing is disabled. */
export function renderBlock(disabled: readonly string[]): string {
  const unique = [...new Set(disabled.map((item) => item.trim()).filter(Boolean))].sort();
  if (unique.length === 0) return "";
  return [MARKET_BLOCK_BEGIN, ...unique.flatMap((pkg) => [`- id: ${pkg}`, "  disabled: true"]), MARKET_BLOCK_END].join("\n");
}

/** Replace the managed block, leaving every other byte of the file alone. */
export function mergeBlock(existing: string, disabled: readonly string[]): string {
  const begin = existing.indexOf(MARKET_BLOCK_BEGIN);
  const end = existing.indexOf(MARKET_BLOCK_END);
  let rest = existing;
  if (begin >= 0) {
    const cutEnd = end >= 0 ? end + MARKET_BLOCK_END.length : existing.length;
    rest = `${existing.slice(0, begin)}${existing.slice(cutEnd)}`;
  }
  const block = renderBlock(disabled);
  const trimmed = rest.replace(/\s+$/, "");
  if (!block) return trimmed ? `${trimmed}\n` : "[]\n";
  if (!trimmed || trimmed.trim() === "[]") return `${block}\n`;
  return `${trimmed}\n\n${block}\n`;
}

/**
 * The shell-installed plugins: `- insert:` rows naming a package. They are
 * junctioned into the profile rather than resolved from a dependency, so the
 * manifest never lists them and the market cannot remove them — but they are
 * loaded profile layers all the same, and the panel has to show what is
 * actually running. The row id is the Cordis name, which is what a disable row
 * must reference.
 * @param patch - the home patch body.
 * @returns one row per inserted plugin, in file order.
 */
export function shellPluginsOf(patch: string): { rowId: string; packageName: string }[] {
  const found: { rowId: string; packageName: string }[] = [];
  let rowId = "";
  for (const line of patch.split(/\r?\n/)) {
    const id = /^\s*-\s*id:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
    if (id) {
      rowId = id[1];
      continue;
    }
    const name = /^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
    if (name && rowId) {
      found.push({ rowId, packageName: name[1] });
      rowId = "";
    }
  }
  return found;
}

/** Build the inventory from a profile manifest and the patch body. */
export function inventoryOf(
  manifest: Record<string, unknown> | null,
  patch: string,
): {
  plugins: PanelPlugin[];
  shellPlugins: { rowId: string; packageName: string; disabled: boolean }[];
  disabled: string[];
  profileBundles: string[];
} {
  const dependencies = (manifest?.dependencies && typeof manifest.dependencies === "object"
    ? manifest.dependencies
    : {}) as Record<string, unknown>;
  const dsh = (manifest?.dsh && typeof manifest.dsh === "object" ? manifest.dsh : {}) as Record<string, unknown>;
  const profile = (dsh.profile && typeof dsh.profile === "object" ? dsh.profile : {}) as Record<string, unknown>;
  const profileBundles = Array.isArray(profile.bundles) ? profile.bundles.map(String) : [];
  const disabledSet = new Set(parseDisabled(patch));
  const names = [...new Set([...Object.keys(dependencies), ...profileBundles])].sort();
  const plugins = names.map((packageName) => {
    const inDeps = Object.prototype.hasOwnProperty.call(dependencies, packageName);
    return {
      packageName,
      version: inDeps ? String(dependencies[packageName] ?? "") : "",
      bundle: profileBundles.includes(packageName),
      removable: inDeps && profileBundles.includes(packageName),
      core: !inDeps,
      disabled: disabledSet.has(packageName),
    };
  });
  const known = new Set(plugins.map((plugin) => plugin.packageName));
  const shellPlugins = shellPluginsOf(patch)
    .filter((row) => !known.has(row.packageName))
    .map((row) => ({ ...row, disabled: disabledSet.has(row.rowId) }));
  return { plugins, shellPlugins, disabled: [...disabledSet].sort(), profileBundles };
}

/**
 * Resolve a toggle request to the row id the patch layer keys on: a manifest
 * dependency is disabled by package name, a shell plugin by its Cordis name.
 * @param inv - current inventory.
 * @param key - the package name or row id the caller sent.
 * @returns the row id, or null when nothing matches.
 */
export function toggleRowId(
  inv: { plugins: PanelPlugin[]; shellPlugins: { rowId: string; packageName: string }[] },
  key: string,
): string | null {
  if (inv.plugins.some((plugin) => plugin.packageName === key)) return key;
  const shell = inv.shellPlugins.find((row) => row.rowId === key || row.packageName === key);
  return shell ? shell.rowId : null;
}

/** Minimal JSON reply helper. */
function sendJson(res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (body?: string) => void }, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

/** Read a request body with a hard cap, so a stuck client cannot pin memory. */
async function readBody(req: AsyncIterable<Buffer>, cap = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > cap) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error("请求体不是 JSON");
  }
}

/** Tail the last `lines` lines of a file, tolerating a missing file. */
export async function tailFile(file: string, lines: number): Promise<string> {
  try {
    const text = await readFile(file, "utf8");
    return text.split(/\r?\n/).slice(-Math.max(1, Math.min(500, lines))).join("\n");
  } catch {
    return "";
  }
}

/** Injectable seams, so the host half is testable without a real server. */
export interface PanelHooks {
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof spawn;
  log?: (line: string) => void;
}

/**
 * Register the panel's routes and helpers.
 * @param ctx - host context carrying `webServer`.
 * @param config - optional `{profile}` from the patch row.
 * @param hooks - test seams.
 * @returns the plugin surface (also used by tests).
 */
export function apply(ctx: Context, config: { profile?: string } = {}, hooks: PanelHooks = {}): void {
  const env = hooks.env ?? process.env;
  // The desktop captures the engine's stdout into its own engine log, so a
  // console write is the one channel that survives a support bundle; ctx.logger
  // is kept for the engine's own log surface.
  const log =
    hooks.log ??
    ((line: string) => {
      try {
        console.log(`[dsh-desktop-panel] ${line}`);
      } catch {
        /* stdout may already be gone during teardown */
      }
      ctx.logger?.info?.(line);
    });
  const profile = config.profile ?? DEFAULT_PROFILE;
  const dshHome = env.DSH_HOME || path.join(env.HOME ?? env.USERPROFILE ?? ".", ".dsh");
  const manifestPath = path.join(dshHome, "profiles", profile, "package.json");
  const patchPath = path.join(dshHome, "cordis.patch.yml");

  const readManifest = async (): Promise<Record<string, unknown> | null> => {
    try {
      const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const readPatch = async (): Promise<string> => {
    try {
      return await readFile(patchPath, "utf8");
    } catch {
      return "[]\n";
    }
  };
  const inventory = async () => inventoryOf(await readManifest(), await readPatch());

  const facts = desktopFacts(env);

  const state = async () => ({
    ...facts,
    profile,
    dshHome,
    engineVersion: env.DSH_ENGINE_VERSION || "",
    engineUrl: ctx.get?.("webServer")?.port ? `http://127.0.0.1:${String(ctx.get("webServer").port)}` : "",
    shellAvailable: Boolean(facts.shellVersion),
    inventory: summarize(await inventory()),
  });

  const handlers: Record<string, (req: any, res: any, url: URL) => Promise<void>> = {
    [`${ROUTE_PREFIX}/state`]: async (_req, res) => sendJson(res, 200, await state()),

    [`${ROUTE_PREFIX}/plugins`]: async (_req, res) => {
      const inv = await inventory();
      sendJson(res, 200, { profile, ...inv, patchPath });
    },

    [`${ROUTE_PREFIX}/hello`]: async (req, res) => {
      const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
      const seats = Array.isArray(body.seats) ? body.seats.map(String).slice(0, 8).join(", ") : "?";
      const failure = typeof body.failure === "string" ? body.failure.slice(0, 300) : "";
      const stage = typeof body.stage === "string" ? body.stage.slice(0, 40) : "apply";
      const receipt = JSON.stringify({
        at: new Date().toISOString(),
        stage,
        seats,
        failure,
        engine: env.DSH_ENGINE_VERSION || "",
      });
      // A durable receipt: whether the browser half actually executed is
      // otherwise invisible from outside the page that ran it.
      try {
        const dir = facts.logDir || dshHome;
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "desktop-panel-client.json"), receipt, "utf8");
      } catch (error) {
        log(`客户端回执写入失败：${error instanceof Error ? error.message : String(error)}`);
      }
      log(failure ? `客户端面板注册失败：${failure}` : `客户端面板 ${stage}（seats: ${seats || "—"}）`);
      sendJson(res, 200, { ok: true, seats: seats });
    },

    [`${ROUTE_PREFIX}/log`]: async (_req, res, url) => {
      const lines = Number(url.searchParams.get("lines") ?? 80);
      const which = url.searchParams.get("which") === "engine" ? "engine.log" : "app.log";
      const text = facts.logDir ? await tailFile(path.join(facts.logDir, which), lines) : "";
      sendJson(res, 200, { file: which, dir: facts.logDir, text, available: Boolean(facts.logDir) });
    },

    [`${ROUTE_PREFIX}/toggle`]: async (req, res) => {
      const body = await readBody(req);
      const key = String(body.id ?? body.packageName ?? "").trim();
      const disabled = Boolean(body.disabled);
      if (!key) return sendJson(res, 400, { ok: false, message: "缺少插件标识" });
      const inv = await inventory();
      const packageName = toggleRowId(inv, key);
      if (!packageName) return sendJson(res, 404, { ok: false, message: "这个插件不在当前 profile 里" });
      // Disabling this panel takes its own routes with it: the patch layer is
      // applied live, so the switch that would turn it back on disappears with
      // the plugin. The desktop's market window owns that case instead.
      if (packageName === name) {
        return sendJson(res, 409, {
          ok: false,
          message: "面板不能停用自己（停用后这个开关也会随之消失），请在桌面端的插件市场里操作",
          restartRequired: false,
        });
      }
      const next = new Set(inv.disabled.filter((item) => item !== packageName));
      if (disabled) next.add(packageName);
      await mkdir(dshHome, { recursive: true });
      await writeFile(patchPath, mergeBlock(await readPatch(), [...next]), "utf8");
      log(disabled ? `面板停用插件 ${packageName}（即时生效）` : `面板启用插件 ${packageName}（即时生效）`);
      sendJson(res, 200, { ok: true, message: disabled ? `${packageName} 已停用（引擎即时重载该层）` : `${packageName} 已启用（引擎即时重载该层）`, restartRequired: true });
    },

    [`${ROUTE_PREFIX}/diagnostics`]: async (_req, res) => {
      if (!facts.executable) {
        return sendJson(res, 409, { ok: false, message: "当前不是打包版桌面端，请用命令行导出诊断包" });
      }
      const spawnImpl = hooks.spawnImpl ?? spawn;
      const child = spawnImpl(facts.executable, ["--export-diagnostics"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
      child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
      const code: number = await new Promise((resolve) => child.on("close", (value: number | null) => resolve(value ?? 1)));
      const bundlePath = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() ?? "";
      log(`面板导出诊断包：${bundlePath || `退出码 ${code}`}`);
      sendJson(res, code === 0 ? 200 : 500, { ok: code === 0, bundlePath, output: output.slice(-4000) });
    },
  };

  const webServer = ctx.get("webServer") as { register: (route: unknown) => () => void } | undefined;
  if (!webServer) {
    log("桌面面板：webServer 服务不可用，仅保留客户端界面");
    return;
  }
  ctx.effect(() => {
    const disposers = Object.entries(handlers).map(([routePath, handler]) =>
      webServer.register({
        kind: "exact",
        path: routePath,
        handler: async (req: any, res: any) => {
          const url = new URL(String(req.url ?? routePath), "http://127.0.0.1");
          try {
            await handler(req, res, url);
          } catch (error) {
            sendJson(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) });
          }
        },
      }),
    );
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, "dsh-desktop-panel: /dsh-desktop routes");
}

/** Compact inventory summary for the state card. */
function summarize(inv: {
  plugins: PanelPlugin[];
  shellPlugins?: { rowId: string; packageName: string; disabled: boolean }[];
  disabled: string[];
}): {
  total: number;
  enabled: number;
  disabled: number;
  removable: number;
  shell: number;
} {
  const shell = inv.shellPlugins ?? [];
  const all = [...inv.plugins, ...shell];
  return {
    total: all.length,
    enabled: all.filter((plugin) => !plugin.disabled).length,
    disabled: inv.disabled.length,
    removable: inv.plugins.filter((plugin) => plugin.removable).length,
    shell: shell.length,
  };
}

export { summarize };
