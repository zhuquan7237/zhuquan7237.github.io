/**
 * `@dsh-desktop/dsh-vision-aux`: when the model selected for a step cannot
 * accept images (`ctx.llm.resolveModelInfo().inputModalities` lacks `image`),
 * replace each image block of the entering user messages with a text
 * description produced by an OpenAI-compatible vision model. Models that do
 * accept images see the original blocks untouched.
 *
 * The rewrite happens in the `agent/pre-step` waterfall — the one sanctioned
 * place that decides what the model sees — so the replaced content becomes the
 * logged `user/message` (model-visible means logged). Message identity
 * (`id`) and `source` are preserved.
 *
 * @module @dsh-desktop/dsh-vision-aux
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-attachment'
import {
  DEFAULT_SKIP_WHEN_UNKNOWN,
  DEFAULT_VISION_PROMPT,
  DEFAULT_VISION_TIMEOUT_MS,
  describeImage,
  renderImageDescription,
  renderImageFailure,
  type ImageRefLike,
  type VisionAuxOptions,
} from './vision.js'

// The host's agent loop owns the real event type; this structural declaration
// only types our listener at compile time (the payload shape matches
// packages/core/agent runtime-types.ts).
declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent/pre-step'(
      payload: {
        agent: { options?: { provider?: string; model?: string } }
        messages: unknown[]
        turn: number
        step: number
        signal: AbortSignal
      },
      next: () => Promise<unknown>,
    ): Promise<unknown>
  }
}

export {
  DEFAULT_SKIP_WHEN_UNKNOWN,
  DEFAULT_VISION_PROMPT,
  DEFAULT_VISION_TIMEOUT_MS,
  describeImage,
  renderImageDescription,
  renderImageFailure,
} from './vision.js'
export type { ImageRefLike, StoredImageLike, VisionAuxOptions } from './vision.js'

/** Cordis plugin name used by loader diagnostics and the patch row id. */
export const name = 'vision-aux'

/** Host services this plugin consumes. */
export const inject = ['llm', 'attachments']

/** Plugin config (the desktop app writes it into the patch row; keys without secrets). */
export interface Config {
  /** OpenAI-compatible base URL; `/chat/completions` is appended. */
  baseURL?: string
  /** Falls back to `$DSH_VISION_AUX_API_KEY`. */
  apiKey?: string
  /** Vision model id. */
  model?: string
  /** Instruction sent with each image. */
  prompt?: string
  /** Per-image timeout in milliseconds. */
  timeoutMs?: number
  /** When modality metadata is unavailable: `true` leaves images untouched. */
  skipWhenUnknown?: boolean
}

// Structural mirrors of the host vocabulary; the only host imports are types.

interface TextBlockLike {
  type: 'text'
  text: string
}

interface ImageBlockLike {
  type: 'image'
  attachment: ImageRefLike & { attachmentId: unknown; mediaType: string; bytes: number }
}

type ContentBlockLike = ({ type: string } & Record<string, unknown>) | TextBlockLike | ImageBlockLike

interface UserMessageLike {
  readonly id: unknown
  readonly role: 'user'
  readonly content: ContentBlockLike[]
  readonly source: unknown
}

interface PreStepPayload {
  agent: {
    options?: { provider?: string; model?: string }
  }
  messages: UserMessageLike[]
  turn: number
  step: number
  signal: AbortSignal
}

type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: UserMessageLike[] }

interface LlmRuntimeLike {
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{
    inputModalities?: readonly string[]
  }>
}

interface AttachmentStoreLike {
  readImage(ref: ImageBlockLike['attachment'], signal?: AbortSignal): Promise<{ data: Uint8Array; mediaType: string }>
}

function blockIsImage(block: ContentBlockLike): block is ImageBlockLike {
  return block.type === 'image'
}

/**
 * True when the selected model accepts images. Results are cached per
 * provider/model; unknown metadata follows `skipWhenUnknown`.
 */
export async function modelSeesImages(
  llm: LlmRuntimeLike,
  agent: PreStepPayload['agent'],
  cache: Map<string, boolean>,
  skipWhenUnknown: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  const provider = agent?.options?.provider
  const model = agent?.options?.model
  if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) {
    return skipWhenUnknown
  }
  const key = `${provider}::${model}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  let sees: boolean
  try {
    const info = await llm.resolveModelInfo(provider, model, signal)
    const modalities = info?.inputModalities
    sees = Array.isArray(modalities) ? modalities.includes('image') : skipWhenUnknown
  } catch {
    sees = skipWhenUnknown
  }
  cache.set(key, sees)
  return sees
}

/** Replace every image block of one message, preserving `id` and `source`. */
export async function rewriteMessageImages(
  attachments: AttachmentStoreLike,
  message: UserMessageLike,
  options: VisionAuxOptions,
  signal?: AbortSignal,
): Promise<UserMessageLike> {
  if (!message.content.some(blockIsImage)) return message
  const images = message.content.filter(blockIsImage)
  const total = images.length
  let index = 0
  const content = await Promise.all(
    message.content.map(async (block): Promise<ContentBlockLike> => {
      if (!blockIsImage(block)) return block
      const current = (index += 1)
      try {
        const stored = await attachments.readImage(block.attachment, signal)
        const description = await describeImage(options, stored, signal)
        return { type: 'text', text: renderImageDescription(current, total, block.attachment, options.model, description) }
      } catch (error) {
        return { type: 'text', text: renderImageFailure(current, total, block.attachment, error) }
      }
    }),
  )
  return { ...message, content }
}

/** Register the pre-step rewrite. */
export function apply(ctx: Context, config: Config = {}): void {
  const options: VisionAuxOptions = {
    baseURL: (config.baseURL ?? '').trim(),
    apiKey: (config.apiKey ?? process.env.DSH_VISION_AUX_API_KEY ?? '').trim(),
    model: (config.model ?? '').trim(),
    prompt: config.prompt?.trim() || DEFAULT_VISION_PROMPT,
    timeoutMs: config.timeoutMs ?? DEFAULT_VISION_TIMEOUT_MS,
  }
  const skipWhenUnknown = config.skipWhenUnknown ?? DEFAULT_SKIP_WHEN_UNKNOWN
  const capability = new Map<string, boolean>()

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = (await next()) as PreStepDecision
    if (decision.kind !== 'enter') return decision
    if (options.model.length === 0 || options.baseURL.length === 0 || options.apiKey.length === 0) return decision
    if (!decision.messages.some((message) => message.content.some(blockIsImage))) return decision
    const sees = await modelSeesImages(
      ctx.llm as unknown as LlmRuntimeLike,
      payload.agent as PreStepPayload['agent'],
      capability,
      skipWhenUnknown,
      payload.signal,
    )
    if (sees) return decision
    const messages = await Promise.all(
      decision.messages.map((message) =>
        rewriteMessageImages(ctx.attachments as unknown as AttachmentStoreLike, message, options, payload.signal),
      ),
    )
    return { kind: 'enter', messages }
  })
}
