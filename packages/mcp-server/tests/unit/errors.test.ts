/**
 * The last line of defence at the tool boundary (FR-004, FR-045).
 *
 * `toToolResult` is what stands between a defect in this server and the model
 * reading a stack trace. Two things about it are load-bearing and pull in
 * opposite directions, which is why they are tested together:
 *
 *   - The **message** to the caller must not change. It already says the right
 *     thing: an internal fault, retry once, and if it persists this is our bug
 *     rather than a problem with the request.
 *   - The **recorded category** must change. It said `UPSTREAM_UNAVAILABLE`,
 *     which is a lie about whose fault it is: an operator counting failure
 *     kinds over a day sees our own defects filed under someone else's outage.
 *
 * So the text below is asserted byte-for-byte deliberately (FR-049 — no
 * observable contract may change), while the code is asserted to have moved.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolError, toToolResult } from '../../src/errors.js'
import { logger, type ToolCallLog } from '../../src/logging.js'
import { runTool } from '../../src/tools/run-tool.js'

const NO_SERVER = null as unknown as McpServer

const INTERNAL_WHAT = 'The server hit an unexpected internal error while handling this call.'
const INTERNAL_NEXT =
  'Retry once; if it persists, this is a defect in the server rather than a problem with your request.'

describe('toToolResult — the non-ToolError fallback', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the internal-fault text unchanged, for any non-ToolError', () => {
    for (const thrown of [
      new TypeError('cannot read properties of undefined'),
      new RangeError('out of range'),
      'a bare string',
      undefined,
      { message: 'not an Error at all' },
    ]) {
      const result = toToolResult(thrown)

      expect(result.isError).toBe(true)
      expect(result.content).toEqual([{ type: 'text', text: `${INTERNAL_WHAT} ${INTERNAL_NEXT}` }])
    }
  })

  it('leaks neither a stack trace nor the library message to the model', () => {
    const result = toToolResult(new TypeError('secretInternal.field is not a function'))
    const [block] = result.content

    expect(block?.text).not.toContain('secretInternal')
    expect(block?.text).not.toContain('TypeError')
    expect(block?.text).not.toContain('at ')
  })

  it('attaches no structuredContent to an error result', () => {
    // A tool declaring an outputSchema describes its *success* shape; a payload
    // on an error result would be rejected by the SDK's outgoing validation.
    expect(toToolResult(new Error('boom')).structuredContent).toBeUndefined()
  })

  it('renders a ToolError as designed, rather than as an internal fault', () => {
    const result = toToolResult(
      new ToolError({
        code: 'NOT_FOUND',
        what: "No taxon matches 'Nonsense nonsense'.",
        next: 'Check the spelling, or try a vernacular name.',
        retryable: false,
      }),
    )

    expect(result.content).toEqual([
      {
        type: 'text',
        text: "No taxon matches 'Nonsense nonsense'. Check the spelling, or try a vernacular name.",
      },
    ])
  })

  it('records an unexpected fault as INTERNAL_ERROR, never as an upstream outage', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)

    await runTool(NO_SERVER, 'resolve_taxon', undefined, () => {
      throw new TypeError('a defect on our side')
    })

    const [entry] = warn.mock.calls[0] as [ToolCallLog]

    expect(entry.errorCode).toBe('INTERNAL_ERROR')
    expect(entry.errorCode).not.toBe('UPSTREAM_UNAVAILABLE')
  })

  it('keeps the caller-facing message identical whichever code is recorded', async () => {
    const result = await runTool(NO_SERVER, 'resolve_taxon', undefined, () => {
      throw new TypeError('a defect on our side')
    })

    // The code moved; the sentence the model reads did not (FR-049).
    expect(result.content).toEqual([{ type: 'text', text: `${INTERNAL_WHAT} ${INTERNAL_NEXT}` }])
  })
})

describe('ToolError', () => {
  it('renders what and next as one sentence pair, in that order', () => {
    const error = new ToolError({
      code: 'EMPTY_NAME',
      what: 'The name is empty.',
      next: 'Supply a scientific or vernacular name.',
      retryable: false,
    })

    expect(error.message).toBe('The name is empty. Supply a scientific or vernacular name.')
    expect(error.toToolResult().content[0]?.text).toBe(error.message)
  })

  it('carries the retry semantics the negative cache reads (FR-007)', () => {
    const transient = new ToolError({
      code: 'UPSTREAM_UNAVAILABLE',
      what: 'Upstream is unavailable.',
      next: 'Retry shortly.',
      retryable: true,
    })
    const settled = new ToolError({
      code: 'NOT_FOUND',
      what: 'No match.',
      next: 'Check the spelling.',
      retryable: false,
    })

    expect(transient.retryable).toBe(true)
    expect(settled.retryable).toBe(false)
  })
})
