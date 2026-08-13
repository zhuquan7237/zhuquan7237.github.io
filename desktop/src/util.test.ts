import { describe, expect, it } from "vitest";
import {
  compareVersions,
  nodeDistFile,
  nodeMeetsEngine,
  npmSpec,
  parseDshWebUrl,
} from "./util";

describe("parseDshWebUrl", () => {
  it("reads the official banner", () => {
    expect(parseDshWebUrl("booting...\ndsh web: http://127.0.0.1:3080\n")).toBe("http://127.0.0.1:3080");
  });

  it("falls back to a localhost URL", () => {
    expect(parseDshWebUrl("listening on http://127.0.0.1:4173/")).toBe("http://127.0.0.1:4173/");
  });

  it("returns null when missing", () => {
    expect(parseDshWebUrl("still starting")).toBeNull();
  });
});

describe("versions", () => {
  it("orders rc prereleases", () => {
    expect(compareVersions("0.1.0-rc.5", "0.1.0-rc.6")).toBe(-1);
    expect(compareVersions("0.1.0-rc.6", "0.1.0")).toBe(-1);
    expect(compareVersions("0.1.0", "0.1.0-rc.6")).toBe(1);
    expect(nodeMeetsEngine("v22.19.0")).toBe(true);
    expect(nodeMeetsEngine("v22.18.0")).toBe(false);
  });
});

describe("npm and node dist names", () => {
  it("builds npm specs", () => {
    expect(npmSpec("latest")).toBe("@deepseek-ai/dsh@latest");
    expect(npmSpec("0.1.0-rc.6")).toBe("@deepseek-ai/dsh@0.1.0-rc.6");
  });

  it("names official node archives", () => {
    expect(nodeDistFile("linux", "x64").archive).toBe("node-v22.23.2-linux-x64.tar.xz");
    expect(nodeDistFile("win32", "arm64").binary).toBe("node.exe");
    expect(nodeDistFile("darwin", "arm64").dir).toBe("node-v22.23.2-darwin-arm64");
  });
});
