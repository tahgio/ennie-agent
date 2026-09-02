/**
 * Errors are messages to a model (Constitution V, FR-023, FR-024).
 *
 * Every failure this server can produce names two things: what went wrong, and
 * what the caller should do instead. `next` is a required field, which is the
 * whole point — a bare "Invalid input" is not expressible in this type. If you
 * find yourself with nothing to put in `next`, the error is not yet understood
 * well enough to return.
 *
 * These are thrown internally and converted at the tool boundary into a result
 * with `isError: true`. They are never allowed to escape as exceptions: a
 * thrown error is invisible to the model's reasoning, so it cannot recover from
 * one, whereas an error *result* lands in the conversation where the model can
 * act on it next turn.
 */

/**
 * The failure taxonomy. Codes are not sent to the client — the rendered
 * sentences are — but they keep the mapping between a condition and its message
 * checkable in tests, and they carry the retry semantics.
 */
export type ToolErrorCode =
  // Resolution (contracts/resolve-taxon.md)
  | 'AMBIGUOUS'
  | 'NOT_FOUND'
  | 'LOW_CONFIDENCE'
  | 'HIGHER_RANK'
  // Input validation, all raised before any network call (FR-011, FR-012)
  | 'EMPTY_NAME'
  | 'INVALID_COUNTRY'
  | 'INVALID_YEAR_RANGE'
  | 'LIMIT_EXCEEDED'
  | 'OFFSET_EXCEEDED'
  | 'NO_DIMENSIONS'
  | 'MISSING_TAXON'
  | 'CONTRADICTORY_TAXON'
  // Upstream (contracts/search-occurrences.md)
  | 'UPSTREAM_RATE_LIMITED'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_BAD_REQUEST'
  | 'CANCELLED'
  // Unattributed: a fault with no defined condition behind it. Never borrows a
  // domain category, so a defect in this server cannot read as an upstream
  // outage in the diagnostic record (FR-004).
  | 'INTERNAL_ERROR'

export interface ToolErrorFields {
  readonly code: ToolErrorCode
  /** What went wrong, in one sentence, naming the offending value. */
  readonly what: string
  /** What to do instead, in one sentence. Required — see the file comment. */
  readonly next: string
  /** Whether repeating the identical call could plausibly succeed. */
  readonly retryable: boolean
}

/** The shape a tool returns on a recoverable failure. */
export interface ToolErrorResult {
  isError: true
  content: Array<{ type: 'text'; text: string }>
  /** The SDK's result type carries an index signature; this matches it. */
  [key: string]: unknown
}

export class ToolError extends Error implements ToolErrorFields {
  readonly code: ToolErrorCode
  readonly what: string
  readonly next: string
  readonly retryable: boolean

  constructor(fields: ToolErrorFields) {
    // The Error message is the rendered pair, so a stray stack trace in the
    // logs still says something useful to a human reading stderr.
    super(`${fields.what} ${fields.next}`)
    this.name = 'ToolError'
    this.code = fields.code
    this.what = fields.what
    this.next = fields.next
    this.retryable = fields.retryable
  }

  /**
   * Render into an MCP tool result. Both sentences go in the text block,
   * because the text block is what the model reads.
   *
   * No `structuredContent` is attached: a tool declaring an `outputSchema`
   * describes its *success* shape, and an error result carrying a payload that
   * does not match it would be rejected by the SDK's outgoing validation.
   */
  toToolResult(): ToolErrorResult {
    return {
      isError: true,
      content: [{ type: 'text', text: `${this.what} ${this.next}` }],
    }
  }
}

export function isToolError(error: unknown): error is ToolError {
  return error instanceof ToolError
}

/**
 * Last line of defence at the tool boundary. A `ToolError` renders as designed;
 * anything else is a bug on our side, and is reported as such rather than
 * leaking a stack trace or a library's internal message to the model.
 *
 * This still returns `isError: true` rather than throwing, because even our own
 * bug is better delivered somewhere the model can see and route around it.
 */
export function toToolResult(error: unknown): ToolErrorResult {
  if (isToolError(error)) return error.toToolResult()

  return new ToolError({
    // Unattributed: our own defect must not be filed under an upstream outage.
    // Only the code changes here — `what`, `next` and `retryable` are
    // byte-identical, because the sentence the caller reads is a contract
    // (FR-004, FR-049).
    code: 'INTERNAL_ERROR',
    what: 'The server hit an unexpected internal error while handling this call.',
    next: 'Retry once; if it persists, this is a defect in the server rather than a problem with your request.',
    retryable: true,
  }).toToolResult()
}
