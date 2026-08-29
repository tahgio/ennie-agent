/**
 * `search_occurrences` over a real MCP client (FR-006 – FR-012, SC-004).
 *
 * The cap tests are the important ones. GBIF accepts `limit=500`, returns HTTP
 * 200, and silently gives you 300 records (research F7) — so a cap that is only
 * documented, or only delegated upstream, does not exist. It has to be enforced
 * here, loudly, before the request is built.
 */
import { describe, expect, it } from 'vitest'
import { createHarness, type Harness, resultText } from '../helpers/mcp-harness.js'

const URSUS = 2433451

interface CallResult {
  isError?: boolean
  content?: unknown
  structuredContent?: {
    totalCount?: number
    offset?: number
    limit?: number
    returnedCount?: number
    records?: Array<Record<string, unknown>>
    [key: string]: unknown
  }
}

async function search(harness: Harness, args: Record<string, unknown>): Promise<CallResult> {
  return (await harness.client.callTool({
    name: 'search_occurrences',
    arguments: args,
  })) as CallResult
}

describe('search_occurrences — bounded pages', () => {
  it('returns trimmed records alongside the total that was not sent', async () => {
    const harness = await createHarness()
    try {
      const result = await search(harness, { taxonKey: URSUS, limit: 5, offset: 0 })

      expect(result.isError).toBeFalsy()
      // FR-010: the caller must be able to see the size of what it did not get.
      expect(result.structuredContent?.totalCount).toBe(11141)
      expect(result.structuredContent?.returnedCount).toBe(5)
      expect(result.structuredContent?.offset).toBe(0)
      expect(result.structuredContent?.limit).toBe(5)
      expect(result.structuredContent?.records).toHaveLength(5)

      const record = result.structuredContent?.records?.[0]
      expect(Object.keys(record ?? {})).toHaveLength(9)
      expect(record?.countryCode).toBe('US')
    } finally {
      await harness.close()
    }
  })

  it('leads its text with the total, then what it actually returned', async () => {
    const harness = await createHarness()
    try {
      const result = await search(harness, { taxonKey: URSUS, limit: 5, offset: 0 })

      const text = resultText(result)
      expect(text).toContain('11,141')
      expect(text).toContain('5')
    } finally {
      await harness.close()
    }
  })

  it('applies the four filters together', async () => {
    const harness = await createHarness()
    try {
      const result = await search(harness, {
        taxonKey: URSUS,
        country: 'CA',
        yearFrom: 2000,
        yearTo: 2020,
        hasCoordinate: true,
        limit: 5,
        offset: 0,
      })

      expect(result.isError).toBeFalsy()
      expect(result.structuredContent?.totalCount).toBe(1023)
    } finally {
      await harness.close()
    }
  })
})

describe('search_occurrences — the cap is ours to enforce', () => {
  it('rejects limit 51 instead of silently clamping it', async () => {
    const harness = await createHarness()
    try {
      const result = await search(harness, { taxonKey: URSUS, limit: 51 })

      expect(result.isError).toBe(true)
      const text = resultText(result)
      expect(text).toContain('50')
      // GBIF would have accepted this and returned a different page size
      // without saying so, so nothing may reach it.
      expect(harness.upstream.count).toBe(0)
    } finally {
      await harness.close()
    }
  })

  it('rejects limit 500 — the exact value GBIF answers 200 to, with 300 records', async () => {
    const harness = await createHarness()
    try {
      const result = await search(harness, { taxonKey: URSUS, limit: 500 })

      expect(result.isError).toBe(true)
      expect(resultText(result)).toContain('500')
      expect(harness.upstream.count).toBe(0)
    } finally {
      await harness.close()
    }
  })

  it('points at summarize_occurrences when a caller asks for too many records', async () => {
    const harness = await createHarness()
    try {
      const result = await search(harness, { taxonKey: URSUS, limit: 500 })

      // FR-024: the remedy, not just the complaint.
      expect(resultText(result)).toContain('summarize_occurrences')
    } finally {
      await harness.close()
    }
  })
})

describe('search_occurrences — input rejected before any network call', () => {
  it('rejects an offset past GBIF’s 100,000-record window', async () => {
    const harness = await createHarness()
    try {
      const result = await search(harness, { taxonKey: URSUS, limit: 1, offset: 100001 })

      expect(result.isError).toBe(true)
      const text = resultText(result)
      expect(text).toContain('100,000')
      expect(harness.upstream.count).toBe(0)
    } finally {
      await harness.close()
    }
  })

  it('rejects a backwards year range, naming both bounds', async () => {
    const harness = await createHarness()
    try {
      const result = await search(harness, { taxonKey: URSUS, yearFrom: 2010, yearTo: 2000 })

      expect(result.isError).toBe(true)
      const text = resultText(result)
      expect(text).toContain('2010')
      expect(text).toContain('2000')
      expect(harness.upstream.count).toBe(0)
    } finally {
      await harness.close()
    }
  })

  it('rejects a three-letter country code, suggesting the two-letter form', async () => {
    const harness = await createHarness()
    try {
      const result = await search(harness, { taxonKey: URSUS, country: 'USA' })

      expect(result.isError).toBe(true)
      const text = resultText(result)
      expect(text).toContain('USA')
      expect(text.toLowerCase()).toContain('iso 3166')
      expect(harness.upstream.count).toBe(0)
    } finally {
      await harness.close()
    }
  })

  it('rejects a call with neither taxonKey nor name', async () => {
    const harness = await createHarness()
    try {
      const result = await search(harness, { limit: 5 })

      expect(result.isError).toBe(true)
      expect(harness.upstream.count).toBe(0)
    } finally {
      await harness.close()
    }
  })
})

describe('search_occurrences — composition', () => {
  it('accepts a name and resolves it with the same policy as resolve_taxon', async () => {
    const harness = await createHarness()
    try {
      const result = await search(harness, { name: 'Ursus maritimus', limit: 5, offset: 0 })

      expect(result.isError).toBeFalsy()
      expect(result.structuredContent?.totalCount).toBe(11141)
    } finally {
      await harness.close()
    }
  })

  it('reports a resolution failure with the same actionable text', async () => {
    const harness = await createHarness()
    try {
      const result = await search(harness, { name: 'Prunella', limit: 5 })

      expect(result.isError).toBe(true)
      expect(resultText(result)).toContain('Plantae')
    } finally {
      await harness.close()
    }
  })

  it('returns a countryCode that is valid as its own country filter', async () => {
    const harness = await createHarness()
    try {
      const page = await search(harness, { taxonKey: URSUS, limit: 5, offset: 0 })
      const code = page.structuredContent?.records?.[0]?.countryCode

      expect(typeof code).toBe('string')
      expect(code).toMatch(/^[A-Z]{2}$/)
    } finally {
      await harness.close()
    }
  })
})
