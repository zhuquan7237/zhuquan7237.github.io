import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// Exercise the real messageRows() from the PWA, with only its helpers stubbed.
const source = readFileSync(join(__dirname, '../resources/plugins/mobile-bridge/app/app.js'), 'utf8');

function fn(name: string) {
  const start = source.indexOf(`  function ${name}(`);
  if (start < 0) throw new Error(`PWA function not found: ${name}`);
  let end = source.length;
  const next = source.slice(start + 5).search(/\n  (?:async )?function \w+\(/);
  if (next >= 0) end = start + 5 + next;
  return source.slice(start, end);
}

const HELPERS = ['extractText', 'contentParts', 'isFailedResult', 'decodeArgs', 'hint'].map(fn).join('\n');
const MESSAGE_ROWS = fn('messageRows');

function rows(history: any[]) {
  const context: any = { state: { history }, findArtifact: () => null };
  runInNewContext(`${HELPERS}\nthis.__h = { extractText, contentParts, isFailedResult, decodeArgs, hint };`, context);
  Object.assign(context, context.__h);
  const call = runInNewContext(`${MESSAGE_ROWS}\nmessageRows`, context) as () => any[];
  return call();
}

describe('mobile PWA chat rows', () => {
  it('renders the human turn and drops the engine injected context', () => {
    const out = rows([
      { event: { type: 'user/message', time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '统计文件数' }] } } },
      { event: { type: 'user/message', time: 2, data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context.…' }] } } },
      { event: { type: 'user/message', time: 3, data: { source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '<system-reminder>…' }] } } },
      { event: { type: 'user/message', time: 4, data: { source: { kind: 'time-context' }, content: [{ type: 'text', text: 'Time sampled…' }] } } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ who: 'user', text: '统计文件数' });
  });

  it('keeps a user turn that carries no source field (older history)', () => {
    const out = rows([
      { event: { type: 'user/message', time: 1, data: { content: [{ type: 'text', text: 'old turn' }] } } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('old turn');
  });

  it('still surfaces assistant answers, reasoning and tool calls', () => {
    const out = rows([
      { event: { type: 'step/start', time: 100, data: {} } },
      { event: { type: 'assistant/message', time: 3000, data: { message: { role: 'assistant', content: [
        { type: 'reasoning', text: 'thinking…' },
        { type: 'text', text: 'done' },
        { type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{}' },
      ] } } } },
    ]);
    expect(out.map((row: any) => row.who)).toEqual(['think', 'assistant', 'tool']);
    expect(out[0].label).toBe('思考 3 秒');
  });
});
