#!/usr/bin/env node
/**
 * Capture real GBIF responses into `packages/mcp-server/tests/fixtures/`.
 *
 * Constitution VI requires the default test suite to be offline, and requires
 * the stubs it runs against to be *real* upstream output rather than invented
 * shapes. Every case below is one of the findings in research.md Part 1 —
 * including the awkward ones that would never be invented by hand:
 *
 *   - `matchType: NONE` arriving at `confidence: 100`               (F1)
 *   - homonym alternatives that only exist under `verbose=true`,
 *     some carrying `confidence: -1`                                (F2)
 *   - a vernacular search that ranks a sponge above the polar bear  (F4)
 *   - a faceted `limit=0` response: counts, zero records            (F6)
 *   - a 95-field occurrence record                                  (F10)
 *   - a 400 whose body is plain text, not JSON                      (F8)
 *
 * Each fixture records the status, content type, and body so the stub can
 * replay the exchange faithfully — an error case is only useful if its status
 * and its unparseable body survive the round trip.
 *
 * Run: `pnpm capture-fixtures`  (hits the network; never part of `pnpm test`)
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE_DIR = join(ROOT, 'packages/mcp-server/tests/fixtures')
const BASE = 'https://api.gbif.org/v1'
const USER_AGENT = 'ennie-agent-fixture-capture/0.1 (+https://github.com/ennie-agent)'

interface FixtureCase {
  /** File name, without extension. Also the key the stub helper looks up. */
  readonly name: string
  /** Path and query below `/v1`, written out so the fixture documents its own request. */
  readonly path: string
  /** Which research finding this case exists to pin down. */
  readonly why: string
}

const CASES: readonly FixtureCase[] = [
  // --- species/match: the resolution policy's whole input space (F1, F2, F5) ---
  {
    name: 'match-exact-ursus-maritimus',
    path: '/species/match?name=Ursus%20maritimus&verbose=true',
    why: 'EXACT match, the happy path: key 2433451 with a full classification',
  },
  {
    name: 'match-fuzzy-ursus-maritimuss',
    path: '/species/match?name=Ursus%20maritimuss&verbose=true',
    why: 'FUZZY match from a typo — accepted only at confidence >= 90 (FR-004)',
  },
  {
    name: 'match-none-nonsense',
    path: '/species/match?name=Zzzzqqq%20xxxxyy&verbose=true',
    why: 'F1: matchType NONE arriving at confidence 100. A confidence-first check accepts this.',
  },
  {
    name: 'match-homonym-prunella',
    path: '/species/match?name=Prunella&verbose=true',
    why: 'F2: a homonym reported as NONE/100, with candidates only in alternatives[]',
  },
  {
    name: 'match-homonym-prunella-plantae',
    path: '/species/match?name=Prunella&kingdom=Plantae&verbose=true',
    why: 'F2: the same name resolving cleanly once a kingdom hint breaks the tie',
  },
  {
    name: 'match-higherrank-puma',
    path: '/species/match?name=Puma%20notarealspecies&verbose=true',
    why: 'F1/FR-004a: HIGHERRANK — reached the genus, not the species. Not an answer.',
  },
  {
    name: 'match-synonym-felis-concolor',
    path: '/species/match?name=Felis%20concolor&verbose=true',
    why: 'F5: SYNONYM carrying acceptedUsageKey. Using usageKey here under-counts downstream.',
  },
  {
    name: 'match-thalarctos-maritimus',
    path: '/species/match?name=Thalarctos%20maritimus&verbose=true',
    why: 'F4: re-resolving the vernacular survivor, which is itself a synonym',
  },

  // --- species/search: the common-name fallback (F3, F4) ---
  {
    name: 'match-none-polar-bear',
    path: '/species/match?name=polar%20bear&verbose=true',
    why: 'F3: species/match does not resolve common names at all',
  },
  {
    name: 'search-vernacular-polar-bear',
    path: '/species/search?q=polar%20bear&qField=VERNACULAR&rank=SPECIES&limit=20',
    why: 'F4: ranks a sponge first, so rank order cannot be trusted',
  },
  {
    name: 'search-vernacular-nonsense',
    path: '/species/search?q=zzzzqqq%20xxxxyy&qField=VERNACULAR&rank=SPECIES&limit=20',
    why: 'The fallback finding nothing — NOT_FOUND rather than a guess',
  },

  // --- occurrence/search: faceting and records (F6, F7, F10) ---
  {
    name: 'occurrence-facets-ursus',
    path: '/occurrence/search?taxonKey=2433451&limit=0&facet=country&facet=year&facet=basisOfRecord&country.facetLimit=10&year.facetLimit=10&basisOfRecord.facetLimit=10',
    why: 'F6: the mechanism behind Principle II — counts with an empty results[]',
  },
  {
    name: 'occurrence-facets-country-only',
    path: '/occurrence/search?taxonKey=2433451&limit=0&facet=country&country.facetLimit=10',
    why: 'A single-dimension summary, to show one call still answers it',
  },
  {
    name: 'occurrence-facets-zero-match',
    path: '/occurrence/search?taxonKey=2433451&country=AQ&limit=0&facet=country&country.facetLimit=10',
    why: 'Zero matches is a success, not an error (FR-013 edge case)',
  },
  {
    name: 'occurrence-page-ursus',
    path: '/occurrence/search?taxonKey=2433451&limit=5&offset=0',
    why: 'F10: real records, 95 fields each, to be trimmed to 8',
  },
  {
    name: 'occurrence-page-ursus-filtered',
    path: '/occurrence/search?taxonKey=2433451&country=CA&year=2000,2020&hasCoordinate=true&limit=5&offset=0',
    why: 'The four hand-picked filters applied together (Principle III)',
  },

  // --- error bodies: the parser must not assume JSON (F8, F9) ---
  {
    name: 'error-offset-exceeded',
    path: '/occurrence/search?taxonKey=2433451&limit=1&offset=100001',
    why: 'F8: a 400 whose body is plain text. Proves the error path reads text first.',
  },
  {
    name: 'error-bad-country',
    path: '/occurrence/search?taxonKey=2433451&country=XX&limit=1',
    why: 'F9: rejected upstream — which is why we reject it locally, before the call',
  },
  {
    name: 'error-backwards-year',
    path: '/occurrence/search?taxonKey=2433451&year=2010,2000&limit=1',
    why: 'F9: a backwards year range is an upstream 400',
  },
]

interface CapturedFixture {
  readonly name: string
  readonly why: string
  readonly request: { readonly path: string }
  readonly response: {
    readonly status: number
    readonly contentType: string | null
    /** Parsed when the body is JSON; the raw string when it is not (F8). */
    readonly json: unknown
    readonly text: string | null
  }
  readonly capturedAt: string
}

async function capture(testCase: FixtureCase): Promise<CapturedFixture> {
  const response = await fetch(`${BASE}${testCase.path}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })

  // Text first, JSON only opportunistically — exactly what the client does (F8).
  const text = await response.text()
  let json: unknown = null
  let isJson = false
  try {
    json = JSON.parse(text)
    isJson = true
  } catch {
    isJson = false
  }

  return {
    name: testCase.name,
    why: testCase.why,
    request: { path: testCase.path },
    response: {
      status: response.status,
      contentType: response.headers.get('content-type'),
      json: isJson ? json : null,
      text: isJson ? null : text,
    },
    capturedAt: new Date().toISOString().slice(0, 10),
  }
}

async function main(): Promise<void> {
  await mkdir(FIXTURE_DIR, { recursive: true })

  const index: Array<{ name: string; path: string; status: number; why: string }> = []
  let failures = 0

  for (const testCase of CASES) {
    try {
      const fixture = await capture(testCase)
      await writeFile(
        join(FIXTURE_DIR, `${fixture.name}.json`),
        `${JSON.stringify(fixture, null, 2)}\n`,
        'utf8',
      )
      index.push({
        name: fixture.name,
        path: testCase.path,
        status: fixture.response.status,
        why: testCase.why,
      })
      const shape = fixture.response.json === null ? 'text' : 'json'
      console.error(`  ok  ${fixture.name}  ${fixture.response.status} (${shape})`)
    } catch (error) {
      failures += 1
      console.error(`  FAIL ${testCase.name}: ${(error as Error).message}`)
    }
    // Deliberately unhurried: this is a courtesy to a free public API.
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  await writeFile(
    join(FIXTURE_DIR, 'index.json'),
    `${JSON.stringify({ capturedAt: new Date().toISOString().slice(0, 10), fixtures: index }, null, 2)}\n`,
    'utf8',
  )

  console.error(`\ncaptured ${index.length}/${CASES.length} fixtures into ${FIXTURE_DIR}`)
  if (failures > 0) process.exit(1)
}

await main()
