/**
 * Opt-in: does GBIF still behave the way the fixtures say it does? (FR-040, T083)
 *
 * ```
 * pnpm test:live      # hits api.gbif.org — never runs in CI
 * ```
 *
 * The offline suite is fast, deterministic, and completely wrong the day GBIF
 * changes its mind. This suite is the counterweight: it re-requests the paths
 * `scripts/capture-fixtures.ts` captured and checks that the *findings* the
 * design rests on still hold — the ones where doing the obvious thing produces
 * a wrong answer:
 *
 *   F1  a total non-match arrives as `NONE` at `confidence: 100`
 *   F2  a homonym is also `NONE`, with the candidates only in `alternatives[]`
 *   F3  `species/match` does not resolve common names at all
 *   F4  the vernacular search does not rank the intended species first
 *   F5  a synonym carries an `acceptedUsageKey` different from its own key
 *   F6  `limit=0` plus facets returns counts with an empty `results[]`
 *   F7  `limit=500` is accepted and silently capped — HTTP 200, not an error
 *   F8  a 400 comes back as plain text, not JSON
 *
 * What is deliberately **not** asserted: record counts, confidence values, and
 * ranking positions past the first. Those drift with every ingest, and a suite
 * that failed on drift would be muted within a month. Every assertion here is
 * about a *shape* which, if it changed, would silently break the server.
 *
 * A failure here is not a bug in this repository. It means GBIF moved, and the
 * fixtures — and probably the resolution policy — need revisiting.
 */
import { describe, expect, it } from 'vitest'
import { TRIMMED_FIELDS, trimRecord } from '../../src/domain/trim.js'
import { CallBudget, GbifClient } from '../../src/gbif/client.js'
import { facetSearch, mapFacetsToDimensions, pageSearch } from '../../src/gbif/occurrence.js'
import { matchName, searchVernacular } from '../../src/gbif/species.js'

const URSUS_MARITIMUS = 2433451

const client = new GbifClient()

/**
 * Run one upstream call with its own budget, releasing the timer afterwards.
 *
 * Every test gets a fresh budget: sharing one would let a slow first test eat
 * the allowance of the next, and produce a timeout that looks like an outage.
 */
async function withBudget<T>(fn: (call: { budget: CallBudget }) => Promise<T>): Promise<T> {
  const budget = new CallBudget()
  try {
    return await fn({ budget })
  } finally {
    budget.dispose()
  }
}

describe('species/match — the findings that shaped the resolution policy', () => {
  it('F1: reports a total non-match as NONE, at full confidence', async () => {
    const { data } = await withBudget((call) => matchName(client, { name: 'Zzzzqqq xxxxyy' }, call))

    // The trap: confidence alone says "certain". Only matchType says "no".
    expect(data.matchType).toBe('NONE')
    expect(data.usageKey ?? null).toBeNull()
  })

  it('F2: reports a homonym as NONE, with the candidates only in alternatives', async () => {
    const { data } = await withBudget((call) => matchName(client, { name: 'Prunella' }, call))

    expect(data.matchType).toBe('NONE')

    // Both kingdoms must stay reachable, or the AMBIGUOUS error loses the very
    // list that makes it actionable (FR-005).
    const kingdoms = new Set(
      (data.alternatives ?? []).map((alternative) => alternative.kingdom).filter(Boolean),
    )
    expect(kingdoms).toContain('Plantae')
    expect(kingdoms).toContain('Animalia')
  })

  it('F2: resolves the same name cleanly once a kingdom hint breaks the tie', async () => {
    const { data } = await withBudget((call) =>
      matchName(client, { name: 'Prunella', kingdom: 'Plantae' }, call),
    )

    expect(data.matchType).not.toBe('NONE')
    expect(data.kingdom).toBe('Plantae')
    expect(typeof data.usageKey).toBe('number')
  })

  it('FR-004a: reaches only the genus for an invented species', async () => {
    const { data } = await withBudget((call) =>
      matchName(client, { name: 'Puma notarealspecies' }, call),
    )

    // HIGHERRANK is not an answer to a species question, and the rank is the
    // only field that distinguishes it from one.
    expect(data.rank).not.toBe('SPECIES')
    expect(data.genus).toBe('Puma')
  })

  it('F5: returns an acceptedUsageKey for a synonym that differs from its own key', async () => {
    const { data } = await withBudget((call) => matchName(client, { name: 'Felis concolor' }, call))

    // The synonym marker is `status`, not a boolean flag — there is no
    // `synonym: true` field to lean on.
    expect(data.status).toBe('SYNONYM')
    expect(typeof data.acceptedUsageKey).toBe('number')
    // Taking usageKey here is the silent under-count this finding exists to
    // prevent: the synonym's own key carries a fraction of the records.
    expect(data.acceptedUsageKey).not.toBe(data.usageKey)
  })

  it('F3: does not resolve a common name at all', async () => {
    const { data } = await withBudget((call) => matchName(client, { name: 'polar bear' }, call))

    // If this ever starts working, the vernacular fallback becomes an
    // optimisation rather than a correctness requirement.
    expect(data.matchType).toBe('NONE')
  })
})

describe('species/search — the vernacular fallback', () => {
  it('F4: does not simply rank the intended species first', async () => {
    const { data } = await withBudget((call) => searchVernacular(client, 'polar bear', call))

    expect(data.results.length).toBeGreaterThan(0)
    expect(
      data.results.some((result) => result.canonicalName === 'Ursus maritimus'),
      'Ursus maritimus should appear somewhere in the vernacular results',
    ).toBe(true)

    // The finding is that rank order cannot be trusted — either an unrelated
    // taxon leads, or backbone-less entries are mixed in, or both. If neither
    // is true any more, the filtering policy deserves a fresh look.
    const firstIsWrong = data.results[0]?.canonicalName !== 'Ursus maritimus'
    const hasNullNubKey = data.results.some((result) => result.nubKey === null)
    expect(firstIsWrong || hasNullNubKey).toBe(true)
  })

  it('finds nothing usable for an invented name rather than guessing', async () => {
    const { data } = await withBudget((call) => searchVernacular(client, 'Zzzzqqq xxxxyy', call))

    expect(data.results.filter((result) => result.nubKey !== null)).toHaveLength(0)
  })
})

describe('occurrence/search — the aggregation the server is built on', () => {
  it('F6: returns facet counts with an empty results array at limit=0', async () => {
    const { data, upstreamRequests } = await withBudget((call) =>
      facetSearch(
        client,
        {
          taxonKey: URSUS_MARITIMUS,
          dimensions: ['country', 'year', 'basisOfRecord'],
          topN: 10,
          filters: {},
        },
        call,
      ),
    )

    // Three dimensions, one request, zero records. Principle II in mechanical
    // form — if GBIF ever started returning records here, the response bound
    // this server promises would quietly stop holding.
    expect(upstreamRequests).toBe(1)
    expect(data.results).toHaveLength(0)
    expect(data.count).toBeGreaterThan(0)

    const dimensions = mapFacetsToDimensions(data.facets, ['country', 'year', 'basisOfRecord'], 10)
    expect(dimensions).toHaveLength(3)

    const countries = dimensions.find((dimension) => dimension.dimension === 'country')
    // Counts drift constantly; the ranking order reflects where the species
    // lives and moves far more slowly.
    expect(countries?.counts[0]?.value).toBe('CA')
  })

  it('returns a real page of records, and a total that dwarfs it', async () => {
    const { data } = await withBudget((call) =>
      pageSearch(client, { taxonKey: URSUS_MARITIMUS, limit: 5, offset: 0, filters: {} }, call),
    )

    expect(data.results).toHaveLength(5)
    expect(data.count).toBeGreaterThan(data.results.length)

    // F10: the trim is not cosmetic. A live record still reduces to the agreed
    // field set, and `countryCode` (not the display name) is what survives.
    const raw = data.results[0]
    expect(raw).toBeDefined()
    if (raw !== undefined) {
      expect(Object.keys(raw).length).toBeGreaterThan(20)
      const trimmed = trimRecord(raw)
      expect(Object.keys(trimmed).sort()).toEqual([...TRIMMED_FIELDS].sort())
    }
  })
})

describe('the upstream behaviours the server defends against', () => {
  it('F7: accepts limit=500 and silently returns fewer, with HTTP 200', async () => {
    const response = await fetch(
      `https://api.gbif.org/v1/occurrence/search?taxonKey=${URSUS_MARITIMUS}&limit=500`,
      { headers: { Accept: 'application/json' } },
    )

    // No error, no warning — just quietly less than asked for. Which is why the
    // 50-record cap is enforced locally and never delegated upstream.
    expect(response.status).toBe(200)
    const body = (await response.json()) as { results: unknown[] }
    expect(body.results.length).toBeLessThan(500)
  })

  it('F8: returns a plain-text body on a 400, not JSON', async () => {
    const response = await fetch(
      `https://api.gbif.org/v1/occurrence/search?taxonKey=${URSUS_MARITIMUS}&year=notayear`,
      { headers: { Accept: 'application/json' } },
    )

    expect(response.status).toBe(400)

    const body = await response.text()
    expect(body.length).toBeGreaterThan(0)
    // Parsing this as JSON first — the obvious implementation — throws, and a
    // recoverable error becomes an unhandled exception.
    expect(() => JSON.parse(body) as unknown).toThrow()
  })

  it('SC-001: answers with no credential of any kind', async () => {
    const response = await fetch(`https://api.gbif.org/v1/species/${URSUS_MARITIMUS}`, {
      headers: { Accept: 'application/json' },
    })

    expect(response.status).toBe(200)
    expect(((await response.json()) as { canonicalName?: string }).canonicalName).toBe(
      'Ursus maritimus',
    )
  })
})
