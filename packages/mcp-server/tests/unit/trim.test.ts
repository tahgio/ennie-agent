/**
 * Record trimming: 95 upstream fields down to 8 (research F10, FR-009).
 *
 * This is Principle II made concrete and measurable. The assertions that matter
 * are about what is *dropped* and how absence is represented — a trim that
 * quietly kept extra fields, or that defaulted a missing date to an empty
 * string, would pass a careless test and still put the caller's context budget
 * and their conclusions at risk.
 */
import { describe, expect, it } from 'vitest'
import { TRIMMED_FIELDS, trimRecord } from '../../src/domain/trim.js'
import { GbifOccurrenceRecordSchema, GbifOccurrenceSearchSchema } from '../../src/gbif/schemas.js'
import { fixtureJson } from '../helpers/stub-gbif.js'

const page = () => GbifOccurrenceSearchSchema.parse(fixtureJson('occurrence-page-ursus'))

const rawRecords = () =>
  (fixtureJson('occurrence-page-ursus') as { results: Array<Record<string, unknown>> }).results

describe('trimRecord', () => {
  it('reduces a 95-field record to exactly the nine contract keys', () => {
    const raw = rawRecords()[0]
    expect(raw).toBeDefined()
    expect(Object.keys(raw as Record<string, unknown>).length).toBe(95)

    const first = page().results[0]
    expect(first).toBeDefined()
    const trimmed = trimRecord(first as never)

    expect(Object.keys(trimmed).sort()).toEqual([...TRIMMED_FIELDS].sort())
    expect(Object.keys(trimmed).length).toBe(9)
  })

  it('emits countryCode, the ISO code, never the country display name', () => {
    // The record carries both: country is "United States of America" and
    // countryCode is "US". Only the code round-trips as this tool's own
    // `country` filter input, which is what makes the tools compose
    // (research F10, Principle III).
    const raw = rawRecords()[0] as Record<string, unknown>
    expect(raw.country).toBe('United States of America')
    expect(raw.countryCode).toBe('US')

    const first = page().results[0]
    const trimmed = trimRecord(first as never)

    expect(trimmed.countryCode).toBe('US')
    expect(JSON.stringify(trimmed)).not.toContain('United States of America')
  })

  it('keeps the fields a caller actually needs', () => {
    const first = page().results[0]
    const trimmed = trimRecord(first as never)

    expect(trimmed).toMatchObject({
      key: 6179282521,
      species: 'Ursus maritimus',
      basisOfRecord: 'HUMAN_OBSERVATION',
      latitude: 71.329539,
      longitude: -156.4248,
    })
    expect(trimmed.dataset.key).toBe('50c9509d-22c7-4a22-a47d-8c48425ef4a7')
  })

  it('drops the other 87 fields, including licence and publishing region', () => {
    const first = page().results[0]
    const trimmed = trimRecord(first as never)
    const serialised = JSON.stringify(trimmed)

    for (const dropped of ['license', 'publishingCountry', 'occurrenceStatus', 'institutionCode']) {
      expect(serialised).not.toContain(dropped)
    }
  })
})

describe('trimRecord — absence is typed, never defaulted (FR-009)', () => {
  it('reports a missing datasetName as null rather than an empty string', () => {
    // Two of the five captured records genuinely lack datasetName.
    const withoutName = page().results[1]
    expect(withoutName).toBeDefined()

    const trimmed = trimRecord(withoutName as never)

    expect(trimmed.dataset.name).toBeNull()
    expect(trimmed.dataset.key).toBe('8a863029-f435-446a-821e-275f4f641165')
  })

  it('reports publisher as null, because GBIF omits it from every search record', () => {
    // Worth stating explicitly: publishedByOrgName is not returned by
    // occurrence/search at all — the response carries publishingOrgKey, a UUID,
    // instead. Attribution therefore rests on the dataset name and key, and
    // publisher is honestly null rather than quietly filled with something else.
    for (const record of page().results) {
      expect(trimRecord(record as never).publisher).toBeNull()
    }
  })

  it('nulls every optional field on a record that carries none of them', () => {
    const sparse = GbifOccurrenceRecordSchema.parse({ key: 1 })

    const trimmed = trimRecord(sparse)

    expect(trimmed).toEqual({
      key: 1,
      species: null,
      eventDate: null,
      countryCode: null,
      latitude: null,
      longitude: null,
      basisOfRecord: null,
      dataset: { name: null, key: null },
      publisher: null,
    })
  })

  it('keeps a key present even when every other field is absent', () => {
    // A record with no date and no coordinates is still a real record; dropping
    // it, or defaulting its date, would misrepresent the data.
    const trimmed = trimRecord(
      GbifOccurrenceRecordSchema.parse({ key: 42, species: 'Ursus maritimus' }),
    )

    expect(trimmed.key).toBe(42)
    expect(trimmed.eventDate).toBeNull()
    expect(trimmed.latitude).toBeNull()
  })
})
