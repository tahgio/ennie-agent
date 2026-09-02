# Contract: The Automated Gates

**New**. Nothing here is a user-facing interface; it is the contract between a change and the
repository — what a change must satisfy before a human reads it.
**Requirements**: FR-036 – FR-045 · **Decisions**: [D10](../research.md#d10--three-compiler-flags-one-lint-rule-and-a-shell-out-removed), [D11](../research.md#d11--coverage-is-reported-never-enforced), [D12](../research.md#d12--two-scheduled-workflows-kept-out-of-the-critical-path)

## Blocking gates — every pull request

Run in `ci.yml`, in this order. A failure at any step fails the change.

| Gate | Command | Change |
|---|---|---|
| Dependency pins | `node scripts/check-deps.mjs` | **reads files directly**; no external command (FR-038) |
| Typecheck | `pnpm typecheck` | **three new compiler flags** (FR-036) |
| Lint | `pnpm lint` | unchanged |
| Build | `pnpm build` | unchanged |
| Deterministic tests | `pnpm test` | **with `--coverage`** (FR-041) |

### The type gate (FR-036, FR-037)

`tsconfig.json` gains three flags, on top of the existing `strict` and `noUncheckedIndexedAccess`:

| Flag | Rejects |
|---|---|
| `noUnusedLocals` | a declared local nothing reads |
| `noUnusedParameters` | a parameter nothing reads |
| `exactOptionalPropertyTypes` | writing an explicit `undefined` into an optional field |

**FR-037 is a precondition, not an aspiration**: the review verified all three pass on the current
tree with no source change. Enabling them must therefore be a ratchet. It is re-verified as the
first task of this group, because the rest of the feature lands new code that must also satisfy them.

### The pin check (FR-038)

`scripts/check-deps.mjs` currently reads `pnpm-lock.yaml` via `execFileSync('cat', …)` — the one
place in the repository that leaves Node for something Node does natively. It fails on any platform
without `cat`, and violates the prefer-the-platform rule (Constitution VIII).

It becomes `readFileSync`. The two assertions it makes are unchanged:

1. `ai` resolves to major 6 (VoltAgent's peer requirement).
2. Exactly one Zod version resolves across the workspace (Constitution IV).

### Coverage (FR-041)

Coverage is **produced and published, never enforced**. The suite runs with `--coverage` and the
report is uploaded as a retained build artefact. No threshold is configured, so no change can fail
on coverage.

This is the clarified decision (Session 2026-09-02, Question 2). It matches what US7 actually asks
for — its acceptance scenarios name the type gate, the pin check, run cancellation and the scheduled
check, and never a number.

### Run cancellation (FR-039)

A `concurrency` group keyed on the ref, with `cancel-in-progress: true`. Two pushes to the same
proposal in quick succession leave one run, not two.

## Non-blocking, scheduled

Deliberately in **separate workflow files**, so neither can become a required check for a pull
request by accident. That separation is the mechanical form of FR-040's "MUST NOT gate ordinary
changes" — a condition inside `ci.yml` would be the only thing standing between a live-network job
and a pull request, which is the arrangement Constitution VI exists to prevent.

| Workflow | Trigger | Does | Requirement |
|---|---|---|---|
| `fixtures.yml` | weekly `schedule` + `workflow_dispatch` | `pnpm test:live` — detects GBIF moving underneath the recorded fixtures | FR-040 |
| `dependabot.yml` | weekly | proposes updates for dependencies that are not deliberately pinned | FR-042 |

A `fixtures.yml` failure means **GBIF moved**, which is information about the world, not a defect in
this repository.

A Dependabot proposal is an ordinary pull request and runs every blocking gate above, including the
pin check — which is why FR-043 ("that mechanism MUST NOT be able to bypass the pin check") needs no
new machinery. An update that would break a deliberate pin fails at the existing gate with the
existing message.

## Repository hygiene (FR-044)

`.gitignore` gains `.claude/settings.local.json` — generated per-contributor by local tooling. It
must be the repository's own rule, not a contributor's personal global ignore, because a fresh clone
by someone with no configuration is the case that matters. `biome.json` sets
`vcs.useIgnoreFile: true`, so this also keeps the file out of lint's view.

## Test coverage of previously untested behaviour (FR-045)

Ten named behaviours, each gaining at least one direct automated check. All are pure-function or
injected-dependency tests: none contacts the network or a model provider.

| Behaviour | Where |
|---|---|
| Open-ended year range translation | `tests/unit/filters.test.ts` |
| Single-value year translation | `tests/unit/filters.test.ts` |
| Paging-window boundary | `tests/unit/filters.test.ts` |
| Country-code normalisation | `tests/unit/filters.test.ts` |
| Country-code rejection | `tests/unit/filters.test.ts` |
| Remembered-key normalisation | `tests/unit/cache.test.ts` |
| Remembered-entry expiry | `tests/unit/cache.test.ts` |
| Hit/miss statistics | `tests/unit/cache.test.ts` |
| Unexpected-internal-fault fallback | `tests/unit/errors.test.ts` |
| SIGINT during an in-flight generation | `packages/agent/tests/session.test.ts` |

Plus, from other requirement groups and landing in the same files: the eviction boundary (FR-020),
the request-time year bound (FR-020), the failure-category sweep (FR-006), and the
retryable/non-retryable remembering split (FR-010).

**FR-050**: the existing 165 checks continue to pass unmodified, except where a test encodes
behaviour this specification deliberately changes. Exactly one place qualifies: the assertions in
`tests/unit/facets.test.ts` that exercise the identity function removed by FR-035. No existing test
asserts today's silent `taxonKey`-wins precedence — verified — so the contradictory-taxon change
adds a check rather than modifying one.
