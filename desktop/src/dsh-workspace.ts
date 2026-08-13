import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { retargetHomeWorkspace, seedWorkspaceRegistry } from "./util";

/**
 * Give first-time users a ready workspace instead of an empty picker. Also
 * rewrite a leftover $HOME workspace (title = username, e.g. "box") that 0.1.3
 * created when a .desktop launch used the home folder as cwd.
 */
export async function ensureDefaultWorkspace(
  dshHome: string,
  workspaceDir: string,
  homeDir: string,
): Promise<boolean> {
  const file = path.join(dshHome, "storages", "workspace.json");
  let existing: unknown = null;
  try {
    existing = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }

  const canonical = await realpath(workspaceDir).catch(() => workspaceDir);
  const entry = {
    id: randomUUID(),
    path: canonical,
    title: path.basename(canonical) || "DeepSeek",
    now: new Date().toISOString(),
  };
  const next = seedWorkspaceRegistry(existing, entry) ?? retargetHomeWorkspace(existing, homeDir, entry);
  if (!next) return false;

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return true;
}
