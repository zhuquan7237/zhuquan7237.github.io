import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { unzipTo } from "./unzip-zip";
import {
  BUILTIN_MAID_ATELIER,
  DEFAULT_SKIN_ID,
  MANAGED_END,
  MANAGED_START,
  OFFICIAL_SKIN_ID,
  applySkin,
  builtinSkinDir,
  ensureBuiltinSkin,
  findSkinRoots,
  githubZipUrl,
  importSkinFromDir,
  isSafeSkinId,
  listSkinCards,
  loadCatalog,
  mergeSkinPatch,
  parseSkinManifest,
  renderManagedPatch,
  sanitizePreviewDataUrl,
  stripManagedPatch,
} from "./skins";
import { DEFAULT_SETTINGS } from "./util";

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeSkin(dir: string, id = "maid-atelier"): Promise<void> {
  await mkdir(path.join(dir, "lib"), { recursive: true });
  await mkdir(path.join(dir, "preview"), { recursive: true });
  await writeFile(
    path.join(dir, "skin.json"),
    JSON.stringify({
      id,
      name: "深海女仆工坊",
      author: "Small-tailqwq",
      tagline: "双女仆背景",
      package: "@dsh-external/dsh-client-ui-skin-maid-atelier",
      wiring: { id: "ui-skin-maid-atelier" },
      preview: { light: "preview/light.webp", dark: "preview/dark.webp" },
    }),
    "utf8",
  );
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "@dsh-external/dsh-client-ui-skin-maid-atelier", license: "CC-BY-NC-SA-4.0" }), "utf8");
  await writeFile(path.join(dir, "lib", "index.js"), "export function apply() {}", "utf8");
  await writeFile(path.join(dir, "lib", "client.js"), "export function apply() {}", "utf8");
  await writeFile(path.join(dir, "preview", "dark.webp"), "preview", "utf8");
}

function storeZipFiles(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.from(body);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    locals.push(local, data);
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, eocd]);
}

function storeZip(name: string, body: string): Buffer {
  return storeZipFiles({ [name]: body });
}

describe("skin manifests", () => {
  it("accepts the official maid-atelier skin.json shape", () => {
    const manifest = parseSkinManifest({
      id: "maid-atelier",
      name: "深海女仆工坊",
      author: "Small-tailqwq",
      package: "@dsh-external/dsh-client-ui-skin-maid-atelier",
      wiring: { id: "ui-skin-maid-atelier" },
      preview: { light: "preview/light.webp" },
    });
    expect(manifest.id).toBe(DEFAULT_SKIN_ID);
    expect(manifest.wiringId).toBe("ui-skin-maid-atelier");
    expect(isSafeSkinId(manifest.id)).toBe(true);
    expect(isSafeSkinId("../evil")).toBe(false);
  });

  it("finds a skin nested in a GitHub zip layout", async () => {
    const root = await tempDir("ds-skin-find-");
    await writeSkin(path.join(root, "dsh-deep-whale-main", "maid-atelier"));
    await expect(findSkinRoots(root)).resolves.toEqual([path.join(root, "dsh-deep-whale-main", "maid-atelier")]);
    await rm(root, { recursive: true, force: true });
  });
});

describe("managed patch", () => {
  it("enables one skin and disables the others", () => {
    const skins = [
      { ...BUILTIN_MAID_ATELIER, dir: "/tmp/a", builtin: true },
      { ...BUILTIN_MAID_ATELIER, id: "other", wiringId: "ui-skin-other", packageName: "@x/other", dir: "/tmp/b", builtin: false },
    ];
    const text = renderManagedPatch(skins, "maid-atelier");
    expect(text).toContain(MANAGED_START);
    expect(text).toContain("- id: ui-skin-other");
    expect(text).toContain("disabled: true");
    expect(text).toContain("name: '@dsh-external/dsh-client-ui-skin-maid-atelier'");
    expect(text).not.toContain("- id: ui-skin-maid-atelier\n  disabled: true");
  });

  it("does not insert a skin already registered in the profile bundle list", () => {
    const skins = [{ ...BUILTIN_MAID_ATELIER, dir: "/tmp/a", builtin: true }];
    const text = renderManagedPatch(skins, "maid-atelier", [BUILTIN_MAID_ATELIER.packageName]);
    expect(text).not.toContain("- insert:");
    expect(text).toContain(MANAGED_START);
  });

  it("restores the official look without an insert row", () => {
    const text = renderManagedPatch([{ ...BUILTIN_MAID_ATELIER, dir: "/tmp/a", builtin: true }], OFFICIAL_SKIN_ID);
    expect(text).toContain("disabled: true");
    expect(text).not.toContain("- insert:");
  });

  it("replaces only the managed section", () => {
    const previous = "keep: true\n\n" + renderManagedPatch([{ ...BUILTIN_MAID_ATELIER, dir: "/tmp/a", builtin: true }], "maid-atelier");
    const next = mergeSkinPatch(previous, [{ ...BUILTIN_MAID_ATELIER, dir: "/tmp/a", builtin: true }], OFFICIAL_SKIN_ID);
    expect(next).toContain("keep: true");
    expect(next).toContain(MANAGED_END);
    expect(stripManagedPatch(next)).toContain("keep: true");
    expect(stripManagedPatch(next)).not.toContain(MANAGED_START);
  });
});

describe("catalog and import", () => {
  it("imports a local skin folder and lists it with official", async () => {
    const userData = await tempDir("ds-skin-cat-");
    const source = path.join(userData, "incoming");
    await writeSkin(source, "maid-atelier");
    const imported = await importSkinFromDir(userData, source);
    expect(imported.id).toBe("maid-atelier");
    expect(imported.builtin).toBe(true);
    expect(imported.dir).toBe(builtinSkinDir(userData));
    const catalog = await loadCatalog(userData);
    expect(catalog.map((skin) => skin.id)).toContain("maid-atelier");
    const cards = await listSkinCards(catalog, "maid-atelier");
    expect(cards[0]?.id).toBe(OFFICIAL_SKIN_ID);
    expect(cards.some((card) => card.id === "maid-atelier" && card.active)).toBe(true);

    const extra = path.join(userData, "incoming-extra");
    await writeSkin(extra, "night-whale");
    const custom = await importSkinFromDir(userData, extra);
    expect(custom.builtin).toBe(false);
    expect(custom.id).toBe("night-whale");
    const after = await loadCatalog(userData);
    expect(after.map((skin) => skin.id).sort()).toEqual(["maid-atelier", "night-whale"]);
    await rm(userData, { recursive: true, force: true });
  });

  it("writes the home patch used by dsh web", async () => {
    const home = await tempDir("ds-skin-home-");
    const userData = await tempDir("ds-skin-ud-");
    const source = path.join(userData, "incoming");
    await writeSkin(source);
    const skin = await importSkinFromDir(userData, source);
    await applySkin(home, [skin], skin.id);
    const patch = await readFile(path.join(home, "cordis.patch.yml"), "utf8");
    expect(patch).toContain("ui-skin-maid-atelier");
    const linked = path.join(home, "profiles", "web", "node_modules", skin.packageName);
    await expect(readFile(path.join(linked, "skin.json"), "utf8")).resolves.toContain("maid-atelier");
    await rm(home, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  });

  it("installs the builtin skin from a downloaded zip", async () => {
    const userData = await tempDir("ds-skin-dl-");
    const prefix = "dsh-deep-whale-main/maid-atelier";
    const archive = storeZipFiles({
      [`${prefix}/skin.json`]: JSON.stringify({
        id: "maid-atelier",
        name: "深海女仆工坊",
        author: "Small-tailqwq",
        package: "@dsh-external/dsh-client-ui-skin-maid-atelier",
        wiring: { id: "ui-skin-maid-atelier" },
      }),
      [`${prefix}/package.json`]: JSON.stringify({
        name: "@dsh-external/dsh-client-ui-skin-maid-atelier",
        license: "CC-BY-NC-SA-4.0",
      }),
      [`${prefix}/lib/client.js`]: "export function apply() {}",
      [`${prefix}/lib/index.js`]: "export function apply() {}",
    });
    const skin = await ensureBuiltinSkin(userData, () => {}, async () => archive);
    expect(skin.id).toBe("maid-atelier");
    expect(skin.builtin).toBe(true);
    await expect(readFile(path.join(skin.dir, "lib", "client.js"), "utf8")).resolves.toContain("export");
    await rm(userData, { recursive: true, force: true });
  });
});

describe("defaults", () => {
  it("enables the maid-atelier skin by default", () => {
    expect(DEFAULT_SETTINGS.skinsEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.activeSkinId).toBe("maid-atelier");
    expect(sanitizePreviewDataUrl("data:image/webp;base64,abc")).toContain("data:image/");
    expect(sanitizePreviewDataUrl("javascript:alert(1)")).toBe("");
  });
});

describe("github zip urls", () => {
  it("accepts the official deep-whale repo", () => {
    expect(githubZipUrl("https://github.com/Small-tailqwq/dsh-deep-whale")).toBe(
      "https://github.com/Small-tailqwq/dsh-deep-whale/archive/refs/heads/main.zip",
    );
    expect(githubZipUrl("https://github.com/Small-tailqwq/dsh-deep-whale/tree/main")).toBe(
      "https://github.com/Small-tailqwq/dsh-deep-whale/archive/refs/heads/main.zip",
    );
  });
});

describe("unzip", () => {
  it("extracts a stored zip entry", async () => {
    const dest = await tempDir("ds-zip-");
    await unzipTo(storeZip("maid-atelier/skin.json", "{\"id\":\"maid-atelier\"}"), dest);
    await expect(readFile(path.join(dest, "maid-atelier", "skin.json"), "utf8")).resolves.toContain("maid-atelier");
    await rm(dest, { recursive: true, force: true });
  });
});
