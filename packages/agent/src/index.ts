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
import { MCPConfiguration } from '@voltagent/core'
import { createAgent, serverEntrypoint } from './agent.js'
import { createTerminalElicitation } from './elicitation.js'
import { forwardedEnv } from './forwarded-env.js'
import { connectBridge, mcpLogLevel } from './mcp-bridge.js'
import { ConfigError, createModel, describeModel, parseModel, requireCredential } from './model.js'
import { createTracing } from './observability.js'
import { Session } from './session.js'

/**
 * 128 + SIGINT(2), the shell convention for "terminated by an interrupt".
 * Reported instead of 1, which means "this crashed" (contracts/agent-cli.md).
 */
const SIGINT_EXIT_CODE = 130

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

  // Optional, and off unless both VoltOps keys are set. Built last among the
  // startup steps, so nothing that can exit 2 leaves a pipeline open behind it.
  const tracing = createTracing()

  const mcp = new MCPConfiguration({
    servers: {
      gbif: {
        type: 'stdio',
        command: process.execPath,
        args: [entrypoint],
        // An explicit allowlist, never `{ ...process.env }`. The launched
        // server gets exactly the variables it is documented to read and
        // nothing else — a spread would hand a child process every credential
        // in this one's environment (FR-026).
        env: forwardedEnv(),
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
    // Connect first and read what the server actually published: its
    // `instructions`, its prompts, whether it can send logs. `getTools()`
    // reuses the same connected client, so this is one server process and one
    // handshake, not two.
    const bridge = await connectBridge(mcp, 'gbif')
    const tools = await mcp.getTools()

    process.stdout.write(
      `Connected to the GBIF MCP server. Tools: ${tools.map((tool) => tool.name).join(', ')}\n`,
    )
    if (bridge.prompts !== null) {
      process.stdout.write(
        `Prompts: ${bridge.prompts.all.map((prompt) => `/${prompt.name}`).join(', ')} (/help for commands)\n`,
      )
    }

    // Server log records go to stderr at `MCP_LOG_LEVEL` (default: warnings
    // and worse). stdout carries answers, and mixing diagnostics into them is
    // the client-side version of the mistake the server's stdout guard exists
    // to prevent.
    await bridge.startLogRelay({
      level: mcpLogLevel(),
      write: (line) => process.stderr.write(line),
    })

    const agent = createAgent({
      model: createModel(route),
      tools,
      serverInstructions: bridge.instructions,
      ...(tracing === null ? {} : { observability: tracing.observability }),
    })

    const firstQuestion = process.argv.slice(2).join(' ').trim()
    const session = new Session({
      agent,
      input: process.stdin,
      output: process.stdout,
      firstQuestion: firstQuestion === '' ? undefined : firstQuestion,
      signal: shutdown.signal,
      prompts: bridge.prompts,
    })

    // Registered after the session exists, because answering a server's
    // question means reading a line, and the session owns the only reader.
    // Safe to do here: an elicitation can only arrive during a tool call,
    // which can only happen once `run()` is looping.
    bridge.setElicitationHandler(
      createTerminalElicitation({
        ask: (question) => session.askLine(question),
        write: (text) => process.stdout.write(text),
      }),
    )

    await session.run()
    return 0
  } catch (error) {
    // An interruption during an in-flight answer is a deliberate, clean stop —
    // not a crash. `Session.ask` rethrows on the abort path precisely so it can
    // be recognised here; every other failure keeps propagating to the handler
    // below, which prints it and exits 1.
    //
    // Nothing is printed here. The `Received SIGINT. Exiting.` line was already
    // written by the signal handler, and the second line of failure text is
    // exactly the defect being fixed (FR-021).
    if (shutdown.signal.aborted) return SIGINT_EXIT_CODE
    throw error
  } finally {
    // Covers every path: clean exit, throw, and both signals. Traces are
    // flushed before the process is allowed to go away — this is a short-lived
    // CLI, and an unflushed batch is a silently lost trace.
    await mcp.disconnect().catch(() => undefined)
    await tracing?.close()
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

/**
 * Exit explicitly once teardown has run.
 *
 * VoltAgent's observability stack leaves timers and sockets open after a model
 * call, so a session that actually asked something would otherwise sit idle
 * forever instead of returning to the shell. `disconnect()` has already run in
 * main()'s finally by this point, so there is nothing left to wait for.
 */
async function exitNow(code: number): Promise<never> {
  // Let anything already queued on stdout drain before the process goes away.
  await new Promise<void>((resolve) => {
    process.stdout.write('', () => resolve())
  })
  process.exit(code)
}

try {
  await exitNow(await main())
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`)
    await exitNow(error.exitCode)
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    await exitNow(1)
  }
}
