import { describe, expect, it } from 'vitest';

/**
 * The phone's model document must include the engine's own providers.
 *
 * `llm-pi-ai` is the only namespace the bridge writes. The official DeepSeek
 * account route (`deepseek-account`, registered by `dsh-llm-deepseek-account`
 * after login) and the official API-key route (`deepseek-official`) live in
 * the engine's live LLM registry, never in that namespace — so before this
 * fix the phone showed only hand-written providers and could not switch to a
 * logged-in DeepSeek model at all.
 *
 * These assertions are the fence around the two halves of that fix:
 *   1. read: engine providers appear as read-only rows in `/mobile/models`;
 *   2. write: a save can never turn them into `llm-pi-ai` provider writes.
 */

import {
  buildDoc,
  engineOps,
  mergeEngineModels,
  writableItems,
  type EngineModelGroup,
  type MobileModelDoc,
} from '../resources/plugins/mobile-bridge/src/models.js';

const official: EngineModelGroup[] = [
  {
    id: 'deepseek-account',
    name: 'DeepSeek',
    models: [
      {
        id: 'deepseek-flash',
        name: 'DeepSeek-V4.1-Flash',
        contextWindow: 1048576,
        maxTokens: 256000,
        input: ['text', 'image'],
        reasoningEfforts: { low: 'low', high: 'high', max: 'max' },
        defaultEffort: 'high',
      },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1048576, input: ['text'] },
    ],
  },
];

function managedDoc(): MobileModelDoc {
  return buildDoc(
    {
      revision: 7,
      value: {
        providers: {
          codego: {
            displayName: 'codego',
            api: 'openai-responses',
            baseURL: 'https://shu26.cfd/v1',
            apiKeyEnv: 'CODEGO_API_KEY',
            models: [{ id: 'gpt-5.6-sol', contextWindow: 1050000, input: ['text', 'image'] }],
          },
        },
      },
    },
    { revision: 3 },
    { CODEGO_API_KEY: true },
    1_700_000_000_000,
  );
}

describe('engine providers in the phone model document', () => {
  it('appends the official DeepSeek provider as read-only rows with real params', () => {
    const merged = mergeEngineModels(managedDoc(), official);
    expect(merged.providers.map((provider) => provider.id)).toEqual(['codego', 'deepseek-account']);
    expect(merged.providers[1]).toMatchObject({ name: 'DeepSeek', readonly: true, apiKeyConfigured: true });

    const flash = merged.items.find((item) => item.id === 'deepseek-account::deepseek-flash');
    expect(flash).toBeDefined();
    expect(flash).toMatchObject({
      provider: 'deepseek-account',
      providerName: 'DeepSeek',
      modelId: 'deepseek-flash',
      name: 'DeepSeek-V4.1-Flash',
      readonly: true,
      enabled: true,
      apiKeyConfigured: true,
    });
    expect(flash?.params).toMatchObject({
      contextWindow: 1048576,
      maxTokens: 256000,
      input: ['text', 'image'],
      // The phone renders the keys of `reasoningEfforts` as the effort menu.
      reasoningEfforts: { low: 'low', high: 'high', max: 'max' },
      defaultReasoningEffort: 'high',
    });
    // The bridge-owned rows are untouched.
    expect(merged.items.filter((item) => item.provider === 'codego')).toHaveLength(1);
    expect(merged.revision).toBe(7);
  });

  it('never duplicates a provider the bridge already configures', () => {
    const merged = mergeEngineModels(managedDoc(), [
      { id: 'codego', name: 'codego', models: [{ id: 'shadow-model' }] },
      ...official,
    ]);
    expect(merged.providers.filter((provider) => provider.id === 'codego')).toHaveLength(1);
    expect(merged.items.some((item) => item.id === 'codego::shadow-model')).toBe(false);
  });

  it('drops read-only rows before a save, even when the client forgot the flag', () => {
    const merged = mergeEngineModels(managedDoc(), official);
    const readonlyProviders = new Set(official.map((group) => group.id));
    // `Wire.modelItemsJson` on the phone sends id/provider/modelId/params/… and
    // has no `readonly` field: the provider name is the only marker left.
    const fromPhone = merged.items.map(({ readonly: _readonly, ...rest }) => rest);
    expect(writableItems(fromPhone as MobileModelDoc['items'], readonlyProviders).map((item) => item.provider)).toEqual([
      'codego',
    ]);
  });

  it('engineOps on the merged document WOULD unset the official provider — the save path must filter first', () => {
    const managed = managedDoc();
    const merged = mergeEngineModels(managed, official);
    // Passing the merged document straight into the writer is the bug this
    // guards against: `deepseek-account` has rows but no pi-ai provider, so the
    // diff turns into `unset providers.deepseek-account`.
    const naive = engineOps(managed, merged);
    expect(naive.some((op) => op.path.includes('deepseek-account'))).toBe(true);

    // The real save path: merge keeps only writable rows, so no op mentions it.
    const safeItems = writableItems(merged.items, new Set(['deepseek-account']));
    const safe = engineOps(managed, { ...managed, items: safeItems });
    expect(safe.some((op) => op.path.includes('deepseek-account'))).toBe(false);
    expect(safe).toEqual([]);
  });
});
