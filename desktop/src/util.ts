export const NODE_VERSION = "22.23.2";
export const DSH_PACKAGE = "@deepseek-ai/dsh";
export const HARNESS_REPO = "https://github.com/deepseek-ai/deepseek-harness.git";
export const NPM_REGISTRY = "https://registry.npmjs.org";

export type HarnessChannel = "latest" | "next" | string;

export interface DesktopSettings {
  autoUpdateHarness: boolean;
  channel: HarnessChannel;
  registry: string;
  /** If set, boot this already-built harness checkout instead of npm. */
  localHarnessDir: string;
  workspaceDir: string;
  lastHarnessVersion: string;
}

export const DEFAULT_SETTINGS: DesktopSettings = {
  autoUpdateHarness: true,
  channel: "latest",
  registry: NPM_REGISTRY,
  localHarnessDir: "",
  workspaceDir: "",
  lastHarnessVersion: "",
};

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

export function npmSpec(channel: HarnessChannel): string {
  if (channel === "latest" || channel === "next") return `${DSH_PACKAGE}@${channel}`;
  if (channel.startsWith(DSH_PACKAGE)) return channel;
  return `${DSH_PACKAGE}@${channel}`;
}
