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
