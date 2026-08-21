import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("settings page contract", () => {
  it("uses UTF-8 and the ProviderInfo fields returned by the main process", async () => {
    const html = await readFile(path.join(__dirname, "..", "resources", "settings.html"), "utf8");

    expect(html).toContain('<meta charset="UTF-8" />');
    expect(html).toContain("getVersion");
    expect(html).toContain("Array.isArray(raw) ? raw : (raw.providers || [])");
    expect(html).toContain("p.name || p.id");
    expect(html).toContain("p.modelCount");
    expect(html).toContain("res.error");
    expect(html).toContain("Desktop v${await window.desktop.getVersion()}");
    expect(html).not.toContain("p.displayName");
    expect(html).not.toContain("p.modelsCount");
    expect(html).not.toContain("Desktop v0.2.1");
    expect(html).not.toContain("�");
  });
});
