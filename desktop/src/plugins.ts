import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat, symlink } from "node:fs/promises";
import path from "node:path";
import { looksLikeAsarVirtualPath } from "./skins";
import type { DesktopSettings } from "./util";

/** One server-side plugin shipped inside the desktop installer. */
export interface BundledPlugin {
  /** Patch row id; must equal the plugin's Cordis `name` export. */
  rowId: string;
  /** Module specifier linked into the profile's node_modules. */
  packageName: string;
  /** Folder under resources/plugins. */
  dir: string;
}

export const BUNDLED_PLUGINS: readonly BundledPlugin[] = [
  { rowId: "web-search-tavily", packageName: "@dsh-desktop/dsh-web-search-tavily", dir: "web-search-tavily" },
  // Search engines: one routing provider plus the 「搜索引擎」 settings page. It
  // replaces the shell's two-option dropdown and the official card's bare
  // Endpoint field, which accepted a URL that could not possibly work.
  { rowId: "dsh-search-engines", packageName: "@dsh-desktop/dsh-search-engines", dir: "search-engines" },
  { rowId: "vision-aux", packageName: "@dsh-desktop/dsh-vision-aux", dir: "vision-aux" },
  // The panel is a dual-face package: a host half serving /dsh-desktop routes
  // and a browser half that registers the "Desktop" settings section inside the
  // DSH web UI, so shell facts and plugin toggles are reachable without
  // switching windows.
  { rowId: "dsh-desktop-panel", packageName: "@dsh-desktop/dsh-desktop-panel", dir: "desktop-panel" },
  // The model-vision plugin adds the missing "does this model accept images"
  // declaration to every pi-ai provider card: the engine refuses an image
  // unless the selected model declares `image`, and the shipped Models page
  // has no field for it, so a hand-declared route can never see an image.
  { rowId: "dsh-model-vision", packageName: "@dsh-desktop/dsh-model-vision", dir: "model-vision" },
  // The mobile bridge is the only surface a paired phone can reach, so it must
  // load whenever the engine runs: its row is unconditional like the panel's.
  { rowId: "dsh-mobile-bridge", packageName: "@dsh-desktop/dsh-mobile-bridge", dir: "mobile-bridge" },
];

export interface PluginPathOptions {
  bundledDir?: string;
  appRoot?: string;
  resourcesPath?: string;
}

export function pluginBundledCandidates(plugin: BundledPlugin, options: PluginPathOptions): string[] {
  const found: string[] = [];
  const add = (dir?: string) => {
    if (!dir) return;
    if (looksLikeAsarVirtualPath(dir)) {
      const twin = dir.replace(/[/\\]app\.asar[/\\]/, `${path.sep}app.asar.unpacked${path.sep}`);
      if (!found.includes(twin)) found.push(twin);
    }
    if (!found.includes(dir)) found.push(dir);
  };
  if (options.resourcesPath) {
    add(path.join(options.resourcesPath, "plugins", plugin.dir));
    add(path.join(options.resourcesPath, "app.asar.unpacked", "resources", "plugins", plugin.dir));
  }
  add(options.bundledDir);
  if (options.appRoot) add(path.join(options.appRoot, "resources", "plugins", plugin.dir));
  return found;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** A plugin folder is shippable when its built entry and manifest exist. */
export async function pluginPackageReady(dir: string): Promise<boolean> {
  return (await pathExists(path.join(dir, "lib", "index.js"))) && (await pathExists(path.join(dir, "package.json")));
}

export async function readPluginVersion(dir: string): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as { version?: string };
    return String(pkg.version || "");
  } catch {
    return "";
  }
}

async function resolveBundledPlugin(plugin: BundledPlugin, options: PluginPathOptions): Promise<string | null> {
  for (const dir of pluginBundledCandidates(plugin, options)) {
    if (await pluginPackageReady(dir)) return dir;
  }
  return null;
}

export function installedPluginDir(userData: string, plugin: BundledPlugin): string {
  return path.join(userData, "plugins", plugin.dir);
}

/**
 * A digest of everything that decides what an installed plugin does.
 *
 * Version alone is not enough to decide whether a copy is current: 0.5.4
 * rewrote the model-vision plugin without touching its version, so every machine
 * that already had it kept the old behaviour and nothing reported a problem.
 * Comparing content makes that mistake harmless instead of silent. Files are
 * hashed by relative path and bytes only — timestamps would make every launch
 * look like a change.
 */
async function pluginContentStamp(dir: string): Promise<string> {
  let entries: string[];
  try {
    entries = (await readdir(dir, { recursive: true })) as string[];
  } catch {
    return "";
  }
  const hash = createHash("sha256");
  const files = entries
    .map((entry) => entry.split(path.sep).join("/"))
    .filter((entry) => !entry.includes("node_modules") && !entry.includes(".staging"))
    .sort();
  for (const rel of files) {
    const abs = path.join(dir, rel);
    try {
      const info = await stat(abs);
      if (!info.isFile()) continue;
      hash.update(rel);
      hash.update(await readFile(abs));
    } catch {
      // A file that vanished mid-scan cannot be part of a stable stamp.
    }
  }
  return hash.digest("hex").slice(0, 24);
}

/**
 * Copy a bundled plugin into userData/plugins when its version or its content
 * changed (staging + swap).
 */
export async function installPluginFromDir(
  source: string,
  dest: string,
  onLog: (line: string) => void,
): Promise<"installed" | "updated" | "unchanged"> {
  const have = await readPluginVersion(dest);
  const want = await readPluginVersion(source);
  if (
    have &&
    have === want &&
    (await pluginPackageReady(dest)) &&
    (await pluginContentStamp(dest)) === (await pluginContentStamp(source))
  ) {
    return "unchanged";
  }
  onLog(`正在安装内置插件 ${path.basename(source)}…`);
  const staging = `${dest}.staging`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(path.dirname(dest), { recursive: true });
  try {
    await cp(source, staging, { recursive: true });
    if (!(await pluginPackageReady(staging))) throw new Error(`内置插件 ${path.basename(source)} 复制不完整`);
    await rm(dest, { recursive: true, force: true });
    await cp(staging, dest, { recursive: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return have ? "updated" : "installed";
}

/** Symlink (junction on Windows) one installed plugin into both profile node_modules. */
export async function linkPluginPackage(dshHome: string, packageName: string, sourceDir: string): Promise<string[]> {
  const scope = packageName.split("/").slice(0, -1).join("/");
  const targets = [
    path.join(dshHome, "profiles", "web", "node_modules", packageName),
    path.join(dshHome, "profiles", "node_modules", packageName),
  ];
  const linked: string[] = [];
  for (const target of targets) {
    await mkdir(path.dirname(target), { recursive: true });
    await rm(target, { recursive: true, force: true });
    try {
      await symlink(sourceDir, target, process.platform === "win32" ? "junction" : "dir");
    } catch {
      await cp(sourceDir, target, { recursive: true });
    }
    linked.push(target);
  }
  return linked;
}

/** Install and link every bundled plugin. Safe to run on every boot. */
export async function ensureBundledPlugins(options: {
  userData: string;
  dshHome: string;
  appRoot: string;
  resourcesPath: string;
  onLog: (line: string) => void;
}): Promise<void> {
  for (const plugin of BUNDLED_PLUGINS) {
    try {
      const bundled = await resolveBundledPlugin(plugin, options);
      if (!bundled) {
        options.onLog(`内置插件 ${plugin.rowId} 缺失，跳过`);
        continue;
      }
      const dest = installedPluginDir(options.userData, plugin);
      const state = await installPluginFromDir(bundled, dest, options.onLog);
      if (state !== "unchanged") options.onLog(`插件 ${plugin.rowId} 已${state === "updated" ? "更新" : "安装"}`);
      await linkPluginPackage(options.dshHome, plugin.packageName, dest);
    } catch (error) {
      options.onLog(`插件 ${plugin.rowId} 安装失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function yamlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Render the cordis.patch.yml rows for the bundled plugins. API keys are
 * deliberately absent: they reach the engine through environment variables
 * (DSH_TAVILY_API_KEY / DSH_VISION_AUX_API_KEY), never through the
 * plaintext patch file.
 */
export function renderPluginRows(settings: DesktopSettings): string[] {
  const rows: string[] = [];
  // The panel has no settings of its own: it always loads, so the shell's facts
  // and the profile's plugin toggles are reachable from inside the DSH web UI.
  rows.push(
    "- insert:",
    "    - id: dsh-desktop-panel",
    "      name: '@dsh-desktop/dsh-desktop-panel'",
  );
  // Same reasoning: the image-input declaration is a property of the engine's
  // own model registry, so it must be available whenever the engine runs.
  rows.push(
    "- insert:",
    "    - id: dsh-model-vision",
    "      name: '@dsh-desktop/dsh-model-vision'",
  );
  // Search engines are chosen from that plugin's own settings page, so the row
  // and the provider pin are unconditional: which engine answers is a runtime
  // decision stored in the plugin's namespace, not a shell setting. The pin is
  // required because the seam refuses to guess between two usable providers
  // (WEB_PROVIDER_AMBIGUOUS), and the official DeepSeek provider is registered
  // in the base layer whether or not it has a working key.
  rows.push(
    "- insert:",
    "    - id: dsh-search-engines",
    "      name: '@dsh-desktop/dsh-search-engines'",
    "- id: web",
    "  config:",
    "    searchProvider: search-engines",
  );
  // The mobile bridge always loads: a phone that already holds a device token
  // must keep working across restarts, with no setting to toggle. The public
  // URL is what its pairing page and QR code point at; empty keeps them local.
  const mobileUrl = settings.mobile.publicUrl.trim();
  rows.push(
    "- insert:",
    "    - id: dsh-mobile-bridge",
    "      name: '@dsh-desktop/dsh-mobile-bridge'",
    ...(mobileUrl === "" ? [] : ["      config:", `        publicUrl: ${yamlString(mobileUrl)}`]),
  );
  // The old two-option Tavily row is deliberately gone: two providers registered
  // at once is exactly the ambiguity the seam refuses, and it left search
  // configurable in two places that could disagree. A key already saved in the
  // shell's settings still reaches the engine as DSH_TAVILY_API_KEY, which the
  // search-engines plugin accepts as a fallback while the user migrates.
  const vision = settings.visionAux;
  if (vision.enabled && vision.model.trim().length > 0) {
    rows.push(
      "- insert:",
      "    - id: vision-aux",
      "      name: '@dsh-desktop/dsh-vision-aux'",
      "      config:",
      `        model: ${yamlString(vision.model.trim())}`,
      `        baseURL: ${yamlString(vision.baseURL.trim())}`,
      `        timeoutMs: ${vision.timeoutMs}`,
      `        skipWhenUnknown: ${vision.skipWhenUnknown}`,
    );
  }
  return rows;
}

/** The env keys the plugins read their secrets from (set on the engine process). */
export function pluginSecretsEnv(settings: DesktopSettings): NodeJS.ProcessEnv {
  return {
    DSH_TAVILY_API_KEY: settings.webSearch.tavily.apiKey.trim(),
    DSH_VISION_AUX_API_KEY: settings.visionAux.apiKey.trim(),
  };
}
