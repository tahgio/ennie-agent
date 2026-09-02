/**
 * What a client sees before it has called anything (FR-019, FR-021, SC-006).
 *
 * A third-party client adopts this server on the strength of two responses:
 * the `initialize` result and `tools/list`. If a tool arrives without an output
 * schema, or with a description that omits its caps, the client's model has to
 * discover those limits by hitting them — which is exactly the trial-and-error
 * loop this server exists to prevent.
 *
 * So these assertions are about the *shape of the surface*, not about any
 * particular answer. They run over the same real client/server pair as the rest
 * of the protocol suite, so the schemas asserted here are the ones the SDK
 * actually serialises, not the Zod objects we wrote.
 */
import { describe, expect, it } from 'vitest'
import { TRIMMED_FIELDS } from '../../src/domain/trim.js'
import { createHarness } from '../helpers/mcp-harness.js'

/** The complete public surface. A fourth tool arriving unannounced fails here. */
const EXPECTED_TOOLS = ['resolve_taxon', 'summarize_occurrences', 'search_occurrences'] as const

/**
 * A JSON Schema object as it crosses the wire. The SDK types these loosely, so
 * the test narrows them itself rather than asserting against `unknown`.
 */
interface JsonSchema {
  type?: string
  properties?: Record<string, unknown>
  required?: string[]
  [key: string]: unknown
}

interface ListedTool {
  name: string
  description?: string
  inputSchema?: JsonSchema
  outputSchema?: JsonSchema
}

describe('tools/list — the discoverable surface', () => {
  it('returns exactly the three tools, and no others', async () => {
    const harness = await createHarness()
    try {
      const { tools } = (await harness.client.listTools()) as { tools: ListedTool[] }

      expect(tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOLS].sort())
    } finally {
      await harness.close()
    }
  })

  it('gives every tool a complete input and output schema', async () => {
    const harness = await createHarness()
    try {
      const { tools } = (await harness.client.listTools()) as { tools: ListedTool[] }

      for (const tool of tools) {
        // An input schema with no properties would accept anything, which is a
        // different failure from having no schema at all — check both.
        expect(tool.inputSchema, `${tool.name} input schema`).toBeDefined()
        expect(tool.inputSchema?.type, `${tool.name} input schema type`).toBe('object')
        expect(
          Object.keys(tool.inputSchema?.properties ?? {}).length,
          `${tool.name} input properties`,
        ).toBeGreaterThan(0)

        // The half that is easy to omit: without it a client gets text back and
        // has to parse prose to find a number (SC-006, plan D8).
        expect(tool.outputSchema, `${tool.name} output schema`).toBeDefined()
        expect(tool.outputSchema?.type, `${tool.name} output schema type`).toBe('object')
        expect(
          Object.keys(tool.outputSchema?.properties ?? {}).length,
          `${tool.name} output properties`,
        ).toBeGreaterThan(0)
      }
    } finally {
      await harness.close()
    }
  })

  it('describes every tool in prose long enough to choose between them', async () => {
    const harness = await createHarness()
    try {
      const { tools } = (await harness.client.listTools()) as { tools: ListedTool[] }

      for (const tool of tools) {
        expect(tool.description, `${tool.name} description`).toBeTruthy()
        // A one-line description cannot state a constraint and a steer both.
        expect((tool.description ?? '').length, `${tool.name} description length`).toBeGreaterThan(
          120,
        )
      }
    } finally {
      await harness.close()
    }
  })

  it('states each tool constraint in the description, not only in the schema', async () => {
    const harness = await createHarness()
    try {
      const { tools } = (await harness.client.listTools()) as { tools: ListedTool[] }
      const byName = new Map(tools.map((tool) => [tool.name, tool]))

      // A model reads the description; the schema is enforced after it has
      // already committed to a call. Both must carry the cap (FR-019).
      expect(byName.get('search_occurrences')?.description).toContain('50')
      expect(byName.get('search_occurrences')?.description).toContain('summarize_occurrences')

      // The steer that keeps a distribution question off the paging path.
      expect(byName.get('summarize_occurrences')?.description).toMatch(/how many/i)
      expect(byName.get('summarize_occurrences')?.description).toMatch(/no individual records/i)

      // The composition rule: this one is called first.
      expect(byName.get('resolve_taxon')?.description).toMatch(/call this first/i)
      expect(byName.get('resolve_taxon')?.description).toContain('taxonKey')
    } finally {
      await harness.close()
    }
  })

  it('marks every tool read-only and open-world', async () => {
    const harness = await createHarness()
    try {
      const { tools } = (await harness.client.listTools()) as {
        tools: Array<
          ListedTool & { annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean } }
        >
      }

      for (const tool of tools) {
        // Nothing here writes, and everything here depends on an upstream that
        // can change between calls. A client that gates side effects on the
        // annotation should be able to trust it.
        expect(tool.annotations?.readOnlyHint, `${tool.name} readOnlyHint`).toBe(true)
        expect(tool.annotations?.openWorldHint, `${tool.name} openWorldHint`).toBe(true)
      }
    } finally {
      await harness.close()
    }
  })
})

describe('initialize — instructions reach every client', () => {
  it('returns non-empty instructions', async () => {
    const harness = await createHarness()
    try {
      const instructions = harness.client.getInstructions()

      expect(instructions).toBeTruthy()
      expect((instructions ?? '').trim().length).toBeGreaterThan(0)
    } finally {
      await harness.close()
    }
  })

  it('carries the guidance that would otherwise live only in the bundled agent', async () => {
    const harness = await createHarness()
    try {
      const instructions = harness.client.getInstructions() ?? ''

      // Each of the four sections the contract requires, checked by the thing
      // it exists to say rather than by its heading (FR-021).
      expect(instructions).toContain('resolve_taxon') // composition
      expect(instructions).toContain('summarize_occurrences') // context economy
      expect(instructions).toMatch(/recording effort/i) // interpretation caveat
      expect(instructions).toMatch(/what to try instead/i) // error contract
    } finally {
      await harness.close()
    }
  })

  it('advertises the capabilities a client needs to see the tools and the prompt', async () => {
    const harness = await createHarness()
    try {
      const capabilities = harness.client.getServerCapabilities()

      expect(capabilities?.tools).toBeDefined()
      expect(capabilities?.prompts).toBeDefined()
      // Declared so tool-call records can reach a client that renders them;
      // they go to stderr regardless (Constitution I).
      expect(capabilities?.logging).toBeDefined()
    } finally {
      await harness.close()
    }
  })
})

describe('tools/list — descriptions match the behaviour (FR-029, FR-048)', () => {
  it('states what happens when both taxonKey and name are supplied', async () => {
    const harness = await createHarness()
    try {
      const { tools } = (await harness.client.listTools()) as { tools: ListedTool[] }
      const byName = new Map(tools.map((tool) => [tool.name, tool]))

      // A model must be able to predict the refusal rather than discover it by
      // being refused. Both occurrence tools carry the rule.
      for (const name of ['search_occurrences', 'summarize_occurrences']) {
        const description = byName.get(name)?.description ?? ''
        expect(description).toMatch(/both a taxonKey and a name is refused/i)
        expect(description).toMatch(/exactly one/i)
      }
    } finally {
      await harness.close()
    }
  })

  it('names every field search_occurrences returns, so the claim cannot drift', async () => {
    const harness = await createHarness()
    try {
      const { tools } = (await harness.client.listTools()) as { tools: ListedTool[] }
      const description =
        tools.find((tool) => tool.name === 'search_occurrences')?.description ?? ''

      // The description is where a model learns what it will get back. A field
      // it does not know is returned is a field it will not offer — which is
      // how the occurrence key came to be omitted (FR-048).
      const advertised: Record<string, RegExp> = {
        key: /occurrence key/i,
        species: /species/i,
        eventDate: /event date/i,
        countryCode: /country code/i,
        latitude: /latitude/i,
        longitude: /longitude/i,
        basisOfRecord: /basis of record/i,
        dataset: /dataset/i,
        publisher: /publisher/i,
      }

      // Every trimmed field is named, and the count in the prose matches.
      expect(Object.keys(advertised)).toEqual([...TRIMMED_FIELDS])
      for (const [field, pattern] of Object.entries(advertised)) {
        expect(description, `${field} is returned but not described`).toMatch(pattern)
      }
      expect(description).toMatch(/nine fields/i)
    } finally {
      await harness.close()
    }
  })
})
