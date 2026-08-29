/**
 * The common-name fallback (research F3, F4, clarification Q1).
 *
 * `species/match` does not resolve common names at all — "polar bear" comes
 * back as `matchType: NONE` — so this path is not an optimisation, it is the
 * only way a common name ever resolves.
 *
 * The subtlety is that `species/search` ranks badly. Its ordering cannot be
 * trusted, entries outside the GBIF backbone have to be discarded, and the
 * survivor is frequently a synonym that still needs re-resolving through its
 * accepted taxon. Each of those is one test below.
 */
import { describe, expect, it } from 'vitest'
import { selectVernacularCandidates } from '../../src/domain/resolution.js'
import { GbifSpeciesSearchSchema } from '../../src/gbif/schemas.js'
import { fixtureJson } from '../helpers/stub-gbif.js'

const search = (name: string) => GbifSpeciesSearchSchema.parse(fixtureJson(name))

describe('selectVernacularCandidates', () => {
  it('keeps only candidates that are in the GBIF backbone', () => {
    const parsed = search('search-vernacular-polar-bear')
    expect(parsed.results.some((result) => result.nubKey === null)).toBe(true)

    const candidates = selectVernacularCandidates(parsed, 'polar bear')

    // A null nubKey means the name is not in the backbone, so no occurrence
    // query could ever key off it.
    expect(candidates.every((candidate) => candidate.nubKey !== null)).toBe(true)
  })

  it('verifies the query against vernacularNames instead of trusting rank order', () => {
    // The ranking is the trap: unfiltered, GBIF has ranked a sponge above the
    // bear for this query. Position 1 means nothing.
    const parsed = GbifSpeciesSearchSchema.parse({
      count: 2,
      results: [
        {
          key: 1,
          nubKey: 111,
          canonicalName: 'Xestospongia ursa',
          scientificName: 'Xestospongia ursa',
          rank: 'SPECIES',
          taxonomicStatus: 'ACCEPTED',
          kingdom: 'Animalia',
          vernacularNames: [{ vernacularName: 'Polar Bear Sponge', language: 'eng' }],
        },
        {
          key: 2,
          nubKey: 2433451,
          canonicalName: 'Ursus maritimus',
          scientificName: 'Ursus maritimus',
          rank: 'SPECIES',
          taxonomicStatus: 'ACCEPTED',
          kingdom: 'Animalia',
          vernacularNames: [{ vernacularName: 'Polar bear', language: 'eng' }],
        },
      ],
    })

    const candidates = selectVernacularCandidates(parsed, 'polar bear')

    const keys = candidates.map((candidate) => candidate.nubKey)
    expect(keys).toContain(2433451)
    // "Polar Bear Sponge" is not the polar bear, and only an exact vernacular
    // comparison keeps it out.
    expect(keys).not.toContain(111)
  })

  it('matches vernacular names case-insensitively', () => {
    const candidates = selectVernacularCandidates(
      search('search-vernacular-polar-bear'),
      'POLAR BEAR',
    )
    expect(candidates.length).toBeGreaterThan(0)
  })

  it('collapses to a single backbone taxon for "polar bear"', () => {
    // The real response contains both Ursus maritimus (accepted) and
    // Thalarctos maritimus (a synonym of it). Preferring accepted entries is
    // what keeps this from reading as an ambiguity that it is not.
    const candidates = selectVernacularCandidates(
      search('search-vernacular-polar-bear'),
      'polar bear',
    )

    const distinct = new Set(candidates.map((candidate) => candidate.nubKey))
    expect(distinct.size).toBe(1)
    expect([...distinct][0]).toBe(2433451)
  })

  it('returns nothing when no candidate carries the queried name', () => {
    const candidates = selectVernacularCandidates(
      search('search-vernacular-nonsense'),
      'zzzzqqq xxxxyy',
    )
    expect(candidates).toEqual([])
  })

  it('reports every survivor when genuinely different taxa share a common name', () => {
    const parsed = GbifSpeciesSearchSchema.parse({
      count: 2,
      results: [
        {
          key: 1,
          nubKey: 111,
          canonicalName: 'Alpha one',
          scientificName: 'Alpha one',
          rank: 'SPECIES',
          taxonomicStatus: 'ACCEPTED',
          kingdom: 'Animalia',
          vernacularNames: [{ vernacularName: 'robin', language: 'eng' }],
        },
        {
          key: 2,
          nubKey: 222,
          canonicalName: 'Beta two',
          scientificName: 'Beta two',
          rank: 'SPECIES',
          taxonomicStatus: 'ACCEPTED',
          kingdom: 'Animalia',
          vernacularNames: [{ vernacularName: 'Robin', language: 'eng' }],
        },
      ],
    })

    const candidates = selectVernacularCandidates(parsed, 'robin')

    // Two genuinely different accepted taxa: the caller must be asked, not guessed at.
    expect(new Set(candidates.map((candidate) => candidate.nubKey)).size).toBe(2)
  })
})
