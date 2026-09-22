import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatPairCode,
  pairingLink,
  qrSvg,
  readPairingSnapshot,
  revokePairingDevice,
  rotatePairing,
} from "./mobile-pairing";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close();
  }
});

/** A stand-in for the bridge's loopback routes. */
async function fakeBridge(
  initial: Record<string, unknown> = {},
): Promise<{ base: string; calls: string[]; state: () => Record<string, unknown> }> {
  const calls: string[] = [];
  let current: Record<string, unknown> = { ...initial };
  const server = createServer((req, res) => {
    calls.push(`${req.method ?? "GET"} ${req.url ?? ""}`);
    const send = (status: number, payload: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const url = req.url ?? "";
    if (url.startsWith("/mobile-local/state")) {
      send(200, current);
      return;
    }
    if (url.startsWith("/mobile-local/rotate")) {
      current = { ...current, pairCode: "1a2b3c4d", pairExpiresAt: Date.now() + 5 * 60_000 };
      send(200, { ok: true, code: "1a2b3c4d", expiresAt: current.pairExpiresAt });
      return;
    }
    if (url.startsWith("/mobile-local/devices/")) {
      current = { ...current, devices: [] };
      send(200, { ok: true, removed: url.split("/").pop() });
      return;
    }
    send(404, { ok: false });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    state: () => current,
  };
}

describe("pairing link and code formatting", () => {
  it("formats a code the way the phone displays it", () => {
    expect(formatPairCode("1a2b3c4d")).toBe("1A2B-3C4D");
    expect(formatPairCode("1A2B-3C4D")).toBe("1A2B-3C4D");
    expect(formatPairCode("abcd")).toBe("ABCD");
  });

  it("builds the link the phone scanner understands", () => {
    expect(pairingLink("https://m.example.com/", "1a2b3c4d")).toBe(
      "https://m.example.com/mobile/?pair=1A2B-3C4D",
    );
  });

  it("encodes a scannable QR for the link", () => {
    const svg = qrSvg(pairingLink("https://m.example.com", "1a2b3c4d"));
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("</svg>");
    expect(svg).toContain("viewBox");
  });
});

describe("pairing snapshot", () => {
  it("reports an absent code without inventing one", async () => {
    const bridge = await fakeBridge({ pairCode: null, devices: [] });
    const snapshot = await readPairingSnapshot({ bridgeBase: bridge.base, publicUrl: "https://m.example.com" });
    expect(snapshot.ok).toBe(true);
    expect(snapshot.pairCode).toBeNull();
    expect(snapshot.qrSvg).toBeNull();
    expect(bridge.calls).toEqual(["GET /mobile-local/state"]);
  });

  it("turns a live code into a formatted code, link and QR", async () => {
    const bridge = await fakeBridge({
      pairCode: "1a2b3c4d",
      pairExpiresAt: Date.now() + 60_000,
      devices: [],
    });
    const snapshot = await readPairingSnapshot({ bridgeBase: bridge.base, publicUrl: "https://m.example.com/" });
    expect(snapshot.pairCode).toBe("1A2B-3C4D");
    expect(snapshot.pairLink).toBe("https://m.example.com/mobile/?pair=1A2B-3C4D");
    expect(snapshot.qrSvg).toContain("<svg");
  });

  it("rotates when asked and no code is live", async () => {
    const bridge = await fakeBridge({ pairCode: null, devices: [] });
    const snapshot = await readPairingSnapshot({
      bridgeBase: bridge.base,
      publicUrl: "https://m.example.com",
      ensure: true,
    });
    expect(snapshot.pairCode).toBe("1A2B-3C4D");
    expect(bridge.calls).toEqual([
      "GET /mobile-local/state",
      "POST /mobile-local/rotate",
      "GET /mobile-local/state",
    ]);
  });

  it("keeps the devices the bridge reports and drops entries without an id", async () => {
    const bridge = await fakeBridge({
      pairCode: null,
      devices: [
        { id: "a", name: "Pixel", scopes: ["read", "prompt"], lastSeenAt: 1 },
        { name: "no id" },
      ],
    });
    const snapshot = await readPairingSnapshot({ bridgeBase: bridge.base, publicUrl: "" });
    expect(snapshot.devices.map((device) => device.id)).toEqual(["a"]);
    expect(snapshot.devices[0]?.scopes).toEqual(["read", "prompt"]);
  });

  it("fails honestly when the bridge is down", async () => {
    const snapshot = await readPairingSnapshot({ bridgeBase: "http://127.0.0.1:1", publicUrl: "" });
    expect(snapshot.ok).toBe(false);
    expect(snapshot.error).toBeTruthy();
    expect(snapshot.qrSvg).toBeNull();
  });

  it("does not build a QR without a reachable address", async () => {
    const bridge = await fakeBridge({ pairCode: "1a2b3c4d", pairExpiresAt: Date.now() + 60_000, publicUrl: "" });
    const snapshot = await readPairingSnapshot({ bridgeBase: bridge.base, publicUrl: "" });
    expect(snapshot.pairLink).toBe("http://127.0.0.1/mobile/?pair=1A2B-3C4D");
    expect(snapshot.qrSvg).toBeNull();
    expect(snapshot.pairCode).toBe("1A2B-3C4D");
  });
});

describe("rotate and revoke", () => {
  it("rotates through the bridge", async () => {
    const bridge = await fakeBridge({ devices: [] });
    const result = await rotatePairing(bridge.base);
    expect(result.ok).toBe(true);
    expect(bridge.calls).toContain("POST /mobile-local/rotate");
  });

  it("revokes a device by id", async () => {
    const bridge = await fakeBridge({ devices: [{ id: "abc" }] });
    const result = await revokePairingDevice(bridge.base, "abc");
    expect(result.ok).toBe(true);
    expect(bridge.calls).toContain("DELETE /mobile-local/devices/abc");
  });

  it("refuses an empty device id", async () => {
    const bridge = await fakeBridge({});
    const result = await revokePairingDevice(bridge.base, "  ");
    expect(result.ok).toBe(false);
    expect(bridge.calls).toEqual([]);
  });
});
