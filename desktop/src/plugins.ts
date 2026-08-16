import { cp, mkdir, readFile, rm, stat, symlink } from "node:fs/promises";
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
  { rowId: "vision-aux", packageName: "@dsh-desktop/dsh-vision-aux", dir: "vision-aux" },
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

/** Copy a bundled plugin into userData/plugins when the version changed (staging + swap). */
export async function installPluginFromDir(
  source: string,
  dest: string,
  onLog: (line: string) => void,
): Promise<"installed" | "updated" | "unchanged"> {
  const have = await readPluginVersion(dest);
  const want = await readPluginVersion(source);
  if (have && have === want && (await pluginPackageReady(dest))) return "unchanged";
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
  if (settings.webSearch.provider === "tavily") {
    const tavily = settings.webSearch.tavily;
    rows.push(
      "- insert:",
      "    - id: web-search-tavily",
      "      name: '@dsh-desktop/dsh-web-search-tavily'",
      "      config:",
      `        baseURL: ${yamlString(tavily.baseURL.trim())}`,
      `        maxResults: ${tavily.maxResults}`,
      "        includeAnswer: true",
      // Override the base layer's web row so ctx.web resolves our provider.
      "- id: web",
      "  config:",
      "    searchProvider: tavily",
    );
  }
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
