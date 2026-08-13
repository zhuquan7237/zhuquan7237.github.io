import { describe, expect, it } from "vitest";
import {
  applyRegistryPreference,
  chromeSandboxIsConfigured,
  clampWindowBounds,
  compareVersions,
  formatByteProgress,
  isSystemInstalledApp,
  linuxDesktopEntry,
  linuxRuntimeArgvExtras,
  linuxShmNeedsWorkaround,
  localePrefersChina,
  nodeDistFile,
  nodeDownloadUrls,
  nodeMeetsEngine,
  normalizeLocaleTag,
  npmInvocation,
  npmSpec,
  parseDshWebUrl,
  parseXdgUserDir,
  preferredNpmRegistry,
  resolveLinuxDesktopDir,
  resolveUiLocale,
  seedWorkspaceRegistry,
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

describe("first-run helpers", () => {
  it("formats download progress", () => {
    expect(formatByteProgress(10 * 1048576, 40 * 1048576)).toBe("25%（10.0 MB / 40.0 MB）");
    expect(formatByteProgress(1536, 0)).toBe("0.0 MB");
  });

  it("only treats root setuid chrome-sandbox as usable", () => {
    expect(chromeSandboxIsConfigured({ uid: 0, mode: 0o104755 })).toBe(true);
    expect(chromeSandboxIsConfigured({ uid: 1000, mode: 0o755 })).toBe(false);
    expect(chromeSandboxIsConfigured(null)).toBe(false);
  });

  it("clamps window bounds onto the work area", () => {
    const next = clampWindowBounds(
      { x: -200, y: 20, width: 5000, height: 2000 },
      { x: 0, y: 0, width: 1920, height: 1080 },
    );
    expect(next.width).toBe(1920);
    expect(next.height).toBe(1080);
    expect(next.x).toBe(0);
    expect(next.y).toBe(0);
  });

  it("writes a desktop entry ordinary Linux shells can launch", () => {
    const text = linuxDesktopEntry({ exec: "/home/me/DeepSeek", icon: "/home/me/icon.png" });
    expect(text).toContain("Name=DeepSeek Harness");
    expect(text).toContain("StartupWMClass=DeepSeek Harness");
    expect(text).toContain("Exec=/home/me/DeepSeek %U");
    expect(text).toContain("Categories=Development;IDE;");
  });

  it("quotes Exec paths that contain spaces", () => {
    const text = linuxDesktopEntry({ exec: "/opt/My Apps/DeepSeek", icon: "deepseek-harness" });
    expect(text).toContain('Exec="/opt/My Apps/DeepSeek" %U');
  });
});

describe("typical-user defaults", () => {
  it("picks the China npm mirror for zh_CN", () => {
    expect(localePrefersChina({ LANG: "zh_CN.UTF-8" })).toBe(true);
    expect(preferredNpmRegistry({ LANG: "en_US.UTF-8" })).toBe("https://registry.npmjs.org");
    expect(preferredNpmRegistry({ LANG: "zh_CN.UTF-8" })).toBe("https://registry.npmmirror.com");
    expect(preferredNpmRegistry({ LANG: "en_US.UTF-8" }, "Asia/Shanghai")).toBe("https://registry.npmmirror.com");
  });

  it("lists Node download mirrors with a China-first fallback", () => {
    const chinaFirst = nodeDownloadUrls("node-v22.23.2-linux-x64.tar.xz", true);
    expect(chinaFirst[0]).toContain("npmmirror.com");
    expect(chinaFirst[1]).toContain("nodejs.org");
  });

  it("only disables shm when a mount is noexec", () => {
    expect(linuxShmNeedsWorkaround("tmpfs /dev/shm tmpfs rw,nosuid,nodev 0 0\n")).toBe(false);
    expect(linuxShmNeedsWorkaround("tmpfs /dev/shm tmpfs rw,nosuid,nodev,noexec 0 0\n")).toBe(true);
  });

  it("keeps GPU enabled and only adds Linux flags that are actually needed", () => {
    expect(
      linuxRuntimeArgvExtras({
        sandboxConfigured: true,
        shmNoexec: false,
        hasSwitch: () => false,
      }),
    ).toEqual([]);
    expect(
      linuxRuntimeArgvExtras({
        sandboxConfigured: false,
        shmNoexec: true,
        hasSwitch: () => false,
      }),
    ).toEqual(["--no-sandbox", "--disable-gpu-sandbox", "--disable-dev-shm-usage"]);
  });

  it("keeps following the system language until the user picks a registry", () => {
    const china = "https://registry.npmmirror.com";
    expect(applyRegistryPreference({ registry: "https://registry.npmjs.org" }, china)).toEqual({
      registry: china,
      registrySource: "auto",
    });
    expect(
      applyRegistryPreference({ registry: "https://registry.npmjs.org", registrySource: "user" }, china),
    ).toEqual({ registry: "https://registry.npmjs.org", registrySource: "user" });
  });

  it("turns POSIX locales into Chromium language tags", () => {
    expect(normalizeLocaleTag("zh_CN.UTF-8")).toBe("zh-CN");
    expect(normalizeLocaleTag("C")).toBe("");
    expect(resolveUiLocale({ LANG: "zh_CN.UTF-8" })).toBe("zh-CN");
    expect(resolveUiLocale({ LANG: "C", LANGUAGE: "" })).toBe("");
    expect(resolveUiLocale({}, "zh-hans-cn")).toBe("zh-Hans-CN");
    expect(localePrefersChina({}, "", "zh-Hans-CN")).toBe(true);
  });

  it("runs npm through node when a sidecar cli is available", () => {
    expect(npmInvocation({ node: "/n/node", npm: "/n/npm", npmCli: "/n/npm-cli.js" }, ["install"])).toEqual({
      command: "/n/node",
      args: ["/n/npm-cli.js", "install"],
    });
    expect(npmInvocation({ node: "node", npm: "npm", npmCli: null }, ["install"])).toEqual({
      command: "npm",
      args: ["install"],
    });
  });

  it("registers a default workspace only into an empty dsh registry", () => {
    const entry = { id: "id-1", path: "/home/me/DeepSeek", title: "DeepSeek", now: "2026-01-01T00:00:00.000Z" };
    const seeded = seedWorkspaceRegistry(null, entry);
    expect(seeded?.global.workspaceIds).toEqual(["id-1"]);
    expect(seeded?.tables.workspaces["id-1"]).toMatchObject({ path: "/home/me/DeepSeek", sessionIds: [] });

    const used = {
      unit: { name: "workspace", version: 2 },
      global: { initialized: true, workspaceIds: ["mine"], archivedSessionIds: [] },
      tables: { workspaces: { mine: { path: "/other" } } },
    };
    expect(seedWorkspaceRegistry(used, entry)).toBeNull();
    expect(seedWorkspaceRegistry({ unit: { name: "workspace", version: 3 } }, entry)).toBeNull();
  });

  it("reads XDG desktop folders including 桌面", () => {
    expect(parseXdgUserDir('XDG_DESKTOP_DIR="$HOME/桌面"\n', "XDG_DESKTOP_DIR", "/home/me")).toBe("/home/me/桌面");
    expect(
      resolveLinuxDesktopDir("/home/me", {}, (p) => p.endsWith("桌面"), 'XDG_DESKTOP_DIR="$HOME/桌面"\n'),
    ).toBe("/home/me/桌面");
    expect(isSystemInstalledApp("/usr/bin/DeepSeek")).toBe(true);
    expect(isSystemInstalledApp("/home/me/DeepSeek-0.1.3-linux-x64/DeepSeek")).toBe(false);
  });
});
