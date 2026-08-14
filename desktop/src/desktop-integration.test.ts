import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import {
  copyFileIfChanged,
  desktopEntryExecPath,
  installUserShortcuts,
  launchPath,
  launchWorkingDirectory,
  looksTransientLaunchPath,
  parsePersistedLaunchPath,
  resolveStableLaunchPath,
  shouldRewriteTextFile,
  shouldRewriteWindowsShortcut,
  syncShortcutFile,
  windowsShortcutIdentity,
  windowsShortcutScript,
  windowsStampTargetMissing,
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

  it("only rewrites Windows .lnk when missing, forced, the stamp changed, or the target vanished", () => {
    const stamp = windowsShortcutIdentity("C:\\DeepSeek\\DeepSeek.exe", "C:\\DeepSeek", "0.1.8");
    expect(shouldRewriteWindowsShortcut(stamp, stamp, true)).toBe(false);
    expect(shouldRewriteWindowsShortcut(stamp, stamp, false)).toBe(true);
    expect(shouldRewriteWindowsShortcut(null, stamp, true)).toBe(true);
    expect(shouldRewriteWindowsShortcut(stamp, stamp, true, true)).toBe(true);
    expect(shouldRewriteWindowsShortcut(stamp, stamp, true, false, true)).toBe(true);
    expect(
      shouldRewriteWindowsShortcut(
        stamp,
        windowsShortcutIdentity("D:\\DeepSeek\\DeepSeek.exe", "D:\\DeepSeek", "0.1.8"),
        true,
      ),
    ).toBe(true);
    expect(windowsStampTargetMissing(stamp, () => false)).toBe(true);
    expect(windowsStampTargetMissing(stamp, () => true)).toBe(false);
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

describe("stable launch path", () => {
  it("prefers APPIMAGE and PORTABLE_EXECUTABLE_FILE over the unpacked execPath", () => {
    expect(
      launchPath("/tmp/.mount_DeepSeXXXX/DeepSeek", {
        APPIMAGE: "/home/me/DeepSeek.AppImage",
      }),
    ).toBe("/home/me/DeepSeek.AppImage");
    expect(
      launchPath("C:\\Users\\me\\AppData\\Local\\Temp\\nsiABC\\DeepSeek.exe", {
        PORTABLE_EXECUTABLE_FILE: "D:\\Apps\\DeepSeek-portable.exe",
      }),
    ).toBe("D:\\Apps\\DeepSeek-portable.exe");
    expect(
      launchPath("/tmp/.mount_DeepSeXXXX/DeepSeek", {
        ARGV0: "/home/me/DeepSeek.AppImage",
      }),
    ).toBe("/home/me/DeepSeek.AppImage");
    expect(launchPath("/opt/DeepSeek/DeepSeek", {})).toBe("/opt/DeepSeek/DeepSeek");
  });

  it("uses the portable directory as the Windows working directory", () => {
    expect(
      launchWorkingDirectory("C:\\Users\\me\\AppData\\Local\\Temp\\nsiABC\\DeepSeek.exe", {
        PORTABLE_EXECUTABLE_FILE: "D:\\Apps\\DeepSeek-portable.exe",
        PORTABLE_EXECUTABLE_DIR: "D:\\Apps",
      }),
    ).toBe("D:\\Apps");
    expect(
      launchWorkingDirectory("C:\\Users\\me\\AppData\\Local\\Temp\\nsiABC\\DeepSeek.exe", {
        PORTABLE_EXECUTABLE_FILE: "D:\\Apps\\DeepSeek-portable.exe",
      }),
    ).toBe("D:\\Apps");
  });

  it("detects fuse mounts and Windows portable unpack folders as transient", () => {
    expect(looksTransientLaunchPath("/tmp/.mount_DeepSeAbCd/DeepSeek")).toBe(true);
    expect(looksTransientLaunchPath("C:\\Users\\me\\AppData\\Local\\Temp\\nsiABC\\DeepSeek.exe")).toBe(true);
    expect(looksTransientLaunchPath("C:\\Users\\me\\AppData\\Local\\Programs\\DeepSeek\\DeepSeek.exe")).toBe(false);
    expect(looksTransientLaunchPath("/opt/DeepSeek/DeepSeek")).toBe(false);
    expect(parsePersistedLaunchPath('{"path":"/home/me/DeepSeek.AppImage"}\n')).toBe("/home/me/DeepSeek.AppImage");
    expect(parsePersistedLaunchPath("not-json")).toBeNull();
    expect(desktopEntryExecPath('Exec="/opt/My Apps/DeepSeek" %U\n')).toBe("/opt/My Apps/DeepSeek");
    expect(desktopEntryExecPath("Exec=/tmp/.mount_old/DeepSeek %U\n")).toBe("/tmp/.mount_old/DeepSeek");
  });

  it("writes the AppImage path on the first launch, not the fuse mount", async () => {
    const home = await tempDir("ds-appimage-");
    const userData = path.join(home, ".config", "DeepSeek");
    await mkdir(path.join(home, "Desktop"), { recursive: true });
    const icon = path.join(home, "icon.png");
    const appImage = path.join(home, "DeepSeek.AppImage");
    await writeFile(icon, "official-whale");
    await writeFile(appImage, "stable-appimage");
    await installUserShortcuts({
      platform: "linux",
      homeDir: home,
      userDataDir: userData,
      execPath: "/tmp/.mount_DeepSeXXXX/DeepSeek",
      iconFile: icon,
      workspaceDir: path.join(home, "DeepSeek"),
      env: { XDG_DESKTOP_DIR: path.join(home, "Desktop"), APPIMAGE: appImage },
    });
    const desk = path.join(home, "Desktop", "DeepSeek Harness.desktop");
    const body = await readFile(desk, "utf8");
    expect(body).toContain(`Exec=${appImage} %U`);
    expect(body).not.toContain(".mount_");
    expect(await readFile(path.join(userData, "desktop-launch-path.json"), "utf8")).toContain(appImage);
  });

  it("repairs a shortcut whose Exec vanished after the first quit", async () => {
    const home = await tempDir("ds-dead-");
    const userData = path.join(home, ".config", "DeepSeek");
    await mkdir(path.join(home, "Desktop"), { recursive: true });
    const icon = path.join(home, "icon.png");
    const appImage = path.join(home, "DeepSeek.AppImage");
    const mount = path.join(home, "tmp", ".mount_DeepSeXXXX", "DeepSeek");
    await writeFile(icon, "official-whale");
    await writeFile(appImage, "stable-appimage");
    const base = {
      platform: "linux" as const,
      homeDir: home,
      userDataDir: userData,
      iconFile: icon,
      workspaceDir: path.join(home, "DeepSeek"),
    };
    await installUserShortcuts({
      ...base,
      execPath: mount,
      env: { XDG_DESKTOP_DIR: path.join(home, "Desktop") },
    });
    const desk = path.join(home, "Desktop", "DeepSeek Harness.desktop");
    expect(await readFile(desk, "utf8")).toContain(`Exec=${mount} %U`);
    await installUserShortcuts({
      ...base,
      execPath: mount,
      env: { XDG_DESKTOP_DIR: path.join(home, "Desktop"), APPIMAGE: appImage },
    });
    expect(await readFile(desk, "utf8")).toContain(`Exec=${appImage} %U`);
    const second = await installUserShortcuts({
      ...base,
      execPath: mount,
      env: { XDG_DESKTOP_DIR: path.join(home, "Desktop") },
    });
    expect(second).toContain("快捷方式已存在");
    expect(await readFile(desk, "utf8")).toContain(`Exec=${appImage} %U`);
  });

  it("reuses a persisted portable path when the current execPath is a temp unpack", async () => {
    const home = await tempDir("ds-persist-");
    const userData = path.join(home, ".config", "DeepSeek");
    const portable = path.join(home, "DeepSeek-portable.exe");
    await mkdir(userData, { recursive: true });
    await writeFile(portable, "stable-portable");
    await writeFile(path.join(userData, "desktop-launch-path.json"), `${JSON.stringify({ path: portable })}\n`);
    const resolved = await resolveStableLaunchPath({
      execPath: path.join(home, "AppData", "Local", "Temp", "nsiABC", "DeepSeek.exe"),
      userDataDir: userData,
      env: {},
    });
    expect(resolved).toBe(portable);
  });
});
