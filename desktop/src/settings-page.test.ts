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

  it("points pairing at the engine's own settings page instead of duplicating it", async () => {
    const html = await readFile(path.join(__dirname, "..", "resources", "settings.html"), "utf8");
    // The pairing code, QR and device list live in the mobile-bridge plugin's
    // settings section now: one source of truth, styled by the engine itself.
    // This window only links there.
    expect(html).toContain("window.desktop.mobileOpenPairingSettings()");
    expect(html).toContain("btnOpenPairing");
    for (const gone of ["btnRotate", "pairQrHolder", "devList", "loadPairing", "mobileUrl"]) {
      expect(html).not.toContain(gone);
    }
    expect(html).toContain("window.desktop.desktopAction(\"market\")");
    expect(html).toContain("window.desktop.desktopAction(\"recovery\")");
    expect(html).toContain("window.desktop.mobileOpenSearchSettings()");
  });

  it("wires the transfer tab to the main process instead of touching the filesystem itself", async () => {
    const html = await readFile(path.join(__dirname, "..", "resources", "settings.html"), "utf8");
    // 文件传输页签：数据全部走主进程的 IPC（主进程再打桥接回环路由），
    // 设置页本身不读写文件系统——保持 mobile-bridge 是传输目录的唯一写入方。
    expect(html).toContain('data-tab="transfer"');
    expect(html).toContain('id="tab-transfer"');
    expect(html).toContain("window.desktop.transferList()");
    expect(html).toContain("window.desktop.transferAdd()");
    expect(html).toContain("window.desktop.transferDelete(");
    expect(html).toContain("window.desktop.transferOpenFolder(");
    expect(html).toContain("还没有传输记录");
  });

  it("matches the harness light palette and animates only cheap properties", async () => {
    const html = await readFile(path.join(__dirname, "..", "resources", "settings.html"), "utf8");
    // Values measured off the engine's own settings dialog on 2026-09-22 (see
    // the comment at the top of the stylesheet): they are the whole point of
    // this page looking like the product it configures.
    for (const token of [
      "--bg-main: #ffffff",
      "--bg-panel: #f5f6f7",
      "--bg-selected: #ebeef2",
      "--text-main: #0f1115",
      "--text-muted: #61666b",
      "--text-dim: #81858c",
      "--accent: #4176e6",
      "--radius-control: 18px",
      "color-scheme: light",
    ]) {
      expect(html).toContain(token);
    }
    // A backdrop blur over a scrolling list is the jank source that was reported;
    // hover transitions must stay on border/background, not on shadows.
    expect(html).not.toContain("backdrop-filter");
    expect(html).not.toContain("transition: all");
    expect(html).not.toContain("box-shadow 0.15s");
  });
});
