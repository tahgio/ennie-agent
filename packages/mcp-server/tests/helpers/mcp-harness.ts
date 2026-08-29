/**
 * A real MCP client talking to a real MCP server (FR-039, research D11).
 *
 * The point of these tests is that they do not test our functions — they test
 * the protocol. The server under test is the one `createServer()` builds and
 * ships; the client is the SDK's own `Client`; the only substitution is the
 * transport (in-memory instead of stdio) and `fetch` (fixtures instead of
 * GBIF). Everything between the JSON-RPC frame and the tool handler is the real
 * code path, including input validation, output-schema validation, and the
 * `isError` conversion.
 *
 * That matters because most of the ways an MCP server can be broken — a missing
 * `outputSchema`, `structuredContent` that fails its own declared schema, an
 * error thrown where a result was required — are invisible to a unit test that
 * calls the handler directly.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ResolvedTaxon } from '../../src/domain/resolution.js'
import { TtlCache } from '../../src/gbif/cache.js'
import { GbifClient } from '../../src/gbif/client.js'
import { createServer } from '../../src/server.js'
import { createFixtureFetch, type FixtureFetchOptions, type StubbedFetch } from './stub-gbif.js'

export interface Harness {
  readonly client: Client
  readonly server: McpServer
  /** The stubbed upstream, for asserting how many requests a tool actually made. */
  readonly upstream: StubbedFetch
  readonly cache: TtlCache<ResolvedTaxon>
  close(): Promise<void>
}

export interface HarnessOptions extends FixtureFetchOptions {
  /** Shortened in resilience tests so a budget can expire without a real wait. */
  readonly attemptTimeoutMs?: number
  readonly maxRetries?: number
  /** Replaces the real backoff sleep, so retry tests do not spend real seconds. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/**
 * Stand up a connected client/server pair over `InMemoryTransport`.
 *
 * Always `await harness.close()` — an unclosed pair keeps handles open and
 * leaks between test files.
 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const upstream = createFixtureFetch(options)
  const cache = new TtlCache<ResolvedTaxon>()

  const gbif = new GbifClient({
    fetchImpl: upstream.fetch,
    ...(options.attemptTimeoutMs !== undefined
      ? { attemptTimeoutMs: options.attemptTimeoutMs }
      : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    // Backoff waits are skipped by default: the retry *decisions* are what the
    // protocol tests care about, and the timing is covered by the unit tests.
    sleep: options.sleep ?? (async () => undefined),
  })

  const server = createServer({ client: gbif, cache })
  const client = new Client({ name: 'harness', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  return {
    client,
    server,
    upstream,
    cache,
    async close() {
      await client.close()
      await server.close()
    },
  }
}

/** The text of a tool result's first text block — what the model actually reads. */
export function resultText(result: { content?: unknown }): string {
  const content = result.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } => {
      return (
        typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text'
      )
    })
    .map((block) => block.text)
    .join('\n')
}
