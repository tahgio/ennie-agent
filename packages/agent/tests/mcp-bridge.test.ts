/**
 * The pure parts of the MCP bridge (FR-021, FR-022).
 *
 * `connectBridge` itself needs a connected server and is covered by the
 * protocol suite on the other side of the wire. What is worth testing here is
 * everything it does *to* what a server said — flattening prompt messages,
 * rendering a log record for a terminal, reading a level out of the
 * environment — because each of those is a place where a server's data is
 * reshaped, and reshaping is where things get quietly lost.
 */
import { describe, expect, it } from 'vitest'
import { flattenPromptMessages, formatLogRecord, mcpLogLevel } from '../src/mcp-bridge.js'

describe('flattenPromptMessages', () => {
  it('joins the text blocks of a multi-message prompt', () => {
    const text = flattenPromptMessages([
      { role: 'user', content: { type: 'text', text: 'First.' } },
      { role: 'user', content: { type: 'text', text: 'Second.' } },
    ])

    expect(text).toBe('First.\n\nSecond.')
  })

  it('says so when it could not include part of a prompt', () => {
    const text = flattenPromptMessages([
      { role: 'user', content: { type: 'text', text: 'Look at this:' } },
      { role: 'user', content: { type: 'image' } },
    ])

    // Dropping content silently is the failure mode: the person asked for a
    // prompt and would receive a truncated one with no way to know.
    expect(text).toContain('Look at this:')
    expect(text).toContain('1 non-text block')
  })

  it('returns empty text for a prompt with nothing renderable', () => {
    expect(flattenPromptMessages([])).toBe('')
  })
})

describe('formatLogRecord', () => {
  it('renders a tool-call record as one readable line', () => {
    const line = formatLogRecord({
      level: 'info',
      logger: 'gbif-mcp-server',
      data: {
        tool: 'summarize_occurrences',
        durationMs: 412,
        cache: 'hit',
        upstreamRequests: 1,
        retries: 0,
        outcome: 'ok',
      },
    })

    expect(line).toContain('summarize_occurrences')
    expect(line).toContain('412ms')
    expect(line).toContain('cache=hit')
    expect(line).toContain('upstream=1')
    // Zero retries is the ordinary case and says nothing; printing it on every
    // line would bury the times it is not zero.
    expect(line).not.toContain('retries=')
    expect(line.endsWith('\n')).toBe(true)
  })

  it('carries the error code, which is the whole point of a failure record', () => {
    const line = formatLogRecord({
      level: 'warning',
      logger: 'gbif-mcp-server',
      data: { tool: 'resolve_taxon', durationMs: 90, outcome: 'error', errorCode: 'AMBIGUOUS' },
    })

    expect(line).toContain('error=AMBIGUOUS')
  })

  it('falls back to JSON for a shape it does not recognise', () => {
    // A server is free to send anything as `data`. Printing nothing would be
    // worse than printing something ugly.
    const line = formatLogRecord({ level: 'debug', data: { something: 'else' } })

    expect(line).toContain('something')
  })
})

describe('mcpLogLevel', () => {
  it('defaults to warning, so a successful call is not narrated', () => {
    expect(mcpLogLevel({})).toBe('warning')
  })

  it('takes a valid level from the environment', () => {
    expect(mcpLogLevel({ MCP_LOG_LEVEL: 'info' })).toBe('info')
    expect(mcpLogLevel({ MCP_LOG_LEVEL: ' DEBUG ' })).toBe('debug')
  })

  it('ignores a level that is not one, rather than failing startup', () => {
    expect(mcpLogLevel({ MCP_LOG_LEVEL: 'chatty' })).toBe('warning')
  })
})
