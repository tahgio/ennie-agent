/**
 * The boundary every tool handler runs inside.
 *
 * Three things have to happen identically for all three tools, and doing them
 * in one place is what keeps them from drifting apart:
 *
 *   1. **Every call gets a budget.** 60s (default; `GBIF_CALL_BUDGET_MS`
 *      overrides it) covering every upstream request the call makes, not that
 *      long per request (FR-026a).
 *   2. **A recoverable failure becomes a result, never an exception.** A thrown
 *      error reaches the client as a JSON-RPC error, which the model cannot see
 *      and therefore cannot act on. `isError: true` puts the failure in the
 *      conversation where the next turn can use it (FR-023, Constitution I/V).
 *   3. **One structured log line per call**, carrying duration, retry count and
 *      cache outcome, to stderr (FR-029).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { isToolError, toToolResult } from '../errors.js'
import { CallBudget, callBudgetMs } from '../gbif/client.js'
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
  const budget = new CallBudget({ totalMs: callBudgetMs() })
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
      // The thrown error's *code*, not its class name. `ToolError` sets
      // `this.name` in its constructor, so reading `error.name` recorded the
      // constant "ToolError" for every failure the server can produce —
      // leaving an operator unable to tell a rate limit from an unknown name
      // without reading prose (FR-001). Anything that is not a `ToolError` is
      // a defect on our side and is recorded as unattributed rather than
      // borrowing a domain category (FR-004).
      errorCode: isToolError(error) ? error.code : 'INTERNAL_ERROR',
    })
    return result
  } finally {
    budget.dispose()
  }
}
