/**
 * The GBIF occurrence endpoint, in its two shapes.
 *
 * The faceted shape is the one that matters. `occurrence/search` with
 * `limit=0` and one or more `facet` parameters returns a total count, ranked
 * counts per facet, and an **empty** `results[]` — the aggregation happens
 * inside GBIF and only the counts travel (research F6). That single mechanism
 * is what turns Principle II from an aspiration into something achievable: a
 * distribution question costs one request and a bounded response, whether the
 * species has a hundred occurrences or twenty-five million.
 */
import type { FilterSet } from '../domain/filters.js'
import { toGbifFilterParams } from '../domain/filters.js'
import type { CallBudget, GbifClient, GbifResponse } from './client.js'
import { type GbifFacet, type GbifOccurrenceSearch, GbifOccurrenceSearchSchema } from './schemas.js'

export const DIMENSIONS = ['country', 'year', 'basisOfRecord'] as const
export type Dimension = (typeof DIMENSIONS)[number]

export interface DimensionCount {
  readonly value: string
  readonly count: number
}

export interface DimensionSummary {
  readonly dimension: Dimension
  readonly counts: readonly DimensionCount[]
  /** True when a topN cut hid values (FR-018). */
  readonly truncated: boolean
  readonly distinctValuesReturned: number
}

/**
 * The request-side facet name. GBIF takes camelCase going out
 * (`facet=basisOfRecord`) and returns upper-snake coming back
 * (`BASIS_OF_RECORD`), so the two directions need separate mappings.
 */
export function gbifFacetParam(dimension: Dimension): string {
  return dimension
}

/**
 * Map a returned facet field back to a contract dimension.
 *
 * Comparison is on the name with separators removed, so `BASIS_OF_RECORD` and
 * `basisOfRecord` are the same thing. An unrecognised field returns null and is
 * dropped by the caller — a facet this server has never heard of must not be
 * able to fail a tool call.
 */
export function dimensionForFacetField(field: string | null): Dimension | null {
  if (field === null || field === '') return null
  const normalised = field.replaceAll('_', '').toLowerCase()
  return DIMENSIONS.find((dimension) => dimension.toLowerCase() === normalised) ?? null
}

/**
 * Turn GBIF's facets into the contract's dimension summaries.
 *
 * Two things this must not do: rely on the order GBIF returns facets in (the
 * captured response puts `BASIS_OF_RECORD` first even though the request asked
 * for country first), and report the probe value as a result — the request asks
 * for `topN + 1` values precisely so that receiving more than `topN` reveals a
 * hidden tail, since GBIF never reports how many distinct values exist.
 */
export function mapFacetsToDimensions(
  facets: readonly GbifFacet[],
  requested: readonly Dimension[],
  topN: number,
): DimensionSummary[] {
  const byDimension = new Map<Dimension, GbifFacet>()
  for (const facet of facets) {
    const dimension = dimensionForFacetField(facet.field)
    if (dimension !== null) byDimension.set(dimension, facet)
  }

  // Iterate over what was *asked for*, so a dimension GBIF declined to return
  // still appears — as an empty ranking rather than a silently missing key.
  return requested.map((dimension) => {
    const facet = byDimension.get(dimension)
    const named = (facet?.counts ?? []).filter(
      (count): count is { name: string; count: number } => count.name !== null && count.name !== '',
    )

    const counts = named.slice(0, topN).map((count) => ({ value: count.name, count: count.count }))

    return {
      dimension,
      counts,
      truncated: named.length > topN,
      distinctValuesReturned: counts.length,
    }
  })
}

export interface OccurrenceCall {
  readonly budget: CallBudget
  readonly signal?: AbortSignal | undefined
}

export interface FacetSearchInput {
  readonly taxonKey: number
  readonly filters: FilterSet
  readonly dimensions: readonly Dimension[]
  readonly topN: number
}

/**
 * One request, `limit=0`, N facets. The response carries counts and no records.
 */
export async function facetSearch(
  client: GbifClient,
  input: FacetSearchInput,
  call: OccurrenceCall,
): Promise<GbifResponse<GbifOccurrenceSearch>> {
  const params: Record<string, string | number | boolean | undefined | string[]> = {
    taxonKey: input.taxonKey,
    limit: 0,
    facet: input.dimensions.map(gbifFacetParam),
    ...toGbifFilterParams(input.filters),
  }

  // Per-facet caps use the `{facet}.facetLimit` form. Asking for one more than
  // we intend to return is what makes `truncated` knowable.
  for (const dimension of input.dimensions) {
    params[`${gbifFacetParam(dimension)}.facetLimit`] = input.topN + 1
  }

  return await client.get({
    path: '/occurrence/search',
    params,
    schema: GbifOccurrenceSearchSchema,
    budget: call.budget,
    signal: call.signal,
  })
}

export interface PageSearchInput {
  readonly taxonKey: number
  readonly filters: FilterSet
  readonly limit: number
  readonly offset: number
}

/** The paged shape: real records, capped locally before the request is built. */
export async function pageSearch(
  client: GbifClient,
  input: PageSearchInput,
  call: OccurrenceCall,
): Promise<GbifResponse<GbifOccurrenceSearch>> {
  return await client.get({
    path: '/occurrence/search',
    params: {
      taxonKey: input.taxonKey,
      limit: input.limit,
      offset: input.offset,
      ...toGbifFilterParams(input.filters),
    },
    schema: GbifOccurrenceSearchSchema,
    budget: call.budget,
    signal: call.signal,
  })
}
