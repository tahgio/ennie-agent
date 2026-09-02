# Implementation Plan: Post-Review Hardening

**Branch**: `002-code-review-hardening` | **Date**: 2026-09-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-code-review-hardening/spec.md`

## Summary

Remediate the twenty-four findings of the 2026-09-02 full-repository review (`docs/code-review.md`
§1–§6) without adding a capability, changing a transport, or introducing a dependency.

Two are defects a user can feel: the diagnostic record on every failed tool call carries the
constant `"ToolError"` instead of the failure code, and a transient upstream outage is negatively
cached for a full hour. Both are one-line fixes to existing, well-factored code — `error.code`
instead of `error.name`, and `error.retryable === false` instead of `code !== 'CANCELLED'`.

The remainder is hardening in three groups. **Long-uptime correctness**: a ceiling on the
resolution cache with insertion-order eviction, a year bound derived per request rather than at
module load, and a shutdown that is once-only and time-bounded. **The session a person sits in**:
interruption exits 130 with no spurious failure line, the transcript gains a ceiling with a visible
truncation notice, and `LOG_LEVEL` reaches the launched server. **The toolchain**: three compiler
flags the review verified already pass, a shell-out to `cat` replaced with `readFileSync`, run
cancellation, reported-not-enforced coverage, a scheduled live-fixture check kept out of the
critical path, Dependabot behind the existing pin gate, and ten previously untested behaviours
given direct offline checks.

Two decisions were clarified with the user and are now settled in the spec: an occurrence request
supplying **both** a `taxonKey` and a `name` is **refused** with a new `CONTRADICTORY_TAXON` error
rather than silently preferring the key; and coverage is **reported, never enforced**.

The single structural change is extracting `packages/agent/src/agent.ts`, so the CLI and the eval
suite share one agent definition instead of two copies nothing keeps equal.

## Technical Context

**Language/Version**: TypeScript 5.9 on Node.js 24, ESM, `strict` + `noUncheckedIndexedAccess`

**Primary Dependencies**: `@modelcontextprotocol/sdk` ^1.30, `zod` ^4.5.2 (single version,
enforced), `pino` ^10.3 (server); `@voltagent/core` ^2.10, `ai` ^6, `@ai-sdk/*` ^3 (agent). **No
production dependency is added.** One dev-only addition: `@vitest/coverage-v8`, for FR-041.

**Storage**: None. In-process only — a TTL cache in the server and a transcript array in the CLI,
both dying with their process. The "no persistence" exclusion is preserved.

**Testing**: Vitest, three projects — `unit` and `protocol` (deterministic, network-blocked by a
setup file, run in CI) and `live` (opt-in, never in CI). Viteval for LLM evals, opt-in. Baseline is
165 checks across 16 files; this feature adds to that and modifies none of it except where a test
encodes behaviour deliberately changed (FR-050).

**Target Platform**: Linux, macOS and Windows for development and CI. The `cat` shell-out removed by
FR-038 is the one thing currently standing in the way of that claim.

**Project Type**: pnpm workspace — an MCP stdio server package and a CLI agent package, with no
package dependency between them (Constitution VII, enforced by a Biome `noRestrictedImports` rule).

**Performance Goals**: Unchanged. The per-attempt and per-call time budgets, the retry ceiling, the
record cap and the one-hour remembering period all stand (spec Assumptions).

**Constraints**: Bounded memory over unbounded uptime — a resolution cache ceiling in the low
thousands (default 2,000) and a transcript ceiling of 20 exchanges. Shutdown bounded at 2s.
Coverage produced but never a blocking threshold.

**Scale/Scope**: 24 review findings → 8 user stories → 51 functional requirements. Roughly a dozen
source files touched across both packages, four new unit test files, one new source module, two new
workflow files, and four documentation corrections.

## Constitution Check

*GATE: evaluated before Phase 0, re-evaluated after Phase 1 design. Both passes below.*

| Principle | Assessment | Verdict |
|---|---|---|
| **I. Protocol Correctness** | No transport change. `stdout-guard.js` stays the first import of `src/index.ts` — actively guarded, since §2.5's shutdown work edits that same file (FR-051). New failures return `isError: true`, never thrown. `outputSchema`/`structuredContent` untouched. Two prompt-surface edits (the occurrence descriptions, FR-029; `search_occurrences`'s field list, FR-048) are reviewed as code. | **PASS** |
| **II. Context Economy** | No result shape grows. The record cap, the trim set, and the summary-without-records design are all untouched — and three of them are named in Out of Scope. | **PASS** |
| **III. Tools Model Intents** | No parameter added or removed. `CONTRADICTORY_TAXON` *narrows* an accepted input shape rather than widening one. | **PASS** |
| **IV. Validate At Every Boundary** | Strengthened. `CONTRADICTORY_TAXON` fires before any network call; the year bound moves from a stale constant to a per-request check; three additional compiler flags; the single-Zod-version assertion now runs without an external command. Lenient upstream parsing is preserved, and §2.4 *adds* a developer-channel diagnostic without changing the caller's message. | **PASS — strengthened** |
| **V. Errors Are Messages To A Model** | `next` stays required by the type (Out of Scope). The new error names both offending values and both remedies. FR-017 removes the one message that could name a range containing the value it rejected. | **PASS — strengthened** |
| **VI. Deterministic By Default** | Every new check is offline: pure functions, an injectable clock, and an injected agent stub. `fixtures.yml` puts the live check on a schedule **in its own workflow file**, so it cannot become a required check for a pull request — the mechanical form of "must not gate ordinary changes". `pnpm eval` stays out of CI. | **PASS** |
| **VII. The Package Boundary** | `agent.ts` is agent-internal. The agent still has no dependency on `mcp-server` and still launches the built server by path over stdio. The Biome rule enforcing this is unmodified. | **PASS** |
| **VIII. Dependencies Are Justified** | No production dependency added. `@vitest/coverage-v8` is a dev-only plugin for a dev tool already present, required by FR-041. Removing the `cat` shell-out moves *toward* the platform. | **PASS** |
| **IX. Decisions Documented** | 16 decisions recorded in [research.md](./research.md) in Decision / Rationale / Alternatives form, including the two rejected clarification options. README updates land with the changes they describe (FR-046 – FR-048). | **PASS** |

**Workflow gates**: CI keeps typecheck + lint + deterministic tests and gains coverage reporting,
run cancellation, and a fixed pin check. No tool is added or modified, so the "new tool" checklist
does not apply. Conventional Commits continue.

**Post-Phase-1 re-evaluation**: no violation introduced. The design produced no new entity, no new
dependency, and no new interface — only deltas to four existing entities and four contract
addenda. **Complexity Tracking is empty, deliberately.**

## Project Structure

### Documentation (this feature)

```text
specs/002-code-review-hardening/
├── plan.md              # This file
├── spec.md              # Clarified; both questions resolved
├── research.md          # Phase 0 — 16 decisions (D1–D16)
├── data-model.md        # Phase 1 — 8 entity deltas
├── quickstart.md        # Phase 1 — validation scenarios per user story
├── contracts/           # Phase 1 — deltas to the 001 contracts
│   ├── README.md
│   ├── tool-call-log.md
│   ├── taxon-input.md
│   ├── agent-cli.md
│   └── toolchain.md
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 — NOT created by /speckit-plan
```

### Source Code (repository root)

Existing workspace. Files this feature touches, marked **M**odified or **N**ew.

```text
packages/mcp-server/
├── src/
│   ├── index.ts                     M  once-only, bounded shutdown (D5) — guard import untouched
│   ├── errors.ts                    M  +INTERNAL_ERROR, +CONTRADICTORY_TAXON; fallback code (D1, D8)
│   ├── logging.ts                   M  errorCode narrows to ToolErrorCode (D1)
│   ├── tools/
│   │   ├── run-tool.ts              M  record error.code, not error.name (D1)
│   │   ├── search-occurrences.ts    M  description: both-supplied behaviour, occurrence key (D8, D13)
│   │   └── summarize-occurrences.ts M  description: both-supplied behaviour (D8)
│   ├── domain/
│   │   ├── taxon-input.ts           M  refuse key+name before any upstream call (D8)
│   │   ├── filters.ts               M  year bound derived per request (D4)
│   │   ├── resolution.ts            M  remember only non-retryable failures (D2)
│   │   └── trim.ts                  M  comment: "nine" (D13)
│   └── gbif/
│       ├── cache.ts                 M  maxEntries + insertion-order eviction (D3)
│       ├── client.ts                M  log Zod issues on the developer channel (FR-005)
│       └── occurrence.ts            M  drop the identity gbifFacetParam (D16)
└── tests/
    ├── unit/filters.test.ts         N  FR-045, FR-020
    ├── unit/cache.test.ts           N  FR-045, FR-020
    ├── unit/errors.test.ts          N  FR-045, FR-006
    ├── unit/logging.test.ts         N  FR-006
    ├── unit/facets.test.ts          M  drops the identity-function assertions (D16, FR-050)
    └── protocol/*.test.ts           M  contradictory-input case; notification category

packages/agent/
├── src/
│   ├── agent.ts                     N  the single agent definition (D9)
│   ├── index.ts                     M  consume agent.ts; exit 130; forward LOG_LEVEL (D6, D9, D15)
│   ├── session.ts                   M  transcript ceiling + truncation notice (D7)
│   └── model.ts                     M  one explained type escape (D16)
├── evals/
│   ├── run-scenario.ts              M  consume agent.ts; attribute by invocation (D9)
│   ├── biodiversity.eval.ts         M  third type escape, now via the model.ts helper (D16)
│   └── scenarios/index.ts           M  "twelve scenarios" (D13)
└── tests/
    ├── session.test.ts              M  SIGINT mid-generation; history truncation (FR-027)
    └── scorers.test.ts              M  parallel same-capability attribution (FR-033)

tsconfig.json                        M  three compiler flags (D10)
vitest.config.ts                     M  coverage provider, no thresholds (D11)
scripts/check-deps.mjs               M  readFileSync, not execFileSync (D10)
.gitignore                           M  .claude/settings.local.json (D10)
README.md                            M  pnpm 11+, "nine fields" (D13)
.github/workflows/ci.yml             M  concurrency, coverage upload (D10, D11)
.github/workflows/fixtures.yml       N  scheduled live check, isolated (D12)
.github/dependabot.yml               N  weekly non-major updates (D12)
```

**Structure Decision**: The existing two-package pnpm workspace is kept exactly as it is. It is the
mechanism by which Constitution VII is enforceable rather than asserted, and the review's §7 names
the absence of a package dependency between the two as load-bearing. The only new source module,
`packages/agent/src/agent.ts`, sits inside the agent package and is imported by that package's own
CLI and its own eval runner — it crosses no boundary.

## Implementation Sequencing

Not tasks — those are `/speckit-tasks`. This is the order the groups must land in, and why.

1. **The type ratchet first** (D10, FR-036/FR-037). Verify the three flags pass on the unchanged
   tree, then enable them. Doing this first means every subsequent change in this feature is written
   under the stricter gate rather than retrofitted to it. `exactOptionalPropertyTypes` in particular
   interacts with the optional fields added in groups 2 and 4.
2. **The two P1 defects** (D1, D2). Smallest diffs, highest user-visible value, and both are
   prerequisites for tests in group 5.
3. **Long-uptime correctness** (D3, D4, D5) — independent of each other and of everything else.
4. **The CLI** (D6, D7, D15) and **the agent extraction** (D9). The extraction must precede or
   accompany the CLI changes; otherwise `maxSteps` and the entrypoint path get edited twice.
5. **The new tests** (D14) — after the behaviour they check exists.
6. **The remaining toolchain** (D11, D12) and **the documentation** (D13, D16). Independent; last
   because they gate nothing.

`CONTRADICTORY_TAXON` (D8) may land any time after group 1; it is self-contained apart from the
error code it adds in group 2.

## Complexity Tracking

No Constitution Check violation, on either pass. This section is intentionally empty.
