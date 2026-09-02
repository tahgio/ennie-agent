/**
 * The interactive loop (FR-031, FR-031a, FR-031b, FR-036a, FR-070).
 *
 * Conversation context is a plain array of messages held in this process and
 * nothing else. It is never written to disk, never given a session id, and dies
 * with the process — which is what makes "no persistence" a property of the
 * design rather than a promise (FR-031a).
 *
 * Clarification is not handled here by inspecting error strings. The server
 * already returns an ambiguity as a tool result the model can read, and the
 * agent's instructions tell it to put that choice to the person as a question.
 * The loop's job is simply to keep the exchange open so the person's reply
 * becomes the next turn (FR-036a).
 */
import { createInterface } from 'node:readline/promises'
import type { Agent } from '@voltagent/core'
import { emptyAnswerAdvice, emptyAnswerReason, type Generation } from './empty-answer.js'

/** One turn of the transcript. Kept in memory, for the lifetime of the process. */
export interface Turn {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

export interface SessionOptions {
  readonly agent: Agent
  readonly input: NodeJS.ReadableStream & {
    isTTY?: boolean | undefined
    readableEnded?: boolean | undefined
  }
  readonly output: NodeJS.WritableStream
  /** An opening question supplied as an argv argument; the session stays open after it. */
  readonly firstQuestion?: string | undefined
  /** Aborts the in-flight model call when the process is shutting down. */
  readonly signal?: AbortSignal | undefined
  /**
   * The transcript ceiling, in entries — two per exchange (FR-023, FR-025).
   *
   * Defaults to 40, i.e. 20 exchanges: comfortably beyond the multi-turn
   * clarification flows the eval scenarios exercise, so no ordinary
   * conversation loses the turn in which a person answered a clarifying
   * question, and far below any provider's limit.
   */
  readonly maxTurns?: number | undefined
}

const PROMPT = '\n> '
const EXIT_COMMAND = '/exit'

/** 20 exchanges. See `SessionOptions.maxTurns`. */
const DEFAULT_MAX_TURNS = 40

export class Session {
  readonly #agent: Agent
  readonly #turns: Turn[] = []
  readonly #output: NodeJS.WritableStream
  readonly #maxTurns: number

  constructor(private readonly options: SessionOptions) {
    this.#agent = options.agent
    this.#output = options.output
    this.#maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
  }

  /** The transcript so far. Exposed for the evals, which score the exchange. */
  get turns(): readonly Turn[] {
    return this.#turns
  }

  async run(): Promise<void> {
    const rl = createInterface({
      input: this.options.input,
      output: this.options.output,
      terminal: this.options.input.isTTY === true,
    })

    // Read through readline's async iterator rather than awaiting
    // `rl.question()` per turn. Two reasons, and the second one is a bug that
    // is easy to reintroduce:
    //
    //   - `rl.question()` never settles when the input stream closes underneath
    //     it, so a piped invocation would hang on EOF waiting for a prompt
    //     nobody will answer (FR-031b, spec edge case).
    //   - Racing it against the interface's `close` event fixes the hang but
    //     drops input: with piped stdin every line is buffered and `close`
    //     fires while the *first* answer is still being generated, so from the
    //     second turn onward the already-settled race resolves immediately and
    //     the queued lines are silently discarded. The iterator drains what was
    //     buffered and only then ends, which is what "processes what it
    //     receives" has to mean for a follow-up question to survive.
    //
    // Aborting closes the interface, which ends the iterator — so a signal
    // during teardown breaks the loop deterministically rather than incidentally.
    const onAbort = (): void => {
      rl.close()
    }
    this.options.signal?.addEventListener('abort', onAbort, { once: true })

    // Attach the iterator **now**, before anything is awaited.
    //
    // This is the third form of the same bug, and the sharpest. An opening
    // question from argv is answered before the loop starts, and with piped
    // stdin the stream reaches EOF during that answer — so readline emits
    // `close` while `ask()` is still awaiting. An async iterator created after
    // `close` has already fired waits for an event that has been and gone, and
    // never ends: `pnpm agent "a question" < /dev/null` hung forever, with no
    // output and no exit status.
    //
    // Creating it here subscribes before the first `await`, so the buffered
    // lines and the close both land in the iterator rather than being missed.
    const lines = rl[Symbol.asyncIterator]()

    try {
      if (this.options.firstQuestion !== undefined && this.options.firstQuestion.trim() !== '') {
        await this.ask(this.options.firstQuestion)
      }

      this.write(PROMPT)

      for await (const line of lines) {
        if (this.options.signal?.aborted === true) break

        const question = line.trim()
        if (question === '') {
          this.write(PROMPT)
          continue
        }

        if (question === EXIT_COMMAND) {
          this.write('\nExiting.\n')
          break
        }

        await this.ask(question)
        this.write(PROMPT)
      }
    } finally {
      this.options.signal?.removeEventListener('abort', onAbort)
      rl.close()
    }
  }

  /** Put one question to the agent, keeping the exchange in the transcript. */
  async ask(question: string): Promise<string> {
    this.#turns.push({ role: 'user', content: question })

    try {
      // VoltAgent folds its instructions into a system-role entry inside
      // `messages` rather than the AI SDK's separate `system` field, which is
      // exactly the shape the SDK's own injection warning fires on. The
      // instructions are ours, not user input, so there is nothing to warn
      // about; `allowSystemInMessages` isn't in VoltAgent's option type but is
      // forwarded straight through to the AI SDK call, so it's passed via a
      // loosened type rather than declared as unsupported.
      const generateOptions: Record<string, unknown> = {
        allowSystemInMessages: true,
        ...(this.options.signal !== undefined ? { abortSignal: this.options.signal } : {}),
      }
      const result = (await this.#agent.generateText(
        this.#turns.map((turn) => ({ role: turn.role, content: turn.content })),
        generateOptions as Parameters<Agent['generateText']>[1],
      )) as Generation

      const answer = result.text.trim()

      // An empty answer is treated exactly like a failed turn: reported, and
      // dropped from the transcript. Keeping it would send an empty assistant
      // message back on the next turn — a message some providers reject and
      // none can learn anything from — which is why asking again has to start
      // from the question alone.
      if (answer === '') {
        this.write(
          `\nNo answer came back: ${emptyAnswerReason(result)}. ${emptyAnswerAdvice(result)}\n`,
        )
        this.#turns.pop()
        return ''
      }

      this.#turns.push({ role: 'assistant', content: answer })
      this.write(`\n${answer}\n`)
      this.#trimHistory()
      return answer
    } catch (error) {
      if (this.options.signal?.aborted === true) throw error

      // A failed turn must not end the session: the person may want to rephrase,
      // and the context so far is still worth keeping.
      const message = error instanceof Error ? error.message : String(error)
      this.write(`\nThat question could not be answered: ${message}\n`)
      this.#turns.pop()
      return ''
    }
  }

  /**
   * Drop the oldest exchanges once the transcript passes its ceiling (FR-023).
   *
   * Without this the transcript grew until the provider refused it, and the
   * refusal was reported as though the last question were at fault — the person
   * sees "that question could not be answered" about a question that was fine.
   *
   * Dropping happens in **user/assistant pairs**, from the front. A transcript
   * that began with an assistant entry would be an answer to a question no
   * longer present, which some providers reject outright and none can use.
   * Trimming after a completed exchange means the pairing always holds.
   */
  #trimHistory(): void {
    if (this.#turns.length <= this.#maxTurns) return

    const excess = this.#turns.length - this.#maxTurns
    // Round up to a whole exchange, so the first surviving entry is a question.
    const dropped = Math.ceil(excess / 2) * 2
    this.#turns.splice(0, dropped)

    const exchanges = dropped / 2
    // FR-024: silent truncation is how a person loses context without knowing
    // it happened, so the drop is always said out loud.
    this.write(
      `\n[Dropped the ${exchanges} oldest exchange${exchanges === 1 ? '' : 's'} to stay within the context limit.]\n`,
    )
  }

  private write(text: string): void {
    this.#output.write(text)
  }
}
