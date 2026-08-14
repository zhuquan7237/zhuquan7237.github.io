import { describe, expect, it } from "vitest";
import { DEEPSEEK_WHALE_SVG, SKIN_OVERLAY_CSS, skinOverlayBootstrap, skinOverlayHasPicker } from "./skin-overlay";

describe("skin overlay", () => {
  it("ships a circular whale button, animated panel, and a close control", () => {
    const script = skinOverlayBootstrap();
    expect(skinOverlayHasPicker(script)).toBe(true);
    expect(script).toContain("listSkins");
    expect(script).toContain("importSkinUrl");
    expect(script).toContain("setSkinsEnabled");
    expect(script).toContain("关闭皮肤中心");
    expect(script).toContain("#4D6BFE");
    expect(script).toContain("上善 → ZipZipPipe → Small-tailqwq");
    expect(script).toContain("&amp;");
    expect(DEEPSEEK_WHALE_SVG).toContain("#4D6BFE");
    expect(SKIN_OVERLAY_CSS).toContain("border-radius: 50%");
    expect(SKIN_OVERLAY_CSS).toContain("transform-origin: top right");
    expect(SKIN_OVERLAY_CSS).toContain("cubic-bezier");
    expect(SKIN_OVERLAY_CSS).toMatch(/transition:[^;]*380ms/);
  });
});
