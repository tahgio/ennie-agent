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
import { AMBIGUOUS_PROMPT, type PromptCatalog, type PromptSummary } from './mcp-bridge.js'

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
   * The server's prompts, when it publishes any (FR-022).
   *
   * A prompt is the one part of an MCP surface a *person* invokes rather than
   * a model, so a client that discovers prompts and then offers no way to run
   * one has read the list for nothing.
   */
  readonly prompts?: PromptCatalog | null | undefined
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
const HELP_COMMAND = '/help'
const PROMPTS_COMMAND = '/prompts'

/** `country=CA` — a named argument for a server prompt. */
const NAMED_ARGUMENT = /^([A-Za-z_][A-Za-z0-9_-]*)=(.*)$/

/** 20 exchanges. See `SessionOptions.maxTurns`. */
const DEFAULT_MAX_TURNS = 40

export class Session {
  readonly #agent: Agent
  readonly #turns: Turn[] = []
  readonly #output: NodeJS.WritableStream
  readonly #maxTurns: number
  /**
   * The one reader of stdin, held so `askLine()` can borrow it.
   *
   * Null until `run()` starts and again once it ends, which is what makes an
   * out-of-band question — an elicitation arriving before the loop, or after
   * it — answerable with "there is nobody to ask" rather than a hang.
   */
  #lines: AsyncIterator<string> | null = null

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
    // Elicitation borrows this same iterator rather than opening its own
    // reader. The loop below is not pulling from it while a turn is being
    // generated — which is exactly when a server can ask a question — so the
    // two never compete for a line.
    this.#lines = lines

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

        if (question.startsWith('/')) {
          await this.#command(question)
          this.write(PROMPT)
          continue
        }

        await this.ask(question)
        this.write(PROMPT)
      }
    } finally {
      this.#lines = null
      this.options.signal?.removeEventListener('abort', onAbort)
      rl.close()
    }
  }

  /**
   * Ask the person one question mid-turn and read their reply.
   *
   * Used by the elicitation handler, which is invoked from inside a tool call,
   * inside a generation. Returns null when there is nobody to ask — before the
   * loop starts, after it ends, or at end of piped input — so a caller can
   * decline on the person's behalf instead of waiting for a line that will
   * never arrive.
   */
  async askLine(question: string): Promise<string | null> {
    const lines = this.#lines
    if (lines === null) return null
    if (this.options.signal?.aborted === true) return null

    this.write(question)
    const next = await lines.next()
    return next.done === true ? null : next.value
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

  // -------------------------------------------------------------------------
  // Slash commands, and the server's prompts (FR-022)
  // -------------------------------------------------------------------------

  /**
   * Dispatch a line beginning with `/`.
   *
   * Anything not built in is looked up as a **server prompt**, which is the
   * point of this whole section: `prompts/list` is discovered at connect time,
   * so a server that publishes a new prompt gets a new command here without
   * this client being changed or even redeployed. Nothing about
   * `species_distribution_report` is named in this package.
   *
   * An unknown command is reported rather than sent to the model. A person who
   * mistypes a command wants to be told so, not to have the typo answered as
   * though it were a question about biodiversity.
   */
  async #command(line: string): Promise<void> {
    const body = line.slice(1)
    const space = body.search(/\s/)
    const name = (space === -1 ? body : body.slice(0, space)).trim()
    const argText = space === -1 ? '' : body.slice(space + 1).trim()

    if (`/${name}` === HELP_COMMAND) {
      this.#writeHelp()
      return
    }

    if (`/${name}` === PROMPTS_COMMAND) {
      this.#writePrompts()
      return
    }

    const catalog = this.options.prompts
    if (catalog === null || catalog === undefined) {
      this.write(`\nUnknown command /${name}. The connected server publishes no prompts.\n`)
      return
    }

    const found = catalog.find(name)
    if (found === AMBIGUOUS_PROMPT) {
      this.write(`\n/${name} matches more than one prompt. Run /prompts and use a longer name.\n`)
      return
    }
    if (found === null) {
      this.write(`\nUnknown command /${name}. Try /help or /prompts.\n`)
      return
    }

    await this.#runPrompt(catalog, found, argText)
  }

  /**
   * Fetch a prompt from the server and put its text to the model as this
   * turn's question.
   *
   * The rendered text is printed before it is sent. A prompt is somebody
   * else's instructions being spoken in the user's name — they are entitled to
   * see what was said on their behalf, and without this the answer would refer
   * to steps that appear nowhere in the transcript they can read.
   */
  async #runPrompt(catalog: PromptCatalog, prompt: PromptSummary, argText: string): Promise<void> {
    const args = parsePromptArguments(prompt, argText)

    const missing = prompt.arguments
      .filter((argument) => argument.required === true && (args[argument.name] ?? '') === '')
      .map((argument) => argument.name)
    if (missing.length > 0) {
      this.write(`\n/${prompt.name} needs ${missing.join(', ')}. ${usageLine(prompt)}\n`)
      return
    }

    let text: string
    try {
      text = await catalog.render(prompt.name, args)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.write(`\nThe server could not build /${prompt.name}: ${message}\n`)
      return
    }

    if (text.trim() === '') {
      this.write(`\n/${prompt.name} returned nothing to ask.\n`)
      return
    }

    this.write(`\n[/${prompt.name}]\n${text}\n`)
    await this.ask(text)
  }

  #writeHelp(): void {
    this.write(
      `\nAsk a question in plain language, or use a command:\n` +
        `  ${HELP_COMMAND}     this message\n` +
        `  ${PROMPTS_COMMAND}  the prompts published by the connected server\n` +
        `  ${EXIT_COMMAND}     end the session\n`,
    )
  }

  #writePrompts(): void {
    const catalog = this.options.prompts
    if (catalog === null || catalog === undefined || catalog.all.length === 0) {
      this.write('\nThe connected server publishes no prompts.\n')
      return
    }

    this.write('\nPrompts published by the connected server:\n')
    for (const prompt of catalog.all) {
      this.write(`  /${prompt.name}\n`)
      if (prompt.description !== undefined) this.write(`      ${prompt.description}\n`)
      this.write(`      ${usageLine(prompt)}\n`)
    }
    // Any unique fragment of the name is enough, which is the difference
    // between a usable command and one nobody types twice.
    this.write('\nAn unambiguous part of the name is enough, e.g. /report.\n')
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

/**
 * Read `key=value` pairs out of a command line, and treat whatever is left as
 * the first required argument.
 *
 * Prompt arguments cross the wire as strings, so there is no parsing to do
 * beyond splitting them up. The positional fallback exists because the common
 * case is a single argument containing spaces — `/report polar bear` — and
 * requiring `species="polar bear"` for that would be a quoting rule invented
 * to serve the parser rather than the person.
 */
export function parsePromptArguments(
  prompt: PromptSummary,
  argText: string,
): Record<string, string> {
  const args: Record<string, string> = {}
  const positional: string[] = []

  for (const token of argText.split(/\s+/).filter((part) => part !== '')) {
    const named = NAMED_ARGUMENT.exec(token)
    // A named argument is only named if the prompt actually declares it;
    // otherwise `Ursus x=1` would silently drop a word out of a species name.
    if (named !== null && prompt.arguments.some((argument) => argument.name === named[1])) {
      args[named[1] as string] = named[2] as string
    } else {
      positional.push(token)
    }
  }

  if (positional.length > 0) {
    const target =
      prompt.arguments.find(
        (argument) => argument.required === true && args[argument.name] === undefined,
      ) ?? prompt.arguments.find((argument) => args[argument.name] === undefined)
    if (target !== undefined) args[target.name] = positional.join(' ')
  }

  return args
}

/** `usage: /name <required> [optional=…]` */
export function usageLine(prompt: PromptSummary): string {
  const parts = prompt.arguments.map((argument) =>
    argument.required === true ? `<${argument.name}>` : `[${argument.name}=…]`,
  )
  return `usage: /${prompt.name}${parts.length === 0 ? '' : ` ${parts.join(' ')}`}`
}
