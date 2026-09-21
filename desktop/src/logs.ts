/**
 * Persistent shell logs.
 *
 * Before this, everything the shell knew lived in the splash window and died
 * with it: a crash loop, a failed install or an engine exit left nothing behind
 * to read. Both the startup log and the engine's stdout/stderr now land in
 * `<userData>/logs`, which is also what the diagnostics bundle collects.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

/** 1 MiB per file, plus one rotated copy, so the folder stays bounded. */
export const MAX_LOG_BYTES = 1024 * 1024;

export function logsDir(userData: string): string {
  return path.join(userData, "logs");
}

/** `2026-09-21 10:46:12` — readable in the log and sortable as text. */
export function timestampLocal(date: Date = new Date()): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

export function formatLogLine(line: string, date: Date = new Date()): string {
  return `[${timestampLocal(date)}] ${line}\n`;
}

export class FileLogger {
  readonly file: string;

  constructor(userData: string, name: string, private readonly maxBytes = MAX_LOG_BYTES) {
    this.file = path.join(logsDir(userData), name);
  }

  append(line: string): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      this.rotateIfNeeded();
      appendFileSync(this.file, formatLogLine(line), "utf8");
    } catch {
      // Logging must never take the app down.
    }
  }

  /** One rotated copy (`app.log.1`) is enough to see what preceded a crash. */
  private rotateIfNeeded(): void {
    try {
      if (!existsSync(this.file)) return;
      if (statSync(this.file).size < this.maxBytes) return;
      const previous = `${this.file}.1`;
      if (existsSync(previous)) unlinkSync(previous);
      renameSync(this.file, previous);
    } catch {
      // A locked file is not worth failing over.
    }
  }
}

export function readIfExists(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * Last `maxLines` lines of a file the bundle can include, newest content kept.
 * Returns "" for a missing file so callers can skip the entry.
 */
export function readLogTail(file: string, maxLines = 400): string {
  const content = readIfExists(file);
  if (!content) return "";
  const lines = content.split(/\r?\n/);
  const trimmed = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  return trimmed.slice(-maxLines).join("\n");
}

export interface LogBundleSource {
  userData: string;
  name: string;
  maxLines?: number;
}

/** Current file plus its rotated predecessor, oldest first. */
export function collectLogText(source: LogBundleSource): string {
  const file = path.join(logsDir(source.userData), source.name);
  const previous = `${file}.1`;
  const maxLines = source.maxLines ?? 400;
  const older = existsSync(previous) ? readLogTail(previous, maxLines) : "";
  const current = readLogTail(file, maxLines);
  return [older, current].filter(Boolean).join("\n");
}
