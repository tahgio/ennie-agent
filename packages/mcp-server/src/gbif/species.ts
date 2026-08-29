/**
 * The two GBIF species endpoints this server calls.
 *
 * Both are thin: they own the URL, the parameters, and the lenient schema, and
 * nothing else. The decisions about what a response *means* live in
 * `domain/resolution.ts`, so the policy can be unit-tested against captured
 * responses without a client, a socket, or a budget in sight.
 */
import type { CallBudget, GbifClient, GbifResponse } from './client.js'
import {
  type GbifNameMatch,
  GbifNameMatchSchema,
  type GbifSpeciesSearch,
  GbifSpeciesSearchSchema,
} from './schemas.js'

export interface UpstreamCall {
  readonly budget: CallBudget
  readonly signal?: AbortSignal | undefined
}

export interface MatchNameInput {
  readonly name: string
  /** Disambiguation hint only (FR-002) — never a pass-through parameter. */
  readonly rank?: string | undefined
  readonly kingdom?: string | undefined
}

/**
 * `GET /species/match`, **always** with `verbose=true`.
 *
 * The flag is not optional and not a tuning knob. GBIF reports a cross-kingdom
 * homonym as `matchType: NONE` with no candidate list at all unless verbose is
 * set; the `alternatives[]` array it unlocks is the only place the competing
 * taxa appear anywhere in the API. Without it, FR-005 cannot be implemented —
 * a homonym is indistinguishable from a name that simply does not exist
 * (research F2).
 */
export async function matchName(
  client: GbifClient,
  input: MatchNameInput,
  call: UpstreamCall,
): Promise<GbifResponse<GbifNameMatch>> {
  return await client.get({
    path: '/species/match',
    params: {
      name: input.name,
      verbose: true,
      rank: input.rank,
      kingdom: input.kingdom,
    },
    schema: GbifNameMatchSchema,
    budget: call.budget,
    signal: call.signal,
  })
}

/** How many vernacular candidates to consider before giving up on ranking. */
const VERNACULAR_SEARCH_LIMIT = 20

/**
 * `GET /species/search?qField=VERNACULAR` — the common-name path.
 *
 * Restricted to `rank=SPECIES` because a common name is asking about a species,
 * and because the unrestricted ranking is markedly worse (research F4).
 */
export async function searchVernacular(
  client: GbifClient,
  name: string,
  call: UpstreamCall,
): Promise<GbifResponse<GbifSpeciesSearch>> {
  return await client.get({
    path: '/species/search',
    params: {
      q: name,
      qField: 'VERNACULAR',
      rank: 'SPECIES',
      limit: VERNACULAR_SEARCH_LIMIT,
    },
    schema: GbifSpeciesSearchSchema,
    budget: call.budget,
    signal: call.signal,
  })
}
