/**
 * The shared occurrence filters (FR-016, FR-017, FR-020, FR-045).
 *
 * Everything here runs before any network call, which is what makes it worth
 * testing directly: these are the messages a model reads when it got the call
 * wrong, and the translation GBIF actually receives.
 *
 * Four of FR-045's untested behaviours live in this file — filter translation
 * for open-ended and single-value ranges, the paging-window boundary, and
 * country-code normalisation and rejection — plus the year bound, which is the
 * one behaviour here that was not merely untested but wrong.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  countrySchema,
  type FilterSet,
  FilterSetSchema,
  MAX_OFFSET_WINDOW,
  MIN_YEAR,
  maxYear,
  toGbifFilterParams,
  validateFilters,
  validatePaging,
} from '../../src/domain/filters.js'
import { ToolError } from '../../src/errors.js'

const filters = (partial: Partial<FilterSet> = {}): FilterSet => partial as FilterSet

describe('country code — normalisation and rejection', () => {
  it('accepts a lowercase code and canonicalises it for GBIF', () => {
    expect(countrySchema.parse('ca')).toBe('CA')
    expect(countrySchema.parse('  ca  ')).toBe('CA')
    expect(countrySchema.parse('Ca')).toBe('CA')
  })

  it('passes an already-canonical code through unchanged', () => {
    expect(countrySchema.parse('US')).toBe('US')
  })

  it('rejects a three-letter code, naming the value and the remedy', () => {
    const result = countrySchema.safeParse('USA')

    expect(result.success).toBe(false)
    const message = result.error?.issues[0]?.message ?? ''
    expect(message).toContain('USA')
    expect(message).toContain('ISO 3166-1')
  })

  it('rejects a single letter, a digit pair, and an empty string', () => {
    for (const bad of ['C', '12', '', 'C1']) {
      expect(countrySchema.safeParse(bad).success).toBe(false)
    }
  })
})

describe('the year bound is derived from the request, not from process start', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('accepts next calendar year and rejects the year after it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-15T00:00:00Z'))

    expect(FilterSetSchema.safeParse({ yearFrom: 2027 }).success).toBe(true)
    expect(FilterSetSchema.safeParse({ yearFrom: 2028 }).success).toBe(false)
  })

  it('accepts the new year immediately after the calendar turns, with no restart', () => {
    vi.useFakeTimers()

    // A server that started in December...
    vi.setSystemTime(new Date('2026-12-31T23:59:00Z'))
    expect(maxYear()).toBe(2027)
    expect(FilterSetSchema.safeParse({ yearFrom: 2028 }).success).toBe(false)

    // ...and is still running a minute later, in January. The bound must move
    // with the calendar; the module was evaluated in the old year.
    vi.setSystemTime(new Date('2027-01-01T00:01:00Z'))
    expect(maxYear()).toBe(2028)
    expect(FilterSetSchema.safeParse({ yearFrom: 2027 }).success).toBe(true)
    expect(FilterSetSchema.safeParse({ yearFrom: 2028 }).success).toBe(true)
  })

  it('never names a range that contains the value it just rejected (FR-017)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2027-01-01T00:01:00Z'))

    const rejected = 2029
    const result = FilterSetSchema.safeParse({ yearFrom: rejected })
    expect(result.success).toBe(false)

    const message = result.error?.issues[0]?.message ?? ''
    expect(message).toContain(String(rejected))

    // The range named in the message is the range actually applied.
    expect(message).toContain(String(maxYear()))
    expect(maxYear()).toBeLessThan(rejected)
  })

  it('still rejects a year before GBIF holds dated records', () => {
    const result = FilterSetSchema.safeParse({ yearFrom: MIN_YEAR - 1 })

    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message ?? '').toContain(String(MIN_YEAR))
  })

  it('rejects a non-integer year', () => {
    expect(FilterSetSchema.safeParse({ yearFrom: 2020.5 }).success).toBe(false)
  })
})

describe('year range — the cross-field rule', () => {
  it('rejects a backwards range, naming both bounds', () => {
    const error = (() => {
      try {
        validateFilters(filters({ yearFrom: 2010, yearTo: 2000 }))
        return null
      } catch (caught) {
        return caught as ToolError
      }
    })()

    expect(error).toBeInstanceOf(ToolError)
    expect(error?.code).toBe('INVALID_YEAR_RANGE')
    // Naming both is what lets the model fix the call without guessing which
    // bound was objected to.
    expect(error?.what).toContain('2010')
    expect(error?.what).toContain('2000')
    expect(error?.retryable).toBe(false)
  })

  it('accepts an equal pair, and either bound alone', () => {
    expect(() => validateFilters(filters({ yearFrom: 2010, yearTo: 2010 }))).not.toThrow()
    expect(() => validateFilters(filters({ yearFrom: 2010 }))).not.toThrow()
    expect(() => validateFilters(filters({ yearTo: 2010 }))).not.toThrow()
    expect(() => validateFilters(filters({}))).not.toThrow()
  })
})

describe('filter translation into GBIF query parameters', () => {
  const NOW = new Date('2026-06-15T00:00:00Z')

  it('sends a closed range as from,to', () => {
    const params = toGbifFilterParams(filters({ yearFrom: 2000, yearTo: 2010 }), NOW)

    expect(params.year).toBe('2000,2010')
  })

  it('collapses a single-value range to one year, not a degenerate pair', () => {
    const params = toGbifFilterParams(filters({ yearFrom: 2010, yearTo: 2010 }), NOW)

    expect(params.year).toBe('2010')
  })

  it('closes an open lower bound against MIN_YEAR', () => {
    const params = toGbifFilterParams(filters({ yearTo: 2010 }), NOW)

    expect(params.year).toBe(`${MIN_YEAR},2010`)
  })

  it('closes an open upper bound against the request-time maximum', () => {
    const params = toGbifFilterParams(filters({ yearFrom: 2000 }), NOW)

    // 2027, from the injected clock — not from whenever the module loaded.
    expect(params.year).toBe(`2000,${maxYear(NOW)}`)
  })

  it('omits the year parameter entirely when neither bound is given', () => {
    expect(toGbifFilterParams(filters({}), NOW).year).toBeUndefined()
  })

  it('passes country and hasCoordinate through, and omits what was not asked for', () => {
    const params = toGbifFilterParams(filters({ country: 'CA', hasCoordinate: true }), NOW)

    expect(params.country).toBe('CA')
    expect(params.hasCoordinate).toBe(true)
    expect(params.year).toBeUndefined()
  })

  it('keeps hasCoordinate: false, which is a real filter and not an absence', () => {
    const params = toGbifFilterParams(filters({ hasCoordinate: false }), NOW)

    expect(params.hasCoordinate).toBe(false)
  })
})

describe('the paging window boundary', () => {
  it('accepts a request that lands exactly on the window', () => {
    expect(() => validatePaging(50, MAX_OFFSET_WINDOW - 50)).not.toThrow()
  })

  it('rejects the first request one record past it', () => {
    const error = (() => {
      try {
        validatePaging(50, MAX_OFFSET_WINDOW - 49)
        return null
      } catch (caught) {
        return caught as ToolError
      }
    })()

    expect(error?.code).toBe('OFFSET_EXCEEDED')
    // The remedy is usually to stop paging altogether, so the message says so.
    expect(error?.next).toContain('summarize_occurrences')
    expect(error?.retryable).toBe(false)
  })

  it('accepts an ordinary first page', () => {
    expect(() => validatePaging(20, 0)).not.toThrow()
  })
})
