/**
 * `resolve_taxon` over a real MCP client — every row of quickstart Scenario 4
 * (SC-005, FR-004, FR-004a, FR-005, FR-023, FR-024).
 *
 * The distinguishing assertion in this file is not "an error happened" but
 * "the failure arrived as a *result*". A thrown exception would surface as a
 * JSON-RPC error, which the model never sees and therefore cannot recover from;
 * `isError: true` with a what/next sentence lands in the conversation, where
 * the next turn can act on it (Constitution I, V).
 */
import { describe, expect, it } from 'vitest'
import { createHarness, type Harness, resultText } from '../helpers/mcp-harness.js'

interface CallResult {
  isError?: boolean
  content?: unknown
  structuredContent?: Record<string, unknown>
}

async function resolve(harness: Harness, args: Record<string, unknown>): Promise<CallResult> {
  return (await harness.client.callTool({ name: 'resolve_taxon', arguments: args })) as CallResult
}

describe('resolve_taxon — successful resolution', () => {
  it('resolves an exact scientific name to the accepted taxon', async () => {
    const harness = await createHarness()
    try {
      const result = await resolve(harness, { name: 'Ursus maritimus' })

      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toMatchObject({
        taxonKey: 2433451,
        scientificName: 'Ursus maritimus',
        rank: 'SPECIES',
        matchType: 'EXACT',
        wasSynonym: false,
      })
      // A text block accompanies the structured output for clients that do not
      // render it (FR-020).
      expect(resultText(result)).toContain('Ursus maritimus')
      expect(resultText(result)).toContain('2433451')
    } finally {
      await harness.close()
    }
  })

  it('resolves a misspelling through a fuzzy match', async () => {
    const harness = await createHarness()
    try {
      const result = await resolve(harness, { name: 'Ursus maritimuss' })

      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toMatchObject({ taxonKey: 2433451, matchType: 'FUZZY' })
    } finally {
      await harness.close()
    }
  })

  it('resolves a synonym to its accepted taxon, reporting both names', async () => {
    const harness = await createHarness()
    try {
      const result = await resolve(harness, { name: 'Felis concolor' })

      expect(result.isError).toBeFalsy()
      // 2435099 is Puma concolor; 2435104 is the synonym's own key and would
      // silently under-count every downstream query (research F5).
      expect(result.structuredContent).toMatchObject({
        taxonKey: 2435099,
        scientificName: 'Puma concolor',
        wasSynonym: true,
        matchedName: 'Felis concolor',
      })
    } finally {
      await harness.close()
    }
  })

  it('resolves a common name through the vernacular path', async () => {
    const harness = await createHarness()
    try {
      const result = await resolve(harness, { name: 'polar bear' })

      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toMatchObject({
        taxonKey: 2433451,
        scientificName: 'Ursus maritimus',
        matchType: 'VERNACULAR',
      })
    } finally {
      await harness.close()
    }
  })

  it('resolves a homonym once a kingdom hint is supplied', async () => {
    const harness = await createHarness()
    try {
      const result = await resolve(harness, { name: 'Prunella', kingdom: 'Plantae' })

      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toMatchObject({ taxonKey: 2926553 })
    } finally {
      await harness.close()
    }
  })
})

describe('resolve_taxon — recoverable errors', () => {
  it('reports a name it cannot match, despite GBIF scoring it 100', async () => {
    const harness = await createHarness()
    try {
      const result = await resolve(harness, { name: 'Zzzzqqq xxxxyy' })

      expect(result.isError).toBe(true)
      const text = resultText(result)
      expect(text).toContain('Zzzzqqq xxxxyy')
      expect(text.toLowerCase()).toContain('spelling')
      // No taxon may be fabricated on a failed lookup.
      expect(result.structuredContent).toBeUndefined()
    } finally {
      await harness.close()
    }
  })

  it('lists the competing candidates for a cross-kingdom homonym', async () => {
    const harness = await createHarness()
    try {
      const result = await resolve(harness, { name: 'Prunella' })

      expect(result.isError).toBe(true)
      const text = resultText(result)
      // FR-005: naming the candidates is what makes the error recoverable —
      // the caller can pick one without another round trip.
      expect(text).toContain('Plantae')
      expect(text).toContain('Animalia')
      expect(text).toContain('2926553')
      expect(text).toContain('2495070')
      expect(text.toLowerCase()).toContain('kingdom')
    } finally {
      await harness.close()
    }
  })

  it('refuses to answer a species question with a genus', async () => {
    const harness = await createHarness()
    try {
      const result = await resolve(harness, { name: 'Puma notarealspecies' })

      expect(result.isError).toBe(true)
      const text = resultText(result)
      expect(text).toContain('Puma')
      expect(text).toContain('2435098')
      expect(text.toLowerCase()).toContain('genus')
      expect(result.structuredContent).toBeUndefined()
    } finally {
      await harness.close()
    }
  })

  it('rejects an empty name before making any upstream request', async () => {
    const harness = await createHarness()
    try {
      const result = await resolve(harness, { name: '   ' })

      expect(result.isError).toBe(true)
      expect(harness.upstream.count).toBe(0)
    } finally {
      await harness.close()
    }
  })

  it('names what to do next on every failure, never just what went wrong', async () => {
    const harness = await createHarness()
    try {
      for (const name of ['Zzzzqqq xxxxyy', 'Prunella', 'Puma notarealspecies']) {
        const text = resultText(await resolve(harness, { name }))
        // FR-024: two sentences — the problem, and the remedy. A bare
        // "Invalid input" is the defect this asserts against.
        expect(text.length).toBeGreaterThan(40)
        expect(text).toMatch(/\.\s/)
      }
    } finally {
      await harness.close()
    }
  })
})

describe('resolve_taxon — caching', () => {
  it('serves a repeated resolution from cache instead of asking GBIF again', async () => {
    const harness = await createHarness()
    try {
      await resolve(harness, { name: 'Ursus maritimus' })
      const afterFirst = harness.upstream.count
      expect(afterFirst).toBeGreaterThan(0)

      await resolve(harness, { name: 'Ursus maritimus' })

      expect(harness.upstream.count).toBe(afterFirst)
    } finally {
      await harness.close()
    }
  })

  it('caches a negative outcome too — the same bad spelling gets asked twice', async () => {
    const harness = await createHarness()
    try {
      await resolve(harness, { name: 'Zzzzqqq xxxxyy' })
      const afterFirst = harness.upstream.count

      await resolve(harness, { name: 'Zzzzqqq xxxxyy' })

      expect(harness.upstream.count).toBe(afterFirst)
    } finally {
      await harness.close()
    }
  })

  it('keys the cache on the kingdom hint, so a hint still changes the answer', async () => {
    const harness = await createHarness()
    try {
      const ambiguous = await resolve(harness, { name: 'Prunella' })
      expect(ambiguous.isError).toBe(true)

      const hinted = await resolve(harness, { name: 'Prunella', kingdom: 'Plantae' })

      expect(hinted.isError).toBeFalsy()
      expect(hinted.structuredContent).toMatchObject({ taxonKey: 2926553 })
    } finally {
      await harness.close()
    }
  })
})
