import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const desktop = path.join(__dirname, "..");

describe("Win11 splash chrome", () => {
  it("keeps Fluent titlebar, caption close, and secondary quit", async () => {
    const html = await readFile(path.join(desktop, "resources", "splash.html"), "utf8");
    const main = await readFile(path.join(desktop, "src", "main.ts"), "utf8");

    expect(html).toContain("Segoe UI");
    expect(html).toContain("#005fb8");
    expect(html).toContain("#c42b1c");
    expect(html).toContain("caption");
    expect(html).toContain('aria-label="关闭"');
    expect(html).toContain("btn-secondary");
    expect(html).toContain("详细信息");
    expect(html).toContain('id="quit"');
    expect(html).toContain("window.desktop.quit");

    expect(main).toContain("backgroundMaterial: \"mica\"");
    expect(main).toContain("width: 528");
    expect(main).toContain("height: 420");
    expect(main).toContain("frame: false");
    expect(main).toContain("splash.html");
  });
});
