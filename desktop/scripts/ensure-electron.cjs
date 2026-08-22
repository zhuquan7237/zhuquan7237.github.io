// Verify the Electron binary install and repair it from the local cache.
//
// electron's own postinstall (node_modules/electron/install.js) unpacks the
// runtime zip with extract-zip@2.0.1, which stalls silently on Node 24+: the
// extraction promise never settles, the process exits 0 after writing a
// single file, and npm reports success while dist/ stays incomplete. The
// next `electron .` then dies with "Electron failed to install correctly".
// This script detects that state and re-extracts the already-downloaded zip
// from the @electron/get cache using system tools that do not share the bug.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const electronDir = path.join(__dirname, "..", "node_modules", "electron");
if (!fs.existsSync(path.join(electronDir, "package.json"))) {
  // electron is a devDependency; --omit=dev installs legitimately skip it.
  process.exit(0);
}

const { version } = require(path.join(electronDir, "package.json"));
const platformPath = process.platform === "win32" ? "electron.exe" : "electron";
const distDir = path.join(electronDir, "dist");
const pathTxt = path.join(electronDir, "path.txt");

function isInstalled() {
  try {
    if (fs.readFileSync(pathTxt, "utf8") !== platformPath) return false;
    if (!fs.existsSync(path.join(distDir, platformPath))) return false;
    return fs.readFileSync(path.join(distDir, "version"), "utf8").replace(/^v/, "") === version;
  } catch {
    return false;
  }
}

function findCachedZip() {
  const wanted = `electron-v${version}-${process.platform}-${process.arch}.zip`;
  const roots = [
    process.env.ELECTRON_CACHE,
    path.join(os.homedir(), "AppData", "Local", "electron", "Cache"),
    path.join(os.homedir(), ".cache", "electron"),
  ].filter(Boolean);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root)) {
      const candidate = path.join(root, entry, wanted);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function extract(zipPath) {
  // bsdtar (Windows 10+, macOS) reads zip; unzip covers most Linux distros;
  // python's zipfile module is the last resort.
  const attempts = [
    { command: "tar", args: ["-xf", zipPath, "-C", distDir] },
    { command: "unzip", args: ["-q", zipPath, "-d", distDir] },
  ];
  for (const command of process.platform === "win32" ? ["python", "py"] : ["python3", "python"]) {
    attempts.push({ command, args: ["-m", "zipfile", "-e", zipPath, distDir] });
  }
  for (const attempt of attempts) {
    const result = spawnSync(attempt.command, attempt.args, { stdio: "inherit" });
    if (!result.error && result.status === 0) return true;
  }
  return false;
}

if (isInstalled()) process.exit(0);

const zipPath = findCachedZip();
if (!zipPath) {
  console.warn(
    `[ensure-electron] Electron ${version} binary is missing and no cached zip was found. ` +
      "Re-run `node node_modules/electron/install.js` (with Node <= 22 if it keeps failing).",
  );
  process.exit(0);
}

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });
if (!extract(zipPath)) {
  console.warn(`[ensure-electron] could not extract ${zipPath}.`);
  process.exit(0);
}
fs.writeFileSync(pathTxt, platformPath);
if (!isInstalled()) {
  console.warn(`[ensure-electron] Electron ${version} still incomplete after extracting ${zipPath}.`);
  process.exit(0);
}
console.log(`[ensure-electron] restored Electron ${version} from the local cache.`);
