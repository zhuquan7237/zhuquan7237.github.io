import path from "node:path";

export const APP_ID = "app.deepseek.desktop";
export const APP_DISPLAY_NAME = "DeepSeek Harness";
export const NODE_VERSION = "22.23.2";
export const DSH_PACKAGE = "@deepseek-ai/dsh";
export const HARNESS_REPO = "https://github.com/deepseek-ai/deepseek-harness.git";
export const NPM_REGISTRY = "https://registry.npmjs.org";
export const NPMMIRROR_REGISTRY = "https://registry.npmmirror.com";

export type HarnessChannel = "latest" | "next" | string;

export interface DesktopSettings {
  autoUpdateHarness: boolean;
  /** Check GitHub Releases for a newer desktop installer after launch. */
  autoUpdateDesktop: boolean;
  channel: HarnessChannel;
  registry: string;
  /** "auto" keeps following the system language; "user" pins whatever was picked in settings. */
  registrySource: "auto" | "user";
  /** If set, boot this already-built harness checkout instead of npm. */
  localHarnessDir: string;
  workspaceDir: string;
  lastHarnessVersion: string;
  /** Startup prompt will not ask again until npm publishes a newer version. */
  skippedHarnessVersion: string;
  /** Startup prompt will not ask again until GitHub publishes a newer desktop tag. */
  skippedDesktopVersion: string;
  /** Show the in-window skin picker and apply third-party dsh skins. */
  skinsEnabled: boolean;
  /** "official" keeps the stock Harness look; default is maid-atelier. */
  activeSkinId: string;
}

export const DEFAULT_SETTINGS: DesktopSettings = {
  autoUpdateHarness: true,
  autoUpdateDesktop: true,
  channel: "latest",
  registry: NPM_REGISTRY,
  registrySource: "auto",
  localHarnessDir: "",
  workspaceDir: "",
  lastHarnessVersion: "",
  skippedHarnessVersion: "",
  skippedDesktopVersion: "",
  skinsEnabled: true,
  activeSkinId: "maid-atelier",
};

/**
 * Settings saved before the mirror feature existed pin registry.npmjs.org, which
 * would keep Chinese systems on the slow default forever. Re-derive whenever the
 * user has not picked a registry themselves.
 */
export function applyRegistryPreference(
  saved: Partial<DesktopSettings>,
  preferred: string,
): { registry: string; registrySource: "auto" | "user" } {
  if (saved.registrySource === "user" && saved.registry) {
    return { registry: saved.registry, registrySource: "user" };
  }
  return { registry: preferred, registrySource: "auto" };
}

export function parseDshWebUrl(output: string): string | null {
  const labeled = output.match(/dsh web:\s*(https?:\/\/[^\s]+)/i);
  if (labeled?.[1]) return labeled[1].replace(/[.,;)]+$/, "");
  const local = output.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/?/i);
  return local?.[0] ?? null;
}

/** Compare npm versions, including prerelease tags like 0.1.0-rc.6. */
export function compareVersions(a: string, b: string): number {
  const pa = splitVersion(a);
  const pb = splitVersion(b);
  const n = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < n; i += 1) {
    const da = pa.core[i] ?? 0;
    const db = pb.core[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const m = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < m; i += 1) {
    const sa = pa.pre[i] ?? "";
    const sb = pb.pre[i] ?? "";
    const na = Number(sa);
    const nb = Number(sb);
    if (Number.isFinite(na) && Number.isFinite(nb) && (sa !== "" || sb !== "")) {
      if (na !== nb) return na < nb ? -1 : 1;
      continue;
    }
    if (sa !== sb) return sa < sb ? -1 : 1;
  }
  return 0;
}

/** Keep the engine the user already has unless they asked to upgrade. */
export function pickExistingHarness(installedVersions: string[], lastHarnessVersion: string): string {
  if (lastHarnessVersion && installedVersions.includes(lastHarnessVersion)) return lastHarnessVersion;
  if (installedVersions.length === 0) return "";
  return [...installedVersions].sort(compareVersions)[installedVersions.length - 1] ?? "";
}

export function shouldPromptHarnessUpdate(current: string, latest: string, skipped: string): boolean {
  if (!current || !latest) return false;
  if (current === latest || skipped === latest) return false;
  if (!/^\d/.test(current.replace(/^v/, "")) || !/^\d/.test(latest.replace(/^v/, ""))) return false;
  return compareVersions(current, latest) < 0;
}

function splitVersion(input: string): { core: number[]; pre: string[] } {
  const cleaned = input.replace(/^v/, "");
  const [core, pre] = cleaned.split("-", 2);
  return {
    core: core.split(".").map((part) => Number.parseInt(part, 10) || 0),
    pre: pre ? pre.split(/[.-]/) : [],
  };
}

export function nodeDistFile(platform: NodeJS.Platform, arch: string): { dir: string; archive: string; binary: string } {
  const nodeArch = arch === "arm64" ? "arm64" : "x64";
  if (platform === "win32") {
    const dir = `node-v${NODE_VERSION}-win-${nodeArch}`;
    return { dir, archive: `${dir}.zip`, binary: "node.exe" };
  }
  const plat = platform === "darwin" ? "darwin" : "linux";
  const dir = `node-v${NODE_VERSION}-${plat}-${nodeArch}`;
  // .tar.gz works with the built-in extractor. .tar.xz needs system xz, which
  // a zero-config Ubuntu/Debian often does not have.
  return { dir, archive: `${dir}.tar.gz`, binary: "bin/node" };
}

export function nodeMeetsEngine(version: string, min = "22.19.0"): boolean {
  const cleaned = version.replace(/^v/, "");
  return compareVersions(cleaned, min) >= 0;
}

export function npmInvocation(
  runtime: { node: string; npm: string; npmCli?: string | null },
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (runtime.npmCli) return { command: runtime.node, args: [runtime.npmCli, ...args] };
  return spawnArgv(runtime.npm, args, platform);
}

/**
 * Official Windows Node zips put npm next to node.exe. Unix tarballs put it
 * under lib/. Looking only at the Unix path made Windows fall back to npm.cmd,
 * and spawn(npm.cmd) throws EINVAL.
 */
export function npmCliCandidates(nodePath: string, platform: NodeJS.Platform): string[] {
  const io = platform === "win32" ? path.win32 : path.posix;
  const dir = io.dirname(nodePath);
  if (platform === "win32") {
    return [
      io.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
      io.join(dir, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ];
  }
  const prefix = io.dirname(dir);
  return [
    io.join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    io.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
  ];
}

export function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") clean[key] = value;
  }
  return clean;
}

/** .cmd/.bat cannot be spawn()'d on modern Windows; cmd.exe must launch them. */
export function spawnArgv(
  command: string,
  args: string[],
  platform: NodeJS.Platform,
): { command: string; args: string[] } {
  if (platform === "win32") {
    if (command === "powershell") return { command: "powershell.exe", args };
    if (/\.(cmd|bat)$/i.test(command)) {
      return { command: "cmd.exe", args: ["/d", "/s", "/c", command, ...args] };
    }
  }
  return { command, args };
}

export function npmSpec(channel: HarnessChannel): string {
  if (channel === "latest" || channel === "next") return `${DSH_PACKAGE}@${channel}`;
  if (channel.startsWith(DSH_PACKAGE)) return channel;
  return `${DSH_PACKAGE}@${channel}`;
}

export function formatByteProgress(downloaded: number, total: number): string {
  const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
  if (total > 0) {
    const pct = Math.min(100, Math.floor((downloaded / total) * 100));
    return `${pct}%（${mb(downloaded)} / ${mb(total)}）`;
  }
  return mb(downloaded);
}

/** Prefer the HTTP Content-Length; GitHub 302 hops often report 0, so fall back to the API asset size. */
export function resolveDownloadTotal(contentLength: number, knownSize = 0): number {
  if (Number.isFinite(contentLength) && contentLength > 0) return Math.floor(contentLength);
  if (Number.isFinite(knownSize) && knownSize > 0) return Math.floor(knownSize);
  return 0;
}

/** 1 MiB. Used when the percentage has not ticked yet, so a long 0% still shows rising bytes. */
export const DOWNLOAD_PROGRESS_CHUNK = 1024 * 1024;

/**
 * Old updater only logged every 10%, so a 188 MB GitHub exe sat on "0%" until ~18 MB.
 * Log the first bytes, then every 1% or every 1 MiB.
 */
export function shouldLogDownloadProgress(
  downloaded: number,
  total: number,
  lastLoggedBytes: number,
): boolean {
  if (downloaded <= lastLoggedBytes) return false;
  if (lastLoggedBytes <= 0) return downloaded > 0;
  if (downloaded - lastLoggedBytes >= DOWNLOAD_PROGRESS_CHUNK) return true;
  if (total > 0) {
    return Math.floor((downloaded / total) * 100) > Math.floor((lastLoggedBytes / total) * 100);
  }
  return false;
}

/** Chromium's helper must be root-owned and setuid (mode 4755). */
export function chromeSandboxIsConfigured(info: { uid: number; mode: number } | null): boolean {
  if (!info) return false;
  return info.uid === 0 && (info.mode & 0o4000) !== 0;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Keep a saved window on-screen after display layout changes. */
export function clampWindowBounds(bounds: Rect, workArea: Rect): Rect {
  const width = Math.min(Math.max(bounds.width, 960), Math.max(workArea.width, 960));
  const height = Math.min(Math.max(bounds.height, 640), Math.max(workArea.height, 640));
  const maxX = workArea.x + Math.max(workArea.width - width, 0);
  const maxY = workArea.y + Math.max(workArea.height - height, 0);
  return {
    x: Math.min(Math.max(bounds.x, workArea.x), maxX),
    y: Math.min(Math.max(bounds.y, workArea.y), maxY),
    width,
    height,
  };
}

export function linuxExecLine(execPath: string): string {
  const quoted = execPath.includes(" ") ? `"${execPath.replace(/"/g, '\\"')}"` : execPath;
  if (/\.appimage$/i.test(execPath)) return `env APPIMAGE_EXTRACT_AND_RUN=1 ${quoted} %U`;
  return `${quoted} %U`;
}

export function linuxDesktopEntry(options: { exec: string; icon: string; workingDirectory?: string }): string {
  const lines = [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    "Name=DeepSeek Harness",
    "GenericName=AI coding agent",
    "GenericName[zh_CN]=AI 编程助手",
    "Comment=Codex-style desktop for DeepSeek Harness",
    "Comment[zh_CN]=DeepSeek Harness 桌面版",
    `Exec=${linuxExecLine(options.exec)}`,
    `Icon=${options.icon}`,
  ];
  // Without Path=, a .desktop launch uses $HOME as cwd, and dsh may register
  // that folder (title = the username, e.g. "box") instead of ~/DeepSeek.
  if (options.workingDirectory) lines.push(`Path=${options.workingDirectory}`);
  lines.push(
    "Terminal=false",
    "StartupNotify=true",
    "StartupWMClass=DeepSeek Harness",
    "Categories=Development;IDE;",
    "Keywords=deepseek;dsh;harness;ai;",
    "MimeType=",
    "",
  );
  return lines.join("\n");
}

/** LANG= / LC_MESSAGES= lines from /etc/locale.conf or /etc/default/locale. */
export function parseOsLocaleAssignments(contents: string): string[] {
  const found: string[] = [];
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:LANG|LC_ALL|LC_MESSAGES|LANGUAGE)=(.*)$/);
    if (!match) continue;
    let value = match[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) found.push(value);
  }
  return found;
}

export function parseOsTimeZone(contents: string): string {
  const line = contents.split(/\r?\n/).map((part) => part.trim()).find(Boolean) || "";
  return /^[A-Za-z]+\/[A-Za-z_]+$/.test(line) ? line : "";
}

function isChinaTimeZone(tz: string): boolean {
  const value = tz.trim();
  return (
    value === "Asia/Shanghai" ||
    value === "Asia/Chongqing" ||
    value === "Asia/Urumqi" ||
    value === "Asia/Harbin"
  );
}

/**
 * Electron/ICU often reports UTC on Linux even when the machine is in China.
 * Prefer a China zone from TZ, /etc/timezone, or Intl, in that scan order.
 */
export function resolveTimeZone(
  env: NodeJS.ProcessEnv = process.env,
  osTimeZone = "",
  intlTimeZone = "",
): string {
  const candidates = [env.TZ, osTimeZone, intlTimeZone].filter((value): value is string => Boolean(value));
  return candidates.find(isChinaTimeZone) || osTimeZone || env.TZ || intlTimeZone || "";
}

/** zh-CN / Asia/Shanghai users get the China npm mirror on first launch. */
export function localePrefersChina(
  env: NodeJS.ProcessEnv = process.env,
  timeZone = "",
  systemLocale = "",
): boolean {
  const blob = [systemLocale, env.LANG, env.LANGUAGE, env.LC_ALL, env.LC_MESSAGES, env.LC_CTYPE]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (/(zh[_-]cn|zh[_-]hans)/.test(blob)) return true;
  const tz = timeZone || env.TZ || "";
  return isChinaTimeZone(tz);
}

export function preferredNpmRegistry(
  env: NodeJS.ProcessEnv = process.env,
  timeZone = "",
  systemLocale = "",
): string {
  return localePrefersChina(env, timeZone, systemLocale) ? NPMMIRROR_REGISTRY : NPM_REGISTRY;
}

/** Turn a POSIX locale such as `zh_CN.UTF-8` into the BCP-47 tag Chromium expects. */
export function normalizeLocaleTag(input: string): string {
  const base = input.split(".")[0].split("@")[0].replace("_", "-").trim();
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(base)) return "";
  const [lang, ...rest] = base.split("-");
  const subtags = rest.map((part) =>
    part.length === 4
      ? part[0].toUpperCase() + part.slice(1).toLowerCase()
      : part.toUpperCase(),
  );
  return [lang.toLowerCase(), ...subtags].join("-");
}

/**
 * The Harness web UI picks its language from `navigator.languages`, which
 * Electron drives with `--lang`. Without this the UI is English even on a
 * Chinese desktop.
 *
 * English Ubuntu with a China timezone is common; menus are already Chinese,
 * so the Harness UI should follow that rather than LANG=en_US.
 */
export function resolveUiLocale(
  env: NodeJS.ProcessEnv = process.env,
  systemLocale = "",
  timeZone = "",
): string {
  const fromSystem = systemLocale.split(/[\s,;]+/).filter(Boolean);
  const candidates = [...fromSystem, env.LC_ALL, env.LC_MESSAGES, env.LANG, env.LANGUAGE];
  if (localePrefersChina(env, timeZone, systemLocale)) {
    for (const candidate of candidates) {
      if (!candidate) continue;
      const tag = normalizeLocaleTag(candidate.split(":")[0]);
      if (tag.toLowerCase().startsWith("zh")) return tag;
    }
    return "zh-CN";
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    const tag = normalizeLocaleTag(candidate.split(":")[0]);
    if (tag && !/^(c|posix)$/i.test(tag)) return tag;
  }
  return "";
}

export function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

export function hostIntlLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "";
  } catch {
    return "";
  }
}

/** Chromium --accept-lang value so the Harness UI follows --lang. */
export function chromiumAcceptLang(tag: string): string {
  if (tag.toLowerCase().startsWith("zh")) return "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7";
  return `${tag},en;q=0.8`;
}

/** dsh itself may read LANG; keep it aligned with the window language. */
export function harnessLocaleEnv(uiLocale: string): NodeJS.ProcessEnv {
  if (!uiLocale.toLowerCase().startsWith("zh")) return {};
  return {
    LANG: "zh_CN.UTF-8",
    LANGUAGE: "zh_CN:zh",
    LC_MESSAGES: "zh_CN.UTF-8",
  };
}

export function defaultWorkspacePath(home: string): string {
  return path.join(home, "DeepSeek");
}

/** 0.1.3 saved $HOME as the workspace; never keep that as the coding folder. */
export function resolveWorkspaceDir(saved: string, home: string): string {
  const desired = defaultWorkspacePath(home);
  if (!saved.trim() || isHomeDirectoryWorkspace(saved, home)) return desired;
  return saved;
}

export function nodeDownloadUrls(archive: string, preferChina: boolean): string[] {
  const official = `https://nodejs.org/dist/v${NODE_VERSION}/${archive}`;
  const china = `https://npmmirror.com/mirrors/node/v${NODE_VERSION}/${archive}`;
  return preferChina ? [china, official] : [official, china];
}

/** True when any /dev/shm mount is noexec (common in VMs and some containers). */
export function linuxShmNeedsWorkaround(mounts: string): boolean {
  return mounts.split(/\r?\n/).some((line) => {
    const parts = line.split(/\s+/);
    return parts[1] === "/dev/shm" && (parts[3] || "").split(",").includes("noexec");
  });
}

/**
 * Chromium only honors these when they are real process argv flags.
 * Do not disable the GPU for ordinary desktops; only patch sandbox / noexec shm.
 */
export function linuxRuntimeArgvExtras(options: {
  sandboxConfigured: boolean;
  shmNoexec: boolean;
  hasSwitch: (name: string) => boolean;
}): string[] {
  const extra: string[] = [];
  if (!options.sandboxConfigured && !options.hasSwitch("no-sandbox")) {
    extra.push("--no-sandbox", "--disable-gpu-sandbox");
  }
  if (options.shmNoexec && !options.hasSwitch("disable-dev-shm-usage")) {
    extra.push("--disable-dev-shm-usage");
  }
  return extra;
}

export function parseXdgUserDir(contents: string, key: string, home: string): string | null {
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) !== key) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value.replaceAll("$HOME", home).replace(/^~(?=\/|$)/, home);
  }
  return null;
}

export function resolveLinuxDesktopDir(
  home: string,
  env: NodeJS.ProcessEnv,
  exists: (filePath: string) => boolean,
  userDirsContents?: string | null,
): string {
  const fromEnv = env.XDG_DESKTOP_DIR?.trim();
  if (fromEnv) {
    return fromEnv.replace(/^"|"$/g, "").replaceAll("$HOME", home).replace(/^~(?=\/|$)/, home);
  }
  if (userDirsContents) {
    const parsed = parseXdgUserDir(userDirsContents, "XDG_DESKTOP_DIR", home);
    if (parsed) return parsed;
  }
  const chinese = `${home}/桌面`;
  const desktop = `${home}/Desktop`;
  if (exists(chinese) && !exists(desktop)) return chinese;
  if (exists(desktop)) return desktop;
  if (exists(chinese)) return chinese;
  return desktop;
}

export interface WorkspaceRegistry {
  unit: { name: string; version: number };
  global: { initialized: boolean; workspaceIds: string[]; archivedSessionIds: string[] };
  tables: { workspaces: Record<string, unknown> };
}

export function sameFilesystemPath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return normalize(left) === normalize(right);
}

/** A .desktop launch with cwd=$HOME makes dsh title the username ("box"). */
export function isHomeDirectoryWorkspace(workspacePath: string, home: string): boolean {
  return sameFilesystemPath(workspacePath, home);
}

/**
 * 0.1.3 registered $HOME because the process cwd was the home folder. Keep the
 * same workspace id (so it stays selected) but point it at ~/DeepSeek.
 */
export function retargetHomeWorkspace(
  existing: unknown,
  home: string,
  desired: { path: string; title: string; now: string },
): WorkspaceRegistry | null {
  if (!existing || typeof existing !== "object") return null;
  const registry = existing as Partial<WorkspaceRegistry>;
  if (registry.unit && (registry.unit.name !== "workspace" || registry.unit.version !== 2)) return null;
  const workspaces = registry.tables?.workspaces;
  if (!workspaces || typeof workspaces !== "object") return null;

  let changed = false;
  const nextWorkspaces: Record<string, unknown> = { ...workspaces };
  for (const [id, raw] of Object.entries(workspaces)) {
    if (!raw || typeof raw !== "object") continue;
    const workspace = raw as { path?: string };
    if (typeof workspace.path !== "string" || !isHomeDirectoryWorkspace(workspace.path, home)) continue;
    nextWorkspaces[id] = { ...workspace, path: desired.path, title: desired.title, updatedAt: desired.now };
    changed = true;
  }
  if (!changed) return null;
  return {
    unit: registry.unit ?? { name: "workspace", version: 2 },
    global: {
      initialized: true,
      workspaceIds: registry.global?.workspaceIds ?? Object.keys(nextWorkspaces),
      archivedSessionIds: registry.global?.archivedSessionIds ?? [],
    },
    tables: { workspaces: nextWorkspaces },
  };
}

/**
 * dsh keeps its workspace list in DSH_HOME rather than deriving it from the
 * process cwd, so a fresh profile always opens the picker. Register the default
 * folder once, and only into a registry we fully recognise as empty — anything
 * else belongs to the user and dsh itself.
 */
export function seedWorkspaceRegistry(
  existing: unknown,
  entry: { id: string; path: string; title: string; now: string },
): WorkspaceRegistry | null {
  const empty: WorkspaceRegistry = {
    unit: { name: "workspace", version: 2 },
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [] },
    tables: { workspaces: {} },
  };
  const base = existing === null || existing === undefined ? empty : existing;
  if (typeof base !== "object") return null;
  const registry = base as Partial<WorkspaceRegistry>;
  if (registry.unit && (registry.unit.name !== "workspace" || registry.unit.version !== 2)) return null;
  const ids = registry.global?.workspaceIds;
  if (ids !== undefined && (!Array.isArray(ids) || ids.length > 0)) return null;
  const table = registry.tables?.workspaces;
  if (table !== undefined && (typeof table !== "object" || Object.keys(table).length > 0)) return null;

  return {
    unit: registry.unit ?? empty.unit,
    global: {
      initialized: true,
      workspaceIds: [entry.id],
      archivedSessionIds: registry.global?.archivedSessionIds ?? [],
    },
    tables: {
      workspaces: {
        [entry.id]: {
          path: entry.path,
          title: entry.title,
          sessionIds: [],
          createdAt: entry.now,
          updatedAt: entry.now,
        },
      },
    },
  };
}

export function isSystemInstalledApp(execPath: string): boolean {
  const exec = execPath.replace(/\\/g, "/");
  if (exec.startsWith("/usr/") || exec.startsWith("/opt/")) return true;
  if (/\/Applications\//.test(exec) || exec.endsWith(".app/Contents/MacOS/DeepSeek")) return true;
  return false;
}
