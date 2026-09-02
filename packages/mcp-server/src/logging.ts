/**
 * Logging, on the strict understanding that stdout belongs to the protocol
 * (Constitution I, FR-025).
 *
 * In stdio mode a single stray byte on stdout corrupts the JSON-RPC stream, and
 * the user sees an unexplainable client parse error rather than a log line. So
 * pino is pointed at file descriptor 2 explicitly — not at pino's default
 * destination, which is stdout.
 *
 * Two channels, because they serve different readers (research D10):
 *   - pino to stderr, for the developer watching the terminal
 *   - MCP `notifications/message`, for clients that render server logs in-app
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { destination, pino } from 'pino'
import type { ToolErrorCode } from './errors.js'

/** FD 2. Never 1. This single argument is the whole stdout guarantee for pino. */
const STDERR_FD = 2

const LEVEL = process.env.LOG_LEVEL ?? 'info'

export const logger = pino(
  {
    level: LEVEL,
    base: { name: 'gbif-mcp-server' },
    formatters: {
      // Emit the level as a word rather than a number; these logs are read by
      // people, in a terminal, next to whatever else is on stderr.
      level: (label) => ({ level: label }),
    },
  },
  destination({ dest: STDERR_FD, sync: true }),
)

/** MCP logging levels, in the subset this server actually emits. */
type McpLevel = 'debug' | 'info' | 'warning' | 'error'

/** The outcome of a resolution cache lookup, recorded on every tool call (FR-030). */
export type CacheOutcome = 'hit' | 'miss' | 'n/a'

/** One structured record per tool call (FR-029). */
export interface ToolCallLog {
  readonly tool: string
  /** Wall-clock duration of the whole call, milliseconds. */
  readonly durationMs: number
  /** How many upstream attempts were retried (0 when the first attempt worked). */
  readonly retries: number
  readonly cache: CacheOutcome
  /** How many requests actually left the process — 1 for a summary, by design. */
  readonly upstreamRequests: number
  readonly outcome: 'ok' | 'error'
  /**
   * Present only on failure.
   *
   * The type is the closed `ToolErrorCode` union rather than `string`, and that
   * is what discharges FR-003 — no caller-supplied value is *expressible*
   * here, so no sanitising step is needed to keep one out.
   */
  readonly errorCode?: ToolErrorCode
}

/**
 * Emit a tool-call record to stderr and, best-effort, to the connected client.
 *
 * The client notification is deliberately fire-and-forget: a client that has
 * not enabled logging, or has already gone away, must not turn a successful
 * tool call into a failed one.
 */
export function logToolCall(server: McpServer | null, entry: ToolCallLog): void {
  const level: McpLevel = entry.outcome === 'ok' ? 'info' : 'warning'

  if (entry.outcome === 'ok') {
    logger.info(entry, `${entry.tool} ok in ${entry.durationMs}ms`)
  } else {
    logger.warn(entry, `${entry.tool} failed in ${entry.durationMs}ms: ${entry.errorCode}`)
  }

  notify(server, level, entry)
}

/**
 * Send an MCP logging notification, swallowing every failure.
 *
 * `server.isConnected()` is false during unit tests and before a transport is
 * attached, and the SDK throws if a notification is sent to a client that never
 * declared the logging capability.
 */
export function notify(server: McpServer | null, level: McpLevel, data: unknown): void {
  if (server === null) return

  try {
    if (!server.isConnected()) return
    void server.server.sendLoggingMessage({ level, logger: 'gbif-mcp-server', data }).catch(() => {
      // A client that cannot receive logs is not an error condition.
    })
  } catch {
    // Same reasoning: logging must never be able to fail a tool call.
  }
}
