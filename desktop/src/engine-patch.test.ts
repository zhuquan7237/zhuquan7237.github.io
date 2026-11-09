import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PI_AI_BLOCK_MARKER, patchPiAiBlockContent } from './harness';

/**
 * The installed engine's OpenAI-compatible adapter assumed `delta.content` is a
 * string. Mistral streams typed blocks, which stringified to "[object Object]"
 * when reasoning was on. The shell patches the adapter on every launch because
 * an engine upgrade replaces node_modules — these tests pin the patch contract:
 * apply once, stay idempotent, and never touch a file whose shape changed.
 */
const ORIGINAL = `                    if (choice.delta.content !== null &&
                        choice.delta.content !== undefined &&
                        choice.delta.content.length > 0) {
                        const block = ensureTextBlock();
                        block.text += choice.delta.content;
                        stream.push({
                            type: "text_delta",
                            contentIndex: getContentIndex(block),
                            delta: choice.delta.content,
                            partial: output,
                        });
                    }`;

async function makePrefix(body: string | null): Promise<string> {
  const prefix = await mkdtemp(path.join(os.tmpdir(), 'dsh-patch-'));
  const dir = path.join(prefix, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'api');
  await mkdir(dir, { recursive: true });
  if (body !== null) await writeFile(path.join(dir, 'openai-completions.js'), body, 'utf8');
  return prefix;
}

describe('patchPiAiBlockContent', () => {
  it('rewrites string-only content handling into block-aware handling', async () => {
    const prefix = await makePrefix(`const x = 1;\n${ORIGINAL}\nconst y = 2;\n`);
    await expect(patchPiAiBlockContent(prefix)).resolves.toBe('applied');
    const patched = await readFile(
      path.join(prefix, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'api', 'openai-completions.js'),
      'utf8',
    );
    expect(patched).toContain(PI_AI_BLOCK_MARKER);
    expect(patched).toContain('Array.isArray(rawContent)');
    expect(patched).toContain('ensureThinkingBlock("thinking")');
    expect(patched).toContain('const x = 1;');
    expect(patched).toContain('const y = 2;');
  });

  it('is idempotent', async () => {
    const prefix = await makePrefix(ORIGINAL);
    await patchPiAiBlockContent(prefix);
    await expect(patchPiAiBlockContent(prefix)).resolves.toBe('already');
  });

  it('reports a missing adapter instead of throwing', async () => {
    const prefix = await makePrefix(null);
    await expect(patchPiAiBlockContent(prefix)).resolves.toBe('missing');
  });

  it('leaves an unknown adapter shape untouched', async () => {
    const prefix = await makePrefix('export const stream = () => {};\n');
    await expect(patchPiAiBlockContent(prefix)).resolves.toBe('unexpected');
    const after = await readFile(
      path.join(prefix, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'api', 'openai-completions.js'),
      'utf8',
    );
    expect(after).toBe('export const stream = () => {};\n');
  });
});
