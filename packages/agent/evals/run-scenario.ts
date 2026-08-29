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
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Agent, createHooks, MCPConfiguration } from '@voltagent/core'
import { AGENT_INSTRUCTIONS } from '../src/instructions.js'
import { createModel, describeModel, parseModel, requireCredential } from '../src/model.js'
import type { Scenario } from './scenarios/index.js'
import type { RunRecord, ToolCallRecord } from './scorers/run-record.js'

const HERE = dirname(fileURLToPath(import.meta.url))

function serverEntrypoint(): string {
  const override = process.env.GBIF_MCP_SERVER_PATH?.trim()
  if (override !== undefined && override !== '') return resolve(override)
  return resolve(join(HERE, '..', '..', 'mcp-server', 'dist', 'index.js'))
}

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
export async function runScenario(scenario: Scenario): Promise<RunRecord> {
  const route = parseModel(process.env.MODEL)
  requireCredential(route)

  const entrypoint = serverEntrypoint()
  if (!existsSync(entrypoint)) {
    throw new Error(`The GBIF MCP server is not built: ${entrypoint}. Run \`pnpm build\` first.`)
  }

  const toolCalls: ToolCallRecord[] = []
  const answers: string[] = []

  const mcp = new MCPConfiguration({
    servers: {
      gbif: { type: 'stdio', command: process.execPath, args: [entrypoint], env: {} },
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

    const agent = new Agent({
      name: 'gbif-biodiversity-agent',
      model: createModel(route) as never,
      instructions: AGENT_INSTRUCTIONS,
      tools,
      memory: false,
      maxSteps: 8,
      hooks: createHooks({
        // The recorded sequence is the entire basis of the structural score.
        onToolStart: ({ tool, args }) => {
          toolCalls.push({
            name: tool.name,
            input: (args ?? {}) as Record<string, unknown>,
            isError: false,
          })
        },
        onToolEnd: async ({ tool, output, error }) => {
          const last = [...toolCalls].reverse().find((call) => call.name === tool.name)
          if (last === undefined) return
          const index = toolCalls.lastIndexOf(last)
          // A tool result carrying isError is a recoverable failure, and is the
          // thing the agent is supposed to act on rather than repeat.
          const failed =
            error !== undefined ||
            (typeof output === 'object' && output !== null && 'isError' in output
              ? Boolean((output as { isError?: unknown }).isError)
              : false)
          toolCalls[index] = { ...last, isError: failed }
        },
      }),
    })

    // The transcript is held here, exactly as the interactive session holds it.
    const transcript: Array<{ role: 'user' | 'assistant'; content: string }> = []

    for (const question of scenario.questions) {
      transcript.push({ role: 'user', content: question })
      const result = await agent.generateText(transcript)
      const answer = result.text.trim()
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
