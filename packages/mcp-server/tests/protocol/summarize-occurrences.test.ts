/**
 * `summarize_occurrences` over a real MCP client (SC-002, SC-003, FR-013 – FR-018).
 *
 * This is the capability the whole server exists for, and the assertions here
 * are about *cost* as much as correctness:
 *
 *   - one upstream request per call, however many dimensions were asked for;
 *   - zero individual records in the response, structurally;
 *   - the same response bounds for a species with 11 thousand records as for
 *     one with 25 million.
 *
 * A summary that returned the right numbers by paging through records would
 * pass a naive correctness test and still defeat the point (Principle II).
 */
import { describe, expect, it } from 'vitest'
import { createHarness, type Harness, resultText } from '../helpers/mcp-harness.js'

const URSUS = 2433451 // 11,141 records
const COMMON = 5231190 // 25,836,492 records

interface CallResult {
  isError?: boolean
  content?: unknown
  structuredContent?: {
    totalCount?: number
    taxon?: { taxonKey?: number }
    dimensions?: Array<{
      dimension: string
      counts: Array<{ value: string; count: number }>
      truncated: boolean
      distinctValuesReturned: number
    }>
    [key: string]: unknown
  }
}

async function summarize(harness: Harness, args: Record<string, unknown>): Promise<CallResult> {
  return (await harness.client.callTool({
    name: 'summarize_occurrences',
    arguments: args,
  })) as CallResult
}

describe('summarize_occurrences — context economy', () => {
  it('answers a three-dimension question with exactly one upstream request', async () => {
    const harness = await createHarness()
    try {
      const result = await summarize(harness, {
        taxonKey: URSUS,
        dimensions: ['country', 'year', 'basisOfRecord'],
      })

      expect(result.isError).toBeFalsy()
      // Multiple facets ride on the same request; N dimensions must not mean
      // N calls (research F6).
      expect(harness.upstream.count).toBe(1)
      expect(result.structuredContent?.dimensions).toHaveLength(3)
    } finally {
      await harness.close()
    }
  })

  it('transports no records at all — the output schema has no field for them', async () => {
    const harness = await createHarness()
    try {
      const result = await summarize(harness, { taxonKey: URSUS, dimensions: ['country'] })

      expect(result.structuredContent).not.toHaveProperty('records')
      expect(result.structuredContent?.totalCount).toBe(11141)
      // The guarantee is structural, not a convention someone has to remember.
      expect(JSON.stringify(result.structuredContent)).not.toContain('"records"')
    } finally {
      await harness.close()
    }
  })

  it('returns the same bounded response for 25 million records as for 11 thousand', async () => {
    const harness = await createHarness()
    try {
      const dimensions = ['country', 'year', 'basisOfRecord']
      const rare = await summarize(harness, { taxonKey: URSUS, dimensions })
      const common = await summarize(harness, { taxonKey: COMMON, dimensions })

      expect(rare.structuredContent?.totalCount).toBe(11141)
      expect(common.structuredContent?.totalCount).toBe(25836492)

      // Three orders of magnitude more data upstream, same size answer.
      const sizeOf = (r: CallResult) => JSON.stringify(r.structuredContent).length
      const ratio = sizeOf(common) / sizeOf(rare)
      expect(ratio).toBeGreaterThan(0.5)
      expect(ratio).toBeLessThan(2)

      for (const dimension of common.structuredContent?.dimensions ?? []) {
        expect(dimension.counts.length).toBeLessThanOrEqual(20)
      }
    } finally {
      await harness.close()
    }
  })

  it('caps a ranking at topN and states plainly that a tail was hidden', async () => {
    const harness = await createHarness()
    try {
      const result = await summarize(harness, {
        taxonKey: URSUS,
        dimensions: ['country'],
        topN: 3,
      })

      const country = result.structuredContent?.dimensions?.[0]
      expect(country?.counts).toHaveLength(3)
      expect(country?.truncated).toBe(true)
      expect(country?.distinctValuesReturned).toBe(3)
      expect(resultText(result).toLowerCase()).toContain('more')
    } finally {
      await harness.close()
    }
  })

  it('leads its text with the total, so the scale is visible without parsing', async () => {
    const harness = await createHarness()
    try {
      const result = await summarize(harness, { taxonKey: URSUS, dimensions: ['country'] })

      const text = resultText(result)
      expect(text).toContain('11,141')
      expect(text).toContain('CA')
    } finally {
      await harness.close()
    }
  })
})

describe('summarize_occurrences — zero matches is a success', () => {
  it('reports totalCount 0 as a result, not an error', async () => {
    const harness = await createHarness()
    try {
      // A polar bear in Antarctica: a perfectly valid question with no records.
      const result = await summarize(harness, {
        taxonKey: URSUS,
        dimensions: ['country'],
        country: 'AQ',
      })

      expect(result.isError).toBeFalsy()
      expect(result.structuredContent?.totalCount).toBe(0)
      expect(result.structuredContent?.dimensions?.[0]?.counts).toEqual([])
      expect(resultText(result).toLowerCase()).toContain('no records')
    } finally {
      await harness.close()
    }
  })
})

describe('summarize_occurrences — inputs', () => {
  it('accepts a name and resolves it, reporting which taxon it used', async () => {
    const harness = await createHarness()
    try {
      const result = await summarize(harness, {
        name: 'Ursus maritimus',
        dimensions: ['country'],
      })

      expect(result.isError).toBeFalsy()
      expect(result.structuredContent?.taxon?.taxonKey).toBe(URSUS)
    } finally {
      await harness.close()
    }
  })

  it('rejects a call with neither taxonKey nor name, before any request', async () => {
    const harness = await createHarness()
    try {
      const result = await summarize(harness, { dimensions: ['country'] })

      expect(result.isError).toBe(true)
      expect(harness.upstream.count).toBe(0)
      expect(resultText(result).toLowerCase()).toContain('taxonkey')
    } finally {
      await harness.close()
    }
  })

  it('rejects an empty dimensions list, naming the ones it accepts', async () => {
    const harness = await createHarness()
    try {
      const result = await summarize(harness, { taxonKey: URSUS, dimensions: [] })

      expect(result.isError).toBe(true)
      const text = resultText(result)
      expect(text).toContain('country')
      expect(text).toContain('basisOfRecord')
      expect(harness.upstream.count).toBe(0)
    } finally {
      await harness.close()
    }
  })

  it('rejects a backwards year range before any request', async () => {
    const harness = await createHarness()
    try {
      const result = await summarize(harness, {
        taxonKey: URSUS,
        dimensions: ['country'],
        yearFrom: 2010,
        yearTo: 2000,
      })

      expect(result.isError).toBe(true)
      expect(resultText(result)).toContain('2010')
      expect(harness.upstream.count).toBe(0)
    } finally {
      await harness.close()
    }
  })

  it('rejects a country code that is not ISO 3166-1 alpha-2', async () => {
    const harness = await createHarness()
    try {
      const result = await summarize(harness, {
        taxonKey: URSUS,
        dimensions: ['country'],
        country: 'USA',
      })

      expect(result.isError).toBe(true)
      expect(resultText(result)).toContain('USA')
      expect(harness.upstream.count).toBe(0)
    } finally {
      await harness.close()
    }
  })
})

describe('summarize_occurrences — contradictory taxon inputs (FR-028)', () => {
  it('refuses when both taxonKey and name are supplied, naming both values', async () => {
    const harness = await createHarness()
    try {
      const result = (await harness.client.callTool({
        name: 'summarize_occurrences',
        arguments: { taxonKey: 2433451, name: 'Puma concolor', dimensions: ['country'] },
      })) as { isError?: boolean; content?: unknown }

      expect(result.isError).toBe(true)

      const text = resultText(result)
      expect(text).toContain('2433451')
      expect(text).toContain('Puma concolor')
      expect(harness.upstream.count).toBe(0)
    } finally {
      await harness.close()
    }
  })
})
