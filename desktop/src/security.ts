import path from "node:path";

/**
 * Only web links leave the app through the OS handler. Anything else a page
 * can ask for (file:, ms-msdt:, custom protocol handlers…) is refused, so an
 * injected link can't launch local programs.
 */
export function isSafeExternalUrl(target: string): boolean {
  try {
    const url = new URL(String(target ?? ""));
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

/**
 * The main window hosts the engine UI with the desktop preload attached; it must
 * never navigate away from the engine's own origin (a foreign page would get
 * `window.desktop.*`).
 */
export function isSameOrigin(target: string, allowedOrigin: string): boolean {
  try {
    return allowedOrigin !== "" && new URL(target).origin === new URL(allowedOrigin).origin;
  } catch {
    return false;
  }
}

/**
 * True when `target` resolves to `root` or somewhere inside it. A bare
 * `startsWith` lets `D:\DeepSeekData-evil` and `D:\DeepSeekData\..\Windows`
 * through; this compares resolved, case-folded (Windows) path segments.
 */
export function isInsideDir(target: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  if (String(target ?? "") === "" || String(root ?? "") === "") return false;
  const p = platform === "win32" ? path.win32 : path.posix;
  const fold = (value: string): string => (platform === "win32" ? value.toLowerCase() : value);
  const resolvedRoot = fold(p.resolve(root));
  const resolvedTarget = fold(p.resolve(target));
  const rel = p.relative(resolvedRoot, resolvedTarget);
  return rel === "" || (!rel.startsWith("..") && !p.isAbsolute(rel));
}

/** Drops query/hash (the engine URL carries `?token=`) before it goes into a shareable file. */
export function stripUrlSecrets(value: string): string {
  const text = String(value ?? "");
  if (text === "") return text;
  try {
    const url = new URL(text);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return text.replace(/[?#].*$/, "");
  }
}

/**
 * Merge a settings update without letting a partial nested object (e.g. a
 * `visionAux` sent without its `apiKey`) wipe the fields it didn't mention.
 * An explicit value — including "" to clear a key on purpose — still wins.
 */
export function mergeSettingsPreservingSecrets<T extends object>(current: T, next: Partial<T>): T {
  const out: Record<string, unknown> = { ...(current as Record<string, unknown>) };
  for (const [key, value] of Object.entries(next ?? {})) {
    const prev = out[key];
    if (isPlainObject(value) && isPlainObject(prev)) {
      out[key] = mergeSettingsPreservingSecrets(prev, value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
