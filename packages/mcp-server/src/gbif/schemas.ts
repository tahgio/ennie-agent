/**
 * Lenient schemas for what GBIF actually returns (data-model.md §1).
 *
 * This is the upstream layer, and it is deliberately permissive: unknown fields
 * pass through, and every field the code does not strictly require is nullable
 * (Constitution IV). The narrow, capped contract shapes live in `src/tools/`.
 *
 * The asymmetry is the point. A schema stricter than reality turns a perfectly
 * good GBIF response into a protocol fault, which the model cannot recover
 * from; a schema looser than reality costs us a null check.
 */
import * as z from 'zod'

/**
 * GBIF omits fields freely rather than sending explicit nulls, so absence and
 * null both normalise to `null` — a typed absence, never a default (FR-009).
 */
const nullableString = z
  .string()
  .nullish()
  .transform((v) => v ?? null)

const nullableNumber = z
  .number()
  .nullish()
  .transform((v) => v ?? null)

/** The seven backbone ranks, each independently nullable — GBIF skips ranks freely. */
const classification = {
  kingdom: nullableString,
  phylum: nullableString,
  class: nullableString,
  order: nullableString,
  family: nullableString,
  genus: nullableString,
  species: nullableString,
  kingdomKey: nullableNumber,
  phylumKey: nullableNumber,
  classKey: nullableNumber,
  orderKey: nullableNumber,
  familyKey: nullableNumber,
  genusKey: nullableNumber,
  speciesKey: nullableNumber,
}

const nameMatchFields = {
  /** Absent entirely when `matchType` is NONE (research F1). */
  usageKey: nullableNumber,
  /** Present when `status === "SYNONYM"`; the key downstream queries must use (F5). */
  acceptedUsageKey: nullableNumber,
  scientificName: nullableString,
  canonicalName: nullableString,
  rank: nullableString,
  status: nullableString,

  /**
   * 0–100, but alternatives can carry -1 (research F2), so no lower bound is
   * asserted. A missing score reads as 0, which fails the confidence bar and
   * therefore fails safe: unresolved, never a silent accept.
   */
  confidence: z
    .number()
    .nullish()
    .transform((v) => v ?? 0),

  /**
   * A plain string, never an enum. An unrecognised match type must fall through
   * to "unresolved" rather than throwing, and a missing one reads as NONE.
   */
  matchType: z
    .string()
    .nullish()
    .transform((v) => v ?? 'NONE'),

  /** Free text ("Multiple equal matches for Prunella"). Never parsed — see F2. */
  note: nullableString,

  ...classification,
}

/**
 * One entry of `alternatives[]`. Declared separately from the top-level match
 * because alternatives do not nest in practice, and a non-recursive schema is
 * cheaper to read than a `z.lazy` that models a case GBIF never sends.
 */
export const GbifNameMatchAlternativeSchema = z.looseObject(nameMatchFields)

/** `GET /v1/species/match?verbose=true` */
export const GbifNameMatchSchema = z.looseObject({
  ...nameMatchFields,
  /**
   * Only ever populated under `verbose=true` (research F2). Homonym candidates
   * exist nowhere else in the API, so FR-005 is unimplementable without it.
   */
  alternatives: z.array(GbifNameMatchAlternativeSchema).nullish().default([]),
})

/** One vernacular name attached to a species-search result. */
export const GbifVernacularNameSchema = z.looseObject({
  vernacularName: nullableString,
  language: nullableString,
})

/** One result of `GET /v1/species/search?qField=VERNACULAR` */
export const GbifSpeciesSearchResultSchema = z.looseObject({
  key: z.number(),
  /** Null means the name is not in the GBIF backbone; those are discarded (F4). */
  nubKey: nullableNumber,
  canonicalName: nullableString,
  scientificName: nullableString,
  rank: nullableString,
  taxonomicStatus: nullableString,
  kingdom: nullableString,
  vernacularNames: z.array(GbifVernacularNameSchema).nullish().default([]),
})

export const GbifSpeciesSearchSchema = z.looseObject({
  count: z
    .number()
    .nullish()
    .transform((v) => v ?? 0),
  results: z.array(GbifSpeciesSearchResultSchema).nullish().default([]),
})

/**
 * One occurrence record as GBIF sends it: 95 fields (research F10), of which
 * this names the nine the trimmed contract record is built from. The rest pass
 * through untouched and are dropped by `domain/trim.ts`.
 */
export const GbifOccurrenceRecordSchema = z.looseObject({
  key: z.number(),
  species: nullableString,
  eventDate: nullableString,
  /**
   * The ISO code. The sibling `country` field holds a display name
   * ("United States of America") which is useless as a filter input, so the
   * trimmed record carries this one (F10, Principle III: tools compose).
   */
  countryCode: nullableString,
  decimalLatitude: nullableNumber,
  decimalLongitude: nullableNumber,
  basisOfRecord: nullableString,
  datasetName: nullableString,
  datasetKey: nullableString,
  publishedByOrgName: nullableString,
})

export const GbifFacetCountSchema = z.looseObject({
  name: nullableString,
  count: z
    .number()
    .nullish()
    .transform((v) => v ?? 0),
})

/** Facet `field` values arrive upper-snake: COUNTRY, YEAR, BASIS_OF_RECORD (F6). */
export const GbifFacetSchema = z.looseObject({
  field: nullableString,
  counts: z.array(GbifFacetCountSchema).nullish().default([]),
})

/** `GET /v1/occurrence/search` — both the paged and the `limit=0` faceted form. */
export const GbifOccurrenceSearchSchema = z.looseObject({
  offset: z
    .number()
    .nullish()
    .transform((v) => v ?? 0),
  limit: z
    .number()
    .nullish()
    .transform((v) => v ?? 0),
  endOfRecords: z
    .boolean()
    .nullish()
    .transform((v) => v ?? true),
  count: z
    .number()
    .nullish()
    .transform((v) => v ?? 0),
  results: z.array(GbifOccurrenceRecordSchema).nullish().default([]),
  /** Absent whenever no `facet` parameter was sent, so it defaults rather than failing. */
  facets: z.array(GbifFacetSchema).nullish().default([]),
})

export type GbifNameMatch = z.infer<typeof GbifNameMatchSchema>
export type GbifNameMatchAlternative = z.infer<typeof GbifNameMatchAlternativeSchema>
export type GbifSpeciesSearch = z.infer<typeof GbifSpeciesSearchSchema>
export type GbifSpeciesSearchResult = z.infer<typeof GbifSpeciesSearchResultSchema>
export type GbifOccurrenceSearch = z.infer<typeof GbifOccurrenceSearchSchema>
export type GbifOccurrenceRecord = z.infer<typeof GbifOccurrenceRecordSchema>
export type GbifFacet = z.infer<typeof GbifFacetSchema>
