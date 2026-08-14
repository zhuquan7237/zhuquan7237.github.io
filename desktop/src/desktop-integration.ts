import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSystemInstalledApp, linuxDesktopEntry, resolveLinuxDesktopDir } from "./util";

const SHORTCUT_NAME = "DeepSeek Harness";
const DESKTOP_ID = "deepseek-harness";

export interface InstallShortcutsOptions {
  force?: boolean;
  version?: string;
  workspaceDir?: string;
  userDataDir?: string;
  homeDir?: string;
  execPath?: string;
  iconFile?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export function appIconFile(): string {
  const asarPath = path.join(__dirname, "..", "resources", "icon.png");
  const unpacked = asarPath.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  if (unpacked !== asarPath && existsSync(unpacked)) return unpacked;
  return asarPath;
}

export function launchPath(execPath = process.execPath, env: NodeJS.ProcessEnv = process.env): string {
  return env.APPIMAGE || execPath;
}

/** NSIS / deb / dmg already install shortcuts; portable tar.gz and AppImage do not. */
export function needsUserShortcuts(isPackaged: boolean, execPath = process.execPath): boolean {
  if (!isPackaged) return false;
  if (isSystemInstalledApp(execPath)) return false;
  if (existsSync(path.join(path.dirname(execPath), "Uninstall DeepSeek.exe"))) return false;
  return true;
}

export function shouldRewriteTextFile(existing: string | null, next: string, force = false): boolean {
  return force || existing !== next;
}

export function windowsShortcutIdentity(target: string, workingDirectory: string, version: string): string {
  return `${target}\n${workingDirectory}\n${version}\n`;
}

export function shouldRewriteWindowsShortcut(
  existingStamp: string | null,
  nextStamp: string,
  fileExists: boolean,
  force = false,
): boolean {
  if (force || !fileExists) return true;
  return existingStamp !== nextStamp;
}

export async function readTextIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** Write + chmod only when the body actually changed, so GNOME keeps metadata::trusted. */
export async function syncShortcutFile(
  file: string,
  body: string,
  mode = 0o755,
  force = false,
): Promise<"created" | "updated" | "unchanged"> {
  const prev = await readTextIfPresent(file);
  if (!shouldRewriteTextFile(prev, body, force)) return "unchanged";
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body, "utf8");
  await chmod(file, mode);
  return prev == null ? "created" : "updated";
}

export async function copyFileIfChanged(src: string, dest: string): Promise<boolean> {
  if (!existsSync(src)) return false;
  try {
    const [next, prev] = await Promise.all([readFile(src), readFile(dest)]);
    if (Buffer.compare(next, prev) === 0) return false;
  } catch {
    // dest missing or unreadable
  }
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(src, dest);
  return true;
}

export async function installUserShortcuts(options: InstallShortcutsOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  if (platform === "linux") return await installLinuxShortcuts(options);
  if (platform === "win32") return await installWindowsShortcuts(options);
  return "macOS 请把 App 拖到「应用程序」文件夹，再从启动台或程序坞打开。";
}

async function installLinuxShortcuts(options: InstallShortcutsOptions): Promise<string> {
  const home = options.homeDir ?? os.homedir();
  const env = options.env ?? process.env;
  const iconSrc = options.iconFile ?? appIconFile();
  const workspaceDir = options.workspaceDir ?? path.join(home, "DeepSeek");
  await mkdir(workspaceDir, { recursive: true });
  const iconDest = path.join(home, ".local", "share", "icons", "hicolor", "256x256", "apps", `${DESKTOP_ID}.png`);
  const appDir = path.join(home, ".local", "share", "applications");
  const desktopDir = await resolveDesktopDir(home, env);
  const iconChanged = await copyFileIfChanged(iconSrc, iconDest);
  const body = linuxDesktopEntry({
    exec: launchPath(options.execPath ?? process.execPath, env),
    icon: existsSync(iconDest) ? iconDest : iconSrc,
    workingDirectory: workspaceDir,
  });
  const appFile = path.join(appDir, `${DESKTOP_ID}.desktop`);
  const appState = await syncShortcutFile(appFile, body, 0o755, options.force);
  let deskFile = "";
  let deskState: "created" | "updated" | "unchanged" = "unchanged";
  if (desktopDir) {
    deskFile = path.join(desktopDir, `${SHORTCUT_NAME}.desktop`);
    deskState = await syncShortcutFile(deskFile, body, 0o755, options.force);
    await markDesktopTrusted(deskFile);
  }
  await markDesktopTrusted(appFile);
  const changed = iconChanged || appState !== "unchanged" || deskState !== "unchanged";
  if (changed) {
    bestEffort("update-desktop-database", [appDir]);
    bestEffort("gtk-update-icon-cache", ["-f", path.join(home, ".local", "share", "icons", "hicolor")]);
  }
  if (appState === "unchanged" && deskState === "unchanged") {
    return deskFile ? `快捷方式已存在：${deskFile}` : `快捷方式已存在：${appFile}`;
  }
  return deskFile
    ? `已创建应用菜单和桌面快捷方式：${deskFile}`
    : `已创建应用菜单快捷方式：${appFile}`;
}

async function resolveDesktopDir(home: string, env: NodeJS.ProcessEnv): Promise<string> {
  let userDirs: string | null = null;
  try {
    userDirs = await readFile(path.join(home, ".config", "user-dirs.dirs"), "utf8");
  } catch {
    userDirs = null;
  }
  return resolveLinuxDesktopDir(home, env, existsSync, userDirs);
}

async function markDesktopTrusted(filePath: string): Promise<void> {
  if (!existsSync(filePath)) return;
  await new Promise<void>((resolve) => {
    let child;
    try {
      child = spawn("gio", ["set", filePath, "metadata::trusted", "true"], { stdio: "ignore" });
    } catch {
      resolve();
      return;
    }
    const done = () => resolve();
    child.on("error", done);
    child.on("close", done);
    setTimeout(done, 1500);
  });
}

/**
 * Desktop environments ship different helper commands, so a missing one is
 * normal. spawn reports ENOENT through an async "error" event: without this
 * listener Electron turns it into a fatal error dialog on every launch.
 */
function bestEffort(command: string, args: string[]): void {
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Shortcuts still work without the helper; they are already chmod +x.
  }
}

function shortcutStampPath(userDataDir: string): string {
  return path.join(userDataDir, "shortcut-stamp");
}

async function installWindowsShortcuts(options: InstallShortcutsOptions): Promise<string> {
  const home = options.homeDir ?? os.homedir();
  const env = options.env ?? process.env;
  const target = launchPath(options.execPath ?? process.execPath, env);
  const workdir = path.dirname(options.execPath ?? process.execPath);
  const version = options.version ?? "";
  const userDataDir = options.userDataDir ?? path.join(home, "AppData", "Roaming", "DeepSeek");
  const stamp = windowsShortcutIdentity(target, workdir, version);
  const previous = await readTextIfPresent(shortcutStampPath(userDataDir));
  const desktop = path.join(home, "Desktop");
  const startMenu = path.join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs");
  await mkdir(startMenu, { recursive: true });
  const desktopLnk = path.join(desktop, `${SHORTCUT_NAME}.lnk`);
  const startLnk = path.join(startMenu, `${SHORTCUT_NAME}.lnk`);
  let wrote = 0;
  for (const lnk of [desktopLnk, startLnk]) {
    if (!shouldRewriteWindowsShortcut(previous, stamp, existsSync(lnk), options.force)) continue;
    await writeWindowsShortcut(lnk, target, workdir);
    wrote += 1;
  }
  if (wrote > 0) {
    await mkdir(userDataDir, { recursive: true });
    await writeFile(shortcutStampPath(userDataDir), stamp, "utf8");
  }
  return wrote > 0
    ? `已创建桌面和开始菜单快捷方式：${desktopLnk}`
    : `快捷方式已存在：${desktopLnk}`;
}

export function windowsShortcutScript(lnkPath: string, target: string, workdir: string): string {
  const lnk = lnkPath.replace(/'/g, "''");
  const exe = target.replace(/'/g, "''");
  const cwd = workdir.replace(/'/g, "''");
  return [
    `$ws = New-Object -ComObject WScript.Shell`,
    `$s = $ws.CreateShortcut('${lnk}')`,
    `$s.TargetPath = '${exe}'`,
    `$s.WorkingDirectory = '${cwd}'`,
    `$s.IconLocation = '${exe},0'`,
    `$s.Description = 'DeepSeek Harness'`,
    `$s.Save()`,
  ].join("; ");
}

async function writeWindowsShortcut(lnkPath: string, target: string, workdir: string): Promise<void> {
  const script = windowsShortcutScript(lnkPath, target, workdir);
  await new Promise<void>((resolve, reject) => {
    let child;
    try {
      child = spawn("powershell.exe", ["-NoProfile", "-Command", script], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`创建快捷方式失败 (${code})`));
    });
  });
}
