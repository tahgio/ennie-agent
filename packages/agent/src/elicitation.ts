/**
 * Putting a server's `elicitation/create` request to the person at the
 * terminal (FR-036a).
 *
 * This is the client half of the never-guess rule. The server refuses to pick
 * between two taxa that share a name; this is what carries that question to
 * somebody who can actually answer it, and carries the answer back.
 *
 * Whose job this is matters. A server cannot know there is a human, or a
 * terminal, or that the human reads English — so it sends a message and a
 * restricted JSON Schema and lets the client decide how to ask. Rendering that
 * schema is therefore client work in the same way formatting a number with
 * thousand separators is, and for the same reason: only this side knows what
 * the output device is.
 *
 * Two rules hold throughout:
 *
 *   - **Declining is always available and always safe.** Every path that is
 *     not a complete answer returns `cancel`, and the server treats `cancel`
 *     exactly as it treats a client with no elicitation support at all — it
 *     falls back to returning an ambiguity error the model can act on. So a
 *     person who does not want to answer costs the session nothing.
 *   - **Nothing is invented.** A required field with no answer cancels rather
 *     than being filled with a default, which is the same principle the server
 *     applies to a taxon it cannot resolve.
 */
import type { UserInputHandler } from '@voltagent/core'

/**
 * Read one line from the person, or null at end of input.
 *
 * Supplied by the session rather than opened here: the session already owns
 * the one readline interface, and a second reader on the same stdin would
 * steal lines from it.
 */
export type AskLine = (question: string) => Promise<string | null>

/** The words that decline, in addition to an empty line on a required field. */
const CANCEL_WORDS = new Set(['/cancel', '/skip', 'cancel', 'none', 'neither'])

/** One selectable option, normalised from the several shapes the schema allows. */
interface Choice {
  readonly value: string
  readonly label: string
}

/**
 * A property of the requested schema, read structurally.
 *
 * Typed loosely on purpose: this crosses the wire from a server that may be
 * running a newer spec revision than this client, and a field shape we do not
 * recognise should degrade to a free-text question rather than throw.
 */
interface RequestedProperty {
  type?: unknown
  title?: unknown
  description?: unknown
  enum?: unknown
  enumNames?: unknown
  oneOf?: unknown
}

export interface TerminalElicitationOptions {
  readonly ask: AskLine
  readonly write: (text: string) => void
}

export function createTerminalElicitation(options: TerminalElicitationOptions): UserInputHandler {
  const { ask, write } = options

  return async (params) => {
    // URL-mode elicitation asks the client to send someone to a web page.
    // A terminal has no useful way to complete that flow, and pretending to
    // would be worse than saying so.
    if ((params as { mode?: unknown }).mode === 'url') {
      write('\nThe server asked to continue in a browser, which this terminal cannot do.\n')
      return { action: 'cancel' }
    }

    const schema = (params as { requestedSchema?: { properties?: unknown; required?: unknown } })
      .requestedSchema
    const properties = asRecord(schema?.properties)
    const required = new Set(Array.isArray(schema?.required) ? (schema.required as string[]) : [])

    write(`\n${params.message}\n`)

    const content: Record<string, string | number | boolean> = {}

    for (const [name, raw] of Object.entries(properties)) {
      const property = raw as RequestedProperty
      const isRequired = required.has(name)
      const choices = choicesOf(property)

      const answer =
        choices === null
          ? await freeText(ask, write, name, property, isRequired)
          : await fromChoices(ask, write, choices, isRequired)

      if (answer === CANCELLED) return { action: 'cancel' }
      if (answer !== undefined) content[name] = answer
    }

    // Nothing was answered at all: report it as a decline rather than an
    // accept carrying an empty object, which a server would read as "the user
    // answered, and chose nothing".
    if (Object.keys(content).length === 0) return { action: 'decline' }

    return { action: 'accept', content }
  }
}

/** Distinguishes "the person declined" from "this optional field was left blank". */
const CANCELLED = Symbol('cancelled')

/**
 * Normalise the three titled/untitled enum shapes the spec allows into one
 * list. `oneOf` is the current form; `enum` with an optional parallel
 * `enumNames` is the older one, still emitted by plenty of servers.
 */
function choicesOf(property: RequestedProperty): Choice[] | null {
  if (Array.isArray(property.oneOf)) {
    const choices = property.oneOf
      .filter((entry): entry is { const: string; title?: string } => {
        return typeof (entry as { const?: unknown })?.const === 'string'
      })
      .map((entry) => ({ value: entry.const, label: entry.title ?? entry.const }))
    return choices.length > 0 ? choices : null
  }

  if (Array.isArray(property.enum)) {
    const names = Array.isArray(property.enumNames) ? property.enumNames : []
    const choices = property.enum
      .filter((value): value is string => typeof value === 'string')
      .map((value, index) => ({
        value,
        label: typeof names[index] === 'string' ? (names[index] as string) : value,
      }))
    return choices.length > 0 ? choices : null
  }

  return null
}

async function fromChoices(
  ask: AskLine,
  write: (text: string) => void,
  choices: readonly Choice[],
  isRequired: boolean,
): Promise<string | typeof CANCELLED | undefined> {
  for (const [index, choice] of choices.entries()) {
    write(`  ${index + 1}. ${choice.label}\n`)
  }

  const line = await ask(`Choose 1-${choices.length}, or press enter to skip: `)
  if (line === null) return CANCELLED

  const answer = line.trim()
  if (answer === '') return isRequired ? CANCELLED : undefined
  if (CANCEL_WORDS.has(answer.toLowerCase())) return CANCELLED

  // By position, because that is what was displayed. A person who types the
  // label instead is met by the second branch rather than by a rejection.
  const position = Number.parseInt(answer, 10)
  if (Number.isInteger(position) && position >= 1 && position <= choices.length) {
    return choices[position - 1]?.value
  }

  const byLabel = choices.find((choice) =>
    choice.label.toLowerCase().includes(answer.toLowerCase()),
  )
  if (byLabel !== undefined) return byLabel.value

  // One retry would be a loop with no exit condition against piped input, so
  // an unreadable answer declines and lets the server fall back.
  write('That was not one of the options, so nothing was chosen.\n')
  return CANCELLED
}

async function freeText(
  ask: AskLine,
  write: (text: string) => void,
  name: string,
  property: RequestedProperty,
  isRequired: boolean,
): Promise<string | number | boolean | typeof CANCELLED | undefined> {
  const label = typeof property.title === 'string' ? property.title : name
  if (typeof property.description === 'string') write(`  ${property.description}\n`)

  const suffix = isRequired ? '' : ' (optional, press enter to skip)'
  const line = await ask(`${label}${suffix}: `)
  if (line === null) return CANCELLED

  const answer = line.trim()
  if (answer === '') return isRequired ? CANCELLED : undefined
  if (CANCEL_WORDS.has(answer.toLowerCase())) return CANCELLED

  if (property.type === 'boolean') return /^(y|yes|true|1)$/i.test(answer)

  if (property.type === 'number' || property.type === 'integer') {
    const parsed = Number(answer)
    if (!Number.isFinite(parsed)) {
      write('That was not a number, so nothing was submitted.\n')
      return CANCELLED
    }
    return property.type === 'integer' ? Math.trunc(parsed) : parsed
  }

  return answer
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}
