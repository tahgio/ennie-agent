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
 *
 * Supplying **both** is refused (FR-028). It used to be a precedence rule — the
 * key won, the name was silently discarded, and nothing anywhere said so: not
 * the text, not the structured result (which reports no resolution in this
 * case), not the diagnostic record. A model holding a polar bear key while
 * naming a cougar received polar bear counts labelled with nothing.
 *
 * The refusal applies whether or not the two agree, and that is not laziness:
 * checking agreement means resolving the name, which is the very lookup the
 * key exists to avoid. So the choice goes back to the caller, which is what
 * every other ambiguity in this server already does — a homonym, a weak fuzzy
 * match, a name reaching only a genus. This was the one place a genuinely
 * ambiguous input was settled by a silent guess.
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
  const suppliedName = input.name?.trim()

  // First, and before any upstream call: contradictory inputs are refused
  // rather than reconciled (FR-028). Naming both values is what lets the
  // caller drop the right one without guessing which we objected to.
  if (input.taxonKey !== undefined && suppliedName !== undefined && suppliedName !== '') {
    throw new ToolError({
      code: 'CONTRADICTORY_TAXON',
      what: `Both taxonKey ${input.taxonKey} and name '${suppliedName}' were supplied, and they may not describe the same taxon.`,
      next: `Pass only taxonKey ${input.taxonKey} to query that taxon directly, or only name '${suppliedName}' to resolve it here — not both.`,
      retryable: false,
    })
  }

  if (input.taxonKey !== undefined) {
    return {
      taxonKey: input.taxonKey,
      taxon: null,
      cache: 'n/a',
      upstreamRequests: 0,
      retries: 0,
    }
  }

  if (suppliedName === undefined || suppliedName === '') {
    throw new ToolError({
      code: 'MISSING_TAXON',
      what: 'Neither taxonKey nor name was supplied, so there is nothing to query.',
      next: "Pass a taxonKey from resolve_taxon, or a name such as 'Ursus maritimus' to resolve here.",
      retryable: false,
    })
  }

  const outcome = await resolveTaxon(deps, {
    name: suppliedName,
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
