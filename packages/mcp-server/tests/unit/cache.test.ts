/**
 * The remembered-resolution store (FR-012 – FR-015, FR-020, FR-045).
 *
 * Three behaviours the review found untested, and one new one:
 *
 *   - **Key normalisation.** Whitespace and case must collapse to one entry,
 *     while a rank or kingdom hint must *not* — "Prunella" is ambiguous and
 *     "Prunella" with `kingdom=Plantae` resolves, and the two outcomes sharing
 *     a slot would be a wrong answer rather than a slow one.
 *   - **Expiry**, driven by the injected clock rather than by sleeping.
 *   - **Hit/miss statistics**, which every tool log entry reports.
 *   - **The ceiling**, which is new: the store grew without bound for as long
 *     as distinct names kept arriving.
 */
import { describe, expect, it } from 'vitest'
import type { ToolErrorFields } from '../../src/errors.js'
import { cacheKey, DEFAULT_TTL_MS, TtlCache } from '../../src/gbif/cache.js'

/** A stand-in for a resolved taxon; the cache is generic and never inspects it. */
const taxon = (key: number) => ({ taxonKey: key })

const failure: ToolErrorFields = {
  code: 'NOT_FOUND',
  what: "No taxon matches 'Zzzzqqq xxxxyy'.",
  next: 'Check the spelling.',
  retryable: false,
}

describe('cacheKey — normalisation', () => {
  it('collapses case and surrounding whitespace to one key', () => {
    const canonical = cacheKey({ name: 'Ursus maritimus' })

    expect(cacheKey({ name: '  ursus maritimus  ' })).toBe(canonical)
    expect(cacheKey({ name: 'URSUS MARITIMUS' })).toBe(canonical)
    expect(cacheKey({ name: 'UrSuS mAriTimUs' })).toBe(canonical)
  })

  it('collapses runs of internal whitespace', () => {
    expect(cacheKey({ name: 'Ursus    maritimus' })).toBe(cacheKey({ name: 'Ursus maritimus' }))
    expect(cacheKey({ name: 'Ursus\tmaritimus' })).toBe(cacheKey({ name: 'Ursus maritimus' }))
  })

  it('keeps a rank hint in the key, because it changes the answer', () => {
    expect(cacheKey({ name: 'Prunella', rank: 'GENUS' })).not.toBe(cacheKey({ name: 'Prunella' }))
  })

  it('keeps a kingdom hint in the key, because it changes the answer', () => {
    expect(cacheKey({ name: 'Prunella', kingdom: 'Plantae' })).not.toBe(
      cacheKey({ name: 'Prunella' }),
    )
    // The hint itself is normalised, so a differently-cased hint is one entry.
    expect(cacheKey({ name: 'Prunella', kingdom: 'plantae' })).toBe(
      cacheKey({ name: 'Prunella', kingdom: 'Plantae' }),
    )
    expect(cacheKey({ name: 'Prunella', rank: 'genus' })).toBe(
      cacheKey({ name: 'Prunella', rank: 'GENUS' }),
    )
  })

  it('does not let two different hints collide', () => {
    expect(cacheKey({ name: 'Prunella', kingdom: 'Plantae' })).not.toBe(
      cacheKey({ name: 'Prunella', kingdom: 'Animalia' }),
    )
  })
})

describe('TtlCache — expiry, on the injected clock', () => {
  it('returns a value inside the window and nothing after it', () => {
    let now = 1_000
    const cache = new TtlCache<{ taxonKey: number }>({ now: () => now })

    cache.setValue('a', taxon(1))
    expect(cache.get('a')).toEqual({ ok: true, value: { taxonKey: 1 } })

    now += DEFAULT_TTL_MS - 1
    expect(cache.get('a')).toEqual({ ok: true, value: { taxonKey: 1 } })

    // The boundary is exclusive: expiresAt <= now is expired.
    now += 1
    expect(cache.get('a')).toBeUndefined()
  })

  it('evicts the expired entry rather than leaving it to be re-read', () => {
    let now = 0
    const cache = new TtlCache<{ taxonKey: number }>({ ttlMs: 10, now: () => now })

    cache.setValue('a', taxon(1))
    expect(cache.size).toBe(1)

    now = 11
    expect(cache.get('a')).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it('preserves a failure whole, including the text a repeat is answered with', () => {
    const cache = new TtlCache<{ taxonKey: number }>()

    cache.setNegative('a', failure)

    expect(cache.get('a')).toEqual({ ok: false, error: failure })
  })
})

describe('TtlCache — hit and miss statistics', () => {
  it('counts a hit, a miss, and an expiry as a miss', () => {
    let now = 0
    const cache = new TtlCache<{ taxonKey: number }>({ ttlMs: 10, now: () => now })

    cache.setValue('a', taxon(1))

    cache.get('a') // hit
    cache.get('b') // miss — never recorded
    now = 11
    cache.get('a') // miss — expired

    expect(cache.stats).toEqual({ hits: 1, misses: 2 })
  })

  it('resets the counters on clear', () => {
    const cache = new TtlCache<{ taxonKey: number }>()

    cache.setValue('a', taxon(1))
    cache.get('a')
    cache.get('b')
    cache.clear()

    expect(cache.stats).toEqual({ hits: 0, misses: 0 })
    expect(cache.size).toBe(0)
  })
})

describe('TtlCache — the ceiling (FR-020)', () => {
  it('stops at the ceiling and discards the entry recorded longest ago', () => {
    const cache = new TtlCache<{ taxonKey: number }>({ maxEntries: 2 })

    cache.setValue('first', taxon(1))
    cache.setValue('second', taxon(2))
    cache.setValue('third', taxon(3))

    expect(cache.size).toBe(2)
    // The first one recorded is the one gone.
    expect(cache.get('first')).toBeUndefined()
    expect(cache.get('second')).toEqual({ ok: true, value: { taxonKey: 2 } })
    expect(cache.get('third')).toEqual({ ok: true, value: { taxonKey: 3 } })
  })

  it('moves a re-recorded key to the back instead of evicting a neighbour', () => {
    const cache = new TtlCache<{ taxonKey: number }>({ maxEntries: 2 })

    cache.setValue('first', taxon(1))
    cache.setValue('second', taxon(2))

    // Refreshing an existing key must not grow the store or evict anything.
    cache.setValue('first', taxon(11))
    expect(cache.size).toBe(2)
    expect(cache.get('second')).toEqual({ ok: true, value: { taxonKey: 2 } })

    // 'first' is now the most recently recorded, so 'second' is next out.
    cache.setValue('third', taxon(3))
    expect(cache.size).toBe(2)
    expect(cache.get('second')).toBeUndefined()
    expect(cache.get('first')).toEqual({ ok: true, value: { taxonKey: 11 } })
    expect(cache.get('third')).toEqual({ ok: true, value: { taxonKey: 3 } })
  })

  it('is insertion-order, not least-recently-used — reading does not protect a key', () => {
    const cache = new TtlCache<{ taxonKey: number }>({ maxEntries: 2 })

    cache.setValue('first', taxon(1))
    cache.setValue('second', taxon(2))

    // Read 'first' repeatedly. Under true LRU this would save it; under the
    // documented insertion-order rule it does not, and that is deliberate
    // (research D3) — the cost is one extra upstream lookup, never a wrong
    // answer.
    cache.get('first')
    cache.get('first')

    cache.setValue('third', taxon(3))

    expect(cache.get('first')).toBeUndefined()
  })

  it('stays at the ceiling under far more distinct keys than it holds (SC-003)', () => {
    const cache = new TtlCache<{ taxonKey: number }>({ maxEntries: 10 })

    // Ten times the ceiling, the shape of the run SC-003 describes.
    for (let i = 0; i < 100; i += 1) {
      cache.setValue(`name-${i}`, taxon(i))
      expect(cache.size).toBeLessThanOrEqual(10)
    }

    expect(cache.size).toBe(10)
    // The survivors are the last ten recorded.
    expect(cache.get('name-99')).toEqual({ ok: true, value: { taxonKey: 99 } })
    expect(cache.get('name-89')).toBeUndefined()
  })

  it('treats an evicted key as an ordinary miss, so it resolves again (FR-014)', () => {
    const cache = new TtlCache<{ taxonKey: number }>({ maxEntries: 1 })

    cache.setValue('first', taxon(1))
    cache.setValue('second', taxon(2))

    expect(cache.get('first')).toBeUndefined()

    // Nothing special is needed to recover: recording it again just works.
    cache.setValue('first', taxon(1))
    expect(cache.get('first')).toEqual({ ok: true, value: { taxonKey: 1 } })
  })

  it('applies the ceiling to remembered failures too', () => {
    const cache = new TtlCache<{ taxonKey: number }>({ maxEntries: 2 })

    cache.setNegative('a', failure)
    cache.setNegative('b', failure)
    cache.setNegative('c', failure)

    expect(cache.size).toBe(2)
    expect(cache.get('a')).toBeUndefined()
  })
})
