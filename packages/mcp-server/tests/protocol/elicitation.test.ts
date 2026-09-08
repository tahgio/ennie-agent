/**
 * Asking the person which taxon was meant, over the real protocol (FR-005).
 *
 * These run through the same client/server pair as the rest of the protocol
 * suite, so `elicitation/create` genuinely crosses a transport and the
 * capability negotiation is the SDK's own rather than a flag we set on
 * ourselves. That is the only way to check the property that matters most
 * here: a client that cannot elicit must be *unable to tell* that the server
 * gained the ability to ask.
 */
import { describe, expect, it } from 'vitest'
import { createHarness, type Harness, resultText } from '../helpers/mcp-harness.js'

/** *Prunella* is a bird (Animalia) and a mint (Plantae). GBIF ties them at 99. */
const PRUNELLA_PLANTAE_KEY = 2926553
const PRUNELLA_ANIMALIA_KEY = 2495070

interface CallResult {
  isError?: boolean
  content?: unknown
  structuredContent?: { taxonKey?: number; scientificName?: string }
}

async function resolve(harness: Harness, name: string): Promise<CallResult> {
  return (await harness.client.callTool({
    name: 'resolve_taxon',
    arguments: { name },
  })) as CallResult
}

describe('a client that can be asked', () => {
  it('resolves an ambiguous name to the taxon the person chose', async () => {
    const harness = await createHarness({
      // Pick the plant. The value has to be one the server offered, which is
      // exactly the constraint being relied on.
      elicit: () => ({ action: 'accept', content: { taxonKey: String(PRUNELLA_PLANTAE_KEY) } }),
    })
    try {
      const result = await resolve(harness, 'Prunella')

      expect(result.isError).not.toBe(true)
      expect(result.structuredContent?.taxonKey).toBe(PRUNELLA_PLANTAE_KEY)
      expect(harness.elicitations).toHaveLength(1)
    } finally {
      await harness.close()
    }
  })

  it('offers every competing taxon, labelled by the kingdom that separates them', async () => {
    const harness = await createHarness({
      elicit: () => ({ action: 'accept', content: { taxonKey: String(PRUNELLA_PLANTAE_KEY) } }),
    })
    try {
      await resolve(harness, 'Prunella')

      const asked = harness.elicitations[0]
      expect(asked?.message).toContain('Prunella')

      const schema = (asked as { requestedSchema?: { properties?: Record<string, unknown> } })
        ?.requestedSchema
      const choices = (
        schema?.properties?.['taxonKey'] as { oneOf?: Array<{ const: string; title: string }> }
      )?.oneOf

      expect(choices?.map((choice) => choice.const).sort()).toEqual(
        [String(PRUNELLA_PLANTAE_KEY), String(PRUNELLA_ANIMALIA_KEY)].sort(),
      )
      // A person cannot choose between two taxon keys; the kingdom is the
      // thing that makes the question answerable.
      expect(choices?.map((choice) => choice.title).join(' ')).toContain('Plantae')
      expect(choices?.map((choice) => choice.title).join(' ')).toContain('Animalia')
    } finally {
      await harness.close()
    }
  })

  it('accepts only a taxon it offered', async () => {
    const harness = await createHarness({
      // A key that exists in GBIF but was never on the list. The server must
      // not follow it, or an untrusted client could steer resolution.
      elicit: () => ({ action: 'accept', content: { taxonKey: '2435098' } }),
    })
    try {
      const result = await resolve(harness, 'Prunella')

      expect(result.isError).toBe(true)
      expect(resultText(result)).toMatch(/matches several taxa/i)
    } finally {
      await harness.close()
    }
  })

  it('falls back to the ambiguity error when the person declines', async () => {
    const harness = await createHarness({ elicit: () => ({ action: 'decline' }) })
    try {
      const result = await resolve(harness, 'Prunella')

      expect(result.isError).toBe(true)
      expect(resultText(result)).toMatch(/matches several taxa/i)
      // The advice still has to be actionable: declining leaves the model
      // exactly the recovery it would have had without elicitation.
      expect(resultText(result)).toMatch(/kingdom hint/i)
    } finally {
      await harness.close()
    }
  })

  it('asks again on a second call after a decline, rather than caching the refusal', async () => {
    let asked = 0
    const harness = await createHarness({
      elicit: () => {
        asked += 1
        return asked === 1
          ? { action: 'decline' }
          : { action: 'accept', content: { taxonKey: String(PRUNELLA_PLANTAE_KEY) } }
      },
    })
    try {
      const declined = await resolve(harness, 'Prunella')
      expect(declined.isError).toBe(true)

      // Declining once must not disable the question for the cache's whole
      // hour: the person may simply not have been ready to answer.
      const answered = await resolve(harness, 'Prunella')
      expect(answered.isError).not.toBe(true)
      expect(answered.structuredContent?.taxonKey).toBe(PRUNELLA_PLANTAE_KEY)
      expect(asked).toBe(2)
    } finally {
      await harness.close()
    }
  })

  it('does not remember one person’s choice as the meaning of the name', async () => {
    let asked = 0
    const harness = await createHarness({
      elicit: () => {
        asked += 1
        return { action: 'accept', content: { taxonKey: String(PRUNELLA_PLANTAE_KEY) } }
      },
    })
    try {
      await resolve(harness, 'Prunella')
      await resolve(harness, 'Prunella')

      // The cache key is the ambiguous name. Caching the answer would serve
      // the mint to the next person asking about the bird.
      expect(asked).toBe(2)
    } finally {
      await harness.close()
    }
  })
})

describe('a client that cannot be asked', () => {
  it('gets the ambiguity error, unchanged', async () => {
    const harness = await createHarness()
    try {
      const result = await resolve(harness, 'Prunella')

      expect(result.isError).toBe(true)
      expect(resultText(result)).toMatch(/matches several taxa/i)
      expect(harness.elicitations).toHaveLength(0)
    } finally {
      await harness.close()
    }
  })

  it('still resolves an unambiguous name without being asked anything', async () => {
    const harness = await createHarness({
      elicit: () => ({ action: 'accept', content: { taxonKey: '1' } }),
    })
    try {
      const result = await resolve(harness, 'Ursus maritimus')

      expect(result.isError).not.toBe(true)
      // Elicitation is for ambiguity only. A name that resolves must never
      // cost the person a question.
      expect(harness.elicitations).toHaveLength(0)
    } finally {
      await harness.close()
    }
  })
})
