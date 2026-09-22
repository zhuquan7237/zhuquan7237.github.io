/**
 * Phone-companion helpers for the desktop settings window.
 *
 * The mobile-bridge plugin owns the pairing store and publishes it on loopback
 * under `/mobile-local/*` (state / rotate / devices/{id}). The shell only ever
 * talks to those routes, so the bridge stays the single writer of
 * `dsh-home/mobile-bridge.json` and the settings window can never disagree with
 * what a phone actually sees.
 */
import qrcode from "qrcode-generator";

/** How long a pairing code answers. Mirrors PAIR_CODE_TTL_MS in the bridge. */
export const PAIR_TTL_MS = 5 * 60 * 1000;

export interface PairingDevice {
  id: string;
  name?: string;
  platform?: string;
  scopes?: string[];
  createdAt?: number;
  lastSeenAt?: number;
  pushSubscriptions?: number;
}

/** Everything the settings card renders in one round trip. */
export interface PairingSnapshot {
  ok: boolean;
  error?: string;
  /** Public address the QR points at; empty when only a loopback address is known. */
  publicUrl: string;
  pairCode: string | null;
  pairExpiresAt: number | null;
  pairLink: string | null;
  qrSvg: string | null;
  devices: PairingDevice[];
}

interface RawState {
  pairCode?: unknown;
  pairExpiresAt?: unknown;
  pairUrl?: unknown;
  publicUrl?: unknown;
  devices?: unknown;
}

/** Display form AAAA-BBBB; the scanner normalizes to uppercase alphanumerics. */
export function formatPairCode(value: string): string {
  const normalized = value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return normalized.length === 8
    ? `${normalized.slice(0, 4)}-${normalized.slice(4)}`
    : normalized;
}

/** What the phone scanner understands: `<base>/mobile/?pair=CODE`. */
export function pairingLink(base: string, code: string): string {
  return `${base.trim().replace(/\/+$/, "")}/mobile/?pair=${formatPairCode(code)}`;
}

/** Inline SVG for the pairing link. The card only renders it; nothing parses it back. */
export function qrSvg(payload: string): string {
  const qr = qrcode(0, "M");
  qr.addData(payload);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

async function bridgeFetch(
  bridgeBase: string,
  path: string,
  init: { method?: string } = {},
  timeoutMs = 4000,
): Promise<{ ok: boolean; status: number; payload: unknown }> {
  const base = bridgeBase.trim().replace(/\/+$/, "");
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    signal: AbortSignal.timeout(timeoutMs),
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  return { ok: response.ok, status: response.status, payload };
}

function deviceList(raw: unknown): PairingDevice[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry) => ({
      id: String(entry.id ?? ""),
      name: typeof entry.name === "string" ? entry.name : undefined,
      platform: typeof entry.platform === "string" ? entry.platform : undefined,
      scopes: Array.isArray(entry.scopes) ? entry.scopes.map((scope) => String(scope)) : [],
      createdAt: typeof entry.createdAt === "number" ? entry.createdAt : undefined,
      lastSeenAt: typeof entry.lastSeenAt === "number" ? entry.lastSeenAt : undefined,
      pushSubscriptions:
        typeof entry.pushSubscriptions === "number" ? entry.pushSubscriptions : undefined,
    }))
    .filter((device) => device.id !== "");
}

/**
 * Read the live pairing state. With `ensure` set, a code is generated when none
 * is live: a user who opens this card wants something to scan, not a button to
 * press first.
 */
export async function readPairingSnapshot(options: {
  bridgeBase: string;
  publicUrl: string;
  ensure?: boolean;
}): Promise<PairingSnapshot> {
  const publicUrl = options.publicUrl.trim().replace(/\/+$/, "");
  const empty: PairingSnapshot = {
    ok: false,
    publicUrl,
    pairCode: null,
    pairExpiresAt: null,
    pairLink: null,
    qrSvg: null,
    devices: [],
  };
  if (options.bridgeBase.trim() === "") {
    return { ...empty, error: "引擎还没起来，稍等一下再打开这个页面。" };
  }
  try {
    let state = await bridgeFetch(options.bridgeBase, "/mobile-local/state");
    if (!state.ok || typeof state.payload !== "object" || state.payload === null) {
      return { ...empty, error: "读不到配对状态（桥接没有响应）。" };
    }
    let raw = state.payload as RawState;
    const liveCode = typeof raw.pairCode === "string" && raw.pairCode !== "" ? raw.pairCode : null;
    const expiresAt = typeof raw.pairExpiresAt === "number" ? raw.pairExpiresAt : null;
    const expired = expiresAt !== null && expiresAt <= Date.now();
    if (options.ensure === true && (liveCode === null || expired)) {
      const rotated = await bridgeFetch(options.bridgeBase, "/mobile-local/rotate", {
        method: "POST",
      });
      if (rotated.ok) {
        // Re-read instead of trusting the rotate payload: the state route is the
        // same one a phone's pairing attempt writes through.
        const again = await bridgeFetch(options.bridgeBase, "/mobile-local/state");
        if (again.ok && typeof again.payload === "object" && again.payload !== null) {
          raw = again.payload as RawState;
        }
      }
    }
    const code = typeof raw.pairCode === "string" && raw.pairCode !== "" ? raw.pairCode : null;
    const codeExpiresAt = typeof raw.pairExpiresAt === "number" ? raw.pairExpiresAt : null;
    const codeLive = code !== null && (codeExpiresAt === null || codeExpiresAt > Date.now());
    const base = publicUrl !== "" ? publicUrl : String(raw.publicUrl ?? "").trim();
    const link = codeLive ? pairingLink(base !== "" ? base : "http://127.0.0.1", code) : null;
    return {
      ok: true,
      publicUrl,
      pairCode: codeLive ? formatPairCode(code) : null,
      pairExpiresAt: codeLive ? codeExpiresAt : null,
      pairLink: link,
      qrSvg: link !== null && base !== "" ? qrSvg(link) : null,
      devices: deviceList(raw.devices),
    };
  } catch (error) {
    return {
      ...empty,
      error: `读不到配对状态：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Generate (or replace) the pairing code. */
export async function rotatePairing(
  bridgeBase: string,
): Promise<{ ok: boolean; error?: string; code?: string }> {
  try {
    const result = await bridgeFetch(bridgeBase, "/mobile-local/rotate", { method: "POST" });
    if (!result.ok) return { ok: false, error: `生成配对码失败（HTTP ${result.status}）。` };
    const payload = (result.payload ?? {}) as { code?: unknown };
    return { ok: true, code: typeof payload.code === "string" ? payload.code : undefined };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Drop a bound device; the next request from it fails the upgrade handshake. */
export async function revokePairingDevice(
  bridgeBase: string,
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  if (id.trim() === "") return { ok: false, error: "设备 id 为空。" };
  try {
    const result = await bridgeFetch(
      bridgeBase,
      `/mobile-local/devices/${encodeURIComponent(id.trim())}`,
      { method: "DELETE" },
    );
    if (!result.ok) return { ok: false, error: `解除设备失败（HTTP ${result.status}）。` };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
