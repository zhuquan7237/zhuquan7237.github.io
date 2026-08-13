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
  channel: HarnessChannel;
  registry: string;
  /** "auto" keeps following the system language; "user" pins whatever was picked in settings. */
  registrySource: "auto" | "user";
  /** If set, boot this already-built harness checkout instead of npm. */
  localHarnessDir: string;
  workspaceDir: string;
  lastHarnessVersion: string;
}

export const DEFAULT_SETTINGS: DesktopSettings = {
  autoUpdateHarness: true,
  channel: "latest",
  registry: NPM_REGISTRY,
  registrySource: "auto",
  localHarnessDir: "",
  workspaceDir: "",
  lastHarnessVersion: "",
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
  return { dir, archive: `${dir}.tar.xz`, binary: "bin/node" };
}

export function nodeMeetsEngine(version: string, min = "22.19.0"): boolean {
  const cleaned = version.replace(/^v/, "");
  return compareVersions(cleaned, min) >= 0;
}

export function npmInvocation(
  runtime: { node: string; npm: string; npmCli?: string | null },
  args: string[],
): { command: string; args: string[] } {
  if (runtime.npmCli) return { command: runtime.node, args: [runtime.npmCli, ...args] };
  return { command: runtime.npm, args };
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

export function linuxDesktopEntry(options: { exec: string; icon: string }): string {
  const exec = options.exec.includes(" ") ? `"${options.exec.replace(/"/g, '\\"')}"` : options.exec;
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    "Name=DeepSeek Harness",
    "GenericName=AI coding agent",
    "GenericName[zh_CN]=AI 编程助手",
    "Comment=Codex-style desktop for DeepSeek Harness",
    "Comment[zh_CN]=DeepSeek Harness 桌面版",
    `Exec=${exec} %U`,
    `Icon=${options.icon}`,
    "Terminal=false",
    "StartupNotify=true",
    "StartupWMClass=DeepSeek Harness",
    "Categories=Development;IDE;",
    "Keywords=deepseek;dsh;harness;ai;",
    "MimeType=",
    "",
  ].join("\n");
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
  return tz === "Asia/Shanghai" || tz === "Asia/Chongqing" || tz === "Asia/Urumqi";
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
 */
export function resolveUiLocale(env: NodeJS.ProcessEnv = process.env, systemLocale = ""): string {
  const candidates = [systemLocale, env.LC_ALL, env.LC_MESSAGES, env.LANG, env.LANGUAGE];
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
