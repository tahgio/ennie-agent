/**
 * `MODEL` resolution and the credential preflight (FR-032, FR-034).
 *
 * The behaviour worth protecting is the *ordering*: the colon form is checked
 * first, and an unknown provider before a colon fails loudly instead of falling
 * through to the gateway. Silent fall-through would turn a one-character typo
 * into a gateway authentication error that names neither the typo nor the
 * provider the user meant.
 */
import { describe, expect, it } from 'vitest'
import {
  ConfigError,
  describeModel,
  GATEWAY_ENV_VAR,
  PROVIDER_ENV_VARS,
  parseModel,
  requireCredential,
  SUPPORTED_PROVIDERS,
} from '../src/model.js'

describe('parseModel — the colon form routes directly', () => {
  it.each(SUPPORTED_PROVIDERS)('routes %s directly to its own SDK', (provider) => {
    const route = parseModel(`${provider}:some-model-id`)

    expect(route).toMatchObject({
      kind: 'direct',
      provider,
      modelId: 'some-model-id',
      envVar: PROVIDER_ENV_VARS[provider],
    })
  })

  it('keeps colons that appear inside the model id', () => {
    const route = parseModel('openai:ft:gpt-4o:acme')

    expect(route.modelId).toBe('ft:gpt-4o:acme')
  })

  it('errors on an unknown provider instead of falling through to the gateway', () => {
    // The typo case. A gateway fall-through here would be actively misleading.
    let thrown: unknown
    try {
      parseModel('anthropi:claude-opus-5')
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ConfigError)
    const message = (thrown as ConfigError).message
    for (const provider of SUPPORTED_PROVIDERS) {
      expect(message).toContain(provider)
    }
    expect((thrown as ConfigError).exitCode).toBe(2)
  })

  it('errors when the model name after the colon is missing', () => {
    expect(() => parseModel('anthropic:')).toThrow(ConfigError)
  })
})

describe('parseModel — the slash form routes through the gateway', () => {
  it('passes provider/model through to the gateway', () => {
    const route = parseModel('anthropic/claude-opus-5')

    expect(route).toMatchObject({
      kind: 'gateway',
      modelId: 'anthropic/claude-opus-5',
      envVar: GATEWAY_ENV_VAR,
    })
  })

  it('accepts a provider the direct form would reject, since the gateway may know it', () => {
    const route = parseModel('some-other-provider/some-model')

    expect(route.kind).toBe('gateway')
  })
})

describe('parseModel — malformed input', () => {
  it.each([undefined, '', '   ', 'nonsense', '/leading-slash', 'trailing-slash/'])(
    'rejects %p, naming MODEL and showing both accepted forms',
    (value) => {
      let thrown: unknown
      try {
        parseModel(value)
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(ConfigError)
      const message = (thrown as ConfigError).message
      expect(message).toContain('MODEL')
      expect(message).toContain('anthropic:claude-opus-5')
      expect(message).toContain('anthropic/claude-opus-5')
    },
  )
})

describe('requireCredential', () => {
  it('accepts a route whose variable is set', () => {
    const route = parseModel('anthropic:claude-opus-5')

    expect(() => requireCredential(route, { ANTHROPIC_API_KEY: 'sk-test' })).not.toThrow()
  })

  it('names the exact variable that is missing, and exits 2', () => {
    const route = parseModel('anthropic:claude-opus-5')

    let thrown: unknown
    try {
      requireCredential(route, {})
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ConfigError)
    expect((thrown as ConfigError).message).toContain('ANTHROPIC_API_KEY')
    expect((thrown as ConfigError).exitCode).toBe(2)
  })

  it('treats an empty or whitespace-only value as unset', () => {
    const route = parseModel('openai:gpt-5')

    expect(() => requireCredential(route, { OPENAI_API_KEY: '   ' })).toThrow(ConfigError)
  })

  it('asks for the gateway key on a gateway route, not a provider key', () => {
    const route = parseModel('anthropic/claude-opus-5')

    let thrown: unknown
    try {
      requireCredential(route, { ANTHROPIC_API_KEY: 'sk-test' })
    } catch (error) {
      thrown = error
    }

    expect((thrown as ConfigError).message).toContain(GATEWAY_ENV_VAR)
  })

  it('checks the right variable for each provider', () => {
    for (const provider of SUPPORTED_PROVIDERS) {
      const route = parseModel(`${provider}:model-x`)
      expect(() => requireCredential(route, { [PROVIDER_ENV_VARS[provider]]: 'key' })).not.toThrow()
    }
  })
})

describe('describeModel', () => {
  it('states the model and how it is reached, for attribution (FR-033)', () => {
    expect(describeModel(parseModel('anthropic:claude-opus-5'))).toContain('claude-opus-5')
    expect(describeModel(parseModel('anthropic:claude-opus-5'))).toContain('anthropic')
    expect(describeModel(parseModel('anthropic/claude-opus-5'))).toContain('Gateway')
  })
})
