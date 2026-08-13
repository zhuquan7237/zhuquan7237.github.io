import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { seedWorkspaceRegistry } from "./util";

/**
 * Give first-time users a ready workspace instead of an empty picker. Only
 * touches a registry that is still empty, so a returning user's list is never
 * rewritten.
 */
export async function ensureDefaultWorkspace(dshHome: string, workspaceDir: string): Promise<boolean> {
  const file = path.join(dshHome, "storages", "workspace.json");
  let existing: unknown = null;
  try {
    existing = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }

  const canonical = await realpath(workspaceDir).catch(() => workspaceDir);
  const next = seedWorkspaceRegistry(existing, {
    id: randomUUID(),
    path: canonical,
    title: path.basename(canonical) || "DeepSeek",
    now: new Date().toISOString(),
  });
  if (!next) return false;

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return true;
}
