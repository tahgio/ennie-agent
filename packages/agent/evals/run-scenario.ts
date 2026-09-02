/**
 * Drive one scenario end to end and record what happened (FR-041, FR-041a).
 *
 * The agent under test is the real one: the real instructions, the real server
 * launched over stdio, the real tools. Only the person is simulated, by the
 * scripted replies in the scenario.
 *
 * The output is a `RunRecord` — a plain serialisable object — because the
 * scorers are plain functions over it. Recording the tool-call sequence, rather
 * than scoring as we go, is what keeps the structural score reproducible and
 * independent of whichever runner invoked this.
 */
import { existsSync } from 'node:fs'
import { createHooks, MCPConfiguration } from '@voltagent/core'
import { createAgent, serverEntrypoint } from '../src/agent.js'
import { emptyAnswerReason, type Generation } from '../src/empty-answer.js'
import { forwardedEnv } from '../src/forwarded-env.js'
import { createModel, describeModel, parseModel, requireCredential } from '../src/model.js'
import type { Scenario } from './scenarios/index.js'
import type { RunRecord, ToolCallRecord } from './scorers/run-record.js'

export function agentModelLabel(): string {
  return describeModel(parseModel(process.env.MODEL))
}

export function judgeModelLabel(): string | null {
  const judge = process.env.JUDGE_MODEL?.trim()
  return judge === undefined || judge === '' ? null : judge
}

/**
 * Run every turn of a scenario against a freshly connected agent.
 *
 * A failure is captured into the record rather than thrown: a scenario that
 * breaks should appear as a zero in the report, next to the ones that passed,
 * instead of taking the whole run down with it.
 */
/**
 * The per-invocation id the AI SDK assigns, when the runtime supplies one.
 *
 * Read defensively rather than by type: it is optional in VoltAgent's own
 * signature ("optional for external callers"), and an attribution scheme that
 * throws when it is absent would be worse than the one being replaced.
 */
export function callIdOf(options: unknown): string | undefined {
  const context = (options as { toolContext?: { callId?: unknown } } | undefined)?.toolContext
  const callId = context?.callId
  return typeof callId === 'string' && callId !== '' ? callId : undefined
}

export interface ToolCallRecorder {
  /** The recorded sequence, in start order. Serialised into the `RunRecord`. */
  readonly toolCalls: ToolCallRecord[]
  started(name: string, input: Record<string, unknown>, callId?: string | undefined): void
  finished(name: string, failed: boolean, callId?: string | undefined): void
}

/**
 * Record the tool-call sequence, attributing each outcome to the invocation
 * that produced it (FR-033).
 *
 * Pure and free of VoltAgent, so the attribution rule — the part that was
 * wrong — is testable offline rather than only observable in a paid run.
 *
 * The previous rule matched an outcome to "the most recent call of the same
 * name", which is wrong exactly when it matters: with two calls to one
 * capability in flight, whichever finished first claimed the later record, and
 * that record feeds the check asking whether the agent repeated a call it had
 * already been told had failed.
 *
 * Two mechanisms, in order:
 *
 *   1. **The call id**, when the runtime supplies one. Exact.
 *   2. **The most recent *unresolved* call of that name.** Still a heuristic,
 *      but one that cannot overwrite an outcome already attributed, so two
 *      overlapping calls land on two different records either way.
 *
 * Neither the id map nor the resolved set is part of the serialised record.
 */
export function createToolCallRecorder(): ToolCallRecorder {
  const toolCalls: ToolCallRecord[] = []
  const indexByCallId = new Map<string, number>()
  const resolved = new Set<number>()

  function attributionIndex(name: string, callId: string | undefined): number | undefined {
    if (callId !== undefined) {
      const exact = indexByCallId.get(callId)
      if (exact !== undefined) return exact
    }

    for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
      if (toolCalls[index]?.name === name && !resolved.has(index)) return index
    }

    return undefined
  }

  return {
    toolCalls,

    started(name, input, callId) {
      const index = toolCalls.length
      toolCalls.push({ name, input, isError: false })
      if (callId !== undefined) indexByCallId.set(callId, index)
    },

    finished(name, failed, callId) {
      const index = attributionIndex(name, callId)
      if (index === undefined) return

      const started = toolCalls[index]
      if (started === undefined) return

      resolved.add(index)
      toolCalls[index] = { ...started, isError: failed }
    },
  }
}

export async function runScenario(scenario: Scenario): Promise<RunRecord> {
  const route = parseModel(process.env.MODEL)
  requireCredential(route)

  const entrypoint = serverEntrypoint()
  if (!existsSync(entrypoint)) {
    throw new Error(`The GBIF MCP server is not built: ${entrypoint}. Run \`pnpm build\` first.`)
  }

  const recorder = createToolCallRecorder()
  const toolCalls = recorder.toolCalls
  const answers: string[] = []

  const mcp = new MCPConfiguration({
    servers: {
      // Forwarding the same allowlist the CLI uses (FR-026) so the server the
      // eval spawns is configured identically — otherwise a raised
      // GBIF_CALL_BUDGET_MS would fix the interactive session while every
      // eval run kept the client-side default.
      gbif: { type: 'stdio', command: process.execPath, args: [entrypoint], env: forwardedEnv() },
    },
  })

  const base = {
    scenario: scenario.name,
    questions: scenario.questions,
    agentModel: agentModelLabel(),
    judgeModel: judgeModelLabel(),
    date: new Date().toISOString().slice(0, 10),
  }

  try {
    const tools = await mcp.getTools()

    const agent = createAgent({
      model: createModel(route),
      tools,
      hooks: createHooks({
        // The recorded sequence is the entire basis of the structural score.
        onToolStart: ({ tool, args, options }) => {
          recorder.started(tool.name, (args ?? {}) as Record<string, unknown>, callIdOf(options))
        },
        onToolEnd: async ({ tool, output, error, options }) => {
          // A tool result carrying isError is a recoverable failure, and is the
          // thing the agent is supposed to act on rather than repeat.
          const failed =
            error !== undefined ||
            (typeof output === 'object' && output !== null && 'isError' in output
              ? Boolean((output as { isError?: unknown }).isError)
              : false)
          recorder.finished(tool.name, failed, callIdOf(options))
        },
      }),
    })

    // The transcript is held here, exactly as the interactive session holds it.
    const transcript: Array<{ role: 'user' | 'assistant'; content: string }> = []

    for (const question of scenario.questions) {
      transcript.push({ role: 'user', content: question })
      const result = (await agent.generateText(transcript)) as Generation
      const answer = result.text.trim()

      // A turn that produced no text is a failed run, not a bad answer, and the
      // report has to say which. Recorded as a blank answer it scores like
      // prose that simply forgot to mention Canada — a zero indistinguishable
      // from a genuinely wrong answer, on a run where the model never spoke.
      // The tool calls made before the silence are kept, so the record still
      // shows how far the chain got.
      if (answer === '') {
        return {
          ...base,
          answers,
          toolCalls,
          error: `The model produced no answer for '${question}': ${emptyAnswerReason(result)}.`,
        }
      }

      transcript.push({ role: 'assistant', content: answer })
      answers.push(answer)
    }

    return { ...base, answers, toolCalls }
  } catch (error) {
    return {
      ...base,
      answers,
      toolCalls,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await mcp.disconnect().catch(() => undefined)
  }
}
