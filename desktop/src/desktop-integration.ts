import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSystemInstalledApp, linuxDesktopEntry, resolveLinuxDesktopDir } from "./util";

const SHORTCUT_NAME = "DeepSeek Harness";
const DESKTOP_ID = "deepseek-harness";

export function appIconFile(): string {
  const asarPath = path.join(__dirname, "..", "resources", "icon.png");
  const unpacked = asarPath.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  if (unpacked !== asarPath && existsSync(unpacked)) return unpacked;
  return asarPath;
}

function launchPath(): string {
  return process.env.APPIMAGE || process.execPath;
}

/** NSIS / deb / dmg already install shortcuts; portable tar.gz and AppImage do not. */
export function needsUserShortcuts(isPackaged: boolean, execPath = process.execPath): boolean {
  if (!isPackaged) return false;
  if (isSystemInstalledApp(execPath)) return false;
  if (existsSync(path.join(path.dirname(execPath), "Uninstall DeepSeek.exe"))) return false;
  return true;
}

export async function installUserShortcuts(): Promise<string> {
  if (process.platform === "linux") return await installLinuxShortcuts();
  if (process.platform === "win32") return await installWindowsShortcuts();
  return "macOS 请把 App 拖到「应用程序」文件夹，再从启动台或程序坞打开。";
}

async function installLinuxShortcuts(): Promise<string> {
  const home = os.homedir();
  const iconSrc = appIconFile();
  const iconDest = path.join(home, ".local", "share", "icons", "hicolor", "256x256", "apps", `${DESKTOP_ID}.png`);
  const appDir = path.join(home, ".local", "share", "applications");
  const desktopDir = await resolveDesktopDir(home);
  await mkdir(path.dirname(iconDest), { recursive: true });
  await mkdir(appDir, { recursive: true });
  if (existsSync(iconSrc)) await copyFile(iconSrc, iconDest);
  const body = linuxDesktopEntry({
    exec: launchPath(),
    icon: existsSync(iconDest) ? iconDest : iconSrc,
  });
  const appFile = path.join(appDir, `${DESKTOP_ID}.desktop`);
  await writeFile(appFile, body, "utf8");
  await chmod(appFile, 0o755);
  let deskFile = "";
  if (desktopDir) {
    await mkdir(desktopDir, { recursive: true });
    deskFile = path.join(desktopDir, `${SHORTCUT_NAME}.desktop`);
    await writeFile(deskFile, body, "utf8");
    await chmod(deskFile, 0o755);
    markDesktopTrusted(deskFile);
  }
  markDesktopTrusted(appFile);
  bestEffort("update-desktop-database", [appDir]);
  bestEffort("gtk-update-icon-cache", ["-f", path.join(home, ".local", "share", "icons", "hicolor")]);
  return deskFile
    ? `已创建应用菜单和桌面快捷方式：${deskFile}`
    : `已创建应用菜单快捷方式：${appFile}`;
}

async function resolveDesktopDir(home: string): Promise<string> {
  let userDirs: string | null = null;
  try {
    userDirs = await readFile(path.join(home, ".config", "user-dirs.dirs"), "utf8");
  } catch {
    userDirs = null;
  }
  return resolveLinuxDesktopDir(home, process.env, existsSync, userDirs);
}

function markDesktopTrusted(filePath: string): void {
  bestEffort("gio", ["set", filePath, "metadata::trusted", "true"]);
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

async function installWindowsShortcuts(): Promise<string> {
  const desktop = path.join(os.homedir(), "Desktop");
  const startMenu = path.join(os.homedir(), "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs");
  await mkdir(startMenu, { recursive: true });
  const desktopLnk = path.join(desktop, `${SHORTCUT_NAME}.lnk`);
  const startLnk = path.join(startMenu, `${SHORTCUT_NAME}.lnk`);
  await writeWindowsShortcut(desktopLnk);
  await writeWindowsShortcut(startLnk);
  return `已创建桌面和开始菜单快捷方式：${desktopLnk}`;
}

async function writeWindowsShortcut(lnkPath: string): Promise<void> {
  const target = launchPath().replace(/'/g, "''");
  const workdir = path.dirname(process.execPath).replace(/'/g, "''");
  const lnk = lnkPath.replace(/'/g, "''");
  const script = [
    `$ws = New-Object -ComObject WScript.Shell`,
    `$s = $ws.CreateShortcut('${lnk}')`,
    `$s.TargetPath = '${target}'`,
    `$s.WorkingDirectory = '${workdir}'`,
    `$s.IconLocation = '${target},0'`,
    `$s.Description = 'DeepSeek Harness'`,
    `$s.Save()`,
  ].join("; ");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", script], {
      windowsHide: true,
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`创建快捷方式失败 (${code})`));
    });
  });
}
