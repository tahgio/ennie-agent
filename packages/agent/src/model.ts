/**
 * `MODEL` resolution and the credential preflight (FR-032, FR-033, FR-034).
 *
 * Two accepted forms, and the order they are checked in is part of the contract:
 *
 *   provider:model   anthropic:claude-opus-5   -> direct, via @ai-sdk/*
 *   provider/model   anthropic/claude-opus-5   -> the Vercel AI Gateway
 *
 * The colon form is tested **first**, and an unrecognised provider before a
 * colon is an error naming the three supported providers — not a silent
 * fall-through to the gateway. Falling through would turn a typo
 * (`anthropi:claude-opus-5`) into a confusing gateway authentication failure
 * several seconds later, instead of a clear message immediately.
 *
 * The credential is checked before the server is spawned or the model is
 * contacted, so a missing key costs nothing and says exactly which variable to
 * set (FR-034).
 */
import { anthropic } from '@ai-sdk/anthropic'
import { google } from '@ai-sdk/google'
import { openai } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'

export const SUPPORTED_PROVIDERS = ['anthropic', 'openai', 'google'] as const
export type Provider = (typeof SUPPORTED_PROVIDERS)[number]

/** The environment variable each route authenticates with. */
export const PROVIDER_ENV_VARS: Record<Provider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
}

export const GATEWAY_ENV_VAR = 'AI_GATEWAY_API_KEY'

export type ModelRoute =
  | {
      readonly kind: 'direct'
      readonly provider: Provider
      readonly modelId: string
      readonly envVar: string
    }
  | { readonly kind: 'gateway'; readonly modelId: string; readonly envVar: string }

/**
 * A configuration problem the user can fix, as distinct from a runtime failure.
 * Exit code 2 is reserved for these (contracts/agent-cli.md).
 */
export class ConfigError extends Error {
  readonly exitCode = 2

  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

const FORMS = [
  "  MODEL=anthropic:claude-opus-5   (direct, via the provider's own SDK)",
  '  MODEL=anthropic/claude-opus-5   (through the Vercel AI Gateway)',
].join('\n')

export function parseModel(raw: string | undefined): ModelRoute {
  const value = raw?.trim()

  if (value === undefined || value === '') {
    throw new ConfigError(`MODEL is not set. Set it to one of these two forms:\n${FORMS}`)
  }

  // The colon form first, so a mistyped provider is caught here rather than
  // being mistaken for something the gateway might know about.
  const colon = value.indexOf(':')
  if (colon !== -1) {
    const provider = value.slice(0, colon)
    const modelId = value.slice(colon + 1).trim()

    if (!isProvider(provider)) {
      throw new ConfigError(
        `MODEL names an unknown provider '${provider}'. Direct routing supports only: ${SUPPORTED_PROVIDERS.join(', ')}.\n` +
          `Use one of those, or the gateway form '${provider}/${modelId || 'model-name'}'.`,
      )
    }

    if (modelId === '') {
      throw new ConfigError(
        `MODEL is missing a model name after '${provider}:'. Set it to one of these two forms:\n${FORMS}`,
      )
    }

    return { kind: 'direct', provider, modelId, envVar: PROVIDER_ENV_VARS[provider] }
  }

  const slash = value.indexOf('/')
  if (slash > 0 && slash < value.length - 1) {
    return { kind: 'gateway', modelId: value, envVar: GATEWAY_ENV_VAR }
  }

  throw new ConfigError(
    `MODEL='${value}' is not a recognised model reference. Set it to one of these two forms:\n${FORMS}`,
  )
}

function isProvider(value: string): value is Provider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(value)
}

/**
 * Verify the credential for the resolved route.
 *
 * Deliberately runs before anything is spawned or contacted, so the failure is
 * instant and names the one variable that fixes it (FR-034).
 */
export function requireCredential(route: ModelRoute, env: NodeJS.ProcessEnv = process.env): void {
  const value = env[route.envVar]?.trim()
  if (value !== undefined && value !== '') return

  const hint =
    route.kind === 'gateway'
      ? `The gateway form of MODEL authenticates with ${route.envVar}.`
      : `MODEL selects the ${route.provider} provider directly, which authenticates with ${route.envVar}.`

  throw new ConfigError(`${route.envVar} is not set. ${hint}\nExport it and run again.`)
}

/**
 * The model VoltAgent will use.
 *
 * A gateway route stays a plain `provider/model` string: VoltAgent's model
 * router resolves it, which is exactly the fall-through the contract describes.
 */
export function createModel(route: ModelRoute): LanguageModel | string {
  if (route.kind === 'gateway') return route.modelId

  switch (route.provider) {
    case 'anthropic':
      return anthropic(route.modelId)
    case 'openai':
      return openai(route.modelId)
    case 'google':
      return google(route.modelId)
  }
}

/** One line naming the model and how it is reached, printed before the first prompt (FR-033). */
export function describeModel(route: ModelRoute): string {
  return route.kind === 'direct'
    ? `${route.modelId} via ${route.provider} (direct)`
    : `${route.modelId} via the Vercel AI Gateway`
}
