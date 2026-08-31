/**
 * Optional trace export to VoltOps (T081).
 *
 * Off unless **both** `VOLTOPS_PUBLIC_KEY` and `VOLTOPS_SECRET_KEY` are set.
 * That is the whole feature gate, and it is deliberately strict: a half-set
 * pair is a misconfiguration, and silently exporting nothing while appearing to
 * be configured is worse than plainly doing nothing.
 *
 * Three properties this has to hold, because tracing is a convenience and the
 * CLI is the product:
 *
 *   1. **It cannot fail the session.** Every path here swallows its own errors.
 *      A network problem reaching VoltOps must not cost someone their answer.
 *   2. **It cannot reach stdout.** Notices go to stderr, which keeps the
 *      terminal transcript clean and matches the server's own discipline.
 *   3. **It must flush before exit.** The CLI is a short-lived process that
 *      calls `process.exit()` once teardown is done; an unflushed batch
 *      processor would drop the very traces it was configured to collect. Hence
 *      `flushOnFinishStrategy: 'always'` *and* an explicit flush.
 */
import {
  AgentRegistry,
  createVoltAgentObservability,
  createVoltOpsClient,
  type VoltAgentObservability,
} from '@voltagent/core'

/** What the CLI holds on to: something to hand the agent, and a way to close it. */
export interface Tracing {
  readonly observability: VoltAgentObservability
  /** Flush pending spans and shut the pipeline down. Never throws. */
  close(): Promise<void>
}

const PUBLIC_KEY = 'VOLTOPS_PUBLIC_KEY'
const SECRET_KEY = 'VOLTOPS_SECRET_KEY'

function readKey(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/**
 * Build the tracing pipeline, or return `null` when it is not configured.
 *
 * `null` is the normal case and is not worth a message. A *partial*
 * configuration is worth one, because the person plainly intended tracing and
 * would otherwise be left wondering why the console stayed empty.
 */
export function createTracing(): Tracing | null {
  const publicKey = readKey(PUBLIC_KEY)
  const secretKey = readKey(SECRET_KEY)

  if (publicKey === undefined || secretKey === undefined) {
    // Exactly one key set: plainly intended, so say why it did not take effect.
    if (publicKey !== undefined || secretKey !== undefined) {
      const missing = publicKey === undefined ? PUBLIC_KEY : SECRET_KEY
      process.stderr.write(`Tracing disabled: ${missing} is not set.\n`)
    }
    return null
  }

  try {
    // The observability pipeline resolves its exporter lazily through the
    // registry, so the client has to be registered before the first span.
    AgentRegistry.getInstance().setGlobalVoltOpsClient(
      createVoltOpsClient({ publicKey, secretKey }),
    )

    const observability = createVoltAgentObservability({
      serviceName: 'gbif-biodiversity-agent',
      // This process exits as soon as the session ends. Never leave a batch
      // sitting in a queue that nothing will drain.
      flushOnFinishStrategy: 'always',
    })

    process.stderr.write('Tracing enabled: exporting to VoltOps.\n')

    return {
      observability,
      async close() {
        try {
          await observability.forceFlush()
          await observability.shutdown()
        } catch {
          // A failed export is not worth a failed exit code.
        }
      },
    }
  } catch (error) {
    process.stderr.write(
      `Tracing disabled: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    return null
  }
}
