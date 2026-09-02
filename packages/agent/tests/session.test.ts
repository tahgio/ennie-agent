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

  it('says so when the model returns no text, instead of printing nothing', async () => {
    // The bug this covers: a turn that produces no text is not an error and
    // does not throw. Gemini alone reaches this through four different finish
    // reasons — a malformed function call, a content filter, a token limit hit
    // while thinking, and a plain stop with an empty candidate — and the CLI
    // used to answer every one of them with a blank line, which reads as the
    // program ignoring the question.
    const prompts: Array<Array<{ role: string; content: string }>> = []
    let call = 0
    const agent = {
      prompts,
      async generateText(messages: Array<{ role: string; content: string }>) {
        prompts.push(messages.map((message) => ({ ...message })))
        call += 1
        if (call === 1) return { text: '', finishReason: 'error', steps: [{}] }
        return { text: 'recovered' }
      },
    }

    const { output } = await runSession(['A silent question', 'A second question'], agent as never)

    expect(output).toContain('No answer came back')
    expect(output).toContain('recovered')
    // Nothing empty is carried forward: the retry starts from a clean turn,
    // which is what makes asking again work rather than compounding the state.
    expect(prompts[1]).toHaveLength(1)
    expect(prompts[1]?.[0]?.content).toBe('A second question')
  })

  it('names the step budget when a turn ends still calling tools', async () => {
    const agent = {
      prompts: [] as Array<Array<{ role: string; content: string }>>,
      async generateText(messages: Array<{ role: string; content: string }>) {
        this.prompts.push(messages.map((message) => ({ ...message })))
        return { text: '', finishReason: 'tool-calls', steps: new Array(8).fill({}) }
      },
    }

    const { output } = await runSession(['A question that loops'], agent as never)

    // The step limit is the one cause the person can act on — by simplifying
    // the question — so it must be named rather than lumped in with the rest.
    expect(output).toMatch(/8 steps/)
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

/**
 * Interruption during an in-flight answer (FR-021, FR-027).
 *
 * The stub rejects the way a real provider does when its `abortSignal` fires,
 * so the whole path is exercised with **no model provider contacted** — which
 * is what lets this run in the default suite (Constitution VI).
 *
 * What is asserted is an absence: the session must not print the failure line
 * it prints for an ordinary failed turn. A deliberate Ctrl-C reported as
 * "that question could not be answered" is the defect.
 */
describe('Session under interruption', () => {
  /** An agent whose generation rejects once the shutdown signal aborts. */
  function abortingAgent(controller: AbortController): StubAgent {
    const prompts: Array<Array<{ role: string; content: string }>> = []
    return {
      prompts,
      async generateText(messages) {
        prompts.push(messages.map((message) => ({ ...message })))

        return await new Promise((_resolve, reject) => {
          const fail = (): void => {
            reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))
          }
          if (controller.signal.aborted) fail()
          else controller.signal.addEventListener('abort', fail, { once: true })

          // The interrupt lands while the answer is still being generated.
          setTimeout(() => controller.abort(), 5)
        })
      },
    }
  }

  it('prints no failure text and propagates, so the entrypoint can exit 130', async () => {
    const controller = new AbortController()
    const output = collector()
    const session = new Session({
      agent: abortingAgent(controller) as never,
      input: pipedInput([]),
      output: output.stream,
      firstQuestion: 'Where has the polar bear been recorded?',
      signal: controller.signal,
    })

    // The rethrow is the contract: `main()` recognises it by the aborted
    // signal and returns 130 rather than falling through to the exit-1 handler.
    await expect(session.run()).rejects.toThrow()

    expect(output.text()).not.toContain('That question could not be answered')
    expect(controller.signal.aborted).toBe(true)
  })

  it('still reports an ordinary failure, which is a different path entirely', async () => {
    const controller = new AbortController()
    const output = collector()
    const failing: StubAgent = {
      prompts: [],
      async generateText() {
        throw new Error('upstream exploded')
      },
    }

    const session = new Session({
      agent: failing as never,
      input: pipedInput(['/exit']),
      output: output.stream,
      firstQuestion: 'A question',
      signal: controller.signal,
    })

    await session.run()

    // Not aborted, so the session survives the turn and says what went wrong.
    expect(output.text()).toContain('That question could not be answered')
    expect(output.text()).toContain('upstream exploded')
  })
})

/**
 * The transcript ceiling (FR-023 – FR-025).
 *
 * A long conversation used to grow until the provider refused it, and the
 * refusal was attributed to the person's last question. The ceiling is checked
 * on three properties: the transcript stays within it, what survives always
 * begins with a question, and the person is told what was dropped.
 */
describe('Session history ceiling', () => {
  it('stays within the ceiling, drops in pairs, and says what it dropped', async () => {
    const agent = stubAgent()
    const output = collector()

    // Six exchanges against a ceiling of four entries (two exchanges).
    const session = new Session({
      agent: agent as never,
      input: pipedInput(['q1', 'q2', 'q3', 'q4', 'q5', 'q6', '/exit']),
      output: output.stream,
      maxTurns: 4,
    })

    await session.run()

    expect(session.turns.length).toBeLessThanOrEqual(4)

    // Never begins with an assistant entry: that would be an answer to a
    // question no longer present.
    expect(session.turns[0]?.role).toBe('user')
    expect(session.turns.map((turn) => turn.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ])

    // The most recent exchange survives; the earliest is gone.
    expect(session.turns.at(-2)?.content).toBe('q6')
    expect(session.turns.some((turn) => turn.content === 'q1')).toBe(false)

    expect(output.text()).toContain(
      'Dropped the 1 oldest exchange to stay within the context limit.',
    )
  })

  it('keeps a full transcript when the conversation stays within the ceiling', async () => {
    const agent = stubAgent()
    const output = collector()

    const session = new Session({
      agent: agent as never,
      input: pipedInput(['q1', 'q2', '/exit']),
      output: output.stream,
      maxTurns: 40,
    })

    await session.run()

    expect(session.turns.length).toBe(4)
    expect(session.turns[0]?.content).toBe('q1')
    // Nothing was dropped, so nothing is claimed to have been.
    expect(output.text()).not.toContain('Dropped')
  })

  it('keeps answering past the ceiling — the session does not end (SC-006)', async () => {
    const agent = stubAgent()
    const output = collector()

    const questions = Array.from({ length: 30 }, (_, i) => `q${i + 1}`)
    const session = new Session({
      agent: agent as never,
      input: pipedInput([...questions, '/exit']),
      output: output.stream,
      maxTurns: 6,
    })

    await session.run()

    // Every question was answered, and the transcript never grew past the bound.
    expect(agent.prompts.length).toBe(30)
    expect(session.turns.length).toBeLessThanOrEqual(6)

    for (const prompt of agent.prompts) {
      // Trimming happens after a completed exchange, so what is *sent* is the
      // trimmed transcript plus the question being asked: bounded at ceiling+1
      // rather than at the ceiling. Trimming before the call instead would
      // have to drop an exchange that is still within the ceiling.
      expect(prompt.length).toBeLessThanOrEqual(7)
      // Never starts with an answer to a question that is no longer present.
      expect(prompt[0]?.role).toBe('user')
    }
  })
})

/**
 * An opening question from argv, with piped stdin (FR-031b).
 *
 * `pnpm agent "a question"` answers that question and then keeps the session
 * open. When stdin is a pipe rather than a terminal, the stream reaches EOF
 * while that first answer is still being generated — so readline emits `close`
 * before the loop has started reading.
 *
 * An async iterator created *after* `close` has already fired never ends: the
 * event it is waiting for has been and gone. The session then hangs forever
 * instead of exiting, which is a stall with no output and no exit status —
 * the worst shape a bug can take at a command line.
 *
 * These tests pin both halves: the loop terminates, and the lines buffered
 * during the first answer are still processed rather than dropped.
 */
describe('Session with an opening question and piped input', () => {
  it('terminates instead of hanging once the piped input has ended', async () => {
    const agent = stubAgent()
    const output = collector()
    const session = new Session({
      agent: agent as never,
      input: pipedInput([]),
      output: output.stream,
      firstQuestion: 'Where has the polar bear been recorded?',
    })

    // The whole assertion is that this settles at all.
    await session.run()

    expect(agent.prompts).toHaveLength(1)
    expect(agent.prompts[0]?.[0]?.content).toBe('Where has the polar bear been recorded?')
  })

  it('still processes lines buffered while the first answer was in flight', async () => {
    const agent = stubAgent()
    const output = collector()
    const session = new Session({
      agent: agent as never,
      input: pipedInput(['a follow-up', 'another follow-up']),
      output: output.stream,
      firstQuestion: 'the opening question',
    })

    await session.run()

    // Terminating must not be achieved by throwing the buffered input away.
    expect(agent.prompts).toHaveLength(3)
    expect(session.turns.map((turn) => turn.content)).toEqual([
      'the opening question',
      'answer 1',
      'a follow-up',
      'answer 2',
      'another follow-up',
      'answer 3',
    ])
  })

  it('honours /exit arriving after an opening question', async () => {
    const agent = stubAgent()
    const output = collector()
    const session = new Session({
      agent: agent as never,
      input: pipedInput(['/exit']),
      output: output.stream,
      firstQuestion: 'the opening question',
    })

    await session.run()

    expect(agent.prompts).toHaveLength(1)
    expect(output.text()).toContain('Exiting.')
  })
})
