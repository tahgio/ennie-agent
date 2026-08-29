/**
 * Resilience of the GBIF client — one test per row of quickstart Scenario 6
 * (SC-010, SC-012, FR-026, FR-026a, FR-026b, FR-028).
 *
 * Time is injected rather than spent: the backoff sleep is a spy that records
 * what it was asked to wait, and the call budget runs on a fake clock. So these
 * assertions are about the *decisions* — retry or not, wait how long, fail with
 * which message — and the suite still finishes in milliseconds.
 */
import { describe, expect, it, vi } from 'vitest'
import * as z from 'zod'
import { ToolError } from '../../src/errors.js'
import {
  backoffMs,
  CallBudget,
  GbifClient,
  parseRetryAfter,
  userAgent,
} from '../../src/gbif/client.js'

/** `fetch`'s own first parameter type, which is not a global in this tsconfig. */
type FetchInput = Parameters<typeof fetch>[0]

const schema = z.looseObject({ ok: z.boolean().nullish() })

/**
 * A fetch that replays a scripted sequence of responses, one per attempt.
 *
 * The abort signal is handed to each step because real `fetch` rejects when its
 * signal fires — a stub that ignored it would make the per-attempt timeout
 * untestable, and would quietly diverge from the behaviour being relied on.
 */
type Step = (signal: AbortSignal | undefined) => Promise<Response> | Response

function scriptedFetch(steps: Step[]) {
  let index = 0
  const calls: string[] = []
  const impl = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    calls.push(String(input))
    const step = steps[Math.min(index, steps.length - 1)]
    index += 1
    if (step === undefined) throw new Error('no scripted step')
    return await step(init?.signal ?? undefined)
  }
  return {
    impl: impl as unknown as typeof fetch,
    calls,
    get attempts() {
      return index
    },
  }
}

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 })
const status = (code: number, headers: Record<string, string> = {}, body = 'upstream error') =>
  new Response(body, { status: code, headers: { 'content-type': 'text/plain', ...headers } })

interface Harness {
  client: GbifClient
  budget: CallBudget
  sleeps: number[]
  advance: (ms: number) => void
}

function harness(
  steps: Step[],
  options: { maxRetries?: number; attemptTimeoutMs?: number; totalMs?: number } = {},
): Harness & { calls: string[]; attempts: () => number } {
  let clock = 0
  const sleeps: number[] = []
  const fetchStub = scriptedFetch(steps)

  const budget = new CallBudget({ totalMs: options.totalMs ?? 30_000, now: () => clock })
  const client = new GbifClient({
    fetchImpl: fetchStub.impl,
    maxRetries: options.maxRetries ?? 3,
    attemptTimeoutMs: options.attemptTimeoutMs ?? 10_000,
    now: () => clock,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms)
      // The wait is charged to the budget without actually elapsing.
      clock += ms
    },
  })

  return {
    client,
    budget,
    sleeps,
    advance: (ms) => {
      clock += ms
    },
    calls: fetchStub.calls,
    attempts: () => fetchStub.attempts,
  }
}

const request = (h: Harness, signal?: AbortSignal) => ({
  path: '/occurrence/search',
  params: { taxonKey: 1 },
  schema,
  budget: h.budget,
  signal,
})

describe('parseRetryAfter', () => {
  it('reads a delay in seconds', () => {
    expect(parseRetryAfter('2', 0)).toBe(2000)
  })

  it('reads an HTTP date, relative to now', () => {
    const now = Date.parse('2026-08-29T12:00:00Z')
    expect(parseRetryAfter('Sat, 29 Aug 2026 12:00:30 GMT', now)).toBe(30_000)
  })

  it('treats an unparseable or absent header as absent, never as zero', () => {
    expect(parseRetryAfter(null, 0)).toBeNull()
    expect(parseRetryAfter('soon please', 0)).toBeNull()
    expect(parseRetryAfter('', 0)).toBeNull()
  })
})

describe('backoffMs', () => {
  it('grows exponentially and is jittered by the injected random', () => {
    expect(backoffMs(0, () => 1)).toBe(500)
    expect(backoffMs(1, () => 1)).toBe(1000)
    expect(backoffMs(2, () => 1)).toBe(2000)
    // Full jitter: the wait is a random fraction of the ceiling, not the ceiling.
    expect(backoffMs(2, () => 0.5)).toBe(1000)
  })

  it('caps the ceiling so one wait cannot swallow the whole call budget', () => {
    expect(backoffMs(20, () => 1)).toBe(8000)
  })
})

describe('userAgent', () => {
  it('is descriptive, and carries a contact when one is configured', () => {
    expect(userAgent({})).toContain('gbif-mcp-server')
    expect(userAgent({ GBIF_USER_AGENT_CONTACT: 'ops@example.org' })).toContain('ops@example.org')
  })
})

describe('GbifClient retry policy', () => {
  it('429 with Retry-After: 2 waits the requested 2s, retries, and succeeds', async () => {
    const h = harness([() => status(429, { 'retry-after': '2' }), ok])

    const result = await h.client.get(request(h))

    expect(result.data).toEqual({ ok: true })
    expect(result.retries).toBe(1)
    expect(h.sleeps).toEqual([2000])
  })

  it('429 without Retry-After backs off exponentially with jitter', async () => {
    const h = harness([() => status(429), () => status(429), ok])

    const result = await h.client.get(request(h))

    expect(result.retries).toBe(2)
    // random() is pinned at 0.5, so each wait is half its ceiling.
    expect(h.sleeps).toEqual([250, 500])
  })

  it('429 with Retry-After: 600 fails immediately, naming the wait it asked for', async () => {
    const h = harness([() => status(429, { 'retry-after': '600' })])

    const error = await h.client.get(request(h)).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ToolError)
    const toolError = error as ToolError
    expect(toolError.code).toBe('UPSTREAM_RATE_LIMITED')
    expect(toolError.what).toContain('600s')
    expect(toolError.next).toContain('600s')
    // FR-026b: it must not stall the turn sleeping through a wait it cannot afford.
    expect(h.sleeps).toEqual([])
    expect(h.attempts()).toBe(1)
  })

  it('503 four times over retries three times, then names the status', async () => {
    const h = harness([() => status(503)])

    const error = (await h.client.get(request(h)).catch((e: unknown) => e)) as ToolError

    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE')
    expect(error.what).toContain('503')
    expect(h.attempts()).toBe(4) // the first attempt plus three retries
  })

  it('does not retry a 400 — a caller mistake will not fix itself', async () => {
    const h = harness([() => status(400, {}, 'Max offset of 100001 exceeded: 100001 + 1')])

    const error = (await h.client.get(request(h)).catch((e: unknown) => e)) as ToolError

    expect(error.code).toBe('UPSTREAM_BAD_REQUEST')
    expect(error.retryable).toBe(false)
    expect(h.attempts()).toBe(1)
  })

  it('surfaces a plain-text 400 body verbatim rather than failing to parse it as JSON', async () => {
    // research F8: GBIF answers a bad offset with text/plain, not JSON.
    const h = harness([() => status(400, {}, 'Max offset of 100001 exceeded: 100001 + 1')])

    const error = (await h.client.get(request(h)).catch((e: unknown) => e)) as ToolError

    expect(error.what).toContain('Max offset of 100001 exceeded')
  })
})

describe('GbifClient timeouts and cancellation', () => {
  it('abandons an attempt that exceeds the per-attempt timeout and counts it as a retry', async () => {
    // Hangs until its signal aborts, exactly as a real slow request would.
    const never: Step = (signal) =>
      new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
          once: true,
        })
      })
    const h = harness([never, ok], { attemptTimeoutMs: 20 })

    const result = await h.client.get(request(h))

    expect(result.retries).toBe(1)
    expect(h.attempts()).toBe(2)
  })

  it('gives up with a recoverable timeout once the whole-call budget is spent', async () => {
    const h = harness([() => status(503)], { totalMs: 1000 })
    h.advance(1500) // the budget is already gone before the first attempt

    const error = (await h.client.get(request(h)).catch((e: unknown) => e)) as ToolError

    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe('UPSTREAM_TIMEOUT')
    expect(error.what).toContain('budget')
    expect(h.attempts()).toBe(0)
  })

  it('stops when the client cancels mid-flight, without an unhandled rejection', async () => {
    const controller = new AbortController()
    const aborted = vi.fn()
    const h = harness([
      (signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              aborted()
              reject(new DOMException('aborted', 'AbortError'))
            },
            { once: true },
          )
        }),
    ])

    const pending = h.client.get(request(h, controller.signal))
    controller.abort()

    const error = (await pending.catch((e: unknown) => e)) as ToolError

    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe('CANCELLED')
    expect(aborted).toHaveBeenCalled()
  })
})

describe('GbifClient request building', () => {
  it('repeats a key for array values, which is how GBIF takes multiple facets', () => {
    const h = harness([ok])
    const url = h.client.buildUrl('/occurrence/search', {
      taxonKey: 1,
      limit: 0,
      facet: ['country', 'year'],
    })

    expect(url).toContain('facet=country')
    expect(url).toContain('facet=year')
    expect(url).toContain('limit=0')
  })

  it('omits undefined parameters rather than sending the string "undefined"', () => {
    const h = harness([ok])
    const url = h.client.buildUrl('/occurrence/search', { taxonKey: 1, country: undefined })

    expect(url).not.toContain('country')
  })
})
