/**
 * Serve the captured GBIF responses as a stand-in `fetch` (T012, FR-038).
 *
 * The fixtures are real upstream output, captured by `scripts/capture-fixtures.ts`
 * — including the cases nobody would invent by hand: `matchType: NONE` arriving
 * at `confidence: 100`, alternatives carrying `confidence: -1`, and a 400 whose
 * body is plain text rather than JSON. Stubbing from real responses is what
 * makes an offline suite meaningful rather than a test of our own assumptions
 * (Constitution VI).
 *
 * Matching ignores parameter *order* but not parameter *content*, so a test
 * that changes what it asks GBIF for gets a loud miss listing the near matches,
 * rather than a stale fixture that happens to still parse.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** `fetch`'s own first parameter type, which is not a global in this tsconfig. */
type FetchInput = Parameters<typeof fetch>[0]

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

interface Fixture {
  readonly name: string
  readonly why: string
  readonly request: { readonly path: string }
  readonly response: {
    readonly status: number
    readonly contentType: string | null
    readonly json: unknown
    readonly text: string | null
  }
}

/** `/v1/species/match?b=2&a=1` and `/species/match?a=1&b=2` are the same request. */
function normalize(pathAndQuery: string): string {
  const url = new URL(pathAndQuery, 'https://api.gbif.org')
  const path = url.pathname.replace(/^\/v1/, '')
  const params = [...url.searchParams.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('&')
  return params === '' ? path : `${path}?${params}`
}

function loadFixtures(): Map<string, Fixture> {
  const byRequest = new Map<string, Fixture>()
  for (const file of readdirSync(FIXTURE_DIR)) {
    if (!file.endsWith('.json') || file === 'index.json') continue
    const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8')) as Fixture
    byRequest.set(normalize(fixture.request.path), fixture)
  }
  return byRequest
}

const FIXTURES = loadFixtures()

/** Look a fixture up by name, for tests that assert on the captured content itself. */
export function fixture(name: string): Fixture {
  for (const candidate of FIXTURES.values()) {
    if (candidate.name === name) return candidate
  }
  throw new Error(`No fixture named '${name}'. Run \`pnpm capture-fixtures\`.`)
}

/** The parsed body of a named fixture. */
export function fixtureJson<T = unknown>(name: string): T {
  return fixture(name).response.json as T
}

export interface StubbedFetch {
  readonly fetch: typeof fetch
  /** Every URL requested, in order. */
  readonly calls: readonly string[]
  /** How many requests were made — the assertion behind "one call per summary". */
  readonly count: number
  reset(): void
}

export interface FixtureFetchOptions {
  /**
   * Responses to serve instead of a fixture, keyed by normalised path+query, or
   * by the special key `'*'` to answer everything. Used by the resilience tests
   * to script 429/503/timeout sequences that no captured fixture can express.
   */
  readonly overrides?: Record<string, () => Promise<Response> | Response>
}

/**
 * Build a `fetch` that answers from the captured fixtures.
 *
 * An unmatched request throws rather than returning a 404, because a 404 would
 * be indistinguishable from GBIF genuinely not having the record, and would let
 * a mis-specified test pass for the wrong reason.
 */
export function createFixtureFetch(options: FixtureFetchOptions = {}): StubbedFetch {
  const calls: string[] = []
  const overrides = options.overrides ?? {}

  const stub = async (input: FetchInput): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(href)

    const key = normalize(href)

    const override = overrides[key] ?? overrides['*']
    if (override !== undefined) return await override()

    const match = FIXTURES.get(key)
    if (match === undefined) {
      const near = [...FIXTURES.keys()]
        .filter((candidate) => candidate.split('?')[0] === key.split('?')[0])
        .slice(0, 5)
      throw new Error(
        [
          `No captured GBIF fixture for:`,
          `  ${key}`,
          near.length > 0
            ? `\nFixtures on the same path:\n${near.map((n) => `  ${n}`).join('\n')}`
            : '',
          `\nAdd the case to scripts/capture-fixtures.ts and run \`pnpm capture-fixtures\`.`,
        ].join('\n'),
      )
    }

    const body = match.response.text ?? JSON.stringify(match.response.json)
    return new Response(body, {
      status: match.response.status,
      headers: match.response.contentType ? { 'content-type': match.response.contentType } : {},
    })
  }

  return {
    fetch: stub as unknown as typeof fetch,
    get calls() {
      return calls
    },
    get count() {
      return calls.length
    },
    reset() {
      calls.length = 0
    },
  }
}
