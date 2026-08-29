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
import { createServer, SERVER_NAME, SERVER_VERSION } from './server.js'

async function main(): Promise<void> {
  const server = createServer()
  const transport = new StdioServerTransport()

  // Teardown on both signals, so a parent process that stops us does not leave
  // the transport half-open.
  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down')
    void server.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  await server.connect(transport)
  logger.info({ name: SERVER_NAME, version: SERVER_VERSION }, 'listening on stdio')
}

main().catch((error: unknown) => {
  // Nothing is connected yet, so there is no client to send a result to. stderr
  // and a non-zero exit are the only honest channels left.
  logger.error({ err: error }, 'failed to start')
  process.exit(1)
})
