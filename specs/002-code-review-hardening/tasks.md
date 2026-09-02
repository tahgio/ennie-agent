---

description: "Task list for 002-code-review-hardening"
---

# Tasks: Post-Review Hardening

**Input**: Design documents from `/specs/002-code-review-hardening/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: **Required.** This feature's specification mandates automated checks in its own
requirements — FR-006, FR-010, FR-020, FR-027 and FR-045 each demand one — so test tasks are part of
the deliverable, not an option. Every new check is offline: pure functions, an injected clock, or an
injected agent stub (Constitution VI).

**Organization**: Grouped by user story. Each story is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel — different files, no dependency on an incomplete task
- **[Story]**: US1–US8, mapping to the user stories in [spec.md](./spec.md)
- Every task names an exact file path

## Path Conventions

pnpm workspace, two packages. Paths are repository-relative:

- Server: `packages/mcp-server/src/`, `packages/mcp-server/tests/`
- Agent: `packages/agent/src/`, `packages/agent/tests/`, `packages/agent/evals/`
- Toolchain: repository root and `.github/`

---

## Phase 1: Setup (The Type Ratchet)

**Purpose**: Enable the stricter type gate **before** any other code in this feature is written, so
every later task is authored under it rather than retrofitted to it. `exactOptionalPropertyTypes`
interacts directly with the optional fields added in Phases 5 and 6 (`maxEntries`, `maxTurns`).

This phase discharges FR-036 and FR-037, which belong to US7. US7's own phase keeps the
*verification* (SC-010, the 3-of-3 scratch trial), so US7 stays independently testable.

- [X] T001 Verify the FR-037 precondition before changing anything: run `npx tsc --build --force` with `noUnusedLocals`, `noUnusedParameters` and `exactOptionalPropertyTypes` added temporarily to `tsconfig.json`, confirm zero errors on the unmodified tree, then revert. If any error appears, stop and report — the flags were specified as a ratchet, not a refactor.
- [X] T002 Add `noUnusedLocals`, `noUnusedParameters` and `exactOptionalPropertyTypes` to `compilerOptions` in `tsconfig.json` (FR-036)
- [X] T003 [P] Add `@vitest/coverage-v8` to `devDependencies` in `package.json` and run `pnpm install` (FR-041, dev-only — no production dependency)
- [X] T004 Run `pnpm typecheck && pnpm lint && pnpm test` and record the baseline check count (expected: 165 checks, 16 files) in the branch's first commit body, so FR-050's "the total number of automated checks increases" is measurable at the end

**Checkpoint**: The stricter gate is live and green on the unchanged tree.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Two shared edits that would otherwise be made twice, in conflict, by stories running in
parallel. Both are structural: **no behaviour changes in this phase**, and the existing suite must
pass untouched at the checkpoint.

**⚠️ CRITICAL**: No user story work begins until this phase is complete.

- [X] T005 Add `INTERNAL_ERROR` and `CONTRADICTORY_TAXON` to the `ToolErrorCode` union in `packages/mcp-server/src/errors.ts`, with a comment placing each in its group (unattributed; input validation). Nothing throws them yet — this exists so US1 and US5 can proceed in parallel without both editing the union.
- [X] T006 Create `packages/agent/src/agent.ts` exporting `serverEntrypoint()` and `createAgent(options)` — name, instructions, model, tools, `memory: false`, `maxSteps: 8`, and optional `hooks` / `observability` — lifted verbatim from the two existing copies (FR-031)
- [X] T007 Rewire `packages/agent/src/index.ts` to import `serverEntrypoint` and `createAgent` from `./agent.js`, deleting its local copies of both
- [X] T008 Rewire `packages/agent/evals/run-scenario.ts` to import `serverEntrypoint` and `createAgent` from `../src/agent.js`, deleting its local copies of both, and passing its `createHooks({...})` block through the `hooks` option (FR-032)
- [X] T009 Confirm `packages/agent/` still has no import of `mcp-server` and the Biome `noRestrictedImports` override in `biome.json` is unmodified — `agent.ts` is agent-internal and crosses no package boundary (Constitution VII)

**Checkpoint**: `pnpm typecheck && pnpm lint && pnpm test` green, with the same check count as T004.
One agent definition exists. User stories can now proceed in parallel.

---

## Phase 3: User Story 1 — An operator can tell what failed, from the record alone (P1) 🎯 MVP

**Goal**: Every failed tool call records its actual failure category, distinguishable from every
other, on both channels.

**Independent Test**: Provoke one failure of each defined category through a connected client;
inspect the stderr record and the client log notification. Each category is distinguishable without
reading the human-readable message. (SC-001: 100%, up from 0%.)

### Tests for User Story 1

> Write these first and confirm they fail against the current `errorCode: "ToolError"` behaviour.

- [X] T010 [P] [US1] Create `packages/mcp-server/tests/unit/logging.test.ts` asserting the recorded `errorCode` for one failure of each family — resolution, input validation, upstream, cancellation — through `runTool` with a stubbed handler (FR-006)
- [X] T011 [P] [US1] Create `packages/mcp-server/tests/unit/errors.test.ts` asserting `toToolResult` given a plain `Error` returns the internal-fault text unchanged **and** that the recorded code is `INTERNAL_ERROR`, never `UPSTREAM_UNAVAILABLE` (FR-004, FR-045)
- [X] T012 [US1] Add a case to `packages/mcp-server/tests/protocol/resolve-taxon.test.ts` with the client subscribed to logging, asserting the notification payload's `errorCode` equals the stderr record's for the same failed call (FR-002)

### Implementation for User Story 1

- [X] T013 [US1] In `packages/mcp-server/src/tools/run-tool.ts`, replace `errorCode: error instanceof Error ? error.name : 'unknown'` with the thrown `ToolError`'s `code`, falling back to `'INTERNAL_ERROR'` for anything that is not a `ToolError` (FR-001, FR-004)
- [X] T014 [US1] In `packages/mcp-server/src/logging.ts`, narrow `ToolCallLog.errorCode` from `string` to `ToolErrorCode | undefined` and import the type — the closed union is what discharges FR-003, so no sanitising step is added
- [X] T015 [US1] In `packages/mcp-server/src/errors.ts`, change `toToolResult`'s non-`ToolError` fallback from `code: 'UPSTREAM_UNAVAILABLE'` to `code: 'INTERNAL_ERROR'`, leaving `what`, `next` and `retryable` byte-identical — the caller's message must not change (FR-004, FR-049)
- [X] T016 [US1] In `packages/mcp-server/src/gbif/client.ts`, log `parsed.error.issues` and the request path at `debug` on the developer channel when a lenient upstream schema fails to parse; the `ToolError` returned to the caller is unchanged and no upstream payload reaches the caller (FR-005)

**Checkpoint**: US1 fully functional. `pnpm test` green with new checks passing.

---

## Phase 4: User Story 2 — A momentary upstream outage stays momentary (P1)

**Goal**: A failure worth retrying is never replayed as the answer to the next identical request.

**Independent Test**: Provoke a retryable upstream failure for a name, make the upstream healthy,
repeat the identical request — it reaches upstream and succeeds. Repeat with an unknown name — still
answered from memory, no upstream call. (SC-002: recovery time falls from up to an hour to zero.)

### Tests for User Story 2

- [X] T017 [P] [US2] Add to `packages/mcp-server/tests/unit/resolution.test.ts`: a stubbed upstream outage makes a lookup fail; the stub is then made healthy and the identical lookup repeated — assert it reaches upstream and returns the correct taxon (FR-007, FR-010)
- [X] T018 [P] [US2] Add to `packages/mcp-server/tests/unit/resolution.test.ts`: a `NOT_FOUND` and an `AMBIGUOUS` failure are each replayed from memory on repeat with no upstream call, the original text and the candidate list intact (FR-008, FR-010)
- [X] T019 [P] [US2] Add to `packages/mcp-server/tests/unit/resolution.test.ts`: a cancelled lookup is not remembered — the repeat reaches upstream (FR-009)

### Implementation for User Story 2

- [X] T020 [US2] In `packages/mcp-server/src/domain/resolution.ts`, narrow the `setNegative` guard from `error.code !== 'CANCELLED'` to `error.retryable === false && error.code !== 'CANCELLED'`. **Both clauses are load-bearing**: `CANCELLED` carries `retryable: false`, so dropping the second clause would start caching cancellations and break FR-009 (research D2).
- [X] T021 [US2] Rewrite the negative-caching paragraph in the file comment of `packages/mcp-server/src/gbif/cache.ts` to state which failures are remembered (non-retryable resolution outcomes) and which are not (anything retryable, and cancellations), with the reason (FR-011)

**Checkpoint**: Both P1 defects fixed. This is the point at which the feature already earns its keep.

---

## Phase 5: User Story 3 — The server behaves the same on its thousandth hour as on its first (P2)

**Goal**: Bounded memory over unbounded uptime, a year bound that tracks the calendar, and a
shutdown that is once-only and time-bounded.

**Independent Test**: Drive ten times the ceiling in distinct lookups through one instance — the
remembered-entry count stops at the ceiling and lookups keep succeeding. Advance the instance's
clock across a year boundary — the new year is accepted with no restart, and no rejection names a
range containing the value it rejected. (SC-003, SC-004.)

### Tests for User Story 3

- [X] T022 [P] [US3] Create `packages/mcp-server/tests/unit/cache.test.ts` covering key normalisation (whitespace, case, rank and kingdom hints), expiry via the injected `now`, and hit/miss statistics (FR-045)
- [X] T023 [P] [US3] Add to `packages/mcp-server/tests/unit/cache.test.ts`: construct with `maxEntries: 2`, insert three keys, assert `size` is 2, the first-inserted key is the one gone, and re-setting an existing key moves it to the back rather than evicting (FR-020)
- [X] T024 [P] [US3] Create `packages/mcp-server/tests/unit/filters.test.ts` covering the request-time year bound with an injected clock either side of a year boundary, plus open-ended and single-value year translation, the paging-window boundary, and country-code normalisation and rejection (FR-020, FR-045 — this file is US3's, and completes six of FR-045's ten named behaviours)

### Implementation for User Story 3

- [X] T025 [US3] In `packages/mcp-server/src/gbif/cache.ts`, add `maxEntries?: number` to the constructor options with a default of `2_000`, and in `set()` evict `this.#entries.keys().next().value` when at the ceiling with a new key; delete-then-insert on an existing key so a refresh moves to the back (FR-012, FR-013, FR-015)
- [X] T026 [US3] Document in the `cache.ts` file comment that eviction is insertion-order — longest-ago-*recorded*, not least-recently-*read* — and that an evicted key is a miss that resolves upstream, so correctness under eviction needs no new code (FR-014)
- [X] T027 [US3] In `packages/mcp-server/src/domain/filters.ts`, move the upper year bound out of `yearSchema`'s `.max()` into a per-parse check so `maxYear()` is called when the value is parsed, not at module load; keep `MIN_YEAR` as a declared schema constraint (FR-016)
- [X] T028 [US3] In `packages/mcp-server/src/domain/filters.ts`, rewrite the year `.describe()` text to describe the upper bound in words rather than naming a literal year, and ensure every rejection message names the range actually applied at that instant (FR-017)
- [X] T029 [US3] In `packages/mcp-server/src/index.ts`, make shutdown once-only with `process.once` for both signals **plus** a module-level `closing` flag (`once` alone does not cover SIGINT-then-SIGTERM), and bound it with an `unref()`'d `setTimeout(() => process.exit(0), 2_000)` — `unref()` is what stops the timer holding the process open in the normal case (FR-018, FR-019)
- [X] T030 [US3] Confirm `import './stdout-guard.js'` is still the first import of `packages/mcp-server/src/index.ts` after T029. This file is edited by this feature and the guard's position is named load-bearing in the review's §7 (FR-051).

**Checkpoint**: Long-uptime correctness complete and independently verifiable.

---

## Phase 6: User Story 4 — The command-line session ends and continues gracefully (P2)

**Goal**: Interruption exits cleanly with no spurious failure line; a long conversation keeps
answering and says what it dropped; `LOG_LEVEL` reaches the launched server.

**Independent Test**: Interrupt mid-answer — one line of shutdown output, no failure text, exit 130,
no orphaned server. Drive a session past the ceiling — it keeps answering and reports what was
dropped. (SC-005, SC-006.)

### Tests for User Story 4

- [X] T031 [P] [US4] Add to `packages/agent/tests/session.test.ts`: with an injected agent stub whose `generateText` rejects once the shutdown signal aborts, assert the interrupted run produces no `That question could not be answered` text and propagates in a way the entrypoint maps to 130 — **no model provider is contacted** (FR-027)
- [X] T032 [P] [US4] Add to `packages/agent/tests/session.test.ts`: drive the same stub past `maxTurns`, asserting the transcript length stays within the ceiling, that dropping happens in `user`/`assistant` pairs so the transcript never begins with an assistant entry, and that the notice is written (FR-023, FR-024)

### Implementation for User Story 4

- [X] T033 [US4] In `packages/agent/src/session.ts`, add `maxTurns?: number` to `SessionOptions` defaulting to `40` (20 exchanges), and after each successful exchange drop entries from the front of `#turns` in pairs until within the ceiling (FR-023, FR-025)
- [X] T034 [US4] In `packages/agent/src/session.ts`, write one line naming how many exchanges were dropped whenever anything is dropped, e.g. `[Dropped the N oldest exchanges to stay within the context limit.]` (FR-024)
- [X] T035 [US4] In `packages/agent/src/index.ts`, catch the abort-path rethrow from `Session.ask` and return `130` from `main()` — printing nothing beyond the existing `Received SIGINT. Exiting.` line, and leaving the `finally` that calls `mcp.disconnect()` untouched so FR-022 continues to hold by construction (FR-021)
- [X] T036 [US4] Confirm a second interrupt during teardown produces neither a second notice nor a different status, and that `pgrep -f 'mcp-server/dist/index.js'` is empty after both the idle-prompt and mid-answer paths (FR-022)
- [X] T037 [US4] Add `LOG_LEVEL` to the forwarded `env` allowlist for the stdio server in `packages/agent/src/agent.ts` (or `index.ts`, wherever `MCPConfiguration` is constructed after T006), keeping the explicit-allowlist posture — never `{ ...process.env }` (FR-026)
- [X] T038 [US4] Update `specs/001-gbif-mcp-server/contracts/agent-cli.md`'s exit-code table to add `130`, cross-referencing [contracts/agent-cli.md](./contracts/agent-cli.md)

**Checkpoint**: The session is graceful on both the exit path and the long-conversation path.

---

## Phase 7: User Story 5 — Contradictory taxon inputs are not silently reconciled (P2)

**Goal**: Supplying both a `taxonKey` and a `name` is refused, naming both values, before any
upstream call.

**Independent Test**: Issue an occurrence request supplying both with a mismatched name; verify the
refusal names both values and that no upstream request was made. Verify both tool descriptions state
the behaviour. (SC-007: 0% unstated attribution, down from 100%.)

### Tests for User Story 5

- [X] T039 [P] [US5] Add to `packages/mcp-server/tests/protocol/search-occurrences.test.ts`: a call carrying both `taxonKey` and `name` returns `isError: true`, the text names **both** supplied values, and the upstream stub recorded **zero** requests
- [X] T040 [P] [US5] Add the equivalent case to `packages/mcp-server/tests/protocol/summarize-occurrences.test.ts`
- [X] T041 [P] [US5] Add to `packages/mcp-server/tests/protocol/discovery.test.ts`: both occurrence tool descriptions state what happens when both are supplied (FR-029)

### Implementation for User Story 5

- [X] T042 [US5] In `packages/mcp-server/src/domain/taxon-input.ts`, add a first branch to `selectTaxon` — before the existing `taxonKey` branch — throwing `CONTRADICTORY_TAXON` when both a `taxonKey` and a non-empty `name` are present. `what` names both values; `next` names both remedies and what each means; `retryable: false` (FR-028)
- [X] T043 [US5] Update the `taxon-input.ts` file comment: the "when a `taxonKey` is supplied nothing is resolved" paragraph still holds, but the both-supplied case is now a refusal rather than a precedence rule — and it applies whether or not the two agree, because checking agreement requires the very lookup the key exists to avoid
- [X] T044 [US5] In `packages/mcp-server/src/tools/search-occurrences.ts`, extend `DESCRIPTION` to state that supplying both `taxonKey` and `name` is refused (FR-029). Descriptions are prompt surface and reviewed as code (Constitution I).
- [X] T045 [US5] Make the same description change in `packages/mcp-server/src/tools/summarize-occurrences.ts` (FR-029)
- [X] T046 [US5] Confirm the existing key-only and name-only cases in `packages/mcp-server/tests/protocol/search-occurrences.test.ts` and `packages/mcp-server/tests/protocol/summarize-occurrences.test.ts` pass **unmodified** — that is FR-030 stated as a test

**Checkpoint**: The one silent choice in the system is gone. Note this is the single
specification-sanctioned contract change (FR-049).

---

## Phase 8: User Story 6 — The eval suite measures the agent that actually ships (P3)

**Goal**: One agent definition, and every recorded tool outcome attributed to the invocation that
produced it.

**Independent Test**: Change one property of the shipped agent and verify the eval run reflects it
after a single edit. Record a run with two same-capability calls in flight and verify each outcome
belongs to its own invocation. (SC-008.)

> Phase 2 (T006–T008) already discharged FR-031 and FR-032 to keep this story from colliding with
> US4 in `index.ts`. The verification below is what makes US6 independently testable.

### Tests for User Story 6

- [X] T047 [P] [US6] Add to `packages/agent/tests/scorers.test.ts`: a recorded run in which two calls to the same capability overlap — assert each `isError` outcome lands on the invocation that produced it, and that the "does not repeat a call that already failed" check reads the right record (FR-033)

### Implementation for User Story 6

- [X] T048 [US6] In `packages/agent/evals/run-scenario.ts`, replace the `onToolEnd` backwards scan for "the most recent call of the same name" with attribution by the hook context's call id where one is available, falling back to the most recent **unresolved** call of that name; track resolution in a local set that does not appear in the serialised `RunRecord` (FR-033)
- [X] T049 [US6] In `packages/agent/src/model.ts`, add one exported helper that performs the model-value type escape, with a doc comment stating once why the escape is necessary — VoltAgent's `model` parameter and the AI SDK's `LanguageModel` union do not line up (FR-034)
- [X] T050 [US6] Replace the `as never` casts with that helper in `packages/agent/src/agent.ts` and `packages/agent/evals/biodiversity.eval.ts`; the third call site disappeared when T006–T008 collapsed the two agent definitions into one (FR-034)
- [X] T051 [US6] Remove the identity function `gbifFacetParam` from `packages/mcp-server/src/gbif/occurrence.ts` and inline the value at all three call sites — an identity function has no reason to state, so FR-035's "removed **or** carry a stated reason" resolves to removal
- [X] T052 [US6] Remove the `gbifFacetParam` assertions from `packages/mcp-server/tests/unit/facets.test.ts`, keeping every assertion about `dimensionForFacetField` — the response-direction mapping is real and must stay covered. This is the only place FR-050's carve-out applies.
- [ ] T053 [US6] Verify SC-008: change `maxSteps` in `packages/agent/src/agent.ts` from 8 to 3, run `pnpm eval`, confirm the new ceiling is in effect in a recorded run with no second edit, then revert. (Needs a model key; costs money.)

**Checkpoint**: One agent definition, verified. Attribution correct under concurrency.

---

## Phase 9: User Story 7 — The toolchain catches what review would otherwise have to (P3)

**Goal**: The gates that would have caught several of this review's findings before it was written.

**Independent Test**: Introduce an unused local, an unused parameter and an explicitly-undefined
optional value in a scratch change — each is rejected by the automated gate. Verify the pin check
runs without an external command, that a superseded run is cancelled, and that the upstream-reality
check runs on a schedule without gating ordinary changes. (SC-010, SC-011.)

> The type gate itself (FR-036, FR-037) landed in Phase 1 because every later task had to be written
> under it. T054 is the acceptance check for it.

- [X] T054 [US7] Verify SC-010: in a scratch change, introduce (a) an unused local, (b) an unused parameter, (c) `{ x: undefined }` written into an optional field; run `pnpm typecheck` after each and confirm all three are rejected — 3 of 3. Discard the scratch change.
- [X] T055 [P] [US7] In `scripts/check-deps.mjs`, replace `execFileSync('cat', [...])` with `readFileSync`, dropping the `node:child_process` import. The two assertions — `ai` on major 6, exactly one Zod version — are unchanged (FR-038)
- [X] T056 [P] [US7] Add `.claude/settings.local.json` to `.gitignore`. It must be the repository's own rule, not a contributor's personal global ignore, because a fresh clone by someone with no configuration is the case that matters (FR-044)
- [X] T057 [P] [US7] Add a `concurrency` block to `.github/workflows/ci.yml` keyed on the ref with `cancel-in-progress: true` (FR-039)
- [X] T058 [US7] In `.github/workflows/ci.yml`, run the deterministic suite with `--coverage` and upload the report with `actions/upload-artifact@v4`. **No threshold** — coverage is reported, never enforced (FR-041, clarification Q2)
- [X] T059 [US7] Add a coverage provider block to `vitest.config.ts` with the `v8` provider and **no `thresholds` key**, so no change can fail on coverage (FR-041)
- [X] T060 [P] [US7] Create `.github/workflows/fixtures.yml` running `pnpm test:live` on a weekly `schedule` plus `workflow_dispatch`. It must be its **own workflow file** so it cannot become a required check for a pull request — that separation is the mechanical form of FR-040's "MUST NOT gate ordinary changes" (FR-040)
- [X] T061 [P] [US7] Create `.github/dependabot.yml` proposing weekly npm updates, grouping non-major ones. No new machinery is needed for FR-043: a Dependabot proposal is an ordinary pull request and runs the existing `check-deps.mjs` gate, so an update breaking a deliberate pin fails there with the existing message (FR-042, FR-043)
- [X] T062 [US7] Audit FR-045's ten named behaviours against `packages/mcp-server/tests/unit/filters.test.ts`, `packages/mcp-server/tests/unit/cache.test.ts`, `packages/mcp-server/tests/unit/errors.test.ts` and `packages/agent/tests/session.test.ts`, and close any gap. Expected coverage after Phases 3–6: filter translation, paging boundary and country handling (T024), remembered-key normalisation, expiry and statistics (T022), the unexpected-internal-fault fallback (T011), SIGINT during an in-flight generation (T031). List each behaviour and the test that covers it in the task's commit body.
- [X] T063 [US7] Confirm `git status --porcelain` on a fresh clone shows no `.claude/settings.local.json`, and that `pnpm lint` no longer sees it — `biome.json` sets `vcs.useIgnoreFile: true` (FR-044)

**Checkpoint**: The toolchain enforces what human review had to.

---

## Phase 10: User Story 8 — The written record matches the code it describes (P3)

**Goal**: Every count and version claim agrees with the code, and the record-listing capability's
description names every field it returns.

**Independent Test**: Check each numeric and version claim against the code it describes; check the
description enumerates every returned field. (SC-012: 0 mismatches, down from 3.)

- [X] T064 [P] [US8] In `packages/agent/evals/scenarios/index.ts`, change "Ten scenarios" in the file comment to twelve, matching `SCENARIOS.length` and `README.md:146` (FR-046)
- [X] T065 [P] [US8] In `README.md`, change the stated requirement "pnpm 9+" to "pnpm 11+". This is the claim with teeth: `pnpm-workspace.yaml` uses `overrides`, `allowBuilds` and `minimumReleaseAgeExclude`, which pnpm 9 does not honour — so a contributor honouring the stated minimum silently loses the single-Zod-version guarantee Constitution IV requires (FR-047)
- [X] T066 [P] [US8] Change the trim count to **nine** in `README.md` (the `search_occurrences` row, currently "95 fields to 8") and in the file comment of `packages/mcp-server/src/domain/trim.ts` (currently "95 upstream fields down to 8"), matching `TRIMMED_FIELDS.length` and the existing "the nine keys" comment at `trim.ts:23` (FR-046)
- [X] T067 [US8] In `packages/mcp-server/src/tools/search-occurrences.ts`, add the GBIF occurrence `key` to the field list in `DESCRIPTION` — it is the one field a caller needs to look a record up at its source, and a model that does not know it is returned will not offer it. **Sequence after T044**, which edits the same string (FR-048)
- [X] T068 [US8] Add an assertion to `packages/mcp-server/tests/protocol/discovery.test.ts` that `search_occurrences`'s description names every field the tool returns, so this claim cannot drift again (FR-048)

**Checkpoint**: All eight stories complete.

---

## Phase 11: Polish & Cross-Cutting Concerns

- [X] T069 Run the full gate on all platforms available: `node scripts/check-deps.mjs && pnpm typecheck && pnpm lint && pnpm build && pnpm test`. Confirm the check count exceeds the T004 baseline (FR-050, SC-013).
- [X] T070 Walk [quickstart.md](./quickstart.md) end to end, section by section, confirming each stated **Pass** condition
- [X] T071 Audit FR-051 explicitly: confirm all seven load-bearing decisions in `docs/code-review.md` §7 are intact. Two were touched by adjacent work and need direct confirmation — `stdout-guard.js` is still the first import of `packages/mcp-server/src/index.ts` (T029 edited that file), and `next` is still a required field on `ToolErrorFields` (T005 and T042 added to that type).
- [X] T072 [P] Add a Context / Decision / Trade-off entry to `README.md` for each non-obvious choice this feature makes: insertion-order eviction over true LRU, refusal over report-and-proceed for contradictory taxon inputs, and coverage reported rather than enforced (Constitution IX)
- [X] T073 [P] Confirm `.env.example`'s `LOG_LEVEL` line is now true for the agent-launched server after T037, and adjust its comment if it implies a directly-launched server only
- [X] T074 Confirm FR-049: diff the tool `inputSchema`s, `outputSchema`s and result shapes against `main` and verify the only behavioural deltas are the two carved out in [contracts/README.md](./contracts/README.md) — the contradictory-taxon refusal and the CLI history ceiling

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies. T001 **must** precede T002 — it is the FR-037 precondition, and running it after other work would confound the result.
- **Phase 2 (Foundational)**: Depends on Phase 1. **Blocks every user story.**
- **Phases 3–10 (User Stories)**: All depend on Phase 2. Then largely parallel — see below.
- **Phase 11 (Polish)**: Depends on every story you intend to ship.

### User Story Dependencies

| Story | Depends on | Notes |
|---|---|---|
| US1 (P1) | Phase 2 (T005 for `INTERNAL_ERROR`) | Independent of every other story |
| US2 (P1) | Phase 2 | Independent |
| US3 (P2) | Phase 2 | Independent |
| US4 (P2) | Phase 2 (T006–T008) | Independent of US6 *because* the extraction moved to Phase 2 |
| US5 (P2) | Phase 2 (T005 for `CONTRADICTORY_TAXON`) | Independent |
| US6 (P3) | Phase 2 (T006–T008) | Independent |
| US7 (P3) | Phase 1 (T002); T062 reads the tests from US1–US4 | T055–T061 are independent of all stories |
| US8 (P3) | T067 sequences after T044 (US5) — same string | Otherwise independent |

**Only two cross-story orderings exist**: T067 after T044, and T062 after the test tasks it audits.
Everything else is free.

### Within Each User Story

Tests are written first and must fail before the implementation lands. Within implementation:
domain logic before the boundary that calls it, source before the prose describing it.

### Parallel Opportunities

- T003 runs alongside T001/T002
- Phase 2: T006 must precede T007 and T008; T007 and T008 are then parallel
- **All eight story phases can run in parallel** once Phase 2 is done, with the two exceptions above
- Within stories: T010–T011, T017–T019, T022–T024, T031–T032, T039–T041, T055–T057, T060–T061, T064–T066 are each parallel sets
- Different files throughout — the only same-file contention is `errors.ts` (resolved by T005),
  `packages/agent/src/index.ts` (resolved by T006–T008), and `search-occurrences.ts`'s `DESCRIPTION`
  (resolved by sequencing T067 after T044)

---

## Parallel Example: User Story 1

```bash
# Tests first, in parallel — all three fail against today's errorCode: "ToolError"
Task: "Create packages/mcp-server/tests/unit/logging.test.ts asserting the recorded errorCode per failure family"
Task: "Create packages/mcp-server/tests/unit/errors.test.ts asserting the INTERNAL_ERROR fallback"

# Then implementation, sequentially — T013 and T014 touch the shape the tests read
Task: "run-tool.ts: record error.code, not error.name"
Task: "logging.ts: narrow errorCode to ToolErrorCode"
```

## Parallel Example: after Phase 2, across stories

```bash
# Eight independent tracks
Developer A: Phase 3 (US1) then Phase 4 (US2)    # both P1 — the MVP
Developer B: Phase 5 (US3)
Developer C: Phase 6 (US4) and Phase 8 (US6)
Developer D: Phase 7 (US5), Phase 9 (US7), Phase 10 (US8)
```

---

## Implementation Strategy

### MVP: Phases 1–4

Setup, Foundational, US1 and US2 — the two defects a user can actually feel, plus the ratchet that
keeps them from recurring. Roughly a dozen tasks, two of which are one-line source changes
(`error.code` for `error.name`; `retryable === false` for `code !== 'CANCELLED'`).

**Stop and validate here.** SC-001 goes from 0% to 100% and SC-002's recovery time goes from an hour
to zero, both independently demonstrable.

### Incremental Delivery

1. Phases 1–2 → the gate is stricter and the agent is single-sourced; nothing has changed behaviourally
2. Phase 3 → operators can diagnose failures (**MVP**)
3. Phase 4 → transient outages stay transient (**MVP**)
4. Phase 5 → the server survives long uptime
5. Phase 6 → the session is graceful
6. Phase 7 → no silent choice remains *(the one contract change — worth its own commit and note)*
7. Phases 8–10 → the eval, the toolchain, the prose
8. Phase 11 → validate the whole

### Notes

- Commit per task or per logical group, Conventional Commits, as the constitution requires
- The `retryable === false && code !== 'CANCELLED'` guard in T020 is the one place a well-meaning
  simplification would reintroduce a bug — the reasoning is in [research.md](./research.md) D2 and
  belongs in the commit body
- No production dependency is added anywhere in this list. If a task seems to need one, stop: the
  spec assumes none is required (Constitution VIII)
