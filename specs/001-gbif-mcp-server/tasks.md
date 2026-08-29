---
description: "Task list for GBIF Biodiversity MCP Server and CLI Agent"
---

# Tasks: GBIF Biodiversity MCP Server and CLI Agent

**Input**: Design documents from `/specs/001-gbif-mcp-server/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Included. Tests are not optional for this feature — FR-038 through FR-041 and Constitution VI mandate an offline default suite, protocol-level tests over a real client/server pair, and opt-in live and eval suites.

**Organization**: Grouped by user story so each is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story the task serves (US1–US5)

## Path Conventions

pnpm workspace monorepo per [plan.md](./plan.md):

- Server: `packages/mcp-server/src/`, `packages/mcp-server/tests/`
- Agent: `packages/agent/src/`, `packages/agent/evals/`, `packages/agent/tests/`

**Constitution guardrails that constrain nearly every task**: nothing but JSON-RPC on stdout; recoverable failures return `isError: true` rather than throwing; every tool declares `outputSchema` and returns `structuredContent` plus text; the agent never imports server internals.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Workspace, toolchain, and the dependency pins that keep the tree coherent

- [X] T001 Create the pnpm workspace root: `package.json` (`"type": "module"`, `packageManager`), `pnpm-workspace.yaml` listing `packages/*`, and `.gitignore`
- [X] T002 Create the base `tsconfig.json` at repo root with `strict: true`, `noUncheckedIndexedAccess: true`, `module: "nodenext"`, `target: "es2023"` (Constitution IV)
- [X] T003 Scaffold `packages/mcp-server/package.json` with deps `@modelcontextprotocol/sdk@^1.30.0`, `zod@^4.5.2`, `pino@^10.3.1` and a `bin` entry pointing at `dist/index.js`
- [X] T004 Scaffold `packages/agent/package.json` with deps `@voltagent/core@^2.10.0`, `ai@^6.0.0`, `@ai-sdk/anthropic@^3`, `@ai-sdk/openai@^3`, `@ai-sdk/google@^3`, `zod@^4.5.2` — and **no dependency on `mcp-server`** (Constitution VII, FR-037)
- [X] T005 Add a `pnpm.overrides` entry in the root `package.json` pinning a single `zod@^4.5.2` across the workspace (Constitution IV: one Zod version)
- [X] T006 [P] Configure Biome in `biome.json` for lint + format, and wire `lint`/`format` scripts in the root `package.json`
- [X] T007 [P] Add a Biome/ESLint-style restricted-import rule in `biome.json` forbidding any import of `packages/mcp-server/**` from `packages/agent/**` (mechanical enforcement of Constitution VII)
- [X] T008 [P] Add `packages/mcp-server/tsconfig.json` and `packages/agent/tsconfig.json` extending the root config with per-package `outDir`
- [X] T009 [P] Configure Vitest in `vitest.config.ts` with three projects — `unit`, `protocol` (both in the default `test` run) and `live` (excluded by default) — per FR-038/FR-040
- [X] T010 Add `.github/workflows/ci.yml` running install → typecheck → lint → test → build only, and asserting the resolved `ai` major is 6 (research D4 guards against `ai@latest` being 7.x). CI must **not** run `test:live` or `eval` (FR-040, Constitution VI)

**Checkpoint**: `pnpm install`, `pnpm typecheck`, `pnpm lint` all succeed on an empty skeleton

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The GBIF access layer, error/logging contracts, and the server skeleton that every tool plugs into

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

### Upstream contract and fixtures

- [ ] T011 [P] Write lenient upstream Zod schemas in `packages/mcp-server/src/gbif/schemas.ts` per [data-model.md](./data-model.md) §1: `.passthrough()`, every non-essential field `.nullable()`, `confidence` accepting negatives (research F2), `matchType` as a plain string not an enum, `facets` defaulting to `[]`
- [ ] T012 Write `scripts/capture-fixtures.ts` and capture real GBIF responses into `packages/mcp-server/tests/fixtures/` — the exact cases from [research.md](./research.md) Part 1: exact match, fuzzy typo, `NONE` at confidence 100, homonym with `verbose=true` alternatives, `HIGHERRANK`, synonym with `acceptedUsageKey`, vernacular search, faceted `limit=0` response, a full 95-field occurrence record, and a plain-text 400 body (FR-038, Constitution VI)

### Cross-cutting server infrastructure

- [ ] T013 [P] Implement `ToolError` in `packages/mcp-server/src/errors.ts` with **required** `what`, `next`, and `retryable` fields, plus a `toToolResult()` producing `{ isError: true }` with both sentences rendered. The required `next` field is what makes "Invalid input" unrepresentable (FR-023, FR-024, Constitution V)
- [ ] T014 [P] Implement logging in `packages/mcp-server/src/logging.ts`: a pino instance writing to **stderr only**, plus a helper emitting MCP logging notifications for tool events (FR-025, FR-029)
- [ ] T015 In `packages/mcp-server/src/index.ts`, reassign `console.log`/`console.info` to `console.error` **before importing any other module**, so a stray log from any dependency cannot corrupt the protocol stream (Constitution I)
- [ ] T016 Implement the TTL cache in `packages/mcp-server/src/gbif/cache.ts`: in-process `Map`, 1-hour TTL, keyed on normalised name + rank + kingdom hints, **caching negative outcomes too**, exposing hit/miss for logging (FR-030, data-model §4)

### GBIF HTTP client

- [ ] T017 Implement the core request path in `packages/mcp-server/src/gbif/client.ts`: native `fetch`, descriptive `User-Agent` (with optional `GBIF_USER_AGENT_CONTACT`), 10s per-attempt timeout and 30s per-call budget composed via `AbortSignal.any([AbortSignal.timeout(...), budgetSignal, mcpRequestSignal])` (FR-026a, FR-028)
- [ ] T018 Add retry and backoff to `packages/mcp-server/src/gbif/client.ts`: retry **only** on 429/502/503/504 and network errors, max 3 retries, exponential backoff with jitter, honouring `Retry-After` (FR-026)
- [ ] T019 Add the fail-fast rule to `packages/mcp-server/src/gbif/client.ts`: when `Retry-After` exceeds the remaining call budget, abandon immediately and raise a `ToolError` naming the requested wait rather than sleeping through it (FR-026b)
- [ ] T020 Add error-response handling to `packages/mcp-server/src/gbif/client.ts`: read the body as **text first**, attempt JSON only opportunistically — GBIF returns plain text on a 400 (research F8, data-model §1)
- [ ] T021 [P] Implement the shared filter schema in `packages/mcp-server/src/domain/filters.ts`: `country` (`^[A-Z]{2}$`, uppercased first), `yearFrom`/`yearTo` bounds, `hasCoordinate`, plus cross-field rules rejecting a backwards year range and `offset + limit > 100000` — all **before any network call** (FR-011, FR-012, research F8, F9)

### Server skeleton

- [ ] T022 Implement `createServer()` in `packages/mcp-server/src/server.ts` returning a configured `McpServer` with **no knowledge of transports**, so an HTTP entrypoint later is additive rather than a refactor (plan D7)
- [ ] T023 Complete `packages/mcp-server/src/index.ts` as the stdio entrypoint: construct `StdioServerTransport`, connect the server from T022, and do nothing else

### Test harness

- [ ] T024 [P] Build the HTTP stub helper in `packages/mcp-server/tests/helpers/stub-gbif.ts`, serving the T012 fixtures and asserting **no real network call escapes** during the default suite (FR-038)
- [ ] T025 [P] Build the protocol test harness in `packages/mcp-server/tests/helpers/mcp-harness.ts`: a real `Client` and a real server from `createServer()` joined by the SDK's `InMemoryTransport` (FR-039)
- [ ] T026 [P] Write unit tests for retry, backoff, timeout, budget, and `Retry-After` handling in `packages/mcp-server/tests/unit/gbif-client.test.ts` covering every row of [quickstart.md](./quickstart.md) Scenario 6 (SC-010, SC-012)
- [ ] T027 [P] Write the stdout-purity protocol test in `packages/mcp-server/tests/protocol/stdout-purity.test.ts`, asserting that across a full client session stdout carried **only** parseable JSON-RPC frames (SC-009, Constitution I)

**Checkpoint**: A bare server starts, connects over both stdio and in-memory transports, logs to stderr, and the GBIF client is fully tested against fixtures — user stories can now begin

---

## Phase 3: User Story 1 — Resolve a species name to an authoritative taxon (Priority: P1) 🎯 MVP

**Goal**: Turn a scientific or common name into one accepted GBIF taxon, or a recoverable error naming the next step. Never a silent guess.

**Independent Test**: Call `resolve_taxon` over a real MCP client with a correct scientific name, a common name, a synonym, a misspelling, a cross-kingdom homonym, and a genus-only match. Each returns exactly one accepted taxon or an actionable error. No fabricated results, no crashes.

### Tests for User Story 1 ⚠️

> Write these first and confirm they fail before implementing

- [ ] T028 [P] [US1] Unit-test the resolution policy in `packages/mcp-server/tests/unit/resolution.test.ts`, asserting the **ordering** from data-model §3: homonym detected before any confidence test, since GBIF reports both a homonym and a total non-match as `matchType: NONE` with `confidence: 100` (research F1, F2)
- [ ] T029 [P] [US1] Unit-test the vernacular fallback in `packages/mcp-server/tests/unit/vernacular.test.ts`: `nubKey`-null entries discarded, `vernacularNames` verified against the query rather than trusting rank order, and the surviving hit re-resolved through its accepted taxon (research F4 — "polar bear" ranks a sponge first, then a synonym)
- [ ] T030 [P] [US1] Protocol-test `resolve_taxon` in `packages/mcp-server/tests/protocol/resolve-taxon.test.ts` against every row of [quickstart.md](./quickstart.md) Scenario 4, asserting `isError: true` with actionable text — not thrown exceptions (FR-023)

### Implementation for User Story 1

- [ ] T031 [P] [US1] Implement `matchName()` in `packages/mcp-server/src/gbif/species.ts` calling `/v1/species/match` **always with `verbose=true`** — homonym candidates exist nowhere else (research F2, FR-005)
- [ ] T032 [P] [US1] Implement `searchVernacular()` in `packages/mcp-server/src/gbif/species.ts` calling `/v1/species/search?qField=VERNACULAR`
- [ ] T033 [US1] Implement the resolution policy in `packages/mcp-server/src/domain/resolution.ts` in the exact order from data-model §3, mapping to `ResolvedTaxon` with `taxonKey` set to the **accepted** key (`acceptedUsageKey` for synonyms — using `usageKey` silently under-counts downstream) (research F5, FR-003)
- [ ] T034 [US1] Implement the vernacular fallback path in `packages/mcp-server/src/domain/resolution.ts` per data-model §3, reached only when the scientific match fails or falls below 90 (FR-001, clarification Q1)
- [ ] T035 [US1] Wire the resolution cache from T016 into `packages/mcp-server/src/domain/resolution.ts`, recording hit/miss on every call (FR-030)
- [ ] T036 [US1] Register `resolve_taxon` in `packages/mcp-server/src/tools/resolve-taxon.ts` with the input schema, `outputSchema`, and the **exact description text** from [contracts/resolve-taxon.md](./contracts/resolve-taxon.md) — the description is prompt surface (FR-019, Constitution I)
- [ ] T037 [US1] Return `structuredContent` plus a human-readable text block from `packages/mcp-server/src/tools/resolve-taxon.ts`, with every GBIF-omittable field `.nullable()` in the output schema so a valid response cannot become a protocol fault (FR-020, plan D8)
- [ ] T038 [US1] Map every resolution failure in `packages/mcp-server/src/tools/resolve-taxon.ts` to the `ToolError` rows in [contracts/resolve-taxon.md](./contracts/resolve-taxon.md) — `AMBIGUOUS` must **list the competing candidates with their kingdoms** (FR-005, FR-024)

**Checkpoint**: `resolve_taxon` works end to end over a real MCP client. Shippable on its own — it turns colloquial names into authoritative classifications.

---

## Phase 4: User Story 2 — Answer a distribution question without transporting records (Priority: P2)

**Goal**: Answer "where", "when", and "how many" from counts alone, in one upstream call, with a response size independent of match count.

**Independent Test**: Request country, year, and basis-of-record breakdowns for a widespread species. Each returns a total plus ranked counts, contains zero individual records, and is the same size for a species with millions of records as for one with a hundred.

### Tests for User Story 2 ⚠️

- [ ] T039 [P] [US2] Unit-test facet mapping in `packages/mcp-server/tests/unit/facets.test.ts`: upper-snake GBIF fields (`COUNTRY`, `BASIS_OF_RECORD`) mapped back to contract dimension names, unrecognised facet fields dropped rather than throwing (research F6)
- [ ] T040 [P] [US2] Protocol-test `summarize_occurrences` in `packages/mcp-server/tests/protocol/summarize-occurrences.test.ts`, asserting **exactly one** upstream request per call, zero records in the response, and identical response bounds across a common and a rare species (SC-002, SC-003)
- [ ] T041 [P] [US2] Protocol-test the zero-match case in `packages/mcp-server/tests/protocol/summarize-occurrences.test.ts`: `totalCount: 0` is a **success**, not an error (spec edge case)

### Implementation for User Story 2

- [ ] T042 [US2] Implement `searchOccurrences()` in `packages/mcp-server/src/gbif/occurrence.ts` supporting `limit=0` plus multiple `facet` params and the per-facet `{facet}.facetLimit` form on a single request (research F6)
- [ ] T043 [US2] Implement dimension mapping in `packages/mcp-server/src/gbif/occurrence.ts` between contract names (`country`, `year`, `basisOfRecord`) and GBIF's facet keys
- [ ] T044 [US2] Register `summarize_occurrences` in `packages/mcp-server/src/tools/summarize-occurrences.ts` with the exact description from [contracts/summarize-occurrences.md](./contracts/summarize-occurrences.md), which **must** state it is preferred for where/when/how-many questions so the model reaches for it before paginating (FR-017)
- [ ] T045 [US2] Define the output schema in `packages/mcp-server/src/tools/summarize-occurrences.ts` with **no `records` field at all**, making "transports no records" structural rather than conventional (FR-013)
- [ ] T046 [US2] Implement `topN` truncation (1–20, default 10) in `packages/mcp-server/src/tools/summarize-occurrences.ts`, setting `truncated` and `distinctValuesReturned` so a hidden tail is stated plainly (FR-018)
- [ ] T047 [US2] Accept either `taxonKey` or `name` in `packages/mcp-server/src/tools/summarize-occurrences.ts`, resolving names through US1's policy and returning the resolved taxon in the response (FR-015, FR-016)

**Checkpoint**: The server answers distribution questions without transporting records — the capability the whole design exists for

---

## Phase 5: User Story 3 — Retrieve a bounded page of individual records (Priority: P3)

**Goal**: Return a capped, trimmed page of occurrence records plus the total match count, so callers see the size of what they did not receive.

**Independent Test**: Request records with and without filters. Pages never exceed 50, every record carries exactly the 8 specified fields, and `totalCount` always accompanies the page.

### Tests for User Story 3 ⚠️

- [ ] T048 [P] [US3] Unit-test record trimming in `packages/mcp-server/tests/unit/trim.test.ts` against the captured 95-field fixture: exactly 8 data fields survive, and `countryCode` (the ISO code) is emitted rather than `country` (the display name) so values round-trip as filter inputs (research F10, Principle III)
- [ ] T049 [P] [US3] Unit-test absence handling in `packages/mcp-server/tests/unit/trim.test.ts`: records lacking dates, coordinates, or publisher yield explicit `null`, never a default or an omitted key (FR-009)
- [ ] T050 [P] [US3] Protocol-test cap enforcement in `packages/mcp-server/tests/protocol/search-occurrences.test.ts`: `limit: 51` is **rejected**, because GBIF itself accepts `limit=500` and silently returns 300 with HTTP 200 (research F7, FR-008)
- [ ] T051 [P] [US3] Protocol-test input rejection in `packages/mcp-server/tests/protocol/search-occurrences.test.ts` for backwards year ranges, invalid country codes, and `offset > 100000` — all rejected **before** any network call (FR-011, FR-012)

### Implementation for User Story 3

- [ ] T052 [US3] Extend `packages/mcp-server/src/gbif/occurrence.ts` with a paged record search passing `taxonKey`, filters, `limit`, and `offset`
- [ ] T053 [P] [US3] Implement `trimRecord()` in `packages/mcp-server/src/domain/trim.ts` mapping 95 upstream fields to the 8-field `OccurrenceRecord` of data-model §2
- [ ] T054 [US3] Register `search_occurrences` in `packages/mcp-server/src/tools/search-occurrences.ts` with the exact description from [contracts/search-occurrences.md](./contracts/search-occurrences.md), including the explicit steer toward `summarize_occurrences` for distribution questions
- [ ] T055 [US3] Enforce `limit` (1–50, default 20) and the offset ceiling in the Zod input schema in `packages/mcp-server/src/tools/search-occurrences.ts` — locally, never delegated upstream (FR-008, research F7)
- [ ] T056 [US3] Always include `totalCount`, `offset`, `limit`, and `returnedCount` in the response from `packages/mcp-server/src/tools/search-occurrences.ts` (FR-010)
- [ ] T057 [US3] Accept either `taxonKey` or `name` in `packages/mcp-server/src/tools/search-occurrences.ts`, reusing US1's resolution (FR-006)

**Checkpoint**: All three tools functional and independently tested. The server is complete and usable by any MCP client.

---

## Phase 6: User Story 4 — Hold a biodiversity conversation from the command line (Priority: P4)

**Goal**: An interactive CLI agent that connects over stdio, chains the tools, keeps conversation context, asks for clarification when the server reports ambiguity, and never leaves an orphaned process.

**Independent Test**: Start a session; ask a distribution question and confirm one summarising call; follow up without restating the species; ask about a homonym and confirm the agent asks *you* which kingdom; exit and confirm no server process survives.

### Tests for User Story 4 ⚠️

- [ ] T058 [P] [US4] Unit-test `MODEL` resolution in `packages/agent/tests/model.test.ts`: `provider:model` routes direct, `provider/model` falls through to the gateway, an unknown provider before a colon **errors naming the three supported providers** rather than silently falling through (FR-032, [contracts/agent-cli.md](./contracts/agent-cli.md))
- [ ] T059 [P] [US4] Unit-test credential failure in `packages/agent/tests/model.test.ts`: exit code 2, message naming the exact env var, and **no server spawned** (FR-034)
- [ ] T060 [P] [US4] Integration-test teardown in `packages/agent/tests/teardown.test.ts` across all four exit paths — `/exit`, EOF, thrown error, SIGINT — asserting no orphaned server process (FR-035)

### Implementation for User Story 4

- [ ] T061 [P] [US4] Implement `MODEL` parsing and provider routing in `packages/agent/src/model.ts` per [contracts/agent-cli.md](./contracts/agent-cli.md), checking the colon form first
- [ ] T062 [US4] Implement the credential preflight in `packages/agent/src/model.ts`: verify the provider key before contacting the server or the model, exiting 2 with the variable named (FR-034)
- [ ] T063 [US4] Wire `MCPConfiguration` (stdio) in `packages/agent/src/index.ts` to launch the built server **by path as a child process**, with no workspace dependency on `mcp-server` (FR-037, Constitution VII)
- [ ] T064 [US4] Print the resolved model identity before the first prompt in `packages/agent/src/index.ts`, so any answer is attributable (FR-033)
- [ ] T065 [US4] Implement the interactive loop in `packages/agent/src/session.ts` retaining conversation context across turns, in memory only, never written to disk (FR-031, FR-031a)
- [ ] T066 [US4] Handle session exit in `packages/agent/src/session.ts` on `/exit`, EOF, and SIGINT, stating that it is exiting (FR-031b)
- [ ] T067 [US4] Put `disconnect()` in a `finally` in `packages/agent/src/index.ts` covering every path, with SIGINT/SIGTERM handlers routing into the same teardown (FR-035)
- [ ] T068 [US4] Write agent instructions in `packages/agent/src/instructions.ts` covering **presentation and clarification only** — formatting counts, stating zero totals, noting truncation. Tool semantics must come from the server so third-party clients get identical guidance (FR-036)
- [ ] T069 [US4] Implement clarification handling in `packages/agent/src/session.ts`: a server `AMBIGUOUS` error becomes a plain-language question to the person, and their reply drives the retry — never a guess, never raw error text (FR-036a)
- [ ] T070 [US4] Handle non-interactive input in `packages/agent/src/session.ts`: piped or closed stdin processes what it receives and exits cleanly rather than blocking on a prompt nobody will answer (spec edge case)

### Evals for User Story 4

- [ ] T071 [P] [US4] Define the `RunRecord` type and structural scorers as **plain functions** in `packages/agent/evals/scorers/`, scoring capability selection and chain correctness from the recorded call sequence — pure and runner-independent so Viteval can be swapped (FR-041, plan D12)
- [ ] T072 [US4] Build the Viteval suite in `packages/agent/evals/` with **at least 8 scenarios** driven programmatically with scripted replies (including a clarification exchange), reporting the structural score and a separate judge-model rating, stamped with agent model, judge model, and date. A judge failure must not fail the run (FR-041a, FR-041b, FR-041c, SC-011)

**Checkpoint**: The agent proves the server works for its primary user, over a real protocol boundary

---

## Phase 7: User Story 5 — Explore and adopt the server as a third-party client (Priority: P5)

**Goal**: The server is self-describing: any client discovers its capabilities, composition guidance, and guided workflow without reading the source.

**Independent Test**: Point the MCP Inspector at the server from a clean clone following only the documented quickstart. All three tools appear with complete schemas, the instructions arrive at connection time, and the report prompt is invocable.

### Tests for User Story 5 ⚠️

- [ ] T073 [P] [US5] Protocol-test discovery in `packages/mcp-server/tests/protocol/discovery.test.ts`: `tools/list` returns exactly three tools each with complete input **and** output schemas and constraint-stating descriptions (FR-019, SC-006)
- [ ] T074 [P] [US5] Protocol-test the initialize result in `packages/mcp-server/tests/protocol/discovery.test.ts`, asserting the `instructions` field is present and non-empty (FR-021)
- [ ] T075 [P] [US5] Protocol-test the prompt in `packages/mcp-server/tests/protocol/prompt.test.ts`: `prompts/list` includes `species_distribution_report` and `prompts/get` returns the workflow for a given species (FR-022)

### Implementation for User Story 5

- [ ] T076 [US5] Write the server `instructions` in `packages/mcp-server/src/instructions.ts` using the exact text from [contracts/server-instructions.md](./contracts/server-instructions.md), and pass it into `createServer()` (FR-021)
- [ ] T077 [US5] Register `species_distribution_report` in `packages/mcp-server/src/prompts/species-distribution-report.ts` with `species` and optional `country` arguments, returning the exact workflow text from [contracts/species-distribution-report.md](./contracts/species-distribution-report.md) (FR-000b, FR-022)
- [ ] T078 [P] [US5] Add the MCP client configuration snippet to `README.md` (the `mcpServers` JSON block from [quickstart.md](./quickstart.md) Scenario 8)
- [ ] T079 [P] [US5] Add `.env.example` documenting `MODEL`, the three provider keys, `AI_GATEWAY_API_KEY`, the VoltOps keys, and `GBIF_USER_AGENT_CONTACT`
- [ ] T080 [US5] Verify the quickstart in `specs/001-gbif-mcp-server/quickstart.md` (Scenario 2) brings the server up in the MCP Inspector from a clean clone with **no GBIF account**, correcting `README.md` where the documented steps drift (SC-001)

**Checkpoint**: All five user stories independently functional

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T081 [P] Add optional VoltOps trace export in `packages/agent/src/index.ts` behind `VOLTOPS_PUBLIC_KEY`/`VOLTOPS_SECRET_KEY`, flushed before exit
- [ ] T082 [P] Emit a structured log entry per tool call in `packages/mcp-server/src/logging.ts` carrying tool name, duration, retry count, and cache outcome — stderr only (FR-029)
- [ ] T083 [P] Build the opt-in live suite in `packages/mcp-server/tests/live/` behind `pnpm test:live`, confirming the T012 fixtures still match reality; documented as opt-in and excluded from CI (FR-040)
- [ ] T084 [P] Add an `MIT` `LICENSE` file at the repo root
- [ ] T085 [P] Add the CI badge to `README.md`
- [ ] T086 Write the decision record in `README.md` as **Context / Decision / Trade-off** entries, drawn from [research.md](./research.md) — including the four GBIF findings that changed the design and the `ai@6`/provider-v3 pin (FR-042, Constitution IX)
- [ ] T087 Write the "deliberately not built" section in `README.md` covering every item in the spec's Out of Scope, with reasons — recording what was excluded carries as much weight as what was built (Constitution IX)
- [ ] T088 Document in `README.md` how LLM assistance was used and validated on this project (FR-042, SC-013)
- [ ] T089 Document the opt-in commands in `README.md`, stating plainly that `test:live` hits GBIF, that `eval` costs money, and that neither runs in CI (FR-040)
- [ ] T090 Verify Constitution VIII by auditing the final dependency tree: confirm `packages/mcp-server` ships exactly three production dependencies and record the VoltAgent transitive-provider trade-off from [plan.md](./plan.md) Complexity Tracking
- [ ] T091 Run all 8 scenarios in `specs/001-gbif-mcp-server/quickstart.md` and confirm every row of its acceptance summary table
- [ ] T092 Confirm the offline guarantee by running `unshare -rn pnpm test` (or an equivalent airgap) against `vitest.config.ts`'s default projects, verifying a clean pass with no network (FR-038, SC-007)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies
- **Foundational (Phase 2)**: depends on Setup — **blocks every user story**
- **US1 (Phase 3)**: depends on Foundational only
- **US2 (Phase 4)**: depends on Foundational; uses US1's resolution for its `name` input (T047)
- **US3 (Phase 5)**: depends on Foundational; uses US1's resolution for its `name` input (T057)
- **US4 (Phase 6)**: depends on a working server — practically, on US1 plus at least one occurrence tool
- **US5 (Phase 7)**: depends on all three tools being registered
- **Polish (Phase 8)**: depends on all desired stories

### Story Dependencies

- **US1 (P1)** — fully independent once Foundational lands. The MVP.
- **US2 (P2)** and **US3 (P3)** — independently testable via `taxonKey`, and can be built in parallel by different people. Both reuse US1's resolution for the `name` convenience path; if US1 is not done, they remain testable with `taxonKey` inputs alone.
- **US4 (P4)** — needs a running server to talk to, so it is genuinely downstream.
- **US5 (P5)** — discoverability across all three tools, so it lands last.

### Within Each Story

Tests first and failing → upstream client functions → domain logic → tool registration → error mapping.

### Parallel Opportunities

- Setup: T006, T007, T008, T009 in parallel
- Foundational: T011, T013, T014 in parallel; then T024, T025, T026, T027 in parallel. **T017 → T018 → T019 → T020 are strictly sequential — same file.**
- US1: T028, T029, T030 in parallel; T031 and T032 in parallel. **T033, T034, T035 are sequential — same file.**
- US2: T039, T040, T041 in parallel
- US3: T048, T049, T050, T051 in parallel; T053 parallel with T052
- US4: T058, T059, T060 in parallel; T071 parallel with implementation
- US5: T073, T074, T075 in parallel; T078, T079 in parallel
- Polish: T081–T085 in parallel
- With staff: **US2 and US3 in parallel** after US1

---

## Parallel Example: User Story 1

```bash
# Tests first — all three touch different files:
Task: "Unit-test resolution policy ordering in packages/mcp-server/tests/unit/resolution.test.ts"
Task: "Unit-test vernacular fallback in packages/mcp-server/tests/unit/vernacular.test.ts"
Task: "Protocol-test resolve_taxon in packages/mcp-server/tests/protocol/resolve-taxon.test.ts"

# Then the two upstream callers (same file, different exports — coordinate or sequence):
Task: "Implement matchName() with verbose=true in packages/mcp-server/src/gbif/species.ts"
Task: "Implement searchVernacular() in packages/mcp-server/src/gbif/species.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1)

1. Phase 1: Setup
2. Phase 2: Foundational — **critical, blocks everything**
3. Phase 3: US1 — `resolve_taxon`
4. **STOP and VALIDATE**: run quickstart Scenario 4 in full. Every misspelling, homonym, synonym, and genus-only match must produce an actionable error or one accepted taxon.
5. Demo: the server resolves colloquial names to authoritative classifications through a real MCP client.

### Incremental Delivery

1. Setup + Foundational → foundation ready
2. + US1 → **MVP**: name resolution
3. + US2 → the headline capability: distribution answers without records
4. + US3 → record retrieval, deliberately after summarisation so listing stays the exception
5. + US4 → the agent proves the boundary is real
6. + US5 → third-party adoption
7. + Polish → the README that makes the work reviewable

### Parallel Team Strategy

1. Everyone on Setup + Foundational
2. Then: Dev A on US1 → US2; Dev B on US3 (using fixed `taxonKey`s until US1 lands); Dev C on US4 scaffolding and evals
3. US5 and Polish once the tools are registered

---

## Notes

- **Ordering is load-bearing in T033.** GBIF returns `confidence: 100` on `matchType: NONE`, so a confidence check placed before the match-type check accepts every failed lookup. This is the single most likely bug in the feature.
- **Never delegate the record cap upstream** (T055): GBIF accepts `limit=500` and silently returns 300 with HTTP 200.
- **Always use the accepted taxon key** (T033): a synonym's own `usageKey` silently under-counts every downstream query.
- Fixtures come from real captured responses (T012), including the awkward ones — `NONE` at confidence 100, `confidence: -1` alternatives, and a plain-text 400 body.
- Commit after each task or logical group, using Conventional Commits (Constitution Governance).
- `[P]` means different files with no incomplete dependencies. Tasks touching `client.ts`, `resolution.ts`, or `occurrence.ts` are sequential within their file.
