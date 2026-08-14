import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import {
  copyFileIfChanged,
  installUserShortcuts,
  shouldRewriteTextFile,
  shouldRewriteWindowsShortcut,
  syncShortcutFile,
  windowsShortcutIdentity,
  windowsShortcutScript,
} from "./desktop-integration";

const temps: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("shortcut rewrite guards", () => {
  it("does not rewrite an identical .desktop body", () => {
    const body = "[Desktop Entry]\nName=DeepSeek Harness\n";
    expect(shouldRewriteTextFile(body, body)).toBe(false);
    expect(shouldRewriteTextFile(null, body)).toBe(true);
    expect(shouldRewriteTextFile(body, body, true)).toBe(true);
    expect(shouldRewriteTextFile("old", body)).toBe(true);
  });

  it("only rewrites Windows .lnk when missing, forced, or the stamp changed", () => {
    const stamp = windowsShortcutIdentity("C:\\DeepSeek\\DeepSeek.exe", "C:\\DeepSeek", "0.1.8");
    expect(shouldRewriteWindowsShortcut(stamp, stamp, true)).toBe(false);
    expect(shouldRewriteWindowsShortcut(stamp, stamp, false)).toBe(true);
    expect(shouldRewriteWindowsShortcut(null, stamp, true)).toBe(true);
    expect(shouldRewriteWindowsShortcut(stamp, stamp, true, true)).toBe(true);
    expect(
      shouldRewriteWindowsShortcut(
        stamp,
        windowsShortcutIdentity("D:\\DeepSeek\\DeepSeek.exe", "D:\\DeepSeek", "0.1.8"),
        true,
      ),
    ).toBe(true);
  });

  it("quotes PowerShell .lnk paths that contain apostrophes", () => {
    const script = windowsShortcutScript("C:\\O'Brien\\DeepSeek Harness.lnk", "C:\\O'Brien\\DeepSeek.exe", "C:\\O'Brien");
    expect(script).toContain("C:\\O''Brien\\DeepSeek.exe");
    expect(script).toContain("$s.IconLocation = 'C:\\O''Brien\\DeepSeek.exe,0'");
    expect(script).toContain("$s.WorkingDirectory = 'C:\\O''Brien'");
  });
});

describe("syncShortcutFile", () => {
  it("leaves mtime alone when the file already has the same body", async () => {
    const dir = await tempDir("ds-sync-");
    const file = path.join(dir, "DeepSeek Harness.desktop");
    const body = "[Desktop Entry]\nName=DeepSeek Harness\nExec=/opt/DeepSeek %U\n";
    expect(await syncShortcutFile(file, body)).toBe("created");
    const first = await stat(file);
    await utimes(file, first.atime, new Date(first.mtimeMs - 10_000));
    const aged = await stat(file);
    expect(await syncShortcutFile(file, body)).toBe("unchanged");
    const second = await stat(file);
    expect(second.mtimeMs).toBe(aged.mtimeMs);
    expect(await readFile(file, "utf8")).toBe(body);
    expect(await syncShortcutFile(file, body + "Path=/home/me/DeepSeek\n")).toBe("updated");
    expect(await readFile(file, "utf8")).toContain("Path=/home/me/DeepSeek");
  });

  it("copies an icon only when bytes change", async () => {
    const dir = await tempDir("ds-icon-");
    const src = path.join(dir, "src.png");
    const dest = path.join(dir, "dest.png");
    await writeFile(src, "whale-v1");
    expect(await copyFileIfChanged(src, dest)).toBe(true);
    expect(await copyFileIfChanged(src, dest)).toBe(false);
    await writeFile(src, "whale-v2");
    expect(await copyFileIfChanged(src, dest)).toBe(true);
    expect(await readFile(dest, "utf8")).toBe("whale-v2");
  });
});

describe("installUserShortcuts linux", () => {
  it("creates Path= shortcuts once and does not rewrite them on the next launch", async () => {
    const home = await tempDir("ds-home-");
    await mkdir(path.join(home, "Desktop"), { recursive: true });
    const icon = path.join(home, "icon.png");
    await writeFile(icon, "official-whale");
    const opts = {
      platform: "linux" as const,
      homeDir: home,
      execPath: "/opt/DeepSeek/DeepSeek",
      iconFile: icon,
      workspaceDir: path.join(home, "DeepSeek"),
      env: { XDG_DESKTOP_DIR: path.join(home, "Desktop") },
    };
    const first = await installUserShortcuts(opts);
    const desk = path.join(home, "Desktop", "DeepSeek Harness.desktop");
    const appFile = path.join(home, ".local", "share", "applications", "deepseek-harness.desktop");
    expect(first).toContain(desk);
    const body = await readFile(desk, "utf8");
    expect(body).toContain("Exec=/opt/DeepSeek/DeepSeek %U");
    expect(body).toMatch(/^Path=.*\/DeepSeek$/m);
    expect(await readFile(appFile, "utf8")).toBe(body);
    const before = await stat(desk);
    await utimes(desk, before.atime, new Date(before.mtimeMs - 20_000));
    const aged = await stat(desk);
    const second = await installUserShortcuts(opts);
    expect(second).toContain("快捷方式已存在");
    const after = await stat(desk);
    expect(after.mtimeMs).toBe(aged.mtimeMs);
    expect(await readFile(desk, "utf8")).toBe(body);
  });

  it("rewrites when the executable path changes", async () => {
    const home = await tempDir("ds-move-");
    await mkdir(path.join(home, "Desktop"), { recursive: true });
    const icon = path.join(home, "icon.png");
    await writeFile(icon, "official-whale");
    const base = {
      platform: "linux" as const,
      homeDir: home,
      iconFile: icon,
      workspaceDir: path.join(home, "DeepSeek"),
      env: { XDG_DESKTOP_DIR: path.join(home, "Desktop") },
    };
    await installUserShortcuts({ ...base, execPath: "/old/DeepSeek" });
    const desk = path.join(home, "Desktop", "DeepSeek Harness.desktop");
    await installUserShortcuts({ ...base, execPath: "/new/DeepSeek" });
    expect(await readFile(desk, "utf8")).toContain("Exec=/new/DeepSeek %U");
  });
});
