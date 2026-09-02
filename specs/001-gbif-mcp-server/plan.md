# Implementation Plan: GBIF Biodiversity MCP Server and CLI Agent

**Branch**: `001-gbif-mcp-server` | **Date**: 2026-08-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-gbif-mcp-server/spec.md`

## Summary

Three MCP tools over the GBIF biodiversity API — `resolve_taxon`, `search_occurrences`,
`summarize_occurrences` — plus a `species_distribution_report` prompt, served over stdio by the
official MCP TypeScript SDK; and an interactive CLI agent built on VoltAgent that consumes the
server as a genuine MCP client.

The technical approach is shaped by three findings verified against the live GBIF API during Phase 0
(full detail in [research.md](./research.md)):

1. **GBIF reports "no match" at `confidence: 100`.** The resolution policy switches on `matchType`
   first and applies the 90-point bar only to `FUZZY`. A naive confidence check would accept every
   failed lookup.
2. **Homonym candidates only exist under `verbose=true`**, and GBIF reports a homonym as
   `matchType: NONE`. FR-005 is unimplementable without it.
3. **Faceted search with `limit=0` returns counts and zero records.** This single mechanism is what
   makes Principle II's "aggregate server-side" achievable, turning a 95-field × N-record answer
   into one bounded count list.

A fourth finding is a dependency trap rather than a design input: `@voltagent/core@2.10.0` requires
`ai@^6`, but `ai@latest` is 7.0.84 and the `@ai-sdk/*` provider packages at `latest` are v4. The
plan pins v6/v3 explicitly and asserts the resolved major in CI.

## Technical Context

**Language/Version**: TypeScript 5.x on Node 24 LTS. ESM throughout. `strict` plus
`noUncheckedIndexedAccess` (Constitution IV).

**Primary Dependencies**:

| Package | Version | Why it is here (Constitution VIII) |
|---------|---------|-------------------------------------|
| `@modelcontextprotocol/sdk` | `^1.30.0` | The protocol. Non-negotiable. |
| `zod` | `^4.5.2` | Tool input schemas and lenient upstream parsing. One version workspace-wide via pnpm `overrides`; verified compatible with both the MCP SDK (`^3.25 \|\| ^4.0`) and VoltAgent (`^3.25.0 \|\| ^4.0.0`). |
| `pino` | `^10.3.1` | Structured logs to stderr. Earns its place on safe serialisation of errors and circular structures. |
| `@voltagent/core` | `^2.10.0` | Agent runtime with first-class MCP client support. |
| `ai` | `^6.0.0` | **Pinned deliberately.** VoltAgent peer-requires `^6`; `latest` is 7.0.84. |
| `@ai-sdk/anthropic` / `@ai-sdk/openai` / `@ai-sdk/google` | `^3.0.0` | **Pinned deliberately.** `latest` is v4, which pairs with `ai@7`. |
| `vitest` | `^4.1.11` | Test runner for unit, protocol, and live suites. |
| `viteval` | `^0.5.9` | Opt-in agent evals; Vitest-powered, VoltAgent's own eval framework. |
| `@biomejs/biome` | `^2.5.11` | Lint and format in one dependency, replacing ESLint + Prettier. |

No HTTP client, no retry library, no dotenv-style loader: native `fetch`, `AbortSignal.timeout()`,
`AbortSignal.any()`, and `process.env` cover it (Constitution VIII).

**Storage**: None. One in-process TTL cache in front of taxon resolution only, discarded at exit.
No database, no files, no session transcripts.

**Testing**: Vitest. Three suites — `test` (unit + protocol, offline, the CI default), `test:live`
(opt-in, hits GBIF), `eval` (opt-in, calls models). Protocol tests drive a real MCP client against
a real server over the SDK's `InMemoryTransport`. Upstream HTTP stubbed from fixtures captured from
real GBIF responses during Phase 0.

**Target Platform**: Node 24 on Linux and macOS. The server runs as a stdio child process of any
MCP client; the agent runs as an interactive terminal process.

**Project Type**: pnpm workspace monorepo — an MCP server package and a CLI agent package.

**Performance Goals**: 10s per upstream attempt, 60s per tool call by default (operator-tunable via
`GBIF_CALL_BUDGET_MS`) including all retries and backoff (FR-026a). A distribution answer costs
exactly one upstream request regardless of match size (FR-013). Response size is bounded and
independent of match count: ≤ 50 records × 8 fields,
≤ 20 ranked values per facet dimension.

**Constraints**: Nothing but JSON-RPC on stdout, ever (FR-025, Constitution I). Recoverable
failures return `isError: true`, never a thrown exception (FR-023). The default test command runs
with no network access. The agent may not import server internals.

**Scale/Scope**: 3 tools, 1 prompt, 2 packages. GBIF holds billions of records; the design premise
is that essentially none of them ever enter a model's context window.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| # | Principle | Gate | Status |
|---|-----------|------|--------|
| I | Protocol correctness | stdout carries only JSON-RPC; `isError` for tool failures; `outputSchema` + `structuredContent` + text on every tool; instructions and descriptions treated as prompt surface | **PASS** — `console.log` reassigned to stderr at entrypoint before any module loads; protocol suite asserts stdout purity mechanically rather than by convention |
| II | Context economy | aggregate server-side; schema-declared caps; trimmed payloads | **PASS** — `summarize_occurrences` uses `limit=0` faceting (F6); records trimmed 95 fields → 8 (F10); caps of 50 records and top-20 facet values enforced in Zod |
| III | Tools model intents | no pass-through parameters; tools compose | **PASS** — filter set is a hand-picked four (country, year range, coordinate presence, offset), not a mirror of GBIF's parameter list; `resolve_taxon` output key feeds the other two, and records emit `countryCode` so a returned value is valid as a filter input |
| IV | Validate at every boundary | Zod before network; lenient upstream parsing; `strict` + `noUncheckedIndexedAccess`; one Zod version | **PASS** — upstream schemas use `.passthrough()` with `.nullable()` on every optional field; pnpm `overrides` pins one Zod |
| V | Errors are messages to a model | every error names what went wrong and what to do instead | **PASS** — `ToolError` requires a `next` field at the type level, so "Invalid input" cannot be expressed |
| VI | Deterministic by default | `test` never touches the network; protocol-level tests; live and eval suites opt-in and out of CI | **PASS** — fixtures captured from real GBIF responses in Phase 0; CI runs only install/typecheck/lint/test/build |
| VII | Package boundary is the architecture | agent talks to server only over MCP | **PASS** — no workspace dependency from `agent` to `mcp-server`; enforced by a lint rule and by the absence of a package reference |
| VIII | Dependencies justified individually | every production dependency survives "why is this here?" | **PASS with one item tracked** — see Complexity Tracking |
| IX | Decisions documented with trade-offs | Context / Decision / Trade-off in the README, including what was not built | **PASS** — research.md carries the decision record; README assembly is a tracked deliverable (FR-042) |

**Initial gate**: PASS. **Post-Phase-1 re-check**: PASS — the Phase 1 contracts did not introduce a
new violation. One pre-existing item remains tracked below.

## Project Structure

### Documentation (this feature)

```text
specs/001-gbif-mcp-server/
├── plan.md              # This file
├── research.md          # Phase 0: verified API findings + decision record
├── data-model.md        # Phase 1: entities, validation rules, transformations
├── quickstart.md        # Phase 1: runnable validation guide
├── contracts/           # Phase 1: tool, prompt, and CLI contracts
│   ├── README.md
│   ├── resolve-taxon.md
│   ├── search-occurrences.md
│   ├── summarize-occurrences.md
│   ├── species-distribution-report.md
│   ├── server-instructions.md
│   └── agent-cli.md
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
packages/
├── mcp-server/
│   ├── src/
│   │   ├── index.ts                  # stdio entrypoint: transport wiring ONLY
│   │   ├── server.ts                 # createServer() -> McpServer, transport-agnostic
│   │   ├── instructions.ts           # server `instructions` — prompt surface (FR-021)
│   │   ├── tools/
│   │   │   ├── resolve-taxon.ts
│   │   │   ├── search-occurrences.ts
│   │   │   └── summarize-occurrences.ts
│   │   ├── prompts/
│   │   │   └── species-distribution-report.ts
│   │   ├── domain/
│   │   │   ├── resolution.ts         # matchType/confidence policy (F1, F2, F4, F5)
│   │   │   ├── filters.ts            # shared filter schema + cross-field validation
│   │   │   └── trim.ts               # 95 upstream fields -> 8 (F10)
│   │   ├── gbif/
│   │   │   ├── client.ts             # fetch, timeouts, retry, backoff, User-Agent
│   │   │   ├── cache.ts              # TTL map, resolution only
│   │   │   ├── species.ts            # match (verbose) + vernacular search
│   │   │   ├── occurrence.ts         # search + facets
│   │   │   └── schemas.ts            # lenient upstream Zod schemas
│   │   ├── errors.ts                 # ToolError { what, next } -> isError result
│   │   └── logging.ts                # pino -> stderr + MCP logging notifications
│   └── tests/
│       ├── unit/                     # pure: resolution policy, filters, trim, backoff
│       ├── protocol/                 # real client <-> real server, InMemoryTransport
│       ├── fixtures/                 # captured GBIF responses (Phase 0)
│       └── live/                     # opt-in, hits GBIF
└── agent/
    ├── src/
    │   ├── index.ts                  # CLI entry; disconnect() in finally
    │   ├── model.ts                  # MODEL env resolution + credential check
    │   ├── session.ts                # interactive loop, conversation context
    │   └── instructions.ts           # presentation + clarification ONLY (FR-036)
    ├── evals/
    │   ├── scenarios/                # >= 8 scenarios with scripted replies
    │   ├── scorers/                  # plain functions over RunRecord
    │   └── *.eval.ts
    └── tests/
```

**Structure Decision**: pnpm workspace with exactly two packages and **no shared internal
package**. Constitution VII makes the package boundary the architecture, and a `packages/types`
would immediately become the route by which server internals reach the agent. Duplicating a few
type declarations is the cheaper price. The agent's `package.json` deliberately does not list
`mcp-server` as a dependency — it launches it as a child process by path, exactly as a third-party
client would.

Within the server, `index.ts` (transport) is separated from `server.ts` (registration) so that
adding an HTTP transport later is a new entrypoint rather than a refactor, as the spec's non-goals
require — and so that protocol tests connect the same server object to an in-memory transport.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| `@voltagent/core` pulls ~24 transitive `@ai-sdk/*` provider packages, of which the feature uses 3 (Constitution VIII: dependencies justified individually) | VoltAgent supplies the MCP client integration, tool-calling loop, and conversation management that the agent package exists to demonstrate. Its provider breadth is bundled, not opt-in. | Building the agent directly on `ai` with a hand-rolled MCP client would trim the tree but re-implement the integration whose existence is the point of the agent package (FR-037), and would weaken the proof that the server works with a real third-party agent framework. Accepted as a **dev-surface** cost: the server package — the actual deliverable — depends on none of it. |

The item is recorded rather than waived. The mitigation is the package boundary itself:
`packages/mcp-server` has three production dependencies (`@modelcontextprotocol/sdk`, `zod`,
`pino`), and nothing an MCP client installs is affected by the agent's tree.
