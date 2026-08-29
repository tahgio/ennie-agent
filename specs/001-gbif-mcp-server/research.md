# Phase 0 Research: GBIF Biodiversity MCP Server and CLI Agent

**Date**: 2026-08-29 | **Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

The technical direction was supplied with the planning request, so this document does two things:
it records each supplied decision with its rationale and rejected alternatives, and it reports
**what was verified against the live GBIF API and the npm registry on 2026-08-29**. Several
verifications contradicted the obvious implementation and are called out as such — those are the
findings that change the design rather than confirm it.

---

## Part 1 — Upstream API findings (verified against live GBIF)

Every claim below was confirmed by calling `api.gbif.org` directly. Captured responses become the
test fixtures required by Principle VI.

### F1. `matchType: NONE` returns `confidence: 100` — the threshold rule must be gated on match type

**Finding**: A nonsense name returns `{"confidence": 100, "matchType": "NONE", "synonym": false}`
with no `usageKey`. Confidence is a *match-quality* score, not a *found-anything* score.

**Consequence**: A naive `confidence >= 90` check (FR-004) accepts every failed lookup. Resolution
policy MUST evaluate `matchType` first and only then apply the confidence bar:

| `matchType` | Rule |
|-------------|------|
| `NONE` | Unresolved. Recoverable error, regardless of confidence. |
| `HIGHERRANK` | Unresolved at the intended rank. Recoverable error naming the rank reached (FR-004a). |
| `EXACT` | Accept. |
| `FUZZY` | Accept only when `confidence >= 90`. |

This is the single highest-value finding in this document; it would otherwise have shipped as a bug
that silently resolves every unmatched name.

### F2. Homonyms surface as `NONE` with a `note`, and candidates require `verbose=true`

**Finding**: `species/match?name=Prunella` (a genus in both Plantae and Animalia) returns
`matchType: NONE`, `confidence: 100`, and `note: "Multiple equal matches for Prunella"` — with **no
candidate list**. Adding `verbose=true` returns an `alternatives[]` array carrying two equal
`EXACT` matches at confidence 99, one per kingdom. Supplying `kingdom=Plantae` resolves cleanly to
one taxon at confidence 96.

**Consequence**: FR-005 (enumerate competing candidates) is **unimplementable without
`verbose=true`**. The resolution client always requests verbose output. Distinguishing a homonym
from a genuine no-match is done by inspecting `alternatives[]`, not by the `note` string, which is
free text and unsafe to parse. Note also that alternative entries can carry `confidence: -1`, so
the lenient parser must tolerate negative scores.

### F3. `species/match` does not resolve common names at all

**Finding**: `species/match?name=polar bear` returns `matchType: NONE`.

**Consequence**: The two-stage fallback settled in clarification Q1 is not an optimisation — it is
required for common names to work at all.

### F4. The common-name fallback needs filtering and re-resolution, not "take the top hit"

**Finding**: `species/search?q=polar bear&qField=VERNACULAR` ranks poorly. Unfiltered, the first
result is *Xestospongia ursa* — the "Polar Bear Sponge". Constrained to the animal kingdom, the
first result is *Thalarctos maritimus*, which is a **synonym** of *Ursus maritimus*.

**Consequence**: The fallback must (a) keep only entries with a `nubKey` (present in the GBIF
backbone), (b) confirm the query actually appears in the candidate's returned `vernacularNames`
rather than trusting rank order, and (c) re-resolve the winner through the accepted taxon. Where
more than one backbone candidate survives, this returns candidates as a recoverable error, matching
the "never guess silently" rule.

### F5. Synonyms carry `acceptedUsageKey`; occurrence queries must use the accepted key

**Finding**: `species/match?name=Felis concolor` returns `status: SYNONYM`, `usageKey: 2435104`,
`acceptedUsageKey: 2435099`, plus `species: "Puma concolor"` and `speciesKey: 2435099`.

**Consequence**: Resolution reports the matched key and the accepted key separately (FR-003), and
every downstream occurrence query keys off the **accepted** identifier. Using `usageKey` for a
synonym silently under-counts.

### F6. Faceting returns counts with zero records at `limit=0`

**Finding**: `occurrence/search?taxonKey=…&limit=0&facet=country&facet=year` returns `count`, an
empty `results[]`, and `facets[]` of `{field, counts:[{name,count}]}`. Field names come back
upper-snake (`COUNTRY`, `YEAR`, `BASIS_OF_RECORD`). Per-facet caps use the `{facet}.facetLimit`
form — `basisOfRecord.facetLimit=3` — verified working.

**Consequence**: `summarize_occurrences` is one request with `limit=0` and N facets. This is the
mechanism that makes Principle II achievable rather than aspirational.

### F7. Upstream silently clamps an oversized `limit` — our cap must be enforced locally

**Finding**: `limit=500` returns HTTP **200** with `"limit": 300`. No error.

**Consequence**: FR-008's cap of 50 cannot be delegated upstream. Zod enforces it before the call,
so an over-cap request fails loudly at our boundary instead of quietly returning a different page
size than asked for.

### F8. Offset beyond 100,000 is a hard upstream 400

**Finding**: `offset=100001` returns HTTP 400, body `Max offset of 100001 exceeded: 100001 + 1`.

**Consequence**: Validate `offset + limit <= 100000` locally and return a recoverable error
directing the caller to narrow filters or summarise (FR-024). A plain-text 400 body also proves the
error parser must not assume JSON.

### F9. Backwards year ranges and unknown country codes are upstream 400s

**Finding**: `year=2010,2000` → 400. `country=XX` → 400.

**Consequence**: FR-011 and FR-012 already require rejecting both *before* any network call, which
is correct on latency grounds and produces a better message than the upstream body.

### F10. Occurrence records carry 95 fields; country appears twice in different forms

**Finding**: A single record returned **95 fields**. The filter parameter takes an ISO code
(`country=CA`), but the record's `country` field is a display name
(`"United States of America"`) while `countryCode` holds `US`. Facet keys use the code. Records
also carry `license` and `occurrenceStatus`.

**Consequence**: This is Principle II made concrete — 95 fields trimmed to 8. Emit `countryCode`
(the code) as the record's country, never the display name, so that a value returned by one tool
can be fed back as a filter to another (Principle III, tools compose). `license` is noted under
Deferred below.

---

## Part 2 — Stack decisions

### D1. Runtime and language

**Decision**: TypeScript on Node 24 LTS, ESM throughout, `strict` plus `noUncheckedIndexedAccess`.

**Rationale**: Directly mandated by Constitution IV. Node 24 provides native `fetch`,
`AbortSignal.timeout()`, and `AbortSignal.any()` — the three platform primitives that let the
retry/timeout/cancellation design carry zero dependencies (Constitution VIII).

**Alternatives rejected**: CommonJS (the MCP SDK and VoltAgent are ESM-first); Deno or Bun (a
third-party MCP client must be able to launch the server with a plain `node` command).

### D2. Workspace layout

**Decision**: pnpm workspace with `packages/mcp-server` and `packages/agent`. No shared internal
package.

**Rationale**: Constitution VII makes the boundary the architecture. Two packages with no path
between them means the agent *cannot* import server internals, and the integration is proven rather
than asserted. A lint rule plus the absence of a workspace dependency enforce it mechanically.

**Alternatives rejected**: a single package with directories (the boundary becomes a convention
that erodes); a shared `packages/types` (it would immediately become the smuggling route for server
internals, defeating the point — duplicating a handful of type declarations is the cheaper price).

### D3. Zod 4 across the workspace

**Decision**: `zod@^4.5.2`, one version, enforced by a pnpm overrides entry.

**Rationale**: Verified compatible with both consumers — `@modelcontextprotocol/sdk@1.30.0`
declares `zod: ^3.25 || ^4.0`, and `@voltagent/core@2.10.0` declares `zod: ^3.25.0 || ^4.0.0`.
Constitution IV requires exactly one version; without an override, transitive resolution can
install both majors side by side and Zod instances stop being mutually recognisable.

### D4. AI SDK v6 and provider v3 — **not** the `latest` tags

**Decision**: pin `ai@^6.0.0`, `@ai-sdk/anthropic@^3`, `@ai-sdk/openai@^3`, `@ai-sdk/google@^3`.

**Rationale**: This was verified because it is a trap. `@voltagent/core@2.10.0` declares
`peerDependencies: { ai: "^6.0.0" }` and depends on the provider packages at `^3.0.0`. But
`npm latest` currently resolves `ai` to **7.0.84** and the providers to **v4**. A routine
`pnpm add ai @ai-sdk/anthropic` therefore installs a combination VoltAgent does not support. AI SDK
v6 remains published under the `ai-v6` dist-tag (6.0.271).

**Consequence**: exact ranges are pinned in the plan and a CI check asserts the resolved `ai` major
stays at 6.

### D5. GBIF access layer

**Decision**: one `gbif/client.ts` owning native `fetch`, a 10s per-attempt timeout, a 30s
per-call budget, retries limited to 429/502/503/504 and network errors, exponential backoff with
jitter honouring `Retry-After`, and a descriptive `User-Agent`.

**Rationale**: Implements FR-026/026a/026b in one auditable place. Timeout and cancellation compose
from platform primitives: `AbortSignal.any([AbortSignal.timeout(10_000), callBudgetSignal,
mcpRequestSignal])` threads the client's cancellation (FR-028) through to the socket with no
dependency. Retrying only on those statuses keeps a 400 — a caller mistake — from being retried
three times before surfacing.

**Alternatives rejected**: `axios`/`got` plus a retry plugin (Constitution VIII — the platform
already does this); retrying all 5xx (a 501 will never succeed on retry).

### D6. Cache scope

**Decision**: in-process TTL map in front of taxon resolution only. Not occurrence search, not
summaries.

**Rationale**: Resolution is the hot path — every tool accepting a name resolves first, and a
conversation revisits the same species repeatedly. It is also the only genuinely stable mapping;
occurrence counts change as datasets are published, and caching them would serve stale answers to a
question about current data. Keeps the no-persistence exclusion intact.

**Note**: this remains the one design element resting on inference rather than an explicit
instruction, flagged as Outstanding at the end of `/speckit-clarify`.

### D7. Tool registration isolated from transport wiring

**Decision**: `server.ts` exports `createServer()` returning a fully configured `McpServer` with no
knowledge of transports. `index.ts` is the stdio entrypoint and does nothing but construct a
transport and connect.

**Rationale**: This is what makes the "HTTP transport is a new entrypoint, not a refactor"
non-goal true rather than aspirational, and it is what lets protocol tests connect the same server
to an in-memory transport (FR-039).

### D8. Structured output

**Decision**: every tool declares `outputSchema` and returns `structuredContent` plus a text block.

**Rationale**: FR-019/FR-020, Constitution I. Confirmed supported by the SDK's `registerTool`,
which derives JSON Schema from the Zod schema and validates results against `outputSchema`.

**Consequence worth noting**: because the SDK validates outgoing `structuredContent` against the
declared schema, an output schema that is stricter than reality turns a successful upstream call
into a protocol fault. Output schemas therefore model absence explicitly (`.nullable()`) for every
field GBIF may omit — dates, coordinates, and publisher (FR-009, spec edge case).

### D9. Errors

**Decision**: an internal `ToolError` carrying `{ what, next }`, converted at the tool boundary
into `{ isError: true }` with both sentences rendered. Thrown exceptions are reserved for protocol
faults.

**Rationale**: Constitution I and V. `isError: true` keeps the failure inside the model's
reasoning; a thrown exception is invisible to it. Forcing `next` to be a required field at the type
level makes "Invalid input" structurally impossible to express (FR-024).

### D10. Logging

**Decision**: pino to stderr, plus MCP logging notifications for tool events. Optional VoltOps
trace export behind env vars, flushed before exit.

**Rationale**: Two channels serve different consumers — pino for the developer's terminal, MCP
notifications for connected clients that render logs. Both avoid stdout. pino is one of the few
dependencies that clears Constitution VIII on its own merits: hand-rolled JSON logging drops
serialisation safety around circular structures and error objects.

**Guard**: Constitution I's stdout rule gets a mechanical test, not just a convention — the
protocol suite asserts stdout carries only JSON-RPC frames, and the entrypoint reassigns
`console.log` to `console.error` before any module can misuse it.

### D11. Testing

**Decision**: Vitest. Unit tests for pure logic; protocol tests driving a real client against a
real server over the SDK's `InMemoryTransport`; upstream HTTP stubbed from captured fixtures. A
separate opt-in live suite.

**Rationale**: FR-038/039/040 and Constitution VI. Fixtures are the responses captured in Part 1,
so the stubs are real GBIF output rather than invented shapes — including the awkward ones (`NONE`
at confidence 100, `confidence: -1` alternatives, a plain-text 400 body).

### D12. Evals

**Decision**: Viteval, with scorers written as plain functions over a `RunRecord`.

**Rationale**: Viteval is Vitest-powered, so evals reuse the test toolchain, and it is VoltAgent's
own eval framework. Keeping scorers as plain functions over a serialisable run record is the part
that matters: the structural score (FR-041) is then pure and runner-independent, and swapping
Viteval out later touches no scoring logic.

### D13. Lint, format, CI

**Decision**: Biome. GitHub Actions running install, typecheck, lint, test, build — nothing else.

**Rationale**: Biome replaces ESLint plus Prettier with one dependency. CI deliberately omits live
and eval suites (FR-040), which is the mechanical expression of Constitution VI.

---

## Part 3 — Deferred

- **Dataset licence surfacing**: records carry a `license` URL (verified: a CC BY-NC link on an
  iNaturalist record). The trimmed record includes dataset and publisher, which satisfies
  attribution, but per-record licence is not surfaced. This is the Compliance item left Outstanding
  by `/speckit-clarify`; adding the field later is additive and breaks no schema.
- **GBIF registration**: not required. All endpoints used are anonymous, satisfying the "no account
  signup beyond a model key" quickstart criterion (SC-001).

## Unresolved

None. No `NEEDS CLARIFICATION` markers remain in the Technical Context.
