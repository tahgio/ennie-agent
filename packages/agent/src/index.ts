#!/usr/bin/env node
/**
 * The CLI entrypoint (FR-033, FR-035, FR-037, Constitution VII).
 *
 * The order of startup is the contract, and it is chosen so that a
 * misconfiguration costs nothing:
 *
 *   1. resolve MODEL                exit 2 if malformed
 *   2. check the credential         exit 2, naming the variable — before
 *                                   anything is spawned or contacted
 *   3. print the resolved model     so any answer is attributable
 *   4. spawn the server over stdio  as a child process, by path
 *   5. loop
 *
 * Step 4 is where Constitution VII is proved rather than asserted. This package
 * has no dependency on `mcp-server`; it launches the built server exactly as a
 * third-party client would, and everything it can do it does over MCP. If the
 * boundary were fake, the integration would be a function call wearing a
 * protocol costume.
 *
 * Teardown runs in a `finally` that covers every exit path — clean exit, thrown
 * error, and both signals — because an orphaned server process is invisible
 * until a machine is full of them (FR-035).
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Agent, MCPConfiguration } from '@voltagent/core'
import { AGENT_INSTRUCTIONS } from './instructions.js'
import { ConfigError, createModel, describeModel, parseModel, requireCredential } from './model.js'
import { Session } from './session.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * The built server, addressed by path. `GBIF_MCP_SERVER_PATH` overrides it so a
 * different build can be pointed at without touching this package.
 */
function serverEntrypoint(): string {
  const override = process.env.GBIF_MCP_SERVER_PATH?.trim()
  if (override !== undefined && override !== '') return resolve(override)
  return resolve(join(HERE, '..', '..', 'mcp-server', 'dist', 'index.js'))
}

async function main(): Promise<number> {
  const route = parseModel(process.env.MODEL)
  requireCredential(route)

  // FR-033: printed before the first prompt, so every answer is attributable.
  process.stdout.write(`Model: ${describeModel(route)}\n`)

  const entrypoint = serverEntrypoint()
  if (!existsSync(entrypoint)) {
    throw new ConfigError(
      `The GBIF MCP server is not built: ${entrypoint} does not exist.\nRun \`pnpm build\` first, or set GBIF_MCP_SERVER_PATH to a built server.`,
    )
  }

  const mcp = new MCPConfiguration({
    servers: {
      gbif: {
        type: 'stdio',
        command: process.execPath,
        args: [entrypoint],
        env: process.env.GBIF_USER_AGENT_CONTACT
          ? { GBIF_USER_AGENT_CONTACT: process.env.GBIF_USER_AGENT_CONTACT }
          : {},
      },
    },
  })

  // One controller drives every teardown path, so a signal, a thrown error and
  // a clean exit all converge on the same shutdown.
  const shutdown = new AbortController()
  const onSignal = (signal: NodeJS.Signals): void => {
    process.stdout.write(`\nReceived ${signal}. Exiting.\n`)
    shutdown.abort()
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  try {
    const tools = await mcp.getTools()
    process.stdout.write(
      `Connected to the GBIF MCP server. Tools: ${tools.map((tool) => tool.name).join(', ')}\n`,
    )

    const agent = new Agent({
      name: 'gbif-biodiversity-agent',
      model: createModel(route) as never,
      instructions: AGENT_INSTRUCTIONS,
      tools,
      // Context is the transcript the session holds in memory; nothing is
      // persisted anywhere (FR-031a).
      memory: false,
      maxSteps: 8,
    })

    const firstQuestion = process.argv.slice(2).join(' ').trim()
    const session = new Session({
      agent,
      input: process.stdin,
      output: process.stdout,
      firstQuestion: firstQuestion === '' ? undefined : firstQuestion,
      signal: shutdown.signal,
    })

    await session.run()
    return 0
  } finally {
    // Covers every path: clean exit, throw, and both signals.
    await mcp.disconnect().catch(() => undefined)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

try {
  process.exitCode = await main()
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = error.exitCode
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
