import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('mobile PWA theme readability', () => {
  it('keeps a white base for light and a dark base for dark', () => {
    const css = readFileSync(join(__dirname, '../resources/plugins/mobile-bridge/app/theme.css'), 'utf8');
    const light = css.slice(css.indexOf(':root, [data-theme="light"]'), css.indexOf('[data-theme="dark"]'));
    const dark = css.slice(css.indexOf('[data-theme="dark"]'), css.indexOf('@media (prefers-color-scheme: dark)'));
    expect(light).toContain('--dsw-alias-bg-base: var(--dsw-static-neutral-bluish-00)');
    expect(light).toContain('--dsw-alias-label-primary: var(--dsw-static-neutral-bluish-1000)');
    expect(dark).toContain('--dsw-alias-bg-base: var(--dsw-static-neutral-bluish-950)');
    expect(dark).toContain('--dsw-alias-label-primary: var(--dsw-static-neutral-bluish-50)');
  });
});
