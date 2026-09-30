import { describe, expect, it } from "vitest";
import { isInsideDir, isSafeExternalUrl, isSameOrigin, mergeSettingsPreservingSecrets, stripUrlSecrets } from "./security";
import { isLocalRequestAllowed } from "../resources/plugins/mobile-bridge/src/local-guard";

describe("isInsideDir", () => {
  const home = "D:\\DeepSeekData";
  it("accepts the root and its children", () => {
    expect(isInsideDir(home, home, "win32")).toBe(true);
    expect(isInsideDir("D:\\DeepSeekData\\transfer\\files", home, "win32")).toBe(true);
    expect(isInsideDir("d:\\deepseekdata\\transfer", home, "win32")).toBe(true);
  });
  it("rejects sibling prefixes and traversal", () => {
    expect(isInsideDir("D:\\DeepSeekData-evil", home, "win32")).toBe(false);
    expect(isInsideDir("D:\\DeepSeekData\\..\\Windows\\System32\\cmd.exe", home, "win32")).toBe(false);
    expect(isInsideDir("C:\\Windows", home, "win32")).toBe(false);
    expect(isInsideDir("", home, "win32")).toBe(false);
  });
});

describe("external links", () => {
  it("only lets web links reach the OS", () => {
    expect(isSafeExternalUrl("https://github.com/x")).toBe(true);
    expect(isSafeExternalUrl("http://example.com")).toBe(true);
    expect(isSafeExternalUrl("file:///C:/Windows/System32/calc.exe")).toBe(false);
    expect(isSafeExternalUrl("ms-msdt:/id PCWDiagnostic")).toBe(false);
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("not a url")).toBe(false);
  });
  it("keeps the main window on the engine origin", () => {
    const engine = "http://127.0.0.1:17731/?token=abc";
    expect(isSameOrigin("http://127.0.0.1:17731/sessions/1", engine)).toBe(true);
    expect(isSameOrigin("http://127.0.0.1:9999/", engine)).toBe(false);
    expect(isSameOrigin("https://evil.example.com/", engine)).toBe(false);
  });
});

describe("stripUrlSecrets", () => {
  it("drops the engine token from diagnostics", () => {
    expect(stripUrlSecrets("http://127.0.0.1:17731/?token=AbF3secret")).toBe("http://127.0.0.1:17731/");
    expect(stripUrlSecrets("")).toBe("");
  });
});

describe("mergeSettingsPreservingSecrets", () => {
  it("keeps nested fields the update did not mention", () => {
    const current = { webPort: 17731, visionAux: { model: "a", apiKey: "sk-keep", baseURL: "u" } };
    const merged = mergeSettingsPreservingSecrets(current, { visionAux: { model: "b" } } as never);
    expect(merged.visionAux).toEqual({ model: "b", apiKey: "sk-keep", baseURL: "u" });
    expect(merged.webPort).toBe(17731);
  });
  it("still honours an explicit clear", () => {
    const merged = mergeSettingsPreservingSecrets({ visionAux: { apiKey: "sk-x" } }, { visionAux: { apiKey: "" } });
    expect(merged.visionAux.apiKey).toBe("");
  });
});

describe("mobile-local guard (DNS rebinding)", () => {
  it("accepts loopback hosts", () => {
    expect(isLocalRequestAllowed({ host: "127.0.0.1:17731" })).toBe(true);
    expect(isLocalRequestAllowed({ host: "localhost:17731", origin: "http://localhost:17731" })).toBe(true);
    expect(isLocalRequestAllowed({ host: "[::1]:17731" })).toBe(true);
  });
  it("rejects a rebound hostname or a foreign origin", () => {
    expect(isLocalRequestAllowed({ host: "evil.example.com" })).toBe(false);
    expect(isLocalRequestAllowed({ host: "127.0.0.1.evil.com:17731" })).toBe(false);
    expect(isLocalRequestAllowed({ host: "127.0.0.1:17731", origin: "https://evil.example.com" })).toBe(false);
    expect(isLocalRequestAllowed({ host: "127.0.0.1:17731", origin: "null" })).toBe(false);
    expect(isLocalRequestAllowed({})).toBe(false);
  });
});
