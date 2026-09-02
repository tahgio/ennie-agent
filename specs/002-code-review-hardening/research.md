# Phase 0 Research: Post-Review Hardening

**Feature**: `002-code-review-hardening` | **Date**: 2026-09-02 | **Spec**: [spec.md](./spec.md)

This feature remediates a review of an existing codebase, so there are no technology choices to
make: the stack, the workspace layout, and the dependency set are fixed and Out of Scope. What
Phase 0 resolves instead is the set of *implementation decisions* the specification deliberately
left open, plus the two questions the clarification session settled.

Every decision below is recorded in Decision / Rationale / Alternatives form, and each names the
functional requirements it discharges.

---

## D1 — The failure category on the diagnostic record is the `ToolErrorCode`

**Requirements**: FR-001 – FR-004, FR-006 · **Review**: §1.1

**Decision**: `runTool`'s catch branch reads `error.code` from a `ToolError` and writes it to
`ToolCallLog.errorCode`. Anything that is not a `ToolError` is recorded as the literal
`'INTERNAL_ERROR'`. `ToolErrorCode` gains that member, and `toToolResult`'s fallback stops
borrowing `'UPSTREAM_UNAVAILABLE'`.

**Rationale**: The taxonomy already exists, is already closed, is already documented as "the
`ToolErrorCode`, never the user's data" (`logging.ts:53`), and already carries retry semantics.
Deriving the field from anything else would create a second taxonomy to keep in step. The current
value — `error.name`, which `ToolError`'s constructor sets to the constant `'ToolError'` — is the
whole defect. Because the code is a closed union of literals, FR-003 (no caller-supplied value) is
discharged by the type rather than by a sanitising step.

`'INTERNAL_ERROR'` is a *new* member rather than a reuse because FR-004 requires an unattributed
fault to be distinguishable from a real upstream outage — which is exactly what the present
fallback destroys. The message the caller reads is unchanged; only the code differs.

**Alternatives considered**:
- *A free-form string from the thrown error.* Rejected: unbounded, and re-opens the possibility of
  caller data reaching the record.
- *A separate coarse "family" enum alongside the code.* Rejected: two taxonomies, one of which
  would drift. The existing codes already group cleanly by prefix for anyone aggregating.

---

## D2 — Only non-retryable failures are remembered

**Requirements**: FR-007 – FR-011 · **Review**: §1.2

**Decision**: The negative-caching guard in `resolveTaxon` narrows from
`error.code !== 'CANCELLED'` to `error.retryable === false` (which already excludes `CANCELLED`,
whose `retryable` is false but which is separately never reached — see below). The file comment on
`cache.ts` is rewritten to state which failures are held and which are not.

**Rationale**: `retryable` is already a required field on every `ToolError` and already means
exactly "repeating the identical call could plausibly succeed". A failure that is worth retrying
and a failure that is worth remembering are complementary by definition, so the existing field is
the correct predicate and no new one is needed. This also makes the guard self-describing: today's
`code !== 'CANCELLED'` states an exception without stating the rule.

One subtlety worth recording: `CANCELLED` carries `retryable: false`, so switching predicates
would start caching cancellations, violating FR-009. The guard is therefore
`error.retryable === false && error.code !== 'CANCELLED'`. A cancellation is not a fact about the
name — it is a fact about the caller — which is why it is excluded on its own terms rather than
by its retry semantics.

**Alternatives considered**:
- *A per-code allowlist of cacheable failures.* Rejected: a third place to keep in step with the
  taxonomy, and it would silently omit any code added later.
- *A shorter TTL for retryable failures.* Rejected: any non-zero window still defeats the retry
  advice the message itself gives, which is the finding. FR-007 says "MUST NOT be replayed".

---

## D3 — The remembered-resolution store is bounded by insertion-order eviction

**Requirements**: FR-012 – FR-015, FR-020 · **Review**: §2.1

**Decision**: `TtlCache` gains a `maxEntries` constructor option, defaulting to `2_000`. On
`set()`, when the map is at the ceiling and the key is new, the first key returned by
`this.#entries.keys()` is deleted before the insert. `set()` on an *existing* key deletes and
re-inserts, so a refreshed entry moves to the back.

**Rationale**: A JavaScript `Map` iterates in insertion order, so `keys().next().value` *is* the
longest-ago-recorded entry, at O(1) and with no second data structure. That satisfies FR-013 as
written — "the entry recorded longest ago", which is insertion order, not last-access order.

`2_000` sits in the "low thousands" the spec assumes: an entry is a normalised name plus a small
resolved record, so the ceiling costs on the order of a megabyte, while an ordinary conversation
touches tens of names and will never evict. FR-015's "settable when the store is created" is
satisfied by the same options object that already carries `ttlMs` and `now`, which is what makes
the boundary testable without allocating two thousand entries.

Correctness under eviction is free: an evicted key is a miss, and a miss resolves upstream. That
is FR-014, and it is a property of the existing read path rather than new code.

**Alternatives considered**:
- *True LRU (re-insert on read).* Rejected: it changes what `get()` means — a read would mutate
  ordering — for a workload whose access pattern is already dominated by TTL expiry. FR-013 asks
  for oldest-recorded, and insertion order is that, exactly.
- *A periodic sweep of expired entries.* Rejected: expiry is already lazy and correct on read; a
  sweep adds a timer to a process whose whole design is "dies with the process". The ceiling alone
  bounds the memory, which is what FR-012 asks for.

---

## D4 — The year bound is derived per request

**Requirements**: FR-016, FR-017, FR-020 · **Review**: §1.3

**Decision**: `yearSchema` moves its `.min()`/`.max()` bounds from schema-construction time into a
`.superRefine()` (or equivalent per-parse check) that calls `maxYear()` when the value is parsed.
The `.describe()` text stops naming a literal upper year and describes the bound in words.

**Rationale**: `maxYear()` already takes an injectable `now`, so the mechanism exists; the defect
is purely that `yearSchema` calls it once, at module load, and bakes the result into both the
constraint and the message. FR-017 — a rejection must not name a range that includes the rejected
value — is unsatisfiable while the constraint and the message are both frozen at a different
instant from the request.

The cost is that the upper bound no longer appears as a literal `maximum` in the JSON Schema the
model reads. That is the trade-off the spec explicitly accepts under **Assumptions → Year-bound
placement**: a slightly later rejection point, in exchange for a message that cannot contradict
itself. The lower bound (`MIN_YEAR`, a constant) stays in the schema, so the model still sees a
range.

**Alternatives considered**:
- *Keep the static bound and only fix the message.* Rejected: the rejection would still happen at
  the stale bound, so a server running into a new year still refuses the new year (FR-016).
- *Rebuild the schema per request.* Rejected: the schema is spread into two tool definitions
  registered once at server construction; rebuilding it per call would mean re-registering tools.

---

## D5 — Server shutdown is once-only and time-bounded

**Requirements**: FR-018, FR-019 · **Review**: §2.5

**Decision**: `process.once` for both signals, plus a module-level `closing` flag that makes a
second call a no-op even if both signals arrive. Alongside `server.close()`, an
`unref()`'d `setTimeout(() => process.exit(0), 2_000)` bounds the wait.

**Rationale**: `once` alone does not cover SIGINT-then-SIGTERM, so the flag is not redundant with
it — the flag is the actual guarantee and `once` is the cheap first line. `unref()` is what keeps
the timer from *itself* holding the process open in the normal case where `close()` settles
promptly, which is the trap in this pattern. Two seconds is comfortably longer than a stdio
transport teardown and short enough that a stuck server does not hold a pipe open long enough to
matter to the parent.

**Alternatives considered**:
- *`Promise.race` between `close()` and a timer.* Rejected: the timer would still need `unref()`
  and the race adds nothing over calling `process.exit(0)` from both paths.
- *No bound, relying on the parent to kill the child.* Rejected: FR-019 asks for a bound, and the
  agent's existing teardown test exists precisely because orphans are invisible.

---

## D6 — Interruption during a generation exits 130 with no failure text

**Requirements**: FR-021, FR-022, FR-027 · **Review**: §2.3

**Decision**: `Session.ask` already rethrows when the shutdown signal is aborted. `main()` gains a
catch for that path — or `run()` swallows it — such that the interrupted run returns the
conventional interrupt status `130` (128 + SIGINT) and prints nothing beyond the existing
`Received SIGINT. Exiting.` line. The `finally` block that disconnects MCP is untouched, so
FR-022 continues to hold by construction.

**Rationale**: `130` is the shell convention for "terminated by SIGINT" and is what a caller
scripting the CLI will already branch on. The spec's Assumptions allow a plain `0` instead; `130`
is chosen because it preserves the distinction between "the person interrupted" and "the session
finished", which a wrapper script may legitimately care about. `contracts/agent-cli.md` already
reserves `2` for configuration errors and `1` for runtime failures, so `130` slots in without
colliding.

FR-027 asks for a check that does not contact a provider. The seam is `Session` itself: it takes
an injected `agent`, so a stub whose `generateText` rejects with an abort once the signal fires
exercises the whole path offline. `tests/session.test.ts` already stubs the agent this way.

**Alternatives considered**:
- *Catch inside `Session.run`.* Rejected: the session would then have to know the process exit
  convention, which belongs to the entrypoint. Rethrowing and letting `index.ts` decide keeps the
  session reusable by the eval runner.
- *Exit `0`.* Allowed by the spec, rejected here for the reason above.

---

## D7 — Conversation history is bounded by turn count, with a notice

**Requirements**: FR-023 – FR-025 · **Review**: §2.2

**Decision**: `Session` gains a `maxTurns` option defaulting to `40` entries — 20 exchanges. After
each successful push, entries are dropped from the front in `user`/`assistant` pairs until the
array is within the ceiling. When anything is dropped, the session writes one line naming how many
exchanges were dropped.

**Rationale**: Counting turns rather than tokens keeps the ceiling free of a tokeniser dependency,
which Constitution VIII would make us justify, and free of per-provider variance. Twenty exchanges
is squarely inside the spec's assumed "twenty to thirty" and far above the longest eval scenario
(three questions), so FR-025 — a clarification exchange must never be truncated mid-flight — holds
with a wide margin.

Dropping in pairs matters: leaving an orphaned `assistant` entry at the head of the transcript
produces a message sequence some providers reject, which would convert a graceful truncation into
the very failure this requirement exists to prevent.

The notice is required by FR-024 and is also what keeps the truncation honest — a session that
silently forgets is indistinguishable from a model that ignored the context.

**Alternatives considered**:
- *A character or token budget.* Rejected: needs a tokeniser (a new dependency) or a bad estimate,
  for a ceiling whose only job is to stay far below the provider's real limit.
- *Summarising dropped history.* Rejected: an extra model call per truncation, and it is a
  capability the spec does not ask for.

---

## D8 — Contradictory taxon inputs are refused

**Requirements**: FR-028 – FR-030 · **Review**: §2.7 · **Clarification**: Session 2026-09-02, Q1

**Decision**: `selectTaxon` checks for both values *before* the `taxonKey` branch and throws a new
`CONTRADICTORY_TAXON` `ToolError` naming both supplied values, `retryable: false`. Both occurrence
tool descriptions state the behaviour.

**Rationale**: This is the clarification the user settled: refuse rather than report-and-proceed.
It is the treatment every other ambiguity in this codebase already receives — a homonym, a weak
fuzzy match, a genus-only match are all returned to the caller as a recoverable question rather
than guessed at — and §2.7 of the review reaches the same conclusion ("reads more like the rest of
the design").

The check runs before any network call, so it costs nothing and satisfies the project's rule that
input validation precedes upstream traffic. FR-029's description change is not optional dressing:
the tool description is prompt surface (Constitution I), and a model that cannot predict the
refusal will trip it.

This is the one place the feature deliberately changes a previously-succeeding input shape, which
is why FR-049 carves it out explicitly.

**Alternatives considered**:
- *Report the ignored name in the text block and proceed.* Presented to the user and not chosen.
  It is additive and breaks nothing, but it leaves the system making a silent-ish choice on the
  caller's behalf, which is the inconsistency the finding is about.
- *Refuse only when they disagree.* Impossible without resolving the name — the exact upstream
  call the `taxonKey` form exists to avoid.

---

## D9 — The eval suite imports the shipped agent from one definition

**Requirements**: FR-031 – FR-033 · **Review**: §3.1, §3.4

**Decision**: A new `packages/agent/src/agent.ts` exports `serverEntrypoint()` and
`createAgent(options)` — name, instructions, model, tools, `memory: false`, `maxSteps`, and
optional `hooks`/`observability`. `src/index.ts` and `evals/run-scenario.ts` both call it. The
duplicated copies in each are deleted.

Attribution (§3.4) is fixed by keying `onToolStart` / `onToolEnd` on the call id VoltAgent's hook
context carries, rather than by scanning backwards for the most recent call of the same name.
Where no id is available, the fallback is to match the most recent *unresolved* call of that name
rather than the most recent call of that name.

**Rationale**: FR-032 is a property of there being one definition, not of the two being equal, so
extraction is the requirement rather than a way to meet it. The eval package already imports
`src/instructions.js`, `src/model.js` and `src/empty-answer.js`, so importing one more sibling
introduces no new coupling and no new dependency — and Constitution VII is untouched, because this
is agent-to-agent, not agent-to-server.

The attribution defect is real but currently latent: the scorer that asks "did the agent repeat a
call it was told had failed" reads `isError`, and with parallel same-name calls the wrong record
carries it. Tracking unresolved calls is the minimal fix that holds without a hook-context id.

**Alternatives considered**:
- *Have the eval runner drive `Session` itself.* Attractive — it would put the eval on the exact
  code path the person uses — but the runner needs per-turn access to the record and scripted
  replies, and `Session` owns its own readline loop. Out of proportion to the finding.
- *An index-based `Map` from name to a stack of pending indices.* Equivalent to the chosen
  fallback; the "most recent unresolved" phrasing is the same structure with less bookkeeping.

---

## D10 — Three compiler flags, one lint rule, and a shell-out removed

**Requirements**: FR-036 – FR-039, FR-044 · **Review**: §4.1, §4.2, §4.3, §4.5

**Decision**:
- `tsconfig.json` gains `noUnusedLocals`, `noUnusedParameters`, `exactOptionalPropertyTypes`.
- `check-deps.mjs` replaces `execFileSync('cat', ...)` with `readFileSync`.
- `ci.yml` gains a `concurrency` block with `cancel-in-progress: true`.
- `.gitignore` gains `.claude/settings.local.json`.

**Rationale**: The review verified all three compiler flags pass on the current tree unmodified,
which is FR-037 stated as a fact rather than a hope — so this is a ratchet, not a refactor. It must
be re-verified as the first task of that group, because the other work in this feature lands new
code that must also satisfy it.

The `cat` shell-out is the one place in the repository that reaches outside Node for something Node
does natively; it fails on any platform without `cat` and violates the project's own
prefer-the-platform rule (Constitution VIII).

`.claude/settings.local.json` is generated per-contributor by their tooling; `biome.json` sets
`vcs.useIgnoreFile: true`, so ignoring it also keeps it out of lint's view. FR-044 insists this
live in the repository's own rules rather than a personal global ignore file, because a fresh clone
by a new contributor is the case that matters.

**Alternatives considered**:
- *`noUncheckedSideEffectImports` too.* Rejected: not named in the review or the spec, and
  `src/index.ts` deliberately relies on an import for its side effect.
- *Ignoring all of `.claude/`.* Rejected: the repository's committed skills and settings live
  there; only the `settings.local.json` file is per-contributor.

---

## D11 — Coverage is reported, never enforced

**Requirements**: FR-041 · **Clarification**: Session 2026-09-02, Q2

**Decision**: CI runs the deterministic suite with `--coverage` and uploads the report as a build
artefact. No thresholds are configured in `vitest.config.ts`.

**Rationale**: The user's clarification. It also matches what US7's acceptance scenarios actually
ask for — they name the type gate, the pin check, run cancellation and the scheduled check, and
never a coverage number. A threshold would create a new way for an unrelated change to fail CI on
something other than correctness, and would have to be picked arbitrarily today.

`@vitest/coverage-v8` is a dev-only dependency of an existing dev tool, which is the weakest form
of the Constitution VIII question and is answered by FR-041 requiring coverage at all.

**Alternatives considered**:
- *Blocking thresholds.* Presented to the user and not chosen.
- *Coverage on a schedule rather than per-run.* Rejected: the number is most useful on the change
  that moved it.

---

## D12 — Two scheduled workflows, kept out of the critical path

**Requirements**: FR-040, FR-042, FR-043 · **Review**: §4.3, §4.4

**Decision**: A `fixtures.yml` workflow runs `pnpm test:live` on a weekly `schedule` plus
`workflow_dispatch`, in its own workflow file so it can never gate a pull request. Dependency
updates come from a `.github/dependabot.yml` grouping non-major updates weekly. The existing
`check-deps.mjs` step in `ci.yml` is what stops an update from breaking a deliberate pin, and no
change is needed for that — a Dependabot pull request is an ordinary pull request and runs the
same gate.

**Rationale**: Keeping the live check in a separate workflow is the mechanical form of FR-040's
"MUST NOT gate ordinary changes" — a separate file cannot be a required check for a pull request
by accident. A failure there means GBIF moved, which is information about the world rather than a
defect in this repository (the spec's edge case says exactly this).

Dependabot is repository-native, needs no third-party service and no credentials, which is the
mechanism the spec assumes. Grouping non-major updates keeps the pull-request volume sane on a
project with two packages. FR-043 needs no new machinery precisely because the pin check already
runs on every pull request: this is a case where an existing gate covers a new source of change.

**Alternatives considered**:
- *A `schedule` trigger added to `ci.yml` with a conditional job.* Rejected: the condition becomes
  the only thing standing between a live-network job and a pull request, which is exactly the
  arrangement Constitution VI is written to prevent.
- *Renovate.* Rejected: a third-party app where a native one suffices.

---

## D13 — Documentation drift is corrected to the code, not the code to the prose

**Requirements**: FR-046 – FR-048 · **Review**: §6

**Decision**:
- `evals/scenarios/index.ts:4` — "Ten scenarios" becomes twelve.
- `README.md:27` — "pnpm 9+" becomes "pnpm 11+".
- The trim count is stated as **nine fields** in `README.md:20` and `domain/trim.ts:1`, matching
  `TRIMMED_FIELDS` and the existing "the nine keys" comment at `trim.ts:23`.
- `search_occurrences`'s description names the occurrence `key`.

**Rationale**: In each case the code is right and the prose is stale. The pnpm minimum is the one
with teeth: `pnpm-workspace.yaml` uses `overrides`, `allowBuilds` and `minimumReleaseAgeExclude`,
which pnpm 9 does not honour — so a contributor following the stated minimum silently loses the
single-Zod-version guarantee Constitution IV requires, which is FR-047 exactly.

"Nine" is chosen over "eight data fields plus the key" because `TRIMMED_FIELDS.length` is nine and
a stated count should be checkable against the thing it counts without a caveat.

The `key` omission is a prompt-surface defect, not a documentation one: it is the single field a
caller needs to look a record up at its source, and a model that does not know it is returned will
not offer it.

**Alternatives considered**:
- *An automated check that counts and compares.* Rejected as disproportionate — but the trim count
  is already asserted against `TRIMMED_FIELDS` in the unit tests, which is the half that can drift
  silently.

---

## D14 — The untested behaviours get direct unit tests

**Requirements**: FR-006, FR-010, FR-020, FR-027, FR-045 · **Review**: §5.1 – §5.5

**Decision**: Four new unit test files and one addition to an existing one:

| File | Covers |
|---|---|
| `tests/unit/filters.test.ts` | open-ended and single-value year translation, paging boundary, country normalisation and rejection, request-time year bound |
| `tests/unit/cache.test.ts` | key normalisation, expiry, hit/miss statistics, the eviction boundary |
| `tests/unit/errors.test.ts` | the non-`ToolError` fallback and its `INTERNAL_ERROR` code |
| `tests/unit/logging.test.ts` | the recorded category for one instance of each failure family |
| `packages/agent/tests/session.test.ts` | interruption during an in-flight generation; history truncation and its notice |

**Rationale**: These are the five gaps §5 names, and each maps to a requirement that would
otherwise be verified only by reading. All are pure-function or injected-dependency tests: the
cache takes an injectable `now`, the filters are pure, and `Session` takes an injected agent — so
none of them contacts the network or a model provider, which Constitution VI requires and FR-027
restates for the interruption case.

The eviction boundary test is the reason FR-015 asks for a settable ceiling: with `maxEntries: 2`
the behaviour is three lines to assert instead of two thousand inserts.

**Alternatives considered**:
- *Protocol-level tests for the failure categories.* Partly: one protocol test already provokes
  failures end to end, and asserting the notification's category there is what discharges FR-002.
  The per-family sweep is cheaper as a unit test over `runTool`.

---

## D15 — `LOG_LEVEL` is forwarded to the launched server

**Requirements**: FR-026 · **Review**: §2.6

**Decision**: The `env` object passed to `MCPConfiguration` gains `LOG_LEVEL` when it is set,
alongside the existing `GBIF_USER_AGENT_CONTACT`.

**Rationale**: The environment is replaced rather than merged, which is a deliberate and defensible
posture the spec preserves ("The launched server's environment otherwise remains deliberately
minimal"). Forwarding one further named variable keeps that posture — it is still an allowlist —
while making `.env.example`'s advertised `LOG_LEVEL` true for the path most people use. The
alternative the review offers, documenting that `LOG_LEVEL` applies only to a directly-launched
server, was rejected by the spec's Assumptions.

---

## D16 — `gbifFacetParam` and the model-value type escapes

**Requirements**: FR-034, FR-035 · **Review**: §3.2, §3.3

**Decision**: `gbifFacetParam` is removed and its three call sites in `occurrence.ts` use the value
directly; the assertions in `tests/unit/facets.test.ts` that exercise it go with it. The three
`as never` casts around the model value — in `src/index.ts`, `evals/run-scenario.ts` and
`evals/biodiversity.eval.ts` — are replaced by a single exported helper in `model.ts` that carries
the explanation once in its doc comment.

**Rationale**: FR-035 offers "removed *or* carry a stated reason"; an identity function that only
forwards its argument has no reason to state, so removal is the honest branch. The type escapes are
the opposite case: the escape is genuinely necessary — VoltAgent's `model` parameter and the AI
SDK's `LanguageModel` union do not line up — so the requirement is that the reason be stated once
rather than that the cast disappear. One helper with one comment is the minimal shape of that. Two of the three call sites disappear anyway once D9 lands, since the
CLI and the eval runner will both build their agent through `createAgent`.

Removing the identity function deletes a small number of existing assertions in
`tests/unit/facets.test.ts`. That is the *only* place FR-050's carve-out applies: no existing test
asserts today's silent `taxonKey`-wins precedence, so even D8 adds a check rather than modifying
one.

---

## Cross-cutting: what Phase 0 confirms is *not* needed

- **No new production dependency.** Every decision above uses the platform, an existing dependency,
  or a dev-only addition to an existing dev tool (`@vitest/coverage-v8`). Constitution VIII is
  satisfied without a justification entry in a commit body for a production dependency.
- **No new capability, tool, transport, or persistence.** FR-049 and the Out of Scope list hold.
- **No change to the seven load-bearing decisions** in the review's §7. Two of them are actively
  touched by adjacent work and must be preserved deliberately: the output-channel guard stays the
  first import of `src/index.ts` while §2.5's shutdown change edits that same file, and the
  required-`next` discipline applies to the new `CONTRADICTORY_TAXON` error.
