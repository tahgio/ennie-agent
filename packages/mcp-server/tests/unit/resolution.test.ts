/**
 * The resolution policy, and specifically its **ordering** (data-model §3,
 * research F1/F2).
 *
 * This is the highest-value test in the repository. GBIF reports a name it
 * could not match at `confidence: 100`, and reports a homonym exactly the same
 * way. So the obvious implementation —
 *
 *     if (match.confidence >= 90) return resolve(match)
 *
 * — accepts every single failed lookup, and does it while looking completely
 * reasonable in review. The policy must branch on `matchType` first and only
 * then apply the confidence bar, and these tests pin that order down against
 * the real captured responses rather than against invented ones.
 */
import { describe, expect, it } from 'vitest'
import { applyMatchPolicy } from '../../src/domain/resolution.js'
import { GbifNameMatchSchema } from '../../src/gbif/schemas.js'
import { fixtureJson } from '../helpers/stub-gbif.js'

const match = (name: string) => GbifNameMatchSchema.parse(fixtureJson(name))

describe('applyMatchPolicy — ordering is load-bearing', () => {
  it('does not resolve a NONE match, even though GBIF scores it 100', () => {
    const parsed = match('match-none-nonsense')

    // The trap, stated explicitly: the score alone says "perfect match".
    expect(parsed.confidence).toBe(100)
    expect(parsed.matchType).toBe('NONE')

    const outcome = applyMatchPolicy(parsed)

    expect(outcome.kind).not.toBe('resolved')
    expect(outcome.kind).toBe('unmatched')
  })

  it('detects a homonym before any confidence test, and lists the competing kingdoms', () => {
    const parsed = match('match-homonym-prunella')

    // Same NONE/100 shape as a total non-match — the alternatives are the only
    // thing that distinguishes them, and they exist only under verbose=true.
    expect(parsed.confidence).toBe(100)
    expect(parsed.matchType).toBe('NONE')

    const outcome = applyMatchPolicy(parsed)

    expect(outcome.kind).toBe('ambiguous')
    if (outcome.kind !== 'ambiguous') return

    const kingdoms = outcome.candidates.map((candidate) => candidate.kingdom)
    expect(kingdoms).toContain('Plantae')
    expect(kingdoms).toContain('Animalia')

    const keys = outcome.candidates.map((candidate) => candidate.taxonKey)
    expect(keys).toContain(2926553) // Prunella L., Plantae
    expect(keys).toContain(2495070) // Prunella Vieillot, 1816, Animalia
  })

  it('narrows 50 alternatives to the competing top matches, not the whole list', () => {
    // GBIF returns fifty alternatives for Prunella, most of them weak fuzzy
    // matches scoring as low as -25. Listing all of them in an error message
    // would bury the two candidates that actually compete.
    const parsed = match('match-homonym-prunella')
    expect(parsed.alternatives.length).toBeGreaterThan(10)

    const outcome = applyMatchPolicy(parsed)
    if (outcome.kind !== 'ambiguous') throw new Error('expected an ambiguous outcome')

    expect(outcome.candidates.length).toBeLessThanOrEqual(5)
    expect(outcome.candidates.length).toBeGreaterThanOrEqual(2)
  })

  it('resolves cleanly once a kingdom hint breaks the tie', () => {
    const outcome = applyMatchPolicy(match('match-homonym-prunella-plantae'))

    expect(outcome.kind).toBe('resolved')
    if (outcome.kind !== 'resolved') return
    expect(outcome.taxon.taxonKey).toBe(2926553)
    expect(outcome.taxon.matchType).toBe('EXACT')
  })

  it('treats HIGHERRANK as unresolved, rather than answering with the genus', () => {
    const parsed = match('match-higherrank-puma')
    expect(parsed.confidence).toBe(94) // comfortably over the 90 bar, and still not an answer

    const outcome = applyMatchPolicy(parsed)

    expect(outcome.kind).toBe('higher-rank')
    if (outcome.kind !== 'higher-rank') return
    expect(outcome.rank).toBe('GENUS')
    expect(outcome.taxonKey).toBe(2435098)
    expect(outcome.scientificName).toBe('Puma')
  })

  it('accepts an EXACT match', () => {
    const outcome = applyMatchPolicy(match('match-exact-ursus-maritimus'))

    expect(outcome.kind).toBe('resolved')
    if (outcome.kind !== 'resolved') return
    expect(outcome.taxon.taxonKey).toBe(2433451)
    expect(outcome.taxon.scientificName).toBe('Ursus maritimus')
    expect(outcome.taxon.matchType).toBe('EXACT')
    expect(outcome.taxon.wasSynonym).toBe(false)
    expect(outcome.taxon.classification.family).toBe('Ursidae')
  })

  it('accepts a FUZZY match at or above 90', () => {
    const parsed = match('match-fuzzy-ursus-maritimuss')
    expect(parsed.confidence).toBeGreaterThanOrEqual(90)

    const outcome = applyMatchPolicy(parsed)

    expect(outcome.kind).toBe('resolved')
    if (outcome.kind !== 'resolved') return
    expect(outcome.taxon.taxonKey).toBe(2433451)
    expect(outcome.taxon.matchType).toBe('FUZZY')
  })

  it('rejects a FUZZY match below 90 and reports the score it saw', () => {
    const weak = GbifNameMatchSchema.parse({
      ...(fixtureJson('match-fuzzy-ursus-maritimuss') as Record<string, unknown>),
      confidence: 89,
    })

    const outcome = applyMatchPolicy(weak)

    expect(outcome.kind).toBe('low-confidence')
    if (outcome.kind !== 'low-confidence') return
    expect(outcome.confidence).toBe(89)
  })

  it('returns the ACCEPTED key for a synonym, never the synonym’s own key', () => {
    // research F5: using usageKey here silently under-counts every downstream
    // occurrence query, and nothing in the response looks wrong when it does.
    const parsed = match('match-synonym-felis-concolor')
    expect(parsed.usageKey).toBe(2435104)
    expect(parsed.acceptedUsageKey).toBe(2435099)

    const outcome = applyMatchPolicy(parsed)

    expect(outcome.kind).toBe('resolved')
    if (outcome.kind !== 'resolved') return
    expect(outcome.taxon.taxonKey).toBe(2435099)
    expect(outcome.taxon.wasSynonym).toBe(true)
    expect(outcome.taxon.matchedName).toBe('Felis concolor')
    expect(outcome.taxon.scientificName).toBe('Puma concolor')
  })

  it('falls through to unresolved on an unrecognised match type rather than throwing', () => {
    const odd = GbifNameMatchSchema.parse({ matchType: 'SOMETHING_NEW', confidence: 99 })

    expect(() => applyMatchPolicy(odd)).not.toThrow()
    expect(applyMatchPolicy(odd).kind).not.toBe('resolved')
  })
})
