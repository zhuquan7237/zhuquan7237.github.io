import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { applySkin, ensureHomePatchesAreArrays, OFFICIAL_SKIN_ID } from './skins';
import { renderPluginRows } from './plugins';
import { DEFAULT_SETTINGS } from './util';

/** Execute the shell's real boot path against an empty isolated dsh home. */
describe('bundled plugins without an installed skin', () => {
  it('writes engine plugin patches even when skins are disabled and catalog is empty', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-no-skin-'));
    try {
      const home = path.join(root, 'dsh-home');
      const source = await readFile(path.join(__dirname, 'main.ts'), 'utf8');
      const start = source.indexOf('async function syncSkins(');
      const end = source.indexOf('\n/**', start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const js = ts.transpileModule(source.slice(start, end), {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
      const settings = {...DEFAULT_SETTINGS, skinsEnabled:false};
      const context = {
        settings, path, __dirname:root, process:{resourcesPath:root},
        dshHomeDir:() => home, userData:() => root, shellLog:() => {},
        ensureHomePatchesAreArrays, ensureBundledPlugins:async () => {},
        migrateLegacySearchSettings:async () => {}, renderPluginRows,
        loadCatalog:async () => [], applySkin, OFFICIAL_SKIN_ID,
      };
      const sync = runInNewContext(`${js}\nsyncSkins`, context) as () => Promise<unknown[]>;
      expect(await sync()).toEqual([]);
      const patch = await readFile(path.join(home, 'cordis.patch.yml'), 'utf8');
      expect(patch).toContain('dsh-mobile-bridge');
      expect(patch).toContain('dsh-model-vision');
      expect(patch).toContain('dsh-desktop-panel');
    } finally {
      await rm(root, {recursive:true, force:true});
    }
  });
});
