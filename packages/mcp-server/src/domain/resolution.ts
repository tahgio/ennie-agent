/**
 * The resolved-taxon contract shape (data-model §2).
 *
 * All three tools return one of these, so it lives here rather than in any one
 * tool. The resolution *policy* that produces it — the part where the ordering
 * is load-bearing — arrives with User Story 1.
 *
 * **Invariant**: a `ResolvedTaxon` is only ever constructed for a match that
 * passed the policy. There is deliberately no "low-confidence taxon" value in
 * this type system; an unresolved name is an error, not a taxon with a caveat
 * attached. That is what stops a weak guess from travelling downstream and
 * being counted as if it were an answer.
 */
import * as z from 'zod'
import type { ElicitTaxon, TaxonOption } from '../elicitation.js'
import { ToolError } from '../errors.js'
import { cacheKey, type TtlCache } from '../gbif/cache.js'
import type { CallBudget, GbifClient } from '../gbif/client.js'
import type { GbifNameMatch, GbifSpeciesSearch } from '../gbif/schemas.js'
import { matchName, searchVernacular } from '../gbif/species.js'
import type { CacheOutcome } from '../logging.js'

/** How the name was matched. `VERNACULAR` marks the common-name path (FR-003, Q1). */
export const MatchTypeSchema = z.enum(['EXACT', 'FUZZY', 'VERNACULAR'])
export type MatchType = z.infer<typeof MatchTypeSchema>

/**
 * Every rank is nullable because GBIF omits ranks freely, and a stricter output
 * schema would turn a perfectly good upstream response into a protocol fault
 * (plan D8).
 */
export const ClassificationSchema = z.object({
  kingdom: z.string().nullable(),
  phylum: z.string().nullable(),
  class: z.string().nullable(),
  order: z.string().nullable(),
  family: z.string().nullable(),
  genus: z.string().nullable(),
  species: z.string().nullable(),
})
export type Classification = z.infer<typeof ClassificationSchema>

export const ResolvedTaxonSchema = z.object({
  /**
   * **The accepted key.** For a synonym this is `acceptedUsageKey`, never the
   * synonym's own `usageKey` — using the latter silently under-counts every
   * downstream occurrence query (research F5).
   */
  taxonKey: z.number().int().describe('The accepted GBIF taxon key. Pass this to the other tools.'),
  scientificName: z.string().describe('Canonical name, without the authorship suffix.'),
  rank: z.string().describe('e.g. SPECIES, GENUS.'),
  classification: ClassificationSchema,
  confidence: z.number().describe('GBIF match confidence, 0-100.'),
  matchType: MatchTypeSchema,
  wasSynonym: z
    .boolean()
    .describe('True when the supplied name was a synonym of the accepted taxon.'),
  matchedName: z
    .string()
    .nullable()
    .describe('The name as supplied when it differed from the accepted name; null otherwise.'),
})

export type ResolvedTaxon = z.infer<typeof ResolvedTaxonSchema>

/** The empty classification, used when GBIF returns no ranks at all. */
export const EMPTY_CLASSIFICATION: Classification = {
  kingdom: null,
  phylum: null,
  class: null,
  order: null,
  family: null,
  genus: null,
  species: null,
}

// ---------------------------------------------------------------------------
// Resolution policy (data-model §3)
// ---------------------------------------------------------------------------

/** One competing taxon in an ambiguous result, as reported back to the caller. */
export interface AmbiguousCandidate {
  readonly taxonKey: number
  readonly scientificName: string
  readonly kingdom: string | null
  readonly rank: string | null
  readonly confidence: number
}

/**
 * What the policy concluded. `unmatched` is not a failure yet — it is the
 * signal to try the common-name path, since `species/match` never resolves a
 * vernacular name (research F3).
 */
export type MatchPolicyOutcome =
  | { readonly kind: 'resolved'; readonly taxon: ResolvedTaxon }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly AmbiguousCandidate[] }
  | { readonly kind: 'unmatched' }
  | {
      readonly kind: 'higher-rank'
      readonly rank: string
      readonly scientificName: string
      readonly taxonKey: number
    }
  | {
      readonly kind: 'low-confidence'
      readonly scientificName: string
      readonly confidence: number
    }

/** The bar a fuzzy match must clear (FR-004, clarification Q1). */
export const FUZZY_CONFIDENCE_THRESHOLD = 90

/** At most this many competing taxa are named in an ambiguity error. */
const MAX_AMBIGUOUS_CANDIDATES = 5

/**
 * Apply the resolution policy to a `species/match` response.
 *
 * **The order of these branches is the single most important thing in this
 * file.** GBIF returns `confidence: 100` on `matchType: NONE` — for a nonsense
 * name *and* for a homonym — so a confidence test placed before the match-type
 * test silently accepts every failed lookup while looking entirely sensible.
 * Match type is decided first, always; the confidence bar applies only to
 * `FUZZY` (research F1, F2).
 */
export function applyMatchPolicy(match: GbifNameMatch): MatchPolicyOutcome {
  // 1. A homonym, before any confidence test. GBIF reports it identically to a
  //    total non-match; only the alternatives distinguish the two.
  if (match.matchType === 'NONE') {
    const candidates = competingCandidates(match)
    if (candidates.length > 1) return { kind: 'ambiguous', candidates }
    // 2. Genuinely unmatched — the caller should try the vernacular path.
    return { kind: 'unmatched' }
  }

  // 3. Reached a broader rank than asked for. That is not an answer to a
  //    species question, and returning the genus as if it were would be a
  //    silent substitution (FR-004a).
  if (match.matchType === 'HIGHERRANK') {
    return {
      kind: 'higher-rank',
      rank: match.rank ?? 'a higher rank',
      scientificName: match.canonicalName ?? match.scientificName ?? 'that taxon',
      taxonKey: match.usageKey ?? 0,
    }
  }

  const displayName = match.canonicalName ?? match.scientificName ?? 'that name'

  // 4 & 5. Accept an exact match outright; a fuzzy one only above the bar.
  if (match.matchType === 'EXACT' || match.matchType === 'FUZZY') {
    if (match.matchType === 'FUZZY' && match.confidence < FUZZY_CONFIDENCE_THRESHOLD) {
      return { kind: 'low-confidence', scientificName: displayName, confidence: match.confidence }
    }

    const taxon = buildResolvedTaxon(match, match.matchType)
    if (taxon !== null) return { kind: 'resolved', taxon }
  }

  // 6. Anything else, including a match type this server has never seen. An
  //    unrecognised value must degrade to "unresolved", never throw.
  return { kind: 'low-confidence', scientificName: displayName, confidence: match.confidence }
}

/**
 * The taxa that genuinely compete for a name, drawn from `alternatives[]`.
 *
 * GBIF returns fifty alternatives for `Prunella`, scoring from 99 down to -25.
 * Listing all of them would bury the answer, so this keeps the exactly-matched
 * ones — which for a homonym is precisely the set that ties — and falls back to
 * the top-scoring tier when nothing matched exactly.
 */
function competingCandidates(match: GbifNameMatch): AmbiguousCandidate[] {
  const usable = match.alternatives.filter((alternative) => alternative.usageKey !== null)
  if (usable.length === 0) return []

  const exact = usable.filter((alternative) => alternative.matchType === 'EXACT')
  let tier = exact
  if (tier.length === 0) {
    const best = Math.max(...usable.map((alternative) => alternative.confidence))
    tier = usable.filter((alternative) => alternative.confidence === best)
  }

  const seen = new Set<number>()
  const candidates: AmbiguousCandidate[] = []
  for (const alternative of tier) {
    const taxonKey = alternative.usageKey
    if (taxonKey === null || seen.has(taxonKey)) continue
    seen.add(taxonKey)
    candidates.push({
      taxonKey,
      scientificName: alternative.scientificName ?? alternative.canonicalName ?? 'unnamed taxon',
      kingdom: alternative.kingdom,
      rank: alternative.rank,
      confidence: alternative.confidence,
    })
    if (candidates.length >= MAX_AMBIGUOUS_CANDIDATES) break
  }
  return candidates
}

/**
 * Build the contract shape, resolving a synonym to its accepted taxon.
 *
 * For a synonym the accepted *name* is not in `canonicalName` — that holds the
 * synonym the caller supplied. It is in whichever classification rank shares a
 * key with `acceptedUsageKey`, which is why this walks the ranks rather than
 * reading one field (research F5).
 */
function buildResolvedTaxon(
  match: GbifNameMatch,
  matchType: 'EXACT' | 'FUZZY',
): ResolvedTaxon | null {
  const wasSynonym = match.status === 'SYNONYM' && match.acceptedUsageKey !== null
  const taxonKey = wasSynonym ? match.acceptedUsageKey : match.usageKey
  if (taxonKey === null) return null

  const suppliedName = match.canonicalName ?? match.scientificName
  const acceptedName = wasSynonym ? acceptedNameFor(match, taxonKey) : null

  return {
    taxonKey,
    scientificName: acceptedName ?? suppliedName ?? 'unnamed taxon',
    rank: match.rank ?? 'UNKNOWN',
    classification: {
      kingdom: match.kingdom,
      phylum: match.phylum,
      class: match.class,
      order: match.order,
      family: match.family,
      genus: match.genus,
      species: match.species,
    },
    confidence: match.confidence,
    matchType,
    wasSynonym,
    matchedName: wasSynonym ? (suppliedName ?? null) : null,
  }
}

/** Find the accepted name by matching the accepted key against each rank's key. */
function acceptedNameFor(match: GbifNameMatch, acceptedKey: number): string | null {
  const ranks: ReadonlyArray<readonly [number | null, string | null]> = [
    [match.speciesKey, match.species],
    [match.genusKey, match.genus],
    [match.familyKey, match.family],
    [match.orderKey, match.order],
    [match.classKey, match.class],
    [match.phylumKey, match.phylum],
    [match.kingdomKey, match.kingdom],
  ]
  for (const [key, name] of ranks) {
    if (key === acceptedKey && name !== null) return name
  }
  return null
}

// ---------------------------------------------------------------------------
// Vernacular fallback (data-model §3, research F4)
// ---------------------------------------------------------------------------

export interface VernacularCandidate {
  readonly nubKey: number
  readonly canonicalName: string
  readonly kingdom: string | null
  readonly taxonomicStatus: string | null
}

/**
 * Narrow a vernacular search down to the taxa that actually bear the name.
 *
 * Three filters, each earning its place against real output for "polar bear":
 *
 *   1. **Backbone only.** A null `nubKey` means the entry is not in the GBIF
 *      backbone, so no occurrence query could ever key off it.
 *   2. **Verify the name, do not trust the ranking.** GBIF's relevance order is
 *      unreliable here — unrestricted, it ranks the "Polar Bear Sponge" above
 *      the polar bear. The query is compared against the returned
 *      `vernacularNames` instead, exactly rather than as a substring, which is
 *      what keeps the sponge out.
 *   3. **Prefer accepted taxa.** The real response contains both
 *      *Ursus maritimus* and *Thalarctos maritimus*, a synonym of it. Without
 *      this the two would read as an ambiguity, and a perfectly ordinary common
 *      name would fail. Synonyms are still returned when nothing accepted
 *      survives, and get re-resolved through their accepted taxon afterwards.
 */
export function selectVernacularCandidates(
  search: GbifSpeciesSearch,
  query: string,
): VernacularCandidate[] {
  const wanted = query.trim().toLowerCase()

  const bearsTheName = search.results.filter((result) => {
    if (result.nubKey === null) return false
    return result.vernacularNames.some(
      (vernacular) => vernacular.vernacularName?.trim().toLowerCase() === wanted,
    )
  })

  const accepted = bearsTheName.filter((result) => result.taxonomicStatus === 'ACCEPTED')
  const surviving = accepted.length > 0 ? accepted : bearsTheName

  const seen = new Set<number>()
  const candidates: VernacularCandidate[] = []
  for (const result of surviving) {
    const nubKey = result.nubKey
    if (nubKey === null || seen.has(nubKey)) continue
    seen.add(nubKey)
    candidates.push({
      nubKey,
      canonicalName: result.canonicalName ?? result.scientificName ?? 'unnamed taxon',
      kingdom: result.kingdom,
      taxonomicStatus: result.taxonomicStatus,
    })
  }
  return candidates
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface ResolveDeps {
  readonly client: GbifClient
  readonly cache: TtlCache<ResolvedTaxon>
  /**
   * Ask the person which taxon was meant, when the connected client can carry
   * the question (FR-005). Absent in unit tests and against clients with no
   * elicitation support, and absence is not a degraded mode: the ambiguity
   * error is the designed answer either way.
   */
  readonly elicit?: ElicitTaxon | undefined
}

export interface ResolveInput {
  readonly name: string
  readonly rank?: string | undefined
  readonly kingdom?: string | undefined
  readonly budget: CallBudget
  readonly signal?: AbortSignal | undefined
}

export interface ResolveOutcome {
  readonly taxon: ResolvedTaxon
  readonly cache: CacheOutcome
  readonly upstreamRequests: number
  readonly retries: number
  /**
   * True when a person picked this taxon out of an ambiguity, rather than the
   * name resolving on its own. It is what keeps the choice out of the cache —
   * see `resolveTaxon`.
   */
  readonly elicited: boolean
}

/**
 * Resolve a scientific or common name to one accepted taxon, or raise a
 * recoverable error naming what to try next. Never a silent guess.
 *
 * The shape of the work:
 *
 *   cache -> species/match (verbose) -> policy
 *                                        ├─ resolved      -> done
 *                                        ├─ ambiguous     -> ask the caller
 *                                        ├─ higher rank   -> say so
 *                                        ├─ low confidence-> say so
 *                                        └─ unmatched     -> vernacular path
 *
 * Both outcomes are cached, successes and failures alike (FR-030).
 */
export async function resolveTaxon(
  deps: ResolveDeps,
  input: ResolveInput,
): Promise<ResolveOutcome> {
  const name = input.name.trim()
  if (name === '') {
    throw new ToolError({
      code: 'EMPTY_NAME',
      what: 'The name was empty.',
      next: "Supply a scientific or common species name, e.g. 'Ursus maritimus' or 'polar bear'.",
      retryable: false,
    })
  }

  const key = cacheKey({ name, rank: input.rank, kingdom: input.kingdom })
  const cached = deps.cache.get(key)
  if (cached !== undefined) {
    if (cached.ok) {
      return { taxon: cached.value, cache: 'hit', upstreamRequests: 0, retries: 0, elicited: false }
    }
    // The same failure, verbatim — including an ambiguity's candidate list.
    throw new ToolError(cached.error)
  }

  try {
    const outcome = await resolveUncached(deps, { ...input, name })

    // An elicited taxon is **not** remembered, and this is the one place that
    // rule can be enforced (FR-005, D2). The cache key is the ambiguous name —
    // 'Prunella' with no hint — so caching the answer would mean the next
    // person to ask about Prunella the bird silently receives Prunella the
    // mint, an hour after somebody else answered a question they never saw.
    // The choice is a fact about one conversation, not about the name.
    if (!outcome.elicited) deps.cache.setValue(key, outcome.taxon)
    return outcome
  } catch (error) {
    // Remember a failure only when retrying it cannot help (FR-007, D2).
    //
    // `retryable` already means exactly "repeating the identical call could
    // plausibly succeed", so it is the right predicate: a failure worth
    // retrying and a failure worth remembering are complementary by
    // definition. The previous guard stated an exception without stating the
    // rule, and so remembered a thirty-second outage for a full hour.
    //
    // Both clauses are load-bearing. `CANCELLED` is currently built with
    // `retryable: true` (see `cancelled()` in gbif/client.ts), so the first
    // clause happens to exclude it today — but a cancellation is a fact about
    // the caller rather than about the name, so it is excluded on its own
    // terms and stays excluded whichever way its retry semantics are set
    // later (FR-009).
    //
    // The third exclusion is `AMBIGUOUS` while elicitation is available. The
    // ambiguity itself is a settled fact about the name, so by the rule above
    // it would be remembered — but remembering it means the *next* call throws
    // straight out of the cache, before reaching the code that would have
    // asked the person. Declining the question once would quietly disable it
    // for an hour, which is the opposite of what declining should mean.
    if (
      error instanceof ToolError &&
      error.retryable === false &&
      error.code !== 'CANCELLED' &&
      !(error.code === 'AMBIGUOUS' && deps.elicit !== undefined)
    ) {
      deps.cache.setNegative(key, error)
    }
    throw error
  }
}

async function resolveUncached(deps: ResolveDeps, input: ResolveInput): Promise<ResolveOutcome> {
  const call = { budget: input.budget, signal: input.signal }
  const matched = await matchName(
    deps.client,
    { name: input.name, rank: input.rank, kingdom: input.kingdom },
    call,
  )

  let upstreamRequests = matched.upstreamRequests
  let retries = matched.retries

  const outcome = applyMatchPolicy(matched.data)

  switch (outcome.kind) {
    case 'resolved':
      return { taxon: outcome.taxon, cache: 'miss', upstreamRequests, retries, elicited: false }

    case 'ambiguous': {
      // A cross-kingdom homonym is re-resolved by re-matching the original
      // name with the chosen kingdom — the exact recovery `ambiguousError`
      // advises in prose, performed for the caller instead of described to it.
      const picked = await elicitAndResolve(
        deps,
        input,
        kingdomOptions(input.name, outcome.candidates),
      )
      if (picked !== null) {
        return {
          taxon: picked.taxon,
          cache: 'miss',
          upstreamRequests: upstreamRequests + picked.upstreamRequests,
          retries: retries + picked.retries,
          elicited: true,
        }
      }
      throw ambiguousError(input.name, outcome.candidates)
    }

    case 'higher-rank':
      throw new ToolError({
        code: 'HIGHER_RANK',
        what: `'${input.name}' matches only the ${outcome.rank.toLowerCase()} ${outcome.scientificName} (key ${outcome.taxonKey}), not a species.`,
        next: `Supply a full species name, or use taxonKey ${outcome.taxonKey} to query the whole ${outcome.rank.toLowerCase()}.`,
        retryable: false,
      })

    case 'low-confidence':
      throw new ToolError({
        code: 'LOW_CONFIDENCE',
        what: `The closest match to '${input.name}' is ${outcome.scientificName} at confidence ${outcome.confidence}, below the ${FUZZY_CONFIDENCE_THRESHOLD} required.`,
        next: 'Confirm the spelling, or pass rank/kingdom to narrow the search.',
        retryable: false,
      })

    case 'unmatched': {
      // `species/match` never resolves a common name, so this is where most
      // ordinary human names for animals actually get answered (research F3).
      const search = await searchVernacular(deps.client, input.name, call)
      upstreamRequests += search.upstreamRequests
      retries += search.retries

      const candidates = selectVernacularCandidates(search.data, input.name)

      if (candidates.length === 0) {
        throw new ToolError({
          code: 'NOT_FOUND',
          what: `No GBIF taxon matches '${input.name}'.`,
          next: 'Check the spelling, or try the scientific name if you used a common one.',
          retryable: false,
        })
      }

      if (candidates.length > 1) {
        const competing: AmbiguousCandidate[] = candidates.map((candidate) => ({
          taxonKey: candidate.nubKey,
          scientificName: candidate.canonicalName,
          kingdom: candidate.kingdom,
          rank: null,
          confidence: 0,
        }))

        // A common name borne by several taxa cannot be re-matched with a
        // kingdom hint — `species/match` does not resolve vernacular names at
        // all (research F3) — so the chosen *scientific* name is what gets
        // matched, which is the same second lookup the single-candidate path
        // below already performs.
        const picked = await elicitAndResolve(deps, input, scientificNameOptions(candidates))
        if (picked !== null) {
          return {
            taxon: { ...picked.taxon, matchType: 'VERNACULAR', matchedName: input.name },
            cache: 'miss',
            upstreamRequests: upstreamRequests + picked.upstreamRequests,
            retries: retries + picked.retries,
            elicited: true,
          }
        }

        throw ambiguousError(input.name, competing)
      }

      // Exactly one survivor — but it may itself be a synonym, so it goes back
      // through `species/match` to reach the accepted taxon (research F4).
      const only = candidates[0]
      if (only === undefined) throw unexpectedlyEmpty()

      const reresolved = await matchName(deps.client, { name: only.canonicalName }, call)
      upstreamRequests += reresolved.upstreamRequests
      retries += reresolved.retries

      const confirmed = applyMatchPolicy(reresolved.data)
      if (confirmed.kind !== 'resolved') {
        throw new ToolError({
          code: 'NOT_FOUND',
          what: `'${input.name}' pointed at ${only.canonicalName}, which GBIF could not resolve to an accepted taxon.`,
          next: 'Try the scientific name directly, or a different common name for the same species.',
          retryable: false,
        })
      }

      return {
        // The common-name path is reported as such, so a caller can see that
        // the answer came from a vernacular lookup rather than a name match.
        taxon: { ...confirmed.taxon, matchType: 'VERNACULAR', matchedName: input.name },
        cache: 'miss',
        upstreamRequests,
        retries,
        elicited: false,
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Elicitation (FR-005)
// ---------------------------------------------------------------------------

/**
 * Offer the competing kingdoms, but only when the kingdom is what actually
 * separates them.
 *
 * The retry is `name + kingdom`, so this is sound exactly when each candidate
 * sits in a different, known kingdom — the cross-kingdom homonym the ambiguity
 * error names in so many words. Two taxa that tie *within* one kingdom would
 * be re-matched by a hint that cannot tell them apart, so the empty list is
 * returned instead and the caller falls back to the error. Asking a person a
 * question whose answer cannot be acted on is worse than not asking.
 */
function kingdomOptions(name: string, candidates: readonly AmbiguousCandidate[]): TaxonOption[] {
  const kingdoms = new Set<string>()
  const options: TaxonOption[] = []

  for (const candidate of candidates) {
    const kingdom = candidate.kingdom
    if (kingdom === null || kingdoms.has(kingdom)) return []
    kingdoms.add(kingdom)

    const rank = candidate.rank === null ? '' : `, ${candidate.rank.toLowerCase()}`
    options.push({
      taxonKey: candidate.taxonKey,
      label: `${candidate.scientificName} — ${kingdom}${rank}`,
      retry: { name, kingdom },
    })
  }

  return options
}

/** Offer the candidate scientific names, for the common-name path. */
function scientificNameOptions(candidates: readonly VernacularCandidate[]): TaxonOption[] {
  return candidates.map((candidate) => ({
    taxonKey: candidate.nubKey,
    label:
      candidate.kingdom === null
        ? candidate.canonicalName
        : `${candidate.canonicalName} — ${candidate.kingdom}`,
    retry: { name: candidate.canonicalName },
  }))
}

/**
 * Put the choice to the person, then resolve what they chose.
 *
 * Two things are load-bearing here:
 *
 *   - **The budget stops while a person is thinking.** The call budget bounds
 *     how long this server may hold GBIF waiting; a human reading five taxon
 *     names is not upstream work, and charging it would abort the call for a
 *     slow reader and make the ceiling mean "how fast the user types". The
 *     `finally` is what keeps the clock from staying stopped when the
 *     elicitation throws.
 *   - **One retry, never a loop.** The chosen lookup goes through
 *     `applyMatchPolicy` like any other, and if it comes back anything other
 *     than resolved — including ambiguous again — this returns `null` and the
 *     caller raises the original error. There is no second question.
 */
async function elicitAndResolve(
  deps: ResolveDeps,
  input: ResolveInput,
  options: readonly TaxonOption[],
): Promise<{ taxon: ResolvedTaxon; upstreamRequests: number; retries: number } | null> {
  const elicit = deps.elicit
  if (elicit === undefined || options.length < 2) return null

  input.budget.pause()
  let chosen: TaxonOption | null
  try {
    chosen = await elicit({ name: input.name, options, signal: input.signal })
  } finally {
    input.budget.resume()
  }

  if (chosen === null) return null

  const confirmed = await matchName(deps.client, chosen.retry, {
    budget: input.budget,
    signal: input.signal,
  })
  const outcome = applyMatchPolicy(confirmed.data)
  if (outcome.kind !== 'resolved') return null

  return {
    taxon: outcome.taxon,
    upstreamRequests: confirmed.upstreamRequests,
    retries: confirmed.retries,
  }
}

/** FR-005: an ambiguity is only recoverable if it names what it is ambiguous between. */
function ambiguousError(name: string, candidates: readonly AmbiguousCandidate[]): ToolError {
  const rendered = candidates
    .map((candidate) => {
      const kingdom = candidate.kingdom === null ? 'kingdom unknown' : candidate.kingdom
      return `${candidate.scientificName} (${kingdom}, key ${candidate.taxonKey})`
    })
    .join(', ')

  return new ToolError({
    code: 'AMBIGUOUS',
    what: `'${name}' matches several taxa in different kingdoms: ${rendered}.`,
    next: 'Re-request with a kingdom hint, or call again with the taxonKey you want.',
    retryable: false,
  })
}

function unexpectedlyEmpty(): ToolError {
  return new ToolError({
    code: 'NOT_FOUND',
    what: 'The vernacular search returned a candidate that could not be read.',
    next: 'Try the scientific name instead.',
    retryable: true,
  })
}
