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

describe("settings page keeps what the user already had", () => {
  it("never writes an empty string over a saved key it never displayed", async () => {
    const html = await readFile(path.join(__dirname, "..", "resources", "settings.html"), "utf8");
    // A key the page cannot show must survive a save the user did not touch.
    expect(html).toContain('const loadedSecrets = { vision: "", tavily: "" }');
    expect(html).toContain('const secretDirty = { vision: false, tavily: false }');
    expect(html).toContain('apiKey: secretDirty.vision ? $("visionKey").value.trim() : loadedSecrets.vision');
    expect(html).toContain('apiKey: secretDirty.tavily ? $("tavilyKey").value.trim() : loadedSecrets.tavily');
    expect(html).not.toContain('apiKey: $("');
  });

  it("refuses to save before the current settings loaded", async () => {
    const html = await readFile(path.join(__dirname, "..", "resources", "settings.html"), "utf8");
    // Saving the defaults over a user's settings is the worst outcome here.
    expect(html).toContain("let formReady = false");
    expect(html).toContain("if (!formReady) {");
    expect(html).toContain("formReady = true;");
    expect(html).toContain("已禁止保存以免覆盖原有配置");
  });

  it("renders the phone pairing card off the bridge routes", async () => {
    const html = await readFile(path.join(__dirname, "..", "resources", "settings.html"), "utf8");
    for (const marker of [
      "window.desktop.mobilePairing",
      "loadPairing(true)",
      "window.desktop.mobileRotate()",
      "window.desktop.mobileRevoke(device.id)",
      "window.desktop.mobileCopy(result.pairLink)",
      "window.desktop.mobileOpenSearchSettings()",
      "pairQrHolder",
      "btnRotate",
      "devList",
    ]) {
      expect(html).toContain(marker);
    }
  });
});
