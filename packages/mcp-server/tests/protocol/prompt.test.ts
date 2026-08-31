/**
 * `species_distribution_report` over the protocol (FR-000b, FR-022).
 *
 * A prompt is the one part of the surface a *person* invokes directly — it
 * shows up as a slash command in most clients — so the thing worth asserting is
 * that it arrives complete: listed with its arguments, and returning a workflow
 * that names the tools in the order they should be called.
 *
 * The step-4 assertion is the one that matters most. The workflow's job is to
 * keep a distribution question off the paging path, and a prompt that merely
 * suggested three tools would quietly lose that (Principle II).
 */
import { describe, expect, it } from 'vitest'
import { createHarness } from '../helpers/mcp-harness.js'

const PROMPT_NAME = 'species_distribution_report'

interface ListedPrompt {
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

interface PromptMessage {
  role: string
  content: { type: string; text?: string }
}

/** The text of every message in a prompt result, joined. */
function messageText(result: { messages: PromptMessage[] }): string {
  return result.messages
    .map((message) => (message.content.type === 'text' ? (message.content.text ?? '') : ''))
    .join('\n')
}

describe('prompts/list', () => {
  it('advertises species_distribution_report', async () => {
    const harness = await createHarness()
    try {
      const { prompts } = (await harness.client.listPrompts()) as { prompts: ListedPrompt[] }

      expect(prompts.map((prompt) => prompt.name)).toContain(PROMPT_NAME)
    } finally {
      await harness.close()
    }
  })

  it('declares species as required and country as optional', async () => {
    const harness = await createHarness()
    try {
      const { prompts } = (await harness.client.listPrompts()) as { prompts: ListedPrompt[] }
      const prompt = prompts.find((candidate) => candidate.name === PROMPT_NAME)

      expect(prompt?.description).toBeTruthy()

      const args = new Map((prompt?.arguments ?? []).map((arg) => [arg.name, arg]))
      expect([...args.keys()].sort()).toEqual(['country', 'species'])
      // A client renders the required argument as the one it must ask for; get
      // this backwards and the command appears to need a country code.
      expect(args.get('species')?.required).toBe(true)
      expect(args.get('country')?.required).toBeFalsy()
      expect(args.get('species')?.description).toBeTruthy()
      expect(args.get('country')?.description).toBeTruthy()
    } finally {
      await harness.close()
    }
  })
})

describe('prompts/get', () => {
  it('returns the workflow for a given species as a single user message', async () => {
    const harness = await createHarness()
    try {
      const result = (await harness.client.getPrompt({
        name: PROMPT_NAME,
        arguments: { species: 'Ursus maritimus' },
      })) as { messages: PromptMessage[] }

      expect(result.messages).toHaveLength(1)
      expect(result.messages[0]?.role).toBe('user')
      expect(result.messages[0]?.content.type).toBe('text')

      const text = messageText(result)
      expect(text).toContain('Ursus maritimus')
      // The composition order, which is the whole content of the workflow.
      expect(text.indexOf('resolve_taxon')).toBeGreaterThanOrEqual(0)
      expect(text.indexOf('summarize_occurrences')).toBeGreaterThan(text.indexOf('resolve_taxon'))
      expect(text).toContain('["country", "year"]')
    } finally {
      await harness.close()
    }
  })

  it('names the country when one is supplied, and omits the clause when none is', async () => {
    const harness = await createHarness()
    try {
      const scoped = (await harness.client.getPrompt({
        name: PROMPT_NAME,
        arguments: { species: 'Ursus maritimus', country: 'CA' },
      })) as { messages: PromptMessage[] }
      const unscoped = (await harness.client.getPrompt({
        name: PROMPT_NAME,
        arguments: { species: 'Ursus maritimus' },
      })) as { messages: PromptMessage[] }

      expect(messageText(scoped)).toContain('in CA')
      // No empty braces, no dangling "in" — the optional clause disappears
      // entirely rather than rendering as a placeholder.
      expect(messageText(unscoped)).not.toMatch(/\bin \{|\{ ?country ?\}|\bin \./)
    } finally {
      await harness.close()
    }
  })

  it('tells the model to ask rather than pick when the name is ambiguous', async () => {
    const harness = await createHarness()
    try {
      const result = (await harness.client.getPrompt({
        name: PROMPT_NAME,
        arguments: { species: 'Prunella' },
      })) as { messages: PromptMessage[] }

      // FR-036a at the workflow level: the "never guess silently" rule has to
      // survive being invoked as a one-shot command.
      expect(messageText(result)).toMatch(/do not pick one yourself/i)
    } finally {
      await harness.close()
    }
  })

  it('steers away from search_occurrences and asks for the caveat', async () => {
    const harness = await createHarness()
    try {
      const result = (await harness.client.getPrompt({
        name: PROMPT_NAME,
        arguments: { species: 'Ursus maritimus' },
      })) as { messages: PromptMessage[] }
      const text = messageText(result)

      expect(text).toMatch(/do \*\*not\*\* call `search_occurrences`/i)
      // Zero is an answer, and a report that omits it reads as a failure.
      expect(text).toMatch(/including when it is zero/i)
      // The scientific-integrity line: counts measure effort, not abundance.
      expect(text).toMatch(/recording effort/i)
    } finally {
      await harness.close()
    }
  })

  it('rejects a call with no species rather than rendering an empty report', async () => {
    const harness = await createHarness()
    try {
      await expect(harness.client.getPrompt({ name: PROMPT_NAME, arguments: {} })).rejects.toThrow()
    } finally {
      await harness.close()
    }
  })
})
