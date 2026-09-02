/**
 * The failure category on the diagnostic record (FR-001, FR-004, FR-006).
 *
 * The record already existed, was already emitted on both channels, and was
 * already documented as carrying the failure category. It carried the string
 * `"ToolError"` instead — for every failure, without exception — because
 * `ToolError`'s constructor sets `this.name`, and the record was built from
 * `error.name`.
 *
 * That is the difference between "the server is failing" and "the server is
 * being rate-limited", which call for entirely different responses. So these
 * tests assert one failure from each family lands as its own code, and — the
 * part that actually bites — that no two families collapse onto the same value.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolError, type ToolErrorCode } from '../../src/errors.js'
import { logger, type ToolCallLog } from '../../src/logging.js'
import { runTool } from '../../src/tools/run-tool.js'

/**
 * No client is connected in a unit test, so the notification channel is a
 * no-op and `logger.warn` is the whole observable record. `notify` returns
 * early on a null server, which is why this cast is safe rather than merely
 * convenient.
 */
const NO_SERVER = null as unknown as McpServer

/** Run a handler that throws, and return the record that was logged. */
async function recordFor(error: unknown): Promise<ToolCallLog> {
  // Re-spying the same method returns the same spy, so its call history has to
  // be cleared per invocation or the loop below counts every earlier call too.
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
  warn.mockClear()

  const result = await runTool(NO_SERVER, 'search_occurrences', undefined, () => {
    throw error
  })

  // The failure must still reach the caller as a result, never an exception:
  // a thrown error is invisible to the model's reasoning (Constitution I/V).
  expect(result.isError).toBe(true)

  expect(warn).toHaveBeenCalledTimes(1)
  const [entry] = warn.mock.calls[0] as [ToolCallLog]
  return entry
}

const toolError = (code: ToolErrorCode, retryable: boolean): ToolError =>
  new ToolError({
    code,
    what: `Something went wrong (${code}).`,
    next: 'Try something else.',
    retryable,
  })

describe('the recorded failure category', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('records a resolution failure as its own code, not the class name', async () => {
    const entry = await recordFor(toolError('NOT_FOUND', false))

    expect(entry.outcome).toBe('error')
    expect(entry.errorCode).toBe('NOT_FOUND')
    // The defect this test exists for.
    expect(entry.errorCode).not.toBe('ToolError')
  })

  it('records an input-validation failure as its own code', async () => {
    const entry = await recordFor(toolError('INVALID_COUNTRY', false))

    expect(entry.errorCode).toBe('INVALID_COUNTRY')
  })

  it('records an upstream failure as its own code', async () => {
    const entry = await recordFor(toolError('UPSTREAM_RATE_LIMITED', true))

    expect(entry.errorCode).toBe('UPSTREAM_RATE_LIMITED')
  })

  it('records a cancellation as its own code', async () => {
    const entry = await recordFor(toolError('CANCELLED', false))

    expect(entry.errorCode).toBe('CANCELLED')
  })

  it('records an unattributed fault without borrowing a domain category', async () => {
    const entry = await recordFor(new TypeError('reading property of undefined'))

    expect(entry.errorCode).toBe('INTERNAL_ERROR')
    // A defect in this server must not read as an upstream outage.
    expect(entry.errorCode).not.toBe('UPSTREAM_UNAVAILABLE')
  })

  it('distinguishes every family from every other — the point of FR-001', async () => {
    const families: ToolErrorCode[] = [
      'NOT_FOUND',
      'AMBIGUOUS',
      'INVALID_COUNTRY',
      'UPSTREAM_RATE_LIMITED',
      'UPSTREAM_TIMEOUT',
      'UPSTREAM_UNAVAILABLE',
      'CANCELLED',
    ]

    const recorded: Array<string | undefined> = []
    for (const code of families) {
      const entry = await recordFor(toolError(code, false))
      recorded.push(entry.errorCode)
    }

    expect(recorded).toEqual(families)
    // Distinguishable *from one another*, which a single constant is not.
    expect(new Set(recorded).size).toBe(families.length)
  })

  it('carries no caller-supplied value in the category field (FR-003)', async () => {
    const entry = await recordFor(
      new ToolError({
        code: 'NOT_FOUND',
        what: "No match for 'Ursus maritimus <script>alert(1)</script>'.",
        next: 'Check the spelling.',
        retryable: false,
      }),
    )

    // The category is drawn from a closed union; the caller's text lives in the
    // message and never in this field.
    expect(entry.errorCode).toBe('NOT_FOUND')
  })

  it('records a successful call with no category at all', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined)

    await runTool(NO_SERVER, 'search_occurrences', undefined, async () => ({
      content: [{ type: 'text' as const, text: 'fine' }],
    }))

    const [entry] = info.mock.calls[0] as [ToolCallLog]
    expect(entry.outcome).toBe('ok')
    expect(entry.errorCode).toBeUndefined()
  })
})
