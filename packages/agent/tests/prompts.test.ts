/**
 * Reaching the server's prompts from the terminal (FR-022).
 *
 * A prompt is the part of an MCP surface a *person* invokes. Nothing in this
 * package names `species_distribution_report`: the commands come from
 * `prompts/list` at connect time, so a server that publishes a new prompt gets
 * a new command without this client changing. That is the property worth
 * protecting, so the catalogue here is a stub with deliberately different
 * prompts in it.
 */
import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { AMBIGUOUS_PROMPT, type PromptCatalog, type PromptSummary } from '../src/mcp-bridge.js'
import { parsePromptArguments, Session, usageLine } from '../src/session.js'

const REPORT: PromptSummary = {
  name: 'species_distribution_report',
  description: 'Where a species has been recorded.',
  arguments: [
    { name: 'species', required: true },
    { name: 'country', required: false },
  ],
}

const OTHER: PromptSummary = {
  name: 'dataset_summary',
  description: 'Summarise a dataset.',
  arguments: [{ name: 'datasetKey', required: true }],
}

function catalog(prompts: PromptSummary[] = [REPORT, OTHER]): PromptCatalog & {
  rendered: Array<{ name: string; args: Record<string, string> }>
} {
  const rendered: Array<{ name: string; args: Record<string, string> }> = []
  return {
    rendered,
    all: prompts,
    find(query) {
      const wanted = query.trim().toLowerCase()
      const exact = prompts.find((prompt) => prompt.name.toLowerCase() === wanted)
      if (exact !== undefined) return exact
      const partial = prompts.filter((prompt) => prompt.name.toLowerCase().includes(wanted))
      if (partial.length === 1) return partial[0] ?? null
      return partial.length > 1 ? AMBIGUOUS_PROMPT : null
    },
    async render(name, args) {
      rendered.push({ name, args: { ...args } })
      return `Produce a report for ${args['species'] ?? '?'}.`
    },
  }
}

function collector(): { stream: Writable; text(): string } {
  const chunks: string[] = []
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk))
        callback()
      },
    }),
    text: () => chunks.join(''),
  }
}

function pipedInput(lines: string[]): PassThrough {
  const input = new PassThrough()
  input.end(lines.map((line) => `${line}\n`).join(''))
  return input
}

function stubAgent(): { generateText(): Promise<{ text: string }>; asked: string[][] } {
  const asked: string[][] = []
  return {
    asked,
    async generateText(...args: unknown[]) {
      const messages = args[0] as Array<{ content: string }>
      asked.push(messages.map((message) => message.content))
      return { text: 'An answer.' }
    },
  }
}

async function runSession(lines: string[], prompts: PromptCatalog | null) {
  const output = collector()
  const agent = stubAgent()
  const session = new Session({
    agent: agent as never,
    input: pipedInput(lines),
    output: output.stream,
    prompts,
  })
  await session.run()
  return { output: output.text(), agent }
}

describe('/prompts', () => {
  it('lists what the connected server published, whatever it is', async () => {
    const { output } = await runSession(['/prompts', '/exit'], catalog())

    expect(output).toContain('/species_distribution_report')
    expect(output).toContain('/dataset_summary')
    expect(output).toContain('Where a species has been recorded.')
  })

  it('shows the arguments each prompt needs', async () => {
    const { output } = await runSession(['/prompts', '/exit'], catalog())

    expect(output).toContain('<species>')
    expect(output).toContain('[country=…]')
  })

  it('says so plainly when the server publishes none', async () => {
    const { output } = await runSession(['/prompts', '/exit'], null)

    expect(output).toMatch(/no prompts/i)
  })
})

describe('running a prompt', () => {
  it('sends the rendered text to the model as the turn', async () => {
    const cat = catalog()
    const { agent } = await runSession(['/species_distribution_report polar bear', '/exit'], cat)

    expect(cat.rendered).toEqual([
      { name: 'species_distribution_report', args: { species: 'polar bear' } },
    ])
    expect(agent.asked[0]?.[0]).toBe('Produce a report for polar bear.')
  })

  it('resolves an unambiguous fragment of the name', async () => {
    const cat = catalog()
    // The point of the shortcut: nobody types the whole name twice.
    await runSession(['/report polar bear', '/exit'], cat)

    expect(cat.rendered[0]?.name).toBe('species_distribution_report')
  })

  it('refuses a fragment that matches more than one prompt', async () => {
    const cat = catalog()
    const { output } = await runSession(['/s polar bear', '/exit'], cat)

    expect(output).toMatch(/more than one prompt/i)
    expect(cat.rendered).toHaveLength(0)
  })

  it('shows the person what was said in their name', async () => {
    const { output } = await runSession(['/report polar bear', '/exit'], catalog())

    // Without this the answer refers to steps that appear nowhere in the
    // transcript the person can see.
    expect(output).toContain('Produce a report for polar bear.')
  })

  it('names the missing argument instead of calling the server without it', async () => {
    const cat = catalog()
    const { output } = await runSession(['/report', '/exit'], cat)

    expect(output).toContain('species')
    expect(output).toContain('usage:')
    expect(cat.rendered).toHaveLength(0)
  })

  it('reports a server-side failure without ending the session', async () => {
    const failing: PromptCatalog = {
      ...catalog(),
      render: async () => {
        throw new Error('prompt exploded')
      },
    }
    const { output } = await runSession(
      ['/report polar bear', 'A plain question.', '/exit'],
      failing,
    )

    expect(output).toContain('prompt exploded')
    expect(output).toContain('An answer.') // the next turn still worked
  })
})

describe('unknown commands', () => {
  it('are reported, not answered as questions', async () => {
    const { agent, output } = await runSession(['/nonsense', '/exit'], catalog())

    expect(output).toMatch(/unknown command/i)
    // A mistyped command sent to the model wastes a generation and produces a
    // confident answer to something the person never asked.
    expect(agent.asked).toHaveLength(0)
  })

  it('/help lists the built-in commands', async () => {
    const { output } = await runSession(['/help', '/exit'], catalog())

    expect(output).toContain('/prompts')
    expect(output).toContain('/exit')
  })
})

describe('parsePromptArguments', () => {
  it('treats a bare run of words as the required argument', () => {
    expect(parsePromptArguments(REPORT, 'polar bear')).toEqual({ species: 'polar bear' })
  })

  it('reads key=value pairs the prompt declares', () => {
    expect(parsePromptArguments(REPORT, 'polar bear country=CA')).toEqual({
      species: 'polar bear',
      country: 'CA',
    })
  })

  it('keeps an undeclared key=value as part of the positional text', () => {
    // Otherwise a species name that happens to contain '=' loses a word.
    expect(parsePromptArguments(REPORT, 'Ursus x=1')).toEqual({ species: 'Ursus x=1' })
  })

  it('returns nothing for an empty command line', () => {
    expect(parsePromptArguments(REPORT, '')).toEqual({})
  })
})

describe('usageLine', () => {
  it('distinguishes required from optional arguments', () => {
    expect(usageLine(REPORT)).toBe('usage: /species_distribution_report <species> [country=…]')
  })

  it('names a prompt that takes nothing', () => {
    expect(usageLine({ name: 'status', arguments: [] })).toBe('usage: /status')
  })
})
