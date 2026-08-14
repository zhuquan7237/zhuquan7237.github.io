import { cp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipTo } from "./unzip-zip";

export const OFFICIAL_SKIN_ID = "official";
export const DEFAULT_SKIN_ID = "maid-atelier";
export const DEEP_WHALE_REPO = "https://github.com/Small-tailqwq/dsh-deep-whale";
export const DEEP_WHALE_ZIP = "https://github.com/Small-tailqwq/dsh-deep-whale/archive/refs/heads/main.zip";

export const MANAGED_START = "# --- deepseek-desktop skins (auto-generated; do not edit) ---";
export const MANAGED_END = "# --- end deepseek-desktop skins ---";

export interface SkinManifest {
  id: string;
  name: string;
  nameEn: string;
  author: string;
  tagline: string;
  packageName: string;
  wiringId: string;
  previewLight: string;
  previewDark: string;
  license: string;
  sourceUrl: string;
}

export interface InstalledSkin extends SkinManifest {
  dir: string;
  builtin: boolean;
}

export interface SkinCard {
  id: string;
  name: string;
  author: string;
  tagline: string;
  previewDataUrl: string;
  active: boolean;
  builtin: boolean;
  sourceUrl: string;
  license: string;
}

export const BUILTIN_MAID_ATELIER: SkinManifest = {
  id: DEFAULT_SKIN_ID,
  name: "深海女仆工坊",
  nameEn: "Abyssal Maid Atelier",
  author: "Small-tailqwq",
  tagline: "双女仆背景、深海蓝蕾丝界面与 Q 版侧栏",
  packageName: "@dsh-external/dsh-client-ui-skin-maid-atelier",
  wiringId: "ui-skin-maid-atelier",
  previewLight: "preview/light.webp",
  previewDark: "preview/dark.webp",
  license: "CC BY-NC-SA 4.0",
  sourceUrl: DEEP_WHALE_REPO,
};

export function skinsRoot(userData: string): string {
  return path.join(userData, "skins");
}

export function bundledSkinDir(appRoot: string, id = DEFAULT_SKIN_ID): string {
  return path.join(appRoot, "resources", "skins", id);
}

/** Electron can stat files inside app.asar, but fs.cp cannot copy that virtual tree. */
export function looksLikeAsarVirtualPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return /\/app\.asar\//.test(normalized) && !/\/app\.asar\.unpacked\//.test(normalized);
}

export function asarUnpackedTwin(filePath: string): string {
  if (!looksLikeAsarVirtualPath(filePath)) return filePath;
  return filePath.replace(/[/\\]app\.asar[/\\]/, `${path.sep}app.asar.unpacked${path.sep}`);
}

/** Prefer the asar-unpacked copy so a spawned Node process can read the files. */
export function bundledSkinCandidates(appRoot: string, id = DEFAULT_SKIN_ID): string[] {
  const primary = bundledSkinDir(appRoot, id);
  const unpacked = asarUnpackedTwin(primary);
  return unpacked === primary ? [primary] : [unpacked, primary];
}

export function bundledSkinSearchPaths(options: {
  bundledDir?: string;
  appRoot?: string;
  resourcesPath?: string;
  id?: string;
}): string[] {
  const id = options.id ?? DEFAULT_SKIN_ID;
  const found: string[] = [];
  const add = (dir?: string) => {
    if (!dir) return;
    const unpacked = asarUnpackedTwin(dir);
    if (!found.includes(unpacked)) found.push(unpacked);
    if (!found.includes(dir)) found.push(dir);
  };
  if (options.resourcesPath) {
    add(path.join(options.resourcesPath, "skins", id));
    add(path.join(options.resourcesPath, "app.asar.unpacked", "resources", "skins", id));
    add(path.join(options.resourcesPath, "app.asar.unpacked", "skins", id));
  }
  add(options.bundledDir);
  if (options.appRoot) {
    for (const dir of bundledSkinCandidates(options.appRoot, id)) add(dir);
  }
  return found;
}

export async function skinPackageReady(dir: string): Promise<boolean> {
  return (await exists(path.join(dir, "lib", "client.js"))) && (await exists(path.join(dir, "skin.json")));
}

export async function readPackageVersion(dir: string): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as { version?: string };
    return String(pkg.version || "");
  } catch {
    return "";
  }
}

export function builtinSkinDir(userData: string, id = DEFAULT_SKIN_ID): string {
  return path.join(skinsRoot(userData), "builtin", id);
}

export function importedSkinDir(userData: string, id: string): string {
  return path.join(skinsRoot(userData), "imported", id);
}

export function catalogFile(userData: string): string {
  return path.join(skinsRoot(userData), "catalog.json");
}

export function isSafeSkinId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}

export function parseSkinManifest(raw: unknown, fallbackDir = ""): SkinManifest {
  const data = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const wiring = data.wiring && typeof data.wiring === "object" ? (data.wiring as Record<string, unknown>) : {};
  const preview = data.preview && typeof data.preview === "object" ? (data.preview as Record<string, unknown>) : {};
  const id = String(data.id || path.basename(fallbackDir) || "").trim();
  if (!isSafeSkinId(id)) throw new Error(`皮肤 id 不合法：${id || "（空）"}`);
  const packageName = String(data.package || "").trim();
  if (!packageName) throw new Error(`皮肤 ${id} 缺少 package 字段`);
  return {
    id,
    name: String(data.name || id),
    nameEn: String(data.nameEn || ""),
    author: String(data.author || "unknown"),
    tagline: String(data.tagline || data.description || ""),
    packageName,
    wiringId: String(wiring.id || `ui-skin-${id}`),
    previewLight: String(preview.light || "preview/light.webp"),
    previewDark: String(preview.dark || "preview/dark.webp"),
    license: String(data.license || "unknown"),
    sourceUrl: String(data.sourceUrl || ""),
  };
}

export async function readSkinFromDir(dir: string): Promise<SkinManifest> {
  const file = path.join(dir, "skin.json");
  const json = JSON.parse(await readFile(file, "utf8")) as unknown;
  const manifest = parseSkinManifest(json, dir);
  try {
    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as { license?: string; name?: string };
    if (pkg.license) manifest.license = pkg.license.replace(/^CC-BY-NC-SA-4\.0$/i, "CC BY-NC-SA 4.0");
    if (!manifest.packageName && pkg.name) manifest.packageName = pkg.name;
  } catch {
    // skin.json is enough
  }
  return manifest;
}

export function looksLikeSkinDir(dirFiles: string[]): boolean {
  return dirFiles.includes("skin.json") && dirFiles.includes("package.json") && dirFiles.includes("lib");
}

export async function findSkinRoots(root: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  if (looksLikeSkinDir(names)) return [root];
  const found: string[] = [];
  for (const name of names) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const child = path.join(root, name);
    try {
      if (!(await stat(child)).isDirectory()) continue;
    } catch {
      continue;
    }
    found.push(...(await findSkinRoots(child, depth + 1)));
  }
  return found;
}

export function stripManagedPatch(patch: string): string {
  const start = patch.indexOf(MANAGED_START);
  if (start === -1) return patch;
  const end = patch.indexOf(MANAGED_END, start);
  if (end === -1) return patch.slice(0, start).trimEnd();
  return `${patch.slice(0, start).trimEnd()}\n${patch.slice(end + MANAGED_END.length).trimStart()}`.trim();
}

/** dsh parsePatchList: comments-only / empty / mapping → throw. Only a top-level array is valid. */
export function isYamlArrayDocument(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    return trimmed.startsWith("-") || trimmed.startsWith("[");
  }
  return false;
}

export function isEmptyYamlArrayDocument(text: string): boolean {
  const meaningful = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  return meaningful.length === 1 && /^\[\s*\]$/.test(meaningful[0]);
}

export function renderManagedEntries(
  skins: InstalledSkin[],
  activeId: string,
): string[] {
  const active = activeId === OFFICIAL_SKIN_ID ? "" : activeId;
  const lines: string[] = [];
  for (const skin of skins) {
    if (skin.id === active) continue;
    lines.push(`- id: ${skin.wiringId}`, "  disabled: true");
  }
  const selected = skins.find((skin) => skin.id === active);
  // Always re-insert the active skin. After "official" the plugin is disabled
  // and unloaded; skipping insert (because it once landed in profile bundles)
  // leaves no way to turn the default skin back on.
  if (selected) {
    lines.push("- insert:", `    - id: ${selected.wiringId}`, `      name: '${selected.packageName}'`);
  }
  return lines;
}

export function renderManagedPatch(
  skins: InstalledSkin[],
  activeId: string,
  _bundledPackages: Iterable<string> = [],
): string {
  const entries = renderManagedEntries(skins, activeId);
  // Official dsh: empty / comments-only files throw. Disable the layer with [].
  const body = entries.length > 0 ? entries.join("\n") : "[]";
  return [MANAGED_START, body, MANAGED_END].join("\n");
}

export function mergeSkinPatch(
  existing: string,
  skins: InstalledSkin[],
  activeId: string,
  bundledPackages: Iterable<string> = [],
): string {
  const kept = stripManagedPatch(existing).trim();
  const managed = renderManagedPatch(skins, activeId, bundledPackages);
  const entries = renderManagedEntries(skins, activeId);
  if (!kept || !isYamlArrayDocument(kept) || isEmptyYamlArrayDocument(kept)) {
    return `${managed}\n`;
  }
  if (entries.length === 0) return kept.endsWith("\n") ? kept : `${kept}\n`;
  return `${kept}\n\n${managed}\n`;
}

export function homePatchFile(dshHome: string): string {
  return path.join(dshHome, "cordis.patch.yml");
}

export async function readProfileBundles(dshHome: string): Promise<string[]> {
  try {
    const manifest = JSON.parse(
      await readFile(path.join(dshHome, "profiles", "web", "package.json"), "utf8"),
    ) as { dsh?: { profile?: { bundles?: string[] } } };
    return manifest.dsh?.profile?.bundles ?? [];
  } catch {
    return [];
  }
}

export async function ensurePatchFileIsArray(file: string): Promise<boolean> {
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch {
    return false;
  }
  if (isYamlArrayDocument(existing)) return false;
  try {
    await writeFile(`${file}.bak`, existing, "utf8");
  } catch {
    // still replace the broken file
  }
  await writeFile(file, "[]\n", "utf8");
  return true;
}

export async function ensureHomePatchesAreArrays(dshHome: string): Promise<string[]> {
  const repaired: string[] = [];
  for (const file of [homePatchFile(dshHome), path.join(dshHome, "profiles", "web", "cordis.patch.yml")]) {
    if (await ensurePatchFileIsArray(file)) repaired.push(file);
  }
  return repaired;
}

export async function writeSkinPatch(dshHome: string, skins: InstalledSkin[], activeId: string): Promise<string> {
  const file = homePatchFile(dshHome);
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch {
    existing = "";
  }
  if (existing && !isYamlArrayDocument(existing)) {
    try {
      await writeFile(`${file}.bak`, existing, "utf8");
    } catch {
      // still write a valid array
    }
  }
  const next = mergeSkinPatch(existing, skins, activeId, await readProfileBundles(dshHome));
  await mkdir(dshHome, { recursive: true });
  await writeFile(file, next, "utf8");
  return file;
}

export async function linkSkinPackage(dshHome: string, skin: InstalledSkin): Promise<string[]> {
  const targets = [
    path.join(dshHome, "profiles", "web", "node_modules", skin.packageName),
    path.join(dshHome, "profiles", "node_modules", skin.packageName),
  ];
  const linked: string[] = [];
  for (const target of targets) {
    await mkdir(path.dirname(target), { recursive: true });
    await rm(target, { recursive: true, force: true });
    try {
      await symlink(skin.dir, target, process.platform === "win32" ? "junction" : "dir");
    } catch {
      await cp(skin.dir, target, { recursive: true });
    }
    linked.push(target);
  }
  return linked;
}

export async function loadCatalog(userData: string): Promise<InstalledSkin[]> {
  const skins: InstalledSkin[] = [];
  const builtinDir = builtinSkinDir(userData);
  if (await exists(path.join(builtinDir, "skin.json"))) {
    const manifest = await readSkinFromDir(builtinDir);
    skins.push({ ...manifest, sourceUrl: manifest.sourceUrl || DEEP_WHALE_REPO, dir: builtinDir, builtin: true });
  }
  try {
    const saved = JSON.parse(await readFile(catalogFile(userData), "utf8")) as { imported?: string[] };
    for (const id of saved.imported ?? []) {
      if (!isSafeSkinId(id)) continue;
      const dir = importedSkinDir(userData, id);
      if (!(await exists(path.join(dir, "skin.json")))) continue;
      const manifest = await readSkinFromDir(dir);
      skins.push({ ...manifest, dir, builtin: false });
    }
  } catch {
    // first run
  }
  const unique: InstalledSkin[] = [];
  const seen = new Set<string>();
  for (const skin of skins) {
    if (seen.has(skin.id)) continue;
    seen.add(skin.id);
    unique.push(skin);
  }
  return unique;
}

export async function saveImportedCatalog(userData: string, skins: InstalledSkin[]): Promise<void> {
  await mkdir(skinsRoot(userData), { recursive: true });
  await writeFile(
    catalogFile(userData),
    JSON.stringify({ imported: skins.filter((skin) => !skin.builtin).map((skin) => skin.id) }, null, 2),
    "utf8",
  );
}

export interface EnsureBuiltinSkinOptions {
  download?: (url: string) => Promise<Buffer>;
  bundledDir?: string;
  appRoot?: string;
  resourcesPath?: string;
}

function normalizeEnsureOptions(
  downloadOrOptions?: ((url: string) => Promise<Buffer>) | EnsureBuiltinSkinOptions,
): EnsureBuiltinSkinOptions {
  if (typeof downloadOrOptions === "function") return { download: downloadOrOptions };
  return downloadOrOptions ?? {};
}

export async function isCopyableSkinDir(dir: string): Promise<boolean> {
  if (looksLikeAsarVirtualPath(dir)) return false;
  if (!(await skinPackageReady(dir))) return false;
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function resolveBundledSkin(options: EnsureBuiltinSkinOptions): Promise<string> {
  for (const dir of bundledSkinSearchPaths(options)) {
    if (await isCopyableSkinDir(dir)) return dir;
  }
  return "";
}

async function installBuiltinFromDir(
  source: string,
  dest: string,
  onLog: (line: string) => void,
  message: string,
): Promise<InstalledSkin> {
  if (looksLikeAsarVirtualPath(source)) {
    throw new Error("内置皮肤在 app.asar 里，无法直接复制；请使用 asar.unpacked 目录");
  }
  onLog(message);
  const staging = `${dest}.staging`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(path.dirname(dest), { recursive: true });
  try {
    await cp(source, staging, { recursive: true });
    if (!(await skinPackageReady(staging))) {
      throw new Error("内置皮肤复制不完整");
    }
    await rm(dest, { recursive: true, force: true });
    await cp(staging, dest, { recursive: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const manifest = await readSkinFromDir(dest);
  onLog("默认皮肤已就绪（CC BY-NC-SA 4.0，来自 Small-tailqwq/dsh-deep-whale，已内置安装包）");
  return { ...manifest, sourceUrl: DEEP_WHALE_REPO, dir: dest, builtin: true };
}

export async function ensureBuiltinSkin(
  userData: string,
  onLog: (line: string) => void,
  downloadOrOptions: ((url: string) => Promise<Buffer>) | EnsureBuiltinSkinOptions = downloadBuffer,
): Promise<InstalledSkin> {
  const options = normalizeEnsureOptions(downloadOrOptions);
  const download = options.download ?? downloadBuffer;
  const dir = builtinSkinDir(userData);
  const bundled = await resolveBundledSkin(options);
  if (await skinPackageReady(dir)) {
    if (bundled) {
      const have = await readPackageVersion(dir);
      const want = await readPackageVersion(bundled);
      if (want && have !== want) {
        return await installBuiltinFromDir(bundled, dir, onLog, "正在更新内置默认皮肤…");
      }
    }
    const manifest = await readSkinFromDir(dir);
    return { ...manifest, sourceUrl: DEEP_WHALE_REPO, dir, builtin: true };
  }
  if (bundled) {
    return await installBuiltinFromDir(bundled, dir, onLog, "正在安装内置默认皮肤：深海女仆工坊…");
  }
  onLog("正在下载默认皮肤：深海女仆工坊（dsh-deep-whale）…");
  const archive = await download(DEEP_WHALE_ZIP);
  const staging = path.join(skinsRoot(userData), "staging-deep-whale");
  await rm(staging, { recursive: true, force: true });
  await unzipTo(archive, staging);
  const roots = await findSkinRoots(staging);
  const maid = roots.find((root) => path.basename(root) === DEFAULT_SKIN_ID) ?? roots[0];
  if (!maid) throw new Error("下载的 dsh-deep-whale 里没有找到 maid-atelier 皮肤");
  const installed = await installBuiltinFromDir(maid, dir, onLog, "正在展开下载的默认皮肤…");
  await rm(staging, { recursive: true, force: true });
  return installed;
}

export async function importSkinFromDir(userData: string, sourceDir: string): Promise<InstalledSkin> {
  const roots = await findSkinRoots(sourceDir);
  if (roots.length === 0) throw new Error("这个文件夹里没有 dsh 皮肤（需要 skin.json + package.json + lib/）");
  const root = roots[0];
  const manifest = await readSkinFromDir(root);
  const builtin = manifest.id === DEFAULT_SKIN_ID;
  const dest = builtin ? builtinSkinDir(userData) : importedSkinDir(userData, manifest.id);
  await rm(dest, { recursive: true, force: true });
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(root, dest, { recursive: true });
  const imported: InstalledSkin = {
    ...manifest,
    sourceUrl: manifest.sourceUrl || (builtin ? DEEP_WHALE_REPO : ""),
    dir: dest,
    builtin,
  };
  if (!builtin) {
    const catalog = await loadCatalog(userData);
    const next = [...catalog.filter((skin) => skin.id !== imported.id), imported];
    await saveImportedCatalog(userData, next);
  }
  return imported;
}

export async function importSkinFromUrl(
  userData: string,
  url: string,
  onLog: (line: string) => void,
  download: (href: string) => Promise<Buffer> = downloadBuffer,
): Promise<InstalledSkin> {
  const zipUrl = githubZipUrl(url);
  onLog(`正在导入皮肤：${zipUrl}`);
  const archive = await download(zipUrl);
  const staging = path.join(skinsRoot(userData), `staging-import-${Date.now()}`);
  await rm(staging, { recursive: true, force: true });
  await unzipTo(archive, staging);
  try {
    return await importSkinFromDir(userData, staging);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function githubZipUrl(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)(?:\/(?:tree|blob)\/([^/]+))?/i);
  if (match) {
    const repo = match[2].replace(/\.git$/, "");
    const ref = match[3] || "main";
    return `https://github.com/${match[1]}/${repo}/archive/refs/heads/${ref}.zip`;
  }
  if (/\.zip(\?|$)/i.test(trimmed)) return trimmed;
  throw new Error("请粘贴 GitHub 仓库地址，或一个皮肤 zip 链接");
}

export async function applySkin(
  dshHome: string,
  skins: InstalledSkin[],
  activeId: string,
): Promise<void> {
  await ensureHomePatchesAreArrays(dshHome);
  const selected = skins.find((skin) => skin.id === activeId);
  if (selected) await linkSkinPackage(dshHome, selected);
  await writeSkinPatch(dshHome, skins, activeId);
}

export async function previewDataUrl(skin: InstalledSkin): Promise<string> {
  for (const rel of [skin.previewDark, skin.previewLight]) {
    const file = path.join(skin.dir, rel);
    try {
      const bytes = await readFile(file);
      const ext = path.extname(file).slice(1) || "webp";
      return `data:image/${ext};base64,${bytes.toString("base64")}`;
    } catch {
      // try next
    }
  }
  return "";
}

export async function listSkinCards(
  skins: InstalledSkin[],
  activeId: string,
): Promise<SkinCard[]> {
  const official: SkinCard = {
    id: OFFICIAL_SKIN_ID,
    name: "官方默认",
    author: "DeepSeek Harness",
    tagline: "不套第三方皮肤，使用官方界面",
    previewDataUrl: "",
    active: activeId === OFFICIAL_SKIN_ID,
    builtin: true,
    sourceUrl: "https://github.com/deepseek-ai/deepseek-harness",
    license: "官方引擎",
  };
  const cards = await Promise.all(
    skins.map(async (skin) => ({
      id: skin.id,
      name: skin.name,
      author: skin.author,
      tagline: skin.tagline,
      previewDataUrl: sanitizePreviewDataUrl(await previewDataUrl(skin)),
      active: skin.id === activeId,
      builtin: skin.builtin,
      sourceUrl: skin.sourceUrl,
      license: skin.license,
    })),
  );
  return [official, ...cards];
}

export function sanitizePreviewDataUrl(url: string): string {
  return url.startsWith("data:image/") ? url : "";
}

async function downloadBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url, { headers: { "User-Agent": "DeepSeek-Desktop" } });
  if (!response.ok) throw new Error(`下载失败 ${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
