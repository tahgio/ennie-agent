# Quickstart: Validating Post-Review Hardening

**Feature**: `002-code-review-hardening` | **Spec**: [spec.md](./spec.md) | **Contracts**: [contracts/](./contracts/)

How to prove this feature works, end to end. Every scenario below maps to a user story and its
success criterion. Nothing here is implementation guidance — that belongs in `tasks.md`.

## Prerequisites

```bash
node --version      # v24.x
pnpm --version      # 11.x  (see FR-047 — the README's stated minimum changes to match)
pnpm install --frozen-lockfile
pnpm build
```

A model API key is needed only for §7 and §8. Everything else runs offline.

## The gate everything must pass

```bash
node scripts/check-deps.mjs   # must not shell out to `cat` (FR-038)
pnpm typecheck                # now with three additional flags (FR-036)
pnpm lint
pnpm test                     # 165 existing checks, plus this feature's (FR-050)
```

Expected: all green, on Linux, macOS and Windows alike. A failure in `typecheck` on the *unchanged*
tree would mean FR-037 was violated — the flags were supposed to be a ratchet, not a refactor.

---

## 1. Failures are distinguishable from the record alone

**Story**: US1 · **Criterion**: SC-001 · **Contract**: [tool-call-log.md](./contracts/tool-call-log.md)

```bash
pnpm test -- tests/unit/logging.test.ts tests/unit/errors.test.ts
```

Expect one assertion per failure family, each asserting a distinct `errorCode`, plus the
non-`ToolError` fallback recording `INTERNAL_ERROR` rather than `UPSTREAM_UNAVAILABLE`.

To see it live, with a client subscribed to log notifications:

```bash
LOG_LEVEL=debug node packages/mcp-server/dist/index.js
```

Provoke a not-found, an ambiguity and a bad country code. On stderr, each record's `errorCode`
differs. **Pass**: no two families share a value, and none reads `"ToolError"`.

---

## 2. A transient outage stays transient

**Story**: US2 · **Criterion**: SC-002 · **Decision**: [D2](./research.md#d2--only-non-retryable-failures-are-remembered)

```bash
pnpm test -- tests/unit/resolution.test.ts
```

Two assertions carry this:

- **Retryable** — a lookup fails with a stubbed upstream outage; the stub is then made healthy and
  the identical lookup repeated. **Pass**: the second lookup reaches upstream and succeeds.
- **Non-retryable** — a lookup fails as `NOT_FOUND`; the identical lookup is repeated. **Pass**: it
  is answered from memory with no upstream call, and the original text (including an ambiguity's
  candidate list) is intact.

A cancelled lookup must still not be remembered.

---

## 3. Bounded memory, and a year bound that tracks the calendar

**Story**: US3 · **Criteria**: SC-003, SC-004

```bash
pnpm test -- tests/unit/cache.test.ts tests/unit/filters.test.ts
```

- **Eviction** — construct the store with a small ceiling, insert past it. **Pass**: `size` never
  exceeds the ceiling, the entry discarded is the one recorded longest ago, and an evicted name
  resolves correctly on demand.
- **Scale** — drive ten times the default ceiling in distinct names. **Pass**: `size` stops at the
  ceiling; every lookup still succeeds (SC-003).
- **Year bound** — parse a year filter with an injected clock set *before* a new year, then one set
  *after*. **Pass**: the new year is accepted with no restart, and no rejection message names a
  range that includes the value it just rejected (SC-004).

Shutdown, checked by hand:

```bash
node packages/mcp-server/dist/index.js &
kill -INT %1 ; kill -TERM %1     # two signals in quick succession
```

**Pass**: exactly one `shutting down` line, and the process is gone within two seconds.

---

## 4. A graceful command-line session

**Story**: US4 · **Criteria**: SC-005, SC-006 · **Contract**: [agent-cli.md](./contracts/agent-cli.md)

Offline, no provider contacted:

```bash
pnpm test -- packages/agent/tests/session.test.ts
```

**Pass**: the interruption test asserts one line of shutdown output, no failure text, and status
130; the history test asserts truncation in pairs and the notice.

By hand, with a key set:

```bash
pnpm agent "Where has the polar bear been recorded?"
# press Ctrl-C while the answer is being generated
echo $?
```

**Pass**: `Received SIGINT. Exiting.`, nothing else, and `130`. Then confirm no orphan:

```bash
pgrep -f 'mcp-server/dist/index.js'   # expect no output
```

And that verbosity reaches the child:

```bash
LOG_LEVEL=debug pnpm agent "Where has the polar bear been recorded?"
```

**Pass**: the server's `debug` records appear on stderr. Today they do not.

---

## 5. Contradictory taxon inputs are refused

**Story**: US5 · **Criterion**: SC-007 · **Contract**: [taxon-input.md](./contracts/taxon-input.md)

```bash
pnpm test -- tests/protocol/search-occurrences.test.ts tests/protocol/summarize-occurrences.test.ts
```

**Pass**: a request carrying both `taxonKey` and `name` returns `isError: true` with text naming
**both** values, and **no upstream request is made**. The key-only and name-only tests pass
unmodified (FR-030).

Read the tool descriptions from a connected client and confirm each states what happens when both
are supplied (FR-029) — the description is prompt surface, and a model that cannot predict the
refusal will trip it.

---

## 6. The eval suite measures the shipped agent

**Story**: US6 · **Criterion**: SC-008

The check is a single edit, reverted afterwards:

1. Change `maxSteps` in `packages/agent/src/agent.ts` from 8 to 3 — **one edit, one file**.
2. Run `pnpm eval` (needs a key; costs money).
3. Inspect a recorded run.

**Pass**: the new ceiling is in effect, and there was no second definition to update. **Fail**: the
eval still runs at 8 — the copy survives.

Attribution, offline:

```bash
pnpm test -- packages/agent/tests/scorers.test.ts
```

**Pass**: with two calls to one capability in flight, each recorded outcome belongs to the
invocation that produced it — no completion overwrites another's.

---

## 7. The toolchain catches what review would have to

**Story**: US7 · **Criteria**: SC-010, SC-011 · **Contract**: [toolchain.md](./contracts/toolchain.md)

In a scratch change, introduce each of these one at a time and run `pnpm typecheck`:

| Introduce | Expect |
|---|---|
| an unused local | rejected |
| an unused parameter | rejected |
| `{ x: undefined }` written into an optional field | rejected |

**Pass**: 3 of 3 rejected before human review (SC-010). Discard the scratch change.

Then confirm the scheduled work:

- `.github/workflows/fixtures.yml` exists, triggers on `schedule` and `workflow_dispatch`, and is
  **not** referenced by `ci.yml` (FR-040).
- `.github/dependabot.yml` exists and proposes weekly updates (FR-042).
- `ci.yml` carries a `concurrency` block with `cancel-in-progress: true` (FR-039) — verify by
  pushing twice in quick succession and confirming the superseded run was cancelled.
- A fresh clone shows no uncommitted `.claude/settings.local.json` (FR-044):

```bash
git status --porcelain     # expect no .claude/settings.local.json
```

---

## 8. The written record matches the code

**Story**: US8 · **Criterion**: SC-012

```bash
grep -n 'Ten scenarios' packages/agent/evals/scenarios/index.ts   # expect no match
grep -n 'pnpm 9' README.md                                        # expect no match
grep -rn '95 fields to 8\|to 8' README.md packages/mcp-server/src/domain/trim.ts
```

**Pass**: the scenario count reads twelve and matches `SCENARIOS.length`; the package-manager
minimum is one under which the workspace's single-Zod-version guarantee holds; the trim count reads
**nine** in all three places and matches `TRIMMED_FIELDS.length`; and `search_occurrences`'s
description names the occurrence `key`.

---

## Whole-feature acceptance

| | Check |
|---|---|
| FR-049 | No capability contract changed shape, other than the two carved out in [contracts/README.md](./contracts/README.md) |
| FR-050 | The existing deterministic suite passes; the total check count has increased |
| FR-051 | The seven decisions in `docs/code-review.md` §7 are intact — in particular, `stdout-guard.js` is still the first import of the server entrypoint, and `next` is still a required field on every failure |
| SC-013 | `pnpm test` green, check count up, no capability added or removed |
