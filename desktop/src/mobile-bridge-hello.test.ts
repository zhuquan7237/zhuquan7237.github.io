import { describe, expect, it } from "vitest";
import { normalizeSince } from "../resources/plugins/mobile-bridge/src/hello";

// The bug this guards against shipped: the phone stores its own event
// watermark on disk, the bridge's counter restarts at zero with the engine, and
// an unclamped watermark made the phone deaf while its socket still looked
// connected. Live reproduction: `since=999999` received 0 of a turn's 12 frames
// while `since=0` received all of them.
describe("normalizeSince", () => {
  it("keeps an honest watermark and picks up right after it", () => {
    expect(normalizeSince(12, 20, 5)).toEqual({ since: 12, stale: false, gap: false });
  });

  it("treats a watermark above the counter as stale and resumes from zero", () => {
    // This is the shipped failure: since=999999 against seq=150.
    expect(normalizeSince(999999, 150, 1)).toEqual({ since: 0, stale: true, gap: true });
  });

  it("treats a watermark exactly at the counter as up to date, not stale", () => {
    expect(normalizeSince(150, 150, 1)).toEqual({ since: 150, stale: false, gap: false });
  });

  it("flags a gap when the buffer no longer holds the frames after the watermark", () => {
    // Buffer starts at 100, client claims 40: frames 41..99 were dropped.
    expect(normalizeSince(40, 150, 100)).toEqual({ since: 40, stale: false, gap: true });
  });

  it("does not flag a gap when the buffer still reaches back far enough", () => {
    expect(normalizeSince(99, 150, 100)).toEqual({ since: 99, stale: false, gap: false });
    expect(normalizeSince(100, 150, 100)).toEqual({ since: 100, stale: false, gap: false });
  });

  it("does not flag a gap for a client with nothing to catch up on", () => {
    expect(normalizeSince(0, 150, 100)).toEqual({ since: 0, stale: false, gap: false });
  });

  it("survives garbage: NaN, Infinity, negative and fractional watermarks", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -3]) {
      expect(normalizeSince(bad, 10, 1)).toEqual({ since: 0, stale: false, gap: false });
    }
    expect(normalizeSince(7.9, 10, 1)).toEqual({ since: 7, stale: false, gap: false });
  });

  it("handles a bridge that has published nothing yet", () => {
    expect(normalizeSince(0, 0, undefined)).toEqual({ since: 0, stale: false, gap: false });
    expect(normalizeSince(50, 0, undefined)).toEqual({ since: 0, stale: true, gap: true });
  });
});
