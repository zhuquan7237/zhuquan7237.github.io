import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("macOS Gatekeeper helpers", () => {
  it("ships a readable first-run note and an xattr unlock script", async () => {
    const note = await readFile(path.join(__dirname, "..", "resources", "Read-Me-First.txt"), "utf8");
    const script = await readFile(path.join(__dirname, "..", "resources", "Open-DeepSeek.command"), "utf8");
    expect(note).toContain("xattr -cr /Applications/DeepSeek.app");
    expect(note).toContain("mac-arm64.dmg");
    expect(note).toContain("不要做");
    expect(note).not.toContain("spctl --master-disable");
    expect(script.startsWith("#!/bin/bash")).toBe(true);
    expect(script).toContain("xattr -cr");
    expect(script).toContain("com.apple.quarantine");
    expect(script).toContain("/Applications/DeepSeek.app");
  });
});
