/**
 * Diagnostics bundle.
 *
 * DSH Desktop's troubleshooting flow starts with "Export diagnostics…". The
 * shell only had on-screen logs, which vanish when the window cannot open at
 * all. This builds the same kind of artifact: one zip with system info, the run
 * state, both logs, and the desktop settings with secrets redacted — exportable
 * without booting the engine (`--export-diagnostics`).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { collectLogText } from "./logs";
import { createZip, type ZipEntry } from "./zip-write";

export interface DiagnosticsInput {
  appName: string;
  appVersion: string;
  electron: string;
  chrome: string;
  node: string;
  v8: string;
  platform: string;
  arch: string;
  osRelease: string;
  hostLocale: string;
  shellLocale: string;
  timeZone: string;
  packaged: boolean;
  userData: string;
  dshHome: string;
  workspaceDir: string;
  logsPath: string;
  engineVersion: string;
  enginePrefix: string;
  installedEngines: string[];
  channel: string;
  registry: string;
  webPort: number;
  localUrl: string;
  trayAvailable: boolean;
  autoRestarts: number;
  lastExitReason: string;
  /** Serialized desktop settings; secrets are redacted before it is written. */
  settingsJson: string;
  /** Set when the bundle is produced from the CLI before a window exists. */
  exportedBy: string;
}

const SECRET_JSON_KEYS = /("(?:apiKey|api_key|token|apiToken|accessToken|refreshToken|secret|password|authorization)"\s*:\s*")([^"]*)(")/gi;
const SECRET_ASSIGNMENTS = /((?:[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi;
const SECRET_PREFIXES = /\b(?:sk-[A-Za-z0-9_-]{6,}|tvly-[A-Za-z0-9_-]{4,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9_-]{6,})\b/g;
const SECRET_BEARER = /(\bBearer\s+)([A-Za-z0-9._-]{8,})/gi;

/**
 * Logs and settings go into a file the user may upload, so anything shaped like
 * a credential is replaced. Plugin keys reach the engine through env vars, which
 * is exactly how they would leak into an engine log.
 */
export function redactSecrets(text: string): string {
  return String(text ?? "")
    .replace(SECRET_JSON_KEYS, "$1[redacted]$3")
    .replace(SECRET_ASSIGNMENTS, "$1[redacted]")
    .replace(SECRET_PREFIXES, "[redacted]")
    .replace(SECRET_BEARER, "$1[redacted]");
}

export function systemInfoText(input: DiagnosticsInput, now: Date = new Date()): string {
  const lines = [
    `${input.appName} diagnostics`,
    `exported: ${now.toISOString()}`,
    `exported by: ${input.exportedBy}`,
    "",
    "== application ==",
    `desktop: ${input.appVersion}${input.packaged ? "" : " (from source)"}`,
    `engine: dsh ${input.engineVersion || "not running"}`,
    `engine dir: ${input.enginePrefix || "-"}`,
    `installed engines: ${input.installedEngines.join(", ") || "none"}`,
    `channel: ${input.channel}`,
    `npm registry: ${input.registry}`,
    `local url: ${input.localUrl || "-"}`,
    `web port: ${input.webPort === 0 ? "random" : input.webPort}`,
    `tray: ${input.trayAvailable ? "yes" : "no"}`,
    `auto restarts this run: ${input.autoRestarts}`,
    `last engine exit: ${input.lastExitReason || "-"}`,
    "",
    "== runtime ==",
    `electron: ${input.electron}`,
    `chrome: ${input.chrome}`,
    `node: ${input.node}`,
    `v8: ${input.v8}`,
    `platform: ${input.platform} ${input.osRelease} (${input.arch})`,
    `host locale: ${input.hostLocale || "-"}`,
    `shell locale: ${input.shellLocale}`,
    `time zone: ${input.timeZone || "-"}`,
    "",
    "== paths ==",
    `user data: ${input.userData}`,
    `dsh home: ${input.dshHome}`,
    `workspace: ${input.workspaceDir}`,
    `logs: ${input.logsPath}`,
    "",
  ];
  return lines.join("\n");
}

export function diagnosticsReadme(input: DiagnosticsInput): string {
  return [
    "This bundle was produced by the DeepSeek Harness desktop shell.",
    "",
    "contents:",
    "  system-info.txt        versions, paths, current run state",
    "  desktop-settings.json  desktop shell settings, secrets redacted",
    "  logs/app.log           shell startup log (this run and the previous one)",
    "  logs/engine.log        dsh web stdout/stderr tail",
    "  running.json           process/engine state at export time",
    "",
    "privacy:",
    "  - API keys, tokens and Authorization headers are replaced with [redacted].",
    "  - Logs can still contain local paths, workspace ids and session ids.",
    "  - Review this archive before posting it anywhere public.",
    `  - exported from ${input.appName} ${input.appVersion}.`,
    "",
  ].join("\n");
}

export function diagnosticsFileName(appVersion: string, now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const safeVersion = appVersion.replace(/[^\w.-]/g, "") || "0.0.0";
  return `diagnostics-${stamp}-${safeVersion}.zip`;
}

export interface DiagnosticsBundle {
  name: string;
  path: string;
  text: string;
}

/** Entries are always present even when a source is missing, so the shape is predictable. */
export function buildDiagnosticsEntries(input: DiagnosticsInput, now: Date = new Date()): ZipEntry[] {
  const appLog = collectLogText({ userData: input.userData, name: "app.log" });
  const engineLog = collectLogText({ userData: input.userData, name: "engine.log" });
  const running = {
    exportedAt: now.toISOString(),
    desktopVersion: input.appVersion,
    engineVersion: input.engineVersion,
    enginePrefix: input.enginePrefix,
    installedEngines: input.installedEngines,
    localUrl: input.localUrl,
    webPort: input.webPort,
    channel: input.channel,
    registry: input.registry,
    trayAvailable: input.trayAvailable,
    autoRestarts: input.autoRestarts,
    lastExitReason: input.lastExitReason,
    shellLocale: input.shellLocale,
    packaged: input.packaged,
  };
  return [
    { name: "diagnostics-readme.txt", data: diagnosticsReadme(input) },
    { name: "system-info.txt", data: systemInfoText(input, now) },
    { name: "desktop-settings.json", data: `${redactSecrets(input.settingsJson)}\n` },
    { name: "logs/app.log", data: `${redactSecrets(appLog)}\n` },
    { name: "logs/engine.log", data: `${redactSecrets(engineLog)}\n` },
    { name: "running.json", data: `${JSON.stringify(running, null, 2)}\n` },
  ];
}

export function buildDiagnosticsBundle(
  input: DiagnosticsInput,
  now: Date = new Date(),
): { name: string; data: Buffer; text: string } {
  const name = diagnosticsFileName(input.appVersion, now);
  const entries = buildDiagnosticsEntries(input, now);
  return { name, data: createZip(entries, now), text: systemInfoText(input, now) };
}

/** Writes the bundle and returns its absolute path. */
export function writeDiagnosticsBundle(
  input: DiagnosticsInput,
  outDir: string,
  now: Date = new Date(),
): DiagnosticsBundle {
  mkdirSync(outDir, { recursive: true });
  const bundle = buildDiagnosticsBundle(input, now);
  const target = path.join(outDir, bundle.name);
  writeFileSync(target, bundle.data);
  return { name: bundle.name, path: target, text: bundle.text };
}

/** Prefers Downloads, then Desktop, then user data — the same order users expect. */
export function pickDiagnosticsDir(candidates: string[]): string {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return candidates.find(Boolean) ?? ".";
}
