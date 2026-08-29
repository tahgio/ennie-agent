/**
 * Facet mapping (research F6, FR-018).
 *
 * GBIF returns facet fields in upper-snake — `COUNTRY`, `BASIS_OF_RECORD` —
 * and **in an order it does not promise**. The captured response puts
 * `BASIS_OF_RECORD` first even though the request asked for country first, so
 * anything that read `facets[0]` as "the first dimension I asked for" would be
 * quietly wrong. Mapping is by field name, always.
 */
import { describe, expect, it } from 'vitest'
import {
  dimensionForFacetField,
  gbifFacetParam,
  mapFacetsToDimensions,
} from '../../src/gbif/occurrence.js'
import { GbifOccurrenceSearchSchema } from '../../src/gbif/schemas.js'
import { fixtureJson } from '../helpers/stub-gbif.js'

const parsed = (name: string) => GbifOccurrenceSearchSchema.parse(fixtureJson(name))

describe('dimensionForFacetField', () => {
  it('maps upper-snake GBIF fields back to contract dimension names', () => {
    expect(dimensionForFacetField('COUNTRY')).toBe('country')
    expect(dimensionForFacetField('YEAR')).toBe('year')
    expect(dimensionForFacetField('BASIS_OF_RECORD')).toBe('basisOfRecord')
  })

  it('drops an unrecognised facet field rather than throwing', () => {
    // A new facet appearing upstream must not take a tool call down with it.
    expect(dimensionForFacetField('SOME_NEW_FACET')).toBeNull()
    expect(dimensionForFacetField('')).toBeNull()
  })
})

describe('gbifFacetParam', () => {
  it('sends the request-side facet name, which is not the response-side one', () => {
    expect(gbifFacetParam('basisOfRecord')).toBe('basisOfRecord')
    expect(gbifFacetParam('country')).toBe('country')
  })
})

describe('mapFacetsToDimensions', () => {
  it('does not rely on the order GBIF returns facets in', () => {
    const response = parsed('occurrence-facets-ursus')
    // Requested country, year, basisOfRecord — returned basisOfRecord first.
    expect(response.facets[0]?.field).toBe('BASIS_OF_RECORD')

    const dimensions = mapFacetsToDimensions(
      response.facets,
      ['country', 'year', 'basisOfRecord'],
      10,
    )

    expect(dimensions.map((d) => d.dimension)).toEqual(['country', 'year', 'basisOfRecord'])
    expect(dimensions[0]?.counts[0]).toEqual({ value: 'CA', count: 3554 })
  })

  it('truncates to topN and says so when a tail was hidden', () => {
    const response = parsed('occurrence-facets-ursus')

    const [country] = mapFacetsToDimensions(response.facets, ['country'], 10)

    // 11 values came back for a topN of 10 — the extra one is the probe that
    // reveals the truncation, and must not be reported as a result.
    expect(country?.counts.length).toBe(10)
    expect(country?.distinctValuesReturned).toBe(10)
    expect(country?.truncated).toBe(true)
  })

  it('reports truncated: false when the whole ranking fits', () => {
    const response = parsed('occurrence-facets-ursus')

    const [basis] = mapFacetsToDimensions(response.facets, ['basisOfRecord'], 10)

    // Only 8 distinct bases of record exist for this taxon, so nothing is hidden.
    expect(basis?.counts.length).toBe(8)
    expect(basis?.truncated).toBe(false)
  })

  it('honours a smaller topN', () => {
    const response = parsed('occurrence-facets-topn-3')

    const [country] = mapFacetsToDimensions(response.facets, ['country'], 3)

    expect(country?.counts.length).toBe(3)
    expect(country?.truncated).toBe(true)
    expect(country?.counts.map((c) => c.value)).toEqual(['CA', 'US', 'GL'])
  })

  it('returns an empty ranking, not an error, when nothing matched', () => {
    const response = parsed('occurrence-facets-zero-match')

    const [country] = mapFacetsToDimensions(response.facets, ['country'], 10)

    expect(country?.counts).toEqual([])
    expect(country?.truncated).toBe(false)
    expect(country?.distinctValuesReturned).toBe(0)
  })

  it('emits a requested dimension even when GBIF returned no facet for it', () => {
    const dimensions = mapFacetsToDimensions([], ['country', 'year'], 10)

    expect(dimensions.map((d) => d.dimension)).toEqual(['country', 'year'])
    expect(dimensions.every((d) => d.counts.length === 0)).toBe(true)
  })

  it('drops facet values with no name rather than emitting a blank row', () => {
    const dimensions = mapFacetsToDimensions(
      [
        {
          field: 'COUNTRY',
          counts: [
            { name: null, count: 5 },
            { name: 'CA', count: 3 },
          ],
        },
      ],
      ['country'],
      10,
    )

    expect(dimensions[0]?.counts).toEqual([{ value: 'CA', count: 3 }])
  })
})
