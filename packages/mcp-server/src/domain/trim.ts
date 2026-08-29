/**
 * 95 upstream fields down to 8 (research F10, data-model §2).
 *
 * This function is Principle II at its most literal. A GBIF occurrence record
 * carries ninety-five fields — licences, publishing regions, institution codes,
 * a dozen internal identifiers — and a page of fifty of them would cost a
 * caller thousands of tokens to learn where an animal was seen.
 *
 * Two choices here are load-bearing rather than cosmetic:
 *
 *   - **`countryCode`, never `country`.** The record carries both: `country` is
 *     a display name ("United States of America") and `countryCode` is the ISO
 *     code ("US"). Only the code is valid as this server's own `country` filter,
 *     so emitting the code is what lets the output of one call become the input
 *     of the next (Principle III).
 *   - **Absence is null, never a default.** A record with no date is a real
 *     record with an unknown date, and saying so is the difference between a
 *     caller drawing a correct conclusion and a wrong one (FR-009).
 */
import * as z from 'zod'
import type { GbifOccurrenceRecord } from '../gbif/schemas.js'

/** The nine keys that survive. Asserted against in the tests. */
export const TRIMMED_FIELDS = [
  'key',
  'species',
  'eventDate',
  'countryCode',
  'latitude',
  'longitude',
  'basisOfRecord',
  'dataset',
  'publisher',
] as const

export const OccurrenceRecordSchema = z.object({
  key: z.number().int().describe('GBIF occurrence key.'),
  species: z.string().nullable(),
  eventDate: z.string().nullable().describe('When it was observed. Null when GBIF holds no date.'),
  countryCode: z
    .string()
    .nullable()
    .describe("ISO 3166-1 alpha-2 code — valid as this tool's own country filter."),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  basisOfRecord: z.string().nullable().describe('e.g. HUMAN_OBSERVATION, PRESERVED_SPECIMEN.'),
  dataset: z.object({
    name: z.string().nullable(),
    key: z.string().nullable(),
  }),
  publisher: z
    .string()
    .nullable()
    .describe(
      'Publishing organisation name. GBIF omits this from occurrence search results, so in practice it is null and attribution rests on the dataset.',
    ),
})

export type OccurrenceRecord = z.infer<typeof OccurrenceRecordSchema>

export function trimRecord(raw: GbifOccurrenceRecord): OccurrenceRecord {
  return {
    key: raw.key,
    species: raw.species,
    eventDate: raw.eventDate,
    countryCode: raw.countryCode,
    latitude: raw.decimalLatitude,
    longitude: raw.decimalLongitude,
    basisOfRecord: raw.basisOfRecord,
    dataset: { name: raw.datasetName, key: raw.datasetKey },
    publisher: raw.publishedByOrgName,
  }
}
