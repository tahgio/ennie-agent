/**
 * The single place that talks to api.gbif.org (research D5).
 *
 * Everything about timeouts, retries, backoff and cancellation lives here so
 * that FR-026, FR-026a, FR-026b and FR-028 are auditable in one file rather
 * than re-derived at each call site. It carries no HTTP dependency and no retry
 * library: native `fetch`, `AbortSignal.timeout()` and `AbortSignal.any()`
 * cover the requirement between them (Constitution VIII).
 *
 * Two clocks run at once, and the distinction matters:
 *
 *   - a **10s per-attempt timeout**, after which that attempt is abandoned and
 *     counted against the retry budget; and
 *   - a **30s per-call budget** spanning every attempt, every backoff sleep,
 *     and every upstream request the tool makes — including the resolution call
 *     that precedes an occurrence query. When it expires the call is over.
 *
 * The third signal in the mix is the client's own cancellation, threaded from
 * the MCP request through to the socket, so an abandoned request stops costing
 * GBIF work immediately (FR-028).
 */
import type { ZodType } from 'zod'
import { ToolError } from '../errors.js'

const DEFAULT_BASE_URL = 'https://api.gbif.org/v1'
const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000
const DEFAULT_CALL_BUDGET_MS = 30_000
const DEFAULT_MAX_RETRIES = 3
const BACKOFF_BASE_MS = 500
const BACKOFF_CAP_MS = 8_000

/** Retried because a later attempt can plausibly succeed. A 501 never will. */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504])

/**
 * A descriptive User-Agent is a condition of politely using a free public API.
 * `GBIF_USER_AGENT_CONTACT` is optional and appended when set, so an operator
 * running this at volume can be contacted rather than simply blocked.
 */
export function userAgent(env: NodeJS.ProcessEnv = process.env): string {
  const contact = env.GBIF_USER_AGENT_CONTACT?.trim()
  const base = 'gbif-mcp-server/0.1 (+https://github.com/ennie-agent; MCP server for GBIF)'
  return contact ? `${base} (contact: ${contact})` : base
}

/**
 * The 30s ceiling on one tool call, shared across every request that call makes.
 *
 * Held as an object rather than a bare signal because the retry logic needs to
 * ask how much time is *left* — that is what makes the fail-fast rule below
 * possible (FR-026b).
 */
export class CallBudget {
  readonly signal: AbortSignal
  readonly #startedAt: number
  readonly #totalMs: number
  readonly #now: () => number
  readonly #controller: AbortController
  readonly #timer: ReturnType<typeof setTimeout>

  constructor(options: { totalMs?: number; now?: () => number } = {}) {
    this.#totalMs = options.totalMs ?? DEFAULT_CALL_BUDGET_MS
    this.#now = options.now ?? Date.now
    this.#startedAt = this.#now()
    this.#controller = new AbortController()
    this.signal = this.#controller.signal
    this.#timer = setTimeout(
      () => this.#controller.abort(new Error('call budget exhausted')),
      this.#totalMs,
    )
    // A pending budget timer must never hold the process open by itself.
    this.#timer.unref?.()
  }

  get totalMs(): number {
    return this.#totalMs
  }

  remainingMs(): number {
    return Math.max(0, this.#totalMs - (this.#now() - this.#startedAt))
  }

  /** Always call this when the tool call ends, successfully or not. */
  dispose(): void {
    clearTimeout(this.#timer)
  }
}

export interface GbifClientOptions {
  readonly baseUrl?: string
  /** Injected in tests so the default suite never opens a socket (FR-038). */
  readonly fetchImpl?: typeof fetch
  readonly attemptTimeoutMs?: number
  readonly maxRetries?: number
  readonly env?: NodeJS.ProcessEnv
  /** Injectable clock, jitter and sleep, so retry behaviour is testable without waiting. */
  readonly now?: () => number
  readonly random?: () => number
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

export interface GbifRequest<T> {
  /** Path below the API root, e.g. `/species/match`. */
  readonly path: string
  readonly params: Readonly<Record<string, string | number | boolean | undefined | string[]>>
  /** Lenient schema for the response body (see `schemas.ts`). */
  readonly schema: ZodType<T>
  readonly budget: CallBudget
  /** The MCP request's own cancellation signal, when the client supplied one. */
  readonly signal?: AbortSignal | undefined
}

export interface GbifResponse<T> {
  readonly data: T
  /** Attempts beyond the first. 0 means the first attempt worked. */
  readonly retries: number
  /** Requests that actually left the process — asserted to be 1 for summaries. */
  readonly upstreamRequests: number
}

/** Abortable sleep, so cancellation lands during a backoff wait, not after it. */
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * `Retry-After` is either a delay in seconds or an HTTP date. Both forms are
 * accepted; anything unparseable reads as absent rather than as zero.
 */
export function parseRetryAfter(header: string | null, now: number): number | null {
  if (header === null) return null

  const trimmed = header.trim()
  if (trimmed === '') return null

  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000

  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) return null
  return Math.max(0, date - now)
}

/** Exponential backoff with full jitter, capped so one wait cannot eat the budget. */
export function backoffMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt)
  return Math.round(random() * ceiling)
}

export class GbifClient {
  readonly #baseUrl: string
  readonly #fetch: typeof fetch
  readonly #attemptTimeoutMs: number
  readonly #maxRetries: number
  readonly #userAgent: string
  readonly #now: () => number
  readonly #random: () => number
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>

  constructor(options: GbifClientOptions = {}) {
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
    this.#fetch = options.fetchImpl ?? globalThis.fetch
    this.#attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
    this.#userAgent = userAgent(options.env)
    this.#now = options.now ?? Date.now
    this.#random = options.random ?? Math.random
    this.#sleep = options.sleep ?? defaultSleep
  }

  buildUrl(path: string, params: GbifRequest<unknown>['params']): string {
    const url = new URL(this.#baseUrl + path)
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue
      // Repeated keys are how GBIF takes multiple facets on one request (F6).
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, item)
      } else {
        url.searchParams.append(key, String(value))
      }
    }
    return url.toString()
  }

  async get<T>(request: GbifRequest<T>): Promise<GbifResponse<T>> {
    const url = this.buildUrl(request.path, request.params)
    let attempt = 0
    let upstreamRequests = 0

    for (;;) {
      this.#assertBudgetRemains(request)

      const attemptSignal = AbortSignal.any(
        [
          AbortSignal.timeout(Math.min(this.#attemptTimeoutMs, request.budget.remainingMs())),
          request.budget.signal,
          request.signal,
        ].filter((s): s is AbortSignal => s !== undefined),
      )

      let response: Response
      upstreamRequests += 1
      try {
        response = await this.#fetch(url, {
          method: 'GET',
          headers: { 'User-Agent': this.#userAgent, Accept: 'application/json' },
          signal: attemptSignal,
        })
      } catch (error) {
        // An aborted attempt is not automatically retryable: the client
        // cancelling and the whole budget expiring are both terminal.
        this.#assertNotCancelled(request, error)
        this.#assertBudgetRemains(request)

        // Only an abandoned attempt or a genuine transport failure is worth
        // retrying. `fetch` signals those as an AbortError/TimeoutError or a
        // TypeError; anything else came from our own code, and retrying it
        // three times would bury the real cause under a timeout message.
        if (!isRetryableFetchFailure(error)) throw error

        if (attempt >= this.#maxRetries) {
          throw new ToolError({
            code: 'UPSTREAM_TIMEOUT',
            what: `GBIF did not respond within the ${Math.round(request.budget.totalMs / 1000)}s budget for this call, after ${attempt + 1} attempts.`,
            next: 'Retry, or narrow the filters to make the query cheaper upstream.',
            retryable: true,
          })
        }

        await this.#waitBeforeRetry(request, attempt, null)
        attempt += 1
        continue
      }

      if (response.ok) {
        return {
          data: await this.#parseBody(response, request.schema),
          retries: attempt,
          upstreamRequests,
        }
      }

      // --- Not OK. Decide between retry and a recoverable error. ---
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), this.#now())
      const body = await this.#readErrorBody(response)

      if (!RETRYABLE_STATUSES.has(response.status)) {
        throw this.#terminalHttpError(response.status, body, attempt)
      }

      if (attempt >= this.#maxRetries) {
        throw this.#exhaustedError(response.status, attempt, retryAfterMs)
      }

      await this.#waitBeforeRetry(request, attempt, retryAfterMs)
      attempt += 1
    }
  }

  /**
   * FR-026b, the fail-fast rule. If GBIF asks us to wait longer than the call
   * has left, sleeping through it would stall the model's turn and then fail
   * anyway. Better to say so immediately and name the wait it asked for, so the
   * caller can decide whether to come back later.
   */
  async #waitBeforeRetry(
    request: GbifRequest<unknown>,
    attempt: number,
    retryAfterMs: number | null,
  ): Promise<void> {
    const wait = retryAfterMs ?? backoffMs(attempt, this.#random)
    const remaining = request.budget.remainingMs()

    if (wait >= remaining) {
      if (retryAfterMs !== null) {
        throw new ToolError({
          code: 'UPSTREAM_RATE_LIMITED',
          what: `GBIF is rate limiting and asked us to wait ${Math.round(retryAfterMs / 1000)}s, which is longer than this call's ${Math.round(request.budget.totalMs / 1000)}s budget.`,
          next: `Retry in about ${Math.round(retryAfterMs / 1000)}s, or narrow the query so it costs GBIF less.`,
          retryable: true,
        })
      }
      throw new ToolError({
        code: 'UPSTREAM_TIMEOUT',
        what: `GBIF did not respond within the ${Math.round(request.budget.totalMs / 1000)}s budget for this call.`,
        next: 'Retry, or narrow the filters to make the query cheaper upstream.',
        retryable: true,
      })
    }

    try {
      await this.#sleep(
        wait,
        AbortSignal.any([request.budget.signal, ...(request.signal ? [request.signal] : [])]),
      )
    } catch (error) {
      this.#assertNotCancelled(request, error)
      this.#assertBudgetRemains(request)
      throw error
    }
  }

  #assertBudgetRemains(request: GbifRequest<unknown>): void {
    if (request.signal?.aborted === true) throw cancelled()
    if (request.budget.signal.aborted || request.budget.remainingMs() <= 0) {
      throw new ToolError({
        code: 'UPSTREAM_TIMEOUT',
        what: `GBIF did not respond within the ${Math.round(request.budget.totalMs / 1000)}s budget for this call.`,
        next: 'Retry, or narrow the filters to make the query cheaper upstream.',
        retryable: true,
      })
    }
  }

  #assertNotCancelled(request: GbifRequest<unknown>, error: unknown): void {
    if (error instanceof ToolError) throw error
    if (request.signal?.aborted === true) throw cancelled()
  }

  /**
   * Read the body as text first and only then attempt JSON (research F8).
   *
   * GBIF answers a bad offset with `Max offset of 100001 exceeded: 100001 + 1`
   * — HTTP 400, `Content-Type: text/plain`. Calling `.json()` on that throws a
   * parse error that says nothing about what the caller did wrong.
   */
  async #readErrorBody(response: Response): Promise<string> {
    try {
      const text = (await response.text()).trim()
      if (text === '') return ''
      try {
        const parsed: unknown = JSON.parse(text)
        if (parsed !== null && typeof parsed === 'object' && 'message' in parsed) {
          return String((parsed as { message: unknown }).message)
        }
        return text
      } catch {
        return text
      }
    } catch {
      return ''
    }
  }

  async #parseBody<T>(response: Response, schema: ZodType<T>): Promise<T> {
    const text = await response.text()
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw new ToolError({
        code: 'UPSTREAM_UNAVAILABLE',
        what: 'GBIF returned a success status with a body that is not JSON.',
        next: 'Retry shortly; if it persists GBIF may be having an outage.',
        retryable: true,
      })
    }

    const parsed = schema.safeParse(json)
    if (!parsed.success) {
      throw new ToolError({
        code: 'UPSTREAM_UNAVAILABLE',
        what: 'GBIF returned a response in a shape this server does not recognise.',
        next: 'Retry shortly; if it persists, the GBIF API contract may have changed and this server needs updating.',
        retryable: true,
      })
    }
    return parsed.data
  }

  #terminalHttpError(status: number, body: string, attempt: number): ToolError {
    if (status >= 400 && status < 500) {
      const detail = body === '' ? '' : ` GBIF said: "${body}"`
      return new ToolError({
        code: 'UPSTREAM_BAD_REQUEST',
        what: `GBIF rejected this query with HTTP ${status}.${detail}`,
        next: 'Correct the parameter GBIF named and call again; repeating the same request will fail the same way.',
        retryable: false,
      })
    }
    return new ToolError({
      code: 'UPSTREAM_UNAVAILABLE',
      what: `GBIF returned ${status} after ${attempt} retries.`,
      next: 'Retry shortly; if it persists GBIF may be having an outage.',
      retryable: true,
    })
  }

  #exhaustedError(status: number, attempt: number, retryAfterMs: number | null): ToolError {
    if (status === 429) {
      const seconds = retryAfterMs === null ? 30 : Math.round(retryAfterMs / 1000)
      return new ToolError({
        code: 'UPSTREAM_RATE_LIMITED',
        what: `GBIF is rate limiting; ${attempt} retries did not clear it.`,
        next: `Retry in about ${seconds}s, or narrow the query.`,
        retryable: true,
      })
    }
    return new ToolError({
      code: 'UPSTREAM_UNAVAILABLE',
      what: `GBIF returned ${status} after ${attempt} retries.`,
      next: 'Retry shortly; if it persists GBIF may be having an outage.',
      retryable: true,
    })
  }
}

/**
 * `fetch` rejects with a TypeError for a transport-level failure, and with an
 * AbortError/TimeoutError DOMException when its signal fires. Everything else
 * reaching this point is a defect rather than a flaky network.
 */
function isRetryableFetchFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true
  const name = (error as { name?: unknown } | null)?.name
  return name === 'AbortError' || name === 'TimeoutError'
}

function cancelled(): ToolError {
  return new ToolError({
    code: 'CANCELLED',
    what: 'The client cancelled this request before GBIF replied.',
    next: 'Issue the call again if the answer is still wanted.',
    retryable: true,
  })
}
