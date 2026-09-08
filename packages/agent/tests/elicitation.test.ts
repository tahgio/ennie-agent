/**
 * Carrying a server's question to the person, and their answer back (FR-036a).
 *
 * The handler is a pure function of "what the server asked" and "what the
 * person typed", so it is tested that way: no readline, no MCP client, a
 * scripted `ask`. What is being checked is not the wording of the prompts but
 * the contract with the server — that only `accept` ever carries content, that
 * a value the server did not offer cannot be returned, and that every way of
 * not answering ends up somewhere the server treats as "ask nobody".
 */
import { describe, expect, it } from 'vitest'
import { type AskLine, createTerminalElicitation } from '../src/elicitation.js'

/** Answer with each scripted line in turn, then behave like end of input. */
function scripted(lines: string[]): { ask: AskLine; asked: string[] } {
  const asked: string[] = []
  let index = 0
  return {
    asked,
    ask: async (question) => {
      asked.push(question)
      return index < lines.length ? (lines[index++] as string) : null
    },
  }
}

function collect(): { write: (text: string) => void; text: () => string } {
  const chunks: string[] = []
  return { write: (text) => void chunks.push(text), text: () => chunks.join('') }
}

/** The shape the GBIF server actually sends for a cross-kingdom homonym. */
const TAXON_CHOICE = {
  message: "'Prunella' matches 2 different taxa in GBIF. Which one did you mean?",
  requestedSchema: {
    type: 'object' as const,
    properties: {
      taxonKey: {
        type: 'string',
        title: 'Taxon',
        oneOf: [
          { const: '2926553', title: 'Prunella L. — Plantae, genus' },
          { const: '2495070', title: 'Prunella Vieillot, 1816 — Animalia, genus' },
        ],
      },
    },
    required: ['taxonKey'],
  },
}

describe('choosing from a list', () => {
  it('returns the value behind the number the person typed', async () => {
    const input = scripted(['2'])
    const handler = createTerminalElicitation({ ask: input.ask, write: collect().write })

    const result = await handler(TAXON_CHOICE as never)

    expect(result.action).toBe('accept')
    expect(result.content).toEqual({ taxonKey: '2495070' })
  })

  it('shows the labels, not the taxon keys', async () => {
    const output = collect()
    const input = scripted(['1'])
    const handler = createTerminalElicitation({ ask: input.ask, write: output.write })

    await handler(TAXON_CHOICE as never)

    // A person cannot choose between 2926553 and 2495070. The kingdom is what
    // makes the question answerable, so it has to be on screen.
    expect(output.text()).toContain('Plantae')
    expect(output.text()).toContain('Animalia')
  })

  it('accepts a distinguishing word instead of a number', async () => {
    const input = scripted(['plantae'])
    const handler = createTerminalElicitation({ ask: input.ask, write: collect().write })

    const result = await handler(TAXON_CHOICE as never)

    expect(result.content).toEqual({ taxonKey: '2926553' })
  })

  it('cancels rather than guessing when the answer is not one of the options', async () => {
    const input = scripted(['the third one'])
    const handler = createTerminalElicitation({ ask: input.ask, write: collect().write })

    const result = await handler(TAXON_CHOICE as never)

    expect(result.action).toBe('cancel')
    expect(result.content).toBeUndefined()
  })

  it('cancels on an empty answer to a required field', async () => {
    const input = scripted([''])
    const handler = createTerminalElicitation({ ask: input.ask, write: collect().write })

    expect((await handler(TAXON_CHOICE as never)).action).toBe('cancel')
  })

  it('cancels at end of input, so a piped session cannot hang', async () => {
    const input = scripted([])
    const handler = createTerminalElicitation({ ask: input.ask, write: collect().write })

    expect((await handler(TAXON_CHOICE as never)).action).toBe('cancel')
  })

  it('reads the older enum/enumNames form as well as oneOf', async () => {
    const input = scripted(['1'])
    const handler = createTerminalElicitation({ ask: input.ask, write: collect().write })

    const result = await handler({
      message: 'Which kingdom?',
      requestedSchema: {
        type: 'object',
        properties: {
          kingdom: {
            type: 'string',
            enum: ['Plantae', 'Animalia'],
            enumNames: ['Plants', 'Animals'],
          },
        },
        required: ['kingdom'],
      },
    } as never)

    expect(result.content).toEqual({ kingdom: 'Plantae' })
  })
})

describe('free-text fields', () => {
  it('submits a typed string', async () => {
    const input = scripted(['Ursus maritimus'])
    const handler = createTerminalElicitation({ ask: input.ask, write: collect().write })

    const result = await handler({
      message: 'Which species?',
      requestedSchema: {
        type: 'object',
        properties: { species: { type: 'string', title: 'Species' } },
        required: ['species'],
      },
    } as never)

    expect(result.content).toEqual({ species: 'Ursus maritimus' })
  })

  it('leaves an optional field out rather than sending an empty string', async () => {
    const input = scripted(['Ursus maritimus', ''])
    const handler = createTerminalElicitation({ ask: input.ask, write: collect().write })

    const result = await handler({
      message: 'Which species?',
      requestedSchema: {
        type: 'object',
        properties: {
          species: { type: 'string' },
          country: { type: 'string' },
        },
        required: ['species'],
      },
    } as never)

    // An absent optional field and one set to '' are different statements.
    expect(result.content).toEqual({ species: 'Ursus maritimus' })
  })

  it('cancels on a number field that did not receive a number', async () => {
    const input = scripted(['lots'])
    const handler = createTerminalElicitation({ ask: input.ask, write: collect().write })

    const result = await handler({
      message: 'How many?',
      requestedSchema: {
        type: 'object',
        properties: { limit: { type: 'integer' } },
        required: ['limit'],
      },
    } as never)

    expect(result.action).toBe('cancel')
  })
})

describe('declining', () => {
  it('treats /cancel as a decline at any field', async () => {
    const input = scripted(['/cancel'])
    const handler = createTerminalElicitation({ ask: input.ask, write: collect().write })

    expect((await handler(TAXON_CHOICE as never)).action).toBe('cancel')
  })

  it('declines a URL-mode request a terminal cannot complete', async () => {
    const output = collect()
    const input = scripted([])
    const handler = createTerminalElicitation({ ask: input.ask, write: output.write })

    const result = await handler({
      mode: 'url',
      message: 'Sign in to continue.',
      url: 'https://example.invalid/auth',
    } as never)

    expect(result.action).toBe('cancel')
    // Nothing was asked, because there was no question a terminal could put.
    expect(input.asked).toHaveLength(0)
    expect(output.text()).toMatch(/browser/i)
  })

  it('declines rather than accepting an empty answer set', async () => {
    const input = scripted([''])
    const handler = createTerminalElicitation({ ask: input.ask, write: collect().write })

    const result = await handler({
      message: 'Anything to add?',
      requestedSchema: { type: 'object', properties: { note: { type: 'string' } } },
    } as never)

    // `accept` with `{}` would read to a server as "the person answered, and
    // chose nothing", which is not what happened.
    expect(result.action).toBe('decline')
  })
})
