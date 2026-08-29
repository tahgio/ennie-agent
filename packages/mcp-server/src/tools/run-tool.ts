/**
 * The boundary every tool handler runs inside.
 *
 * Three things have to happen identically for all three tools, and doing them
 * in one place is what keeps them from drifting apart:
 *
 *   1. **Every call gets a budget.** 30s covering every upstream request the
 *      call makes, not 30s per request (FR-026a).
 *   2. **A recoverable failure becomes a result, never an exception.** A thrown
 *      error reaches the client as a JSON-RPC error, which the model cannot see
 *      and therefore cannot act on. `isError: true` puts the failure in the
 *      conversation where the next turn can use it (FR-023, Constitution I/V).
 *   3. **One structured log line per call**, carrying duration, retry count and
 *      cache outcome, to stderr (FR-029).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { toToolResult } from '../errors.js'
import { CallBudget } from '../gbif/client.js'
import { type CacheOutcome, logToolCall } from '../logging.js'

/** What a handler reports back about the work it did, for the log line. */
export interface ToolRunStats {
  cache: CacheOutcome
  upstreamRequests: number
  retries: number
}

export interface ToolRunContext {
  readonly budget: CallBudget
  /** The client's cancellation signal, threaded through to the socket (FR-028). */
  readonly signal: AbortSignal | undefined
  /** Handlers update this as they go; it is read when the call is logged. */
  readonly stats: ToolRunStats
}

/**
 * The MCP result shape a tool handler returns.
 *
 * Deliberately mutable: the SDK's own result type is mutable, and a readonly
 * array is not assignable to it.
 */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
  /** The SDK's result type carries an index signature; this matches it. */
  [key: string]: unknown
}

export async function runTool(
  server: McpServer,
  toolName: string,
  extra: { signal?: AbortSignal } | undefined,
  handler: (context: ToolRunContext) => Promise<ToolResult>,
): Promise<ToolResult> {
  const startedAt = Date.now()
  const budget = new CallBudget()
  const context: ToolRunContext = {
    budget,
    signal: extra?.signal,
    stats: { cache: 'n/a', upstreamRequests: 0, retries: 0 },
  }

  try {
    const result = await handler(context)
    logToolCall(server, {
      tool: toolName,
      durationMs: Date.now() - startedAt,
      retries: context.stats.retries,
      cache: context.stats.cache,
      upstreamRequests: context.stats.upstreamRequests,
      outcome: 'ok',
    })
    return result
  } catch (error) {
    const result = toToolResult(error)
    logToolCall(server, {
      tool: toolName,
      durationMs: Date.now() - startedAt,
      retries: context.stats.retries,
      cache: context.stats.cache,
      upstreamRequests: context.stats.upstreamRequests,
      outcome: 'error',
      errorCode: error instanceof Error ? error.name : 'unknown',
    })
    return result
  } finally {
    budget.dispose()
  }
}
