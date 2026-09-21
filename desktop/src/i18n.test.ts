import { describe, expect, it } from "vitest";
import {
  createTranslator,
  dictionaryKeys,
  resolveShellLocale,
  shellLocaleFromSetting,
} from "./i18n";

describe("shell locale", () => {
  it("treats any zh tag as Chinese and everything else as English", () => {
    expect(resolveShellLocale("zh-CN")).toBe("zh-CN");
    expect(resolveShellLocale("zh_CN.UTF-8")).toBe("zh-CN");
    expect(resolveShellLocale("zh-Hant-TW")).toBe("zh-CN");
    expect(resolveShellLocale("en-US")).toBe("en");
    expect(resolveShellLocale("de")).toBe("en");
    expect(resolveShellLocale("")).toBe("en");
    expect(resolveShellLocale(undefined)).toBe("en");
  });

  it("lets settings pin the language and otherwise follows the system", () => {
    expect(shellLocaleFromSetting("en", "zh-CN")).toEqual({ locale: "en", source: "setting" });
    expect(shellLocaleFromSetting("zh-CN", "en-US")).toEqual({ locale: "zh-CN", source: "setting" });
    expect(shellLocaleFromSetting("", "zh-CN")).toEqual({ locale: "zh-CN", source: "system" });
    expect(shellLocaleFromSetting("   ", "en-GB")).toEqual({ locale: "en", source: "system" });
  });
});

describe("translator", () => {
  it("interpolates named placeholders and drops unknown ones", () => {
    const zh = createTranslator("zh-CN");
    expect(zh("menu.harness.status", { version: "0.1.5-rc.2" })).toBe("当前引擎 0.1.5-rc.2");
    expect(zh("tray.tooltip", { state: "x" })).toBe("DeepSeek Harness — x");
    expect(zh("menu.harness.status", {})).toBe("当前引擎 ");
  });

  it("returns the key itself for a string nobody translated", () => {
    expect(createTranslator("en")("nope.missing")).toBe("nope.missing");
  });

  it("keeps both dictionaries in sync so no locale silently falls back", () => {
    expect(dictionaryKeys("en")).toEqual(dictionaryKeys("zh-CN"));
    expect(dictionaryKeys("zh-CN").length).toBeGreaterThan(60);
  });

  it("translates the strings the tray and recovery window depend on", () => {
    const en = createTranslator("en");
    const zh = createTranslator("zh-CN");
    for (const key of [
      "tray.stateRunning",
      "tray.tooltip",
      "menu.harness.exportDiagnostics",
      "recovery.rollback",
      "diag.doneMessage",
      "status.launching",
    ]) {
      expect(en(key, { version: "1.0.0", state: "s", name: "n" })).not.toBe(key);
      expect(zh(key, { version: "1.0.0", state: "s", name: "n" })).not.toBe(key);
    }
  });
});
