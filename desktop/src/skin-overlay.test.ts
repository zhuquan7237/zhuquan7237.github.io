import { describe, expect, it } from "vitest";
import { SKIN_OVERLAY_CSS, skinOverlayBootstrap, skinOverlayHasPicker } from "./skin-overlay";

describe("skin overlay", () => {
  it("ships a circular button and an animated panel", () => {
    const script = skinOverlayBootstrap();
    expect(skinOverlayHasPicker(script)).toBe(true);
    expect(script).toContain("listSkins");
    expect(script).toContain("importSkinUrl");
    expect(script).toContain("上善 → ZipZipPipe → Small-tailqwq");
    expect(script).toContain("&amp;");
    expect(SKIN_OVERLAY_CSS).toContain("border-radius: 50%");
    expect(SKIN_OVERLAY_CSS).toContain("transform-origin: top right");
    expect(SKIN_OVERLAY_CSS).toContain("cubic-bezier");
    expect(SKIN_OVERLAY_CSS).toMatch(/transition:[^;]*380ms/);
  });
});
