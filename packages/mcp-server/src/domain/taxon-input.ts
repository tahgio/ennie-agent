/**
 * "Give me a taxonKey, or a name I will resolve for you" — shared by both
 * occurrence tools (FR-006, FR-015).
 *
 * Accepting both is a composition affordance, not a convenience: a model that
 * already called `resolve_taxon` should not have to pay for a second
 * resolution, and a model answering a one-shot question should not be forced
 * into two round trips before it can ask anything.
 *
 * When a `taxonKey` is supplied nothing is resolved, so there is no resolution
 * to report and `taxon` comes back null. That is deliberately a typed absence
 * rather than a fabricated record: inventing a name and a classification for a
 * key we never looked up would be a guess dressed as data, and finding out
 * would cost the extra upstream request the caller avoided by passing the key.
 */
import { ToolError } from '../errors.js'
import type { CallBudget } from '../gbif/client.js'
import type { CacheOutcome } from '../logging.js'
import { type ResolveDeps, type ResolvedTaxon, resolveTaxon } from './resolution.js'

export interface TaxonInput {
  readonly taxonKey?: number | undefined
  readonly name?: string | undefined
  readonly budget: CallBudget
  readonly signal?: AbortSignal | undefined
}

export interface TaxonSelection {
  /** The key every downstream query uses. */
  readonly taxonKey: number
  /** The resolution, when one happened; null when the caller supplied a key. */
  readonly taxon: ResolvedTaxon | null
  readonly cache: CacheOutcome
  readonly upstreamRequests: number
  readonly retries: number
}

export async function selectTaxon(deps: ResolveDeps, input: TaxonInput): Promise<TaxonSelection> {
  if (input.taxonKey !== undefined) {
    return {
      taxonKey: input.taxonKey,
      taxon: null,
      cache: 'n/a',
      upstreamRequests: 0,
      retries: 0,
    }
  }

  if (input.name === undefined || input.name.trim() === '') {
    throw new ToolError({
      code: 'MISSING_TAXON',
      what: 'Neither taxonKey nor name was supplied, so there is nothing to query.',
      next: "Pass a taxonKey from resolve_taxon, or a name such as 'Ursus maritimus' to resolve here.",
      retryable: false,
    })
  }

  const outcome = await resolveTaxon(deps, {
    name: input.name,
    budget: input.budget,
    signal: input.signal,
  })

  return {
    taxonKey: outcome.taxon.taxonKey,
    taxon: outcome.taxon,
    cache: outcome.cache,
    upstreamRequests: outcome.upstreamRequests,
    retries: outcome.retries,
  }
}
