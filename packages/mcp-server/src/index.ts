#!/usr/bin/env node
/**
 * The stdio entrypoint, and nothing else.
 *
 * The first import is load-bearing: `./stdout-guard.js` reroutes every console
 * channel that would otherwise write to stdout, and ES modules evaluate their
 * dependencies in import order, so it runs before the MCP SDK — or anything the
 * SDK pulls in — has a chance to print. In stdio mode stdout carries JSON-RPC
 * frames and nothing else; a single stray `console.log` from any dependency
 * corrupts the stream and reaches the user as an unexplainable client parse
 * error (Constitution I, FR-025).
 *
 * Everything else lives in `server.ts`, so that an HTTP transport would be a
 * sibling of this file rather than a rewrite of it.
 */
import './stdout-guard.js'

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { logger } from './logging.js'
import { createServer, SERVER_VERSION } from './server.js'

/** The ceiling on teardown, after which the process exits regardless (FR-019). */
const SHUTDOWN_TIMEOUT_MS = 2_000

async function main(): Promise<void> {
  const server = createServer()
  const transport = new StdioServerTransport()

  // Teardown on both signals, so a parent process that stops us does not leave
  // the transport half-open.
  //
  // Two guarantees, and each needs its own mechanism (FR-018, FR-019):
  //
  //   - **Once only.** `process.once` stops a repeated SIGINT re-entering, but
  //     it is per-signal: a SIGINT followed by a SIGTERM would still run
  //     teardown twice. The `closing` flag is what actually covers that, and
  //     the two together mean no combination of signals produces a second
  //     shutdown sequence or a different exit status.
  //   - **Bounded.** `server.close()` waiting forever would hold the transport
  //     open indefinitely. The timer caps that at two seconds — and is
  //     `unref()`'d, which is the part that matters in the normal case: an
  //     unreferenced timer cannot by itself keep the process alive, so a
  //     teardown that finishes in milliseconds still exits in milliseconds.
  let closing = false
  const shutdown = (signal: string): void => {
    if (closing) return
    closing = true

    logger.info({ signal }, 'shutting down')

    const bail = setTimeout(() => {
      logger.warn({ signal }, 'shutdown did not settle within 2s; exiting anyway')
      process.exit(0)
    }, SHUTDOWN_TIMEOUT_MS)
    bail.unref()

    void server.close().finally(() => {
      clearTimeout(bail)
      process.exit(0)
    })
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))

  await server.connect(transport)
  logger.info({ version: SERVER_VERSION }, 'listening on stdio')
}

main().catch((error: unknown) => {
  // Nothing is connected yet, so there is no client to send a result to. stderr
  // and a non-zero exit are the only honest channels left.
  logger.error({ err: error }, 'failed to start')
  process.exit(1)
})
