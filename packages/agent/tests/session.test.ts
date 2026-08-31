/**
 * The interactive loop's input handling (FR-031, FR-031a, FR-031b, T070).
 *
 * No model is contacted: the agent is a stub that records what it was asked and
 * returns a canned answer, which is enough to check the two properties that
 * actually live in `Session` — that every line supplied is processed, and that
 * each turn is given the whole transcript so far.
 *
 * The multi-line case earns its own test because it regressed once and the
 * failure is quiet. Piped stdin buffers every line at once, so readline reports
 * `close` while the *first* answer is still being generated. An implementation
 * that treats "closed" as "no more input" then answers question one, drops
 * questions two and three, and exits 0 — a transcript that looks like a short
 * conversation rather than like lost input.
 */
import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { Session } from '../src/session.js'

/** What the agent was asked, turn by turn, without a model in the loop. */
interface StubAgent {
  generateText(
    messages: Array<{ role: string; content: string }>,
    options?: unknown,
  ): Promise<{ text: string }>
  readonly prompts: Array<Array<{ role: string; content: string }>>
}

function stubAgent(answer: (n: number) => string = (n) => `answer ${n}`): StubAgent {
  const prompts: Array<Array<{ role: string; content: string }>> = []
  return {
    prompts,
    async generateText(messages) {
      prompts.push(messages.map((message) => ({ ...message })))
      // A tick of latency, so `close` genuinely fires mid-answer the way it
      // does with a real model call. Without it the bug is not reproducible.
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { text: answer(prompts.length) }
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

/** Feed `lines` as if they had been piped in, then close the stream. */
function pipedInput(lines: string[]): PassThrough {
  const input = new PassThrough()
  input.end(lines.map((line) => `${line}\n`).join(''))
  return input
}

async function runSession(lines: string[], agent: StubAgent) {
  const output = collector()
  const session = new Session({
    agent: agent as never,
    input: pipedInput(lines),
    output: output.stream,
  })

  await session.run()
  return { output: output.text(), session }
}

describe('Session over piped input', () => {
  it('processes every buffered line, not only the first', async () => {
    const agent = stubAgent()

    const { output } = await runSession(
      ['Where has the polar bear been recorded?', 'What about just in Canada?', '/exit'],
      agent,
    )

    // The regression: the second question was silently discarded because the
    // stream had already closed while the first answer was in flight.
    expect(agent.prompts).toHaveLength(2)
    expect(output).toContain('answer 1')
    expect(output).toContain('answer 2')
    expect(output).toContain('Exiting.')
  })

  it('carries the transcript forward, so a follow-up needs no repetition', async () => {
    const agent = stubAgent()

    await runSession(
      ['Where has the polar bear been recorded?', 'What about just in Canada?'],
      agent,
    )

    // FR-031a: the second call must see the first exchange, or "what about
    // Canada?" has no subject.
    const second = agent.prompts[1]
    expect(second).toHaveLength(3)
    expect(second?.[0]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('polar bear'),
    })
    expect(second?.[1]).toMatchObject({ role: 'assistant', content: 'answer 1' })
    expect(second?.[2]).toMatchObject({ role: 'user', content: 'What about just in Canada?' })
  })

  it('ends at EOF without waiting for a prompt nobody will answer', async () => {
    const agent = stubAgent()

    const { output } = await runSession(['One question'], agent)

    // No /exit, just a closed stream. Reaching this line at all is the
    // assertion — a hang here fails by timeout.
    expect(agent.prompts).toHaveLength(1)
    expect(output).toContain('answer 1')
  })

  it('skips blank lines rather than putting them to the model', async () => {
    const agent = stubAgent()

    await runSession(['', '   ', 'A real question', '/exit'], agent)

    expect(agent.prompts).toHaveLength(1)
    expect(agent.prompts[0]?.[0]?.content).toBe('A real question')
  })

  it('stops at /exit, leaving later lines unread', async () => {
    const agent = stubAgent()

    await runSession(['First', '/exit', 'Never asked'], agent)

    expect(agent.prompts).toHaveLength(1)
  })

  it('keeps the session open when a turn fails, and drops it from the transcript', async () => {
    const prompts: Array<Array<{ role: string; content: string }>> = []
    let call = 0
    const agent = {
      prompts,
      async generateText(messages: Array<{ role: string; content: string }>) {
        prompts.push(messages.map((message) => ({ ...message })))
        call += 1
        if (call === 1) throw new Error('upstream blew up')
        return { text: 'recovered' }
      },
    }

    const { output } = await runSession(['A failing question', 'A second question'], agent as never)

    expect(output).toContain('That question could not be answered: upstream blew up')
    expect(output).toContain('recovered')
    // The failed turn is not carried forward as if it had been answered.
    expect(prompts[1]).toHaveLength(1)
    expect(prompts[1]?.[0]?.content).toBe('A second question')
  })
})
