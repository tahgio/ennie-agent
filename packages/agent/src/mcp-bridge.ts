/**
 * The parts of MCP that VoltAgent does not surface (Constitution VII).
 *
 * `MCPConfiguration.getTools()` is the whole of VoltAgent's MCP client as far
 * as an agent is concerned, and tools are only one of the three things an MCP
 * server offers. Three capabilities were being dropped on the floor by this
 * client, and each of them is a contract the server on the other end had
 * already gone to the trouble of holding up:
 *
 *   - **`instructions` from `initialize`.** The SDK's own `Client` captures it
 *     (`getInstructions()`); VoltAgent's `connect()` never reads it. So the
 *     server's guidance — which tool to reach for, why paging is the wrong way
 *     to answer "where", the recording-effort caveat — reached nobody, and the
 *     careful decision to put that guidance in the *server* so every client
 *     gets it was quietly undone by the one client in this repository.
 *   - **Prompts.** VoltAgent's `MCPClient` has `listTools`, `callTool` and
 *     `listResources`, and no prompt support at all. A server-side prompt is
 *     the part of the surface a *person* invokes, so a client that ignores
 *     prompts leaves the user unable to reach half of what the server ships.
 *   - **Log notifications.** The server declares the `logging` capability and
 *     emits one `notifications/message` per tool call. Without a level set and
 *     a handler registered, the SDK discards every one of them.
 *
 * All three are reachable on the SDK `Client` that VoltAgent holds internally,
 * so this module reaches through rather than opening a second connection to
 * the same server — which would spawn a second server process, and give it a
 * second cache.
 *
 * **Elicitation is the exception**: VoltAgent exposes it properly, as a public
 * `elicitation` bridge, so that one is used as designed.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  type LoggingLevel,
  LoggingMessageNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { MCPConfiguration, UserInputHandler } from '@voltagent/core'

/**
 * The one type escape in this file, and the reason for it.
 *
 * `MCPClient.client` is declared `private` in VoltAgent's `.d.ts` — but the
 * class offers no accessor for the SDK client and no API of its own for
 * instructions, prompts or logging, so a client that wants to be a complete
 * MCP client has no supported route to them. The cast is narrow on purpose: it
 * names only the two members used, so if a future VoltAgent release renames or
 * removes either, this fails where it is used rather than somewhere downstream.
 *
 * `elicitation` is public and is included here only so one cast covers the
 * whole bridge.
 */
interface VoltMcpClientInternals {
  readonly client: Client
  readonly elicitation: { setHandler(handler: UserInputHandler): unknown }
}

/** One argument a prompt declares, as `prompts/list` reports it. */
export interface PromptArgument {
  readonly name: string
  readonly description?: string | undefined
  readonly required?: boolean | undefined
}

export interface PromptSummary {
  readonly name: string
  readonly title?: string | undefined
  readonly description?: string | undefined
  readonly arguments: readonly PromptArgument[]
}

/** What `find()` returns when a query matched more than one prompt. */
export const AMBIGUOUS_PROMPT = Symbol('ambiguous prompt')

export interface PromptCatalog {
  readonly all: readonly PromptSummary[]
  /**
   * Resolve a typed command to a prompt: an exact name first, then a unique
   * case-insensitive substring. The substring rule is what makes `/report`
   * reach `species_distribution_report` — a server is free to name a prompt
   * for clarity, and a person should not have to type the whole of it.
   */
  find(query: string): PromptSummary | typeof AMBIGUOUS_PROMPT | null
  /** Fetch the prompt and flatten its messages into one turn of user text. */
  render(name: string, args: Readonly<Record<string, string>>): Promise<string>
}

export interface LogRelayOptions {
  /** The minimum severity the server should send. */
  readonly level: LoggingLevel
  /** Where a received record is written. stderr, so it never mixes with answers. */
  readonly write: (line: string) => void
}

export interface McpBridge {
  /** The server's `instructions`, or null when it sent none. */
  readonly instructions: string | null
  /** Null when the server declares no `prompts` capability. */
  readonly prompts: PromptCatalog | null
  /** True when the server declares `logging`. */
  readonly supportsLogging: boolean
  setElicitationHandler(handler: UserInputHandler): void
  startLogRelay(options: LogRelayOptions): Promise<void>
}

/**
 * Connect to one configured server and read everything it offers.
 *
 * `getClient()` is what performs the connection, so this must run before
 * `getTools()` — or rather, either order works, because VoltAgent caches the
 * connected client per server name and both go through the same cache. What
 * must not happen is a second `MCPConfiguration` for the same server: that
 * spawns a second process.
 */
export async function connectBridge(mcp: MCPConfiguration, serverName: string): Promise<McpBridge> {
  const volt = (await mcp.getClient(serverName)) as unknown as VoltMcpClientInternals
  const sdk = volt.client
  const capabilities = sdk.getServerCapabilities()

  const instructions = sdk.getInstructions()?.trim()

  return {
    instructions: instructions === undefined || instructions === '' ? null : instructions,
    prompts: capabilities?.prompts === undefined ? null : await loadPrompts(sdk),
    supportsLogging: capabilities?.logging !== undefined,

    setElicitationHandler(handler) {
      volt.elicitation.setHandler(handler)
    },

    async startLogRelay({ level, write }) {
      if (capabilities?.logging === undefined) return

      sdk.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
        write(formatLogRecord(notification.params))
      })

      // Sent after the handler is registered, so nothing arrives before there
      // is somewhere to put it. A server that refuses the level is not a
      // reason to fail startup — logs are diagnostics, not the product.
      await sdk.setLoggingLevel(level).catch(() => undefined)
    },
  }
}

async function loadPrompts(sdk: Client): Promise<PromptCatalog | null> {
  let all: PromptSummary[]
  try {
    const listed = await sdk.listPrompts()
    all = listed.prompts.map((prompt) => ({
      name: prompt.name,
      title: prompt.title,
      description: prompt.description,
      arguments: prompt.arguments ?? [],
    }))
  } catch {
    // A server that advertises prompts but cannot list them is a server whose
    // tools still work. Nothing here is worth failing a session over.
    return null
  }

  if (all.length === 0) return null

  return {
    all,

    find(query) {
      const wanted = query.trim().toLowerCase()
      if (wanted === '') return null

      const exact = all.find((prompt) => prompt.name.toLowerCase() === wanted)
      if (exact !== undefined) return exact

      const partial = all.filter((prompt) => prompt.name.toLowerCase().includes(wanted))
      if (partial.length === 1) return partial[0] ?? null
      if (partial.length > 1) return AMBIGUOUS_PROMPT
      return null
    },

    async render(name, args) {
      const result = await sdk.getPrompt({ name, arguments: { ...args } })
      return flattenPromptMessages(result.messages)
    },
  }
}

/** A prompt message, narrowed to the shape this client can render. */
interface PromptMessage {
  readonly role: string
  readonly content: { readonly type: string; readonly text?: string | undefined }
}

/**
 * Flatten a prompt's messages into the single user turn this CLI can send.
 *
 * A prompt may legitimately return a scripted exchange — alternating user and
 * assistant messages — and a richer client would seed its transcript with all
 * of them. This session holds one transcript and appends one user turn, so the
 * text blocks are joined and any non-text content is named rather than
 * silently dropped: a person who asked for a prompt and got a truncated
 * version of it with no warning has no way to know what was lost.
 */
export function flattenPromptMessages(messages: readonly PromptMessage[]): string {
  const parts: string[] = []
  let skipped = 0

  for (const message of messages) {
    if (message.content.type === 'text' && typeof message.content.text === 'string') {
      parts.push(message.content.text)
    } else {
      skipped += 1
    }
  }

  if (skipped > 0) {
    parts.push(
      `[${skipped} non-text block${skipped === 1 ? '' : 's'} in this prompt could not be included by this client.]`,
    )
  }

  return parts.join('\n\n').trim()
}

/**
 * Render one server log record for a terminal.
 *
 * The server sends a structured `ToolCallLog` as `data` — tool, duration,
 * cache outcome, upstream request count. Printing it as JSON would be honest
 * but unreadable next to an answer, so the known shape is formatted and
 * anything else falls back to JSON rather than being dropped.
 */
export function formatLogRecord(params: {
  level: string
  logger?: string | undefined
  data?: unknown
}): string {
  const source = params.logger ?? 'mcp'
  const data = params.data

  if (typeof data === 'object' && data !== null && 'tool' in data) {
    const record = data as Record<string, unknown>
    const parts = [`${record['tool']}`]
    if (typeof record['durationMs'] === 'number') parts.push(`${record['durationMs']}ms`)
    if (record['cache'] !== 'n/a' && record['cache'] !== undefined)
      parts.push(`cache=${record['cache']}`)
    if (typeof record['upstreamRequests'] === 'number')
      parts.push(`upstream=${record['upstreamRequests']}`)
    if (typeof record['retries'] === 'number' && record['retries'] > 0)
      parts.push(`retries=${record['retries']}`)
    if (record['errorCode'] !== undefined) parts.push(`error=${record['errorCode']}`)
    return `[${source} ${params.level}] ${parts.join(' ')}\n`
  }

  const rendered = typeof data === 'string' ? data : JSON.stringify(data)
  return `[${source} ${params.level}] ${rendered}\n`
}

/**
 * The level the server is asked to send, from `MCP_LOG_LEVEL`.
 *
 * Defaults to `warning`: a per-tool-call record on every successful call is
 * exactly the noise that makes people stop reading a terminal, so the quiet
 * default shows failures only and `MCP_LOG_LEVEL=info` opts into the rest.
 */
const LOG_LEVELS = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
] as const

export function mcpLogLevel(env: NodeJS.ProcessEnv = process.env): LoggingLevel {
  const raw = env.MCP_LOG_LEVEL?.trim().toLowerCase()
  const match = LOG_LEVELS.find((level) => level === raw)
  return match ?? 'warning'
}
