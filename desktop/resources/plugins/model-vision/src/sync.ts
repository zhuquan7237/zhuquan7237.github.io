/**
 * Planning and applying capability changes to one provider route's `models`
 * array, with a diff a human can read before anything is written.
 *
 * The applied policy comes from the user's own decisions:
 *  - a model the route does not list yet is an addition → applied automatically,
 *    because "pull the list and the model just works" is the point;
 *  - a field the route never set is enrichment → also automatic (the engine's
 *    default is a guess, and a worse one);
 *  - a field that already holds a value the resolver disagrees with is a
 *    correction → it waits for confirmation, because only the user knows whether
 *    that value was deliberate;
 *  - an explicit override is never second-guessed at all.
 *
 * Path ops in the settings service walk plain objects only, so a route's model
 * array is always restated whole — see `capabilities.ts` for why nothing here
 * writes configuration directly.
 *
 * @module @dsh-desktop/dsh-model-vision/sync
 */

import {
  MODALITIES,
  REASONING_LEVELS,
  type CapabilitySource,
  type CapabilityOverride,
  type Catalogue,
  type Modality,
  type ModelCapabilities,
  type ReasoningCapability,
  type ReasoningLevel,
  resolveCapabilities,
  wireReasoning,
} from './capabilities.js'

/** One model as the engine lists it for a route. */
export interface RouteModel {
  id: string
  name?: string
  inputModalities?: readonly string[]
}

/** A field the plan proposes to write. */
export interface FieldChange {
  field: 'input' | 'contextWindow' | 'maxTokens' | 'reasoningEfforts'
  from: unknown
  to: unknown
  source: CapabilitySource
}

/** One planned model row. */
export interface PlannedModel {
  id: string
  name: string
  capabilities: ModelCapabilities
  /** Whether the route's stored array names this model. */
  present: boolean
  /** Fields to write, with `verdict` deciding whether that needs a human. */
  changes: (FieldChange & { verdict: 'add' | 'enrich' | 'correct' })[]
  /** True when the resolver could not state anything for this model. */
  unknown: boolean
}

export interface RoutePlan {
  route: string
  models: PlannedModel[]
  counts: { total: number; added: number; changed: number; correctable: number; unknown: number }
  /** Sources that contributed at least one value, for the UI's summary. */
  sources: Partial<Record<CapabilitySource, number>>
}

const FIELDS = ['input', 'contextWindow', 'maxTokens', 'reasoningEfforts'] as const

/** Every field this module may write, except the reasoning entry itself. */
type SimpleField = Exclude<(typeof FIELDS)[number], 'reasoningEfforts'>

/** Normalize a stored modality list the way the engine reads it. */
export function normalizedInput(value: unknown): Modality[] | undefined {
  if (!Array.isArray(value)) return undefined
  const kept = value.filter((part): part is Modality => MODALITIES.includes(part as Modality))
  return kept.length === 0 ? undefined : [...new Set(kept)]
}

function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i])
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const left = a as Record<string, unknown>
    const right = b as Record<string, unknown>
    const keys = Object.keys(left).sort()
    const other = Object.keys(right).sort()
    return keys.length === other.length && keys.every((key, index) => key === other[index] && left[key] === right[key])
  }
  return a === b
}

/**
 * A stored `reasoningEfforts` value read back as a capability, so an entry the
 * user already set is a *declaration* — never silently overwritten by a source.
 * @param value - the stored entry field.
 * @returns the capability it describes, or `undefined` when it describes none.
 */
export function declaredReasoning(value: unknown): ReasoningCapability | undefined {
  if (value === false) return { kind: 'none' }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const levels = Object.entries(value as Record<string, unknown>)
    .filter(([level, wire]) => (REASONING_LEVELS as readonly string[]).includes(level) && typeof wire === 'string' && wire.length > 0)
    .map(([level]) => level as ReasoningLevel)
  return levels.length > 0 ? { kind: 'efforts', levels } : undefined
}

/**
 * Build a route's plan: what every model's capabilities are, what the stored
 * array says, and exactly which fields differ.
 *
 * @param options.route - provider route id.
 * @param options.models - the engine's model list for the route.
 * @param options.stored - the route's stored `models` entries (user layer).
 * @param options.catalogue - the capability catalogue.
 * @param options.upstream - per-model capabilities published by the endpoint.
 * @param options.overrides - per-model explicit user decisions.
 * @returns the plan, with counts for a summary line.
 */
export function planRoute(options: {
  route: string
  models: readonly RouteModel[]
  stored: readonly Record<string, unknown>[]
  catalogue?: Catalogue | undefined
  upstream?: Record<string, { input?: Modality[]; contextWindow?: number; maxTokens?: number; reasoning?: ReasoningCapability }> | undefined
  overrides?: Record<string, CapabilityOverride> | undefined
}): RoutePlan {
  const storedById = new Map<string, Record<string, unknown>>()
  for (const entry of options.stored) {
    const id = typeof entry.id === 'string' ? entry.id : undefined
    if (id !== undefined) storedById.set(id, entry)
  }

  const sources: Partial<Record<CapabilitySource, number>> = {}
  const models: PlannedModel[] = []

  for (const model of options.models) {
    const current = storedById.get(model.id)
    const capabilities = resolveCapabilities(model.id, {
      override: options.overrides?.[model.id],
      upstream: options.upstream?.[model.id],
      catalogue: options.catalogue,
      declared: { input: normalizedInput(current?.input), reasoning: declaredReasoning(current?.reasoningEfforts) },
    })
    const changes: PlannedModel['changes'] = []
    for (const field of FIELDS) {
      const resolved =
        field === 'reasoningEfforts'
          ? ({ value: wireReasoning(capabilities.reasoning.value), source: capabilities.reasoning.source } as const)
          : { value: capabilities[field as SimpleField].value as unknown, source: capabilities[field as SimpleField].source }
      const value = resolved.value
      // `undefined` is not "leave it alone" for every field: for reasoning it is
      // the resolver saying "this route states nothing writable", and the entry
      // must keep whatever it has.
      if (value === undefined) continue
      sources[resolved.source] = (sources[resolved.source] ?? 0) + 1
      const previous = current?.[field]
      const normalized: unknown = field === 'input' ? normalizedInput(previous) : previous
      if (same(normalized, value)) continue
      const verdict: 'add' | 'enrich' | 'correct' =
        current === undefined || previous === undefined ? 'add' : 'correct'
      if (verdict === 'add' && current !== undefined && previous === undefined) {
        changes.push({ field, from: previous, to: value, source: resolved.source, verdict: 'enrich' })
        continue
      }
      changes.push({ field, from: normalized ?? previous, to: value, source: resolved.source, verdict })
    }
    const unknown = capabilities.input.value === undefined && capabilities.contextWindow.value === undefined
    models.push({
      id: model.id,
      name: model.name || model.id,
      capabilities,
      present: current !== undefined,
      changes,
      unknown,
    })
  }

  const added = models.filter((model) => !model.present).length
  const changed = models.filter((model) => model.present && model.changes.length > 0).length
  const correctable = models.filter((model) => model.changes.some((change) => change.verdict === 'correct')).length
  return {
    route: options.route,
    models,
    counts: { total: models.length, added, changed, correctable, unknown: models.filter((m) => m.unknown).length },
    sources,
  }
}

/**
 * Restate a route's `models` array with the accepted plan applied.
 *
 * Automatic verdicts (`add`, `enrich`) always apply. `correct` applies only for
 * a model the caller accepted — the difference between "the list grew" and "we
 * disagree with something you set".
 *
 * @param options.stored - the route's stored entries, verbatim.
 * @param options.plan - the plan to apply.
 * @param options.accepted - model ids whose corrections the user confirmed.
 * @returns the next `models` array.
 */
export function applyPlan(options: {
  stored: readonly Record<string, unknown>[]
  plan: RoutePlan
  accepted?: readonly string[]
}): Record<string, unknown>[] {
  const accepted = new Set(options.accepted ?? [])
  const byId = new Map<string, PlannedModel>()
  for (const model of options.plan.models) byId.set(model.id, model)

  const next = options.stored.map((entry) => ({ ...entry }))
  const indexById = new Map<string, number>()
  next.forEach((entry, index) => {
    const id = typeof entry.id === 'string' ? entry.id : undefined
    if (id !== undefined) indexById.set(id, index)
  })

  for (const model of options.plan.models) {
    const writable = model.changes.filter((change) => change.verdict !== 'correct' || accepted.has(model.id))
    if (writable.length === 0) continue
    let index = indexById.get(model.id)
    if (index === undefined) {
      index = next.length
      indexById.set(model.id, index)
      next.push({ id: model.id })
    }
    const entry = { ...next[index] }
    for (const change of writable) entry[change.field] = Array.isArray(change.to) ? [...change.to] : change.to
    next[index] = entry
  }
  return next
}

/** One-line summary of a plan, for logs and the UI header. */
export function summarizePlan(plan: RoutePlan): string {
  const { total, added, changed, correctable, unknown } = plan.counts
  const parts = [`${total} 个模型`]
  if (added > 0) parts.push(`新增 ${added}`)
  if (changed > 0) parts.push(`可补全 ${changed - correctable}`)
  if (correctable > 0) parts.push(`待确认修正 ${correctable}`)
  if (unknown > 0) parts.push(`无法判定 ${unknown}`)
  return parts.join(' · ')
}
