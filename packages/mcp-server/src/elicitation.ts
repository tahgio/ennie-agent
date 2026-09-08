/**
 * Asking the *person* which taxon was meant, when the client can carry the
 * question (FR-005, FR-036a).
 *
 * The never-guess rule already had an answer without this: an ambiguous name
 * returns a `ToolError` naming the candidates, the model reads it, and the
 * agent's instructions tell it to put the choice to the human. That path still
 * exists and is still the fallback — it is the only thing that works against a
 * client with no elicitation support, which is most of them.
 *
 * What it cannot do is *enforce* anything. It asks a model not to guess and
 * then hands it a list of taxon keys; whether the question reaches a person is
 * a matter of how well the model followed its instructions that turn. An
 * `elicitation/create` round trip is structural instead: the server is blocked
 * until a human answers, and the only values it will accept back are the ones
 * it offered. For a rule the whole server is built around, the difference
 * between "asked nicely" and "cannot proceed otherwise" is worth the round
 * trip.
 *
 * Three properties this module keeps, in order of how easy they are to lose:
 *
 *   1. **Elicitation never turns into a new failure mode.** Every path out of
 *      here that is not a confirmed choice returns `null`, and `null` means
 *      "fall back to the ambiguity error the caller already knows how to
 *      render". A client that declines, cancels, times out, or answers with
 *      something that was never on the list is indistinguishable, from the
 *      caller's side, from a client that cannot elicit at all.
 *   2. **Only offered values come back.** The answer is looked up in the
 *      option list rather than parsed into a taxon key, so a client returning
 *      an arbitrary key cannot steer the server at a taxon it never proposed.
 *   3. **The capability is checked, not assumed.** A server that sends
 *      `elicitation/create` to a client that never declared support gets an
 *      error back, and that error would surface as a failed tool call for a
 *      question the server could have answered with a plain error result.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { MatchNameInput } from './gbif/species.js'

/**
 * How long the server will hold a tool call open waiting for a person.
 *
 * Five minutes, and the two halves of that number are worth separating.
 *
 * **Why it is so much longer than any upstream timeout.** This is human
 * latency, not network latency. It is not charged to the GBIF call budget
 * either — see `CallBudget.pause()` — because the budget bounds how long GBIF
 * is held waiting, and a person reading two taxon names is not upstream work.
 *
 * **Why it is bounded at all.** A client that accepts an `elicitation/create`
 * and then never answers would otherwise hold this tool call open forever. The
 * cost of the timeout is a narrow race: if the person answers *after* it
 * fires, the server has already fallen back to the ambiguity error, and their
 * keystroke lands in a client that is no longer being waited on. Five minutes
 * puts that far outside the time anyone spends choosing between two taxa,
 * which is the best available trade — a client cannot be relied on to notice
 * the cancellation, since not every client library passes the request's abort
 * signal to its elicitation handler.
 */
export const ELICITATION_TIMEOUT_MS = 300_000

/**
 * One taxon the caller may have meant, together with the lookup that would
 * resolve it.
 *
 * Carrying `retry` rather than just the key is what lets one elicitation
 * serve both ambiguity paths. A cross-kingdom homonym is re-resolved by
 * re-matching the *original* name with a kingdom hint — precisely the recovery
 * the ambiguity error already advises in prose — while a common name that
 * points at several taxa is re-resolved by matching the chosen scientific
 * name. Both end up back in `applyMatchPolicy`, so a chosen taxon that turns
 * out to be a synonym still resolves to its accepted form.
 */
export interface TaxonOption {
  readonly taxonKey: number
  /** What the person reads. Names the taxon and whatever distinguishes it. */
  readonly label: string
  readonly retry: MatchNameInput
}

export interface ElicitTaxonRequest {
  /** The name as the caller supplied it, quoted back in the question. */
  readonly name: string
  readonly options: readonly TaxonOption[]
  /** The client's cancellation signal, so an abandoned request stops asking. */
  readonly signal?: AbortSignal | undefined
}

/**
 * Ask which taxon was meant. Resolves to the chosen option, or to `null` for
 * every other outcome — see property 1 in the file comment.
 */
export type ElicitTaxon = (request: ElicitTaxonRequest) => Promise<TaxonOption | null>

/**
 * Build the elicitation bound to one server, and therefore to one client.
 *
 * The capability check reads the *connected* client's declaration on every
 * call rather than being decided once at registration: `createServer()` runs
 * before any client has connected, so there is nothing to read at that point.
 */
export function createElicitTaxon(server: McpServer): ElicitTaxon {
  return async ({ name, options, signal }) => {
    // Nothing to ask about. One option is not an ambiguity, and zero means the
    // caller could not build a question worth putting.
    if (options.length < 2) return null

    if (server.server.getClientCapabilities()?.elicitation === undefined) return null

    try {
      const result = await server.server.elicitInput(
        {
          message:
            `'${name}' matches ${options.length} different taxa in GBIF, and they are not the same organism. ` +
            'Which one did you mean?',
          requestedSchema: {
            type: 'object',
            properties: {
              // A titled single-select: the value is the taxon key, but what a
              // person is shown is the label. Sending a bare key list would
              // ask the human to know GBIF's numbering.
              taxonKey: {
                type: 'string',
                title: 'Taxon',
                description: `Which taxon '${name}' refers to.`,
                oneOf: options.map((option) => ({
                  const: String(option.taxonKey),
                  title: option.label,
                })),
              },
            },
            required: ['taxonKey'],
          },
        },
        {
          ...(signal === undefined ? {} : { signal }),
          timeout: ELICITATION_TIMEOUT_MS,
        },
      )

      // "decline" and "cancel" are both real answers, and neither is a choice.
      if (result.action !== 'accept') return null

      const answer = result.content?.taxonKey
      if (typeof answer !== 'string') return null

      // Property 2: the answer selects from what was offered. It is never
      // parsed into a key, so an unoffered value simply finds nothing.
      return options.find((option) => String(option.taxonKey) === answer) ?? null
    } catch {
      // Property 1. A client that cannot answer — no handler registered, the
      // request timed out, the connection went away — leaves the caller
      // exactly where it would have been without elicitation at all.
      return null
    }
  }
}
