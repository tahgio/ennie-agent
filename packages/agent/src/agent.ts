/**
 * The one agent definition (FR-031, FR-032).
 *
 * The CLI session and the eval suite both build their agent here. They used to
 * hold a copy each — same name, same instructions, same step ceiling — with
 * nothing keeping the two equal. That is a silent failure by construction: the
 * first person to change one and not the other leaves the eval suite measuring
 * an agent nobody ships, while it goes on reporting a confident score.
 *
 * What varies between the two callers is passed in; what must not vary is
 * fixed here. The step ceiling in particular is part of what the eval measures,
 * so it belongs to the definition rather than to either caller.
 *
 * `serverEntrypoint()` lives here for the same reason: the eval suite must
 * launch the server the session launches, at the same path, or it is not
 * exercising the shipped boundary (Constitution VII).
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Agent } from '@voltagent/core'
import { AGENT_INSTRUCTIONS } from './instructions.js'
import { asModelValue, type createModel } from './model.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * The built server, addressed by path. `GBIF_MCP_SERVER_PATH` overrides it so a
 * different build can be pointed at without touching this package.
 *
 * The relative path resolves identically from `src/` (where the eval runner
 * loads this module) and from `dist/` (where the built CLI loads it): both are
 * one level below the package root, so `../../mcp-server/dist/index.js` reaches
 * the same file either way.
 */
export function serverEntrypoint(): string {
  const override = process.env.GBIF_MCP_SERVER_PATH?.trim()
  if (override !== undefined && override !== '') return resolve(override)
  return resolve(join(HERE, '..', '..', 'mcp-server', 'dist', 'index.js'))
}

type AgentOptions = ConstructorParameters<typeof Agent>[0]

export interface CreateAgentOptions {
  /** The resolved model value, from `createModel()`. */
  readonly model: ReturnType<typeof createModel>
  /** The tools discovered over MCP. */
  readonly tools: NonNullable<AgentOptions['tools']>
  /** Lifecycle hooks. The eval suite records the tool-call sequence with these. */
  readonly hooks?: NonNullable<AgentOptions['hooks']>
  /** The trace pipeline, when one is configured. */
  readonly observability?: NonNullable<AgentOptions['observability']>
}

/**
 * Build the shipped agent.
 *
 * `hooks` and `observability` are spread conditionally rather than passed as
 * `undefined`: under `exactOptionalPropertyTypes` an explicit `undefined` is
 * not the same as an absent property, and the difference is the point of the
 * flag.
 *
 * The model value goes through `asModelValue`, which is where the reason for
 * the type escape is written down (FR-034).
 */
export function createAgent(options: CreateAgentOptions): Agent {
  return new Agent({
    name: 'gbif-biodiversity-agent',
    model: asModelValue<AgentOptions['model']>(options.model),
    instructions: AGENT_INSTRUCTIONS,
    tools: options.tools,
    // Context is the transcript the session holds in memory; nothing is
    // persisted anywhere (FR-031a).
    memory: false,
    maxSteps: 8,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    ...(options.observability === undefined ? {} : { observability: options.observability }),
  })
}
