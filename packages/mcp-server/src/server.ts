/**
 * `createServer()` — a fully configured MCP server that knows nothing about
 * transports (research D7, plan D7).
 *
 * The separation is not ceremony. It buys two concrete things:
 *
 *   1. Adding an HTTP transport later is a new entrypoint, not a refactor —
 *      which is what makes that non-goal in the spec honest rather than
 *      aspirational.
 *   2. The protocol tests connect *this* server object to an in-memory
 *      transport, so they exercise the same registration path that ships,
 *      rather than a test double that resembles it (FR-039).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ResolvedTaxon } from './domain/resolution.js'
import { TtlCache } from './gbif/cache.js'
import { GbifClient } from './gbif/client.js'
import { SERVER_INSTRUCTIONS } from './instructions.js'

export const SERVER_NAME = 'gbif-mcp-server'
export const SERVER_VERSION = '0.1.0'

export interface CreateServerOptions {
  /** Injected by tests so the default suite never opens a socket (FR-038). */
  readonly client?: GbifClient
  /** Injected so tests can drive TTL expiry without waiting an hour. */
  readonly cache?: TtlCache<ResolvedTaxon>
}

/**
 * What every tool registration needs. Passed explicitly rather than reached for
 * through module state, so a test can stand up an isolated server with its own
 * stubbed client and its own empty cache.
 */
export interface ToolContext {
  readonly server: McpServer
  readonly client: GbifClient
  readonly cache: TtlCache<ResolvedTaxon>
}

/**
 * Registration is a separate function so each user story adds exactly one line
 * here as it lands, and the protocol tests can see the full surface at once.
 */
function registerTools(_context: ToolContext): void {
  // Tools are registered here as each story lands (US1 -> US3), and the
  // species_distribution_report prompt with US5.
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: SERVER_INSTRUCTIONS,
      // `logging` is declared so tool-call records can reach clients that
      // render them. They go to stderr either way (Constitution I).
      capabilities: { logging: {} },
    },
  )

  const context: ToolContext = {
    server,
    client: options.client ?? new GbifClient(),
    cache: options.cache ?? new TtlCache<ResolvedTaxon>(),
  }

  registerTools(context)

  return server
}
