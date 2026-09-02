# Phase 1 Data Model: Post-Review Hardening

**Feature**: `002-code-review-hardening` | **Date**: 2026-09-02 | **Spec**: [spec.md](./spec.md)

This feature introduces no new entity. It changes four that already exist — three by adding a
constraint, one by correcting a field that was always specified but never populated. Each section
below states the entity's current shape, the delta, and the requirements that motivate it.

Decisions referenced as **D1**–**D16** are in [research.md](./research.md).

---

## 1. Tool Call Diagnostic Record

**Where**: `packages/mcp-server/src/logging.ts` (`ToolCallLog`), written by
`packages/mcp-server/src/tools/run-tool.ts`.

One record per capability invocation, emitted on stderr and — when a client has subscribed — as an
MCP `notifications/message`.

| Field | Type | Change |
|---|---|---|
| `tool` | `string` | unchanged |
| `durationMs` | `number` | unchanged |
| `retries` | `number` | unchanged |
| `cache` | `'hit' \| 'miss' \| 'n/a'` | unchanged |
| `upstreamRequests` | `number` | unchanged |
| `outcome` | `'ok' \| 'error'` | unchanged |
| `errorCode` | `ToolErrorCode \| undefined` | **narrowed from `string`**, and now actually populated |

**Delta** (D1, FR-001 – FR-004):

- `errorCode` is typed as `ToolErrorCode` rather than `string`. The union is closed, which is what
  discharges FR-003 — no caller-supplied value is *expressible*, so no sanitising step is needed.
- The value written is `error.code` when the thrown value is a `ToolError`. Today it is
  `error.name`, which `ToolError`'s constructor sets to the constant `'ToolError'`.
- A non-`ToolError` is recorded as `'INTERNAL_ERROR'` (FR-004).

**Validation rules**:

- `errorCode` is present if and only if `outcome === 'error'`.
- The value on the stderr record and the value in the client notification are the same object
  (FR-002 holds by construction — `logToolCall` passes one `entry` to both channels).

---

## 2. Tool Error Taxonomy

**Where**: `packages/mcp-server/src/errors.ts` (`ToolErrorCode`).

**Delta** — two members added to a closed union of sixteen:

| Code | Retryable | Raised by | Requirement |
|---|---|---|---|
| `INTERNAL_ERROR` | `true` | `toToolResult`'s non-`ToolError` fallback | FR-004 |
| `CONTRADICTORY_TAXON` | `false` | `selectTaxon`, before any upstream call | FR-028 |

`INTERNAL_ERROR` replaces the present fallback's reuse of `UPSTREAM_UNAVAILABLE`. **The message the
caller reads is unchanged** — only the recorded category differs — so this is not a contract change
under FR-049.

`CONTRADICTORY_TAXON` is a new recoverable failure and *is* a contract change, the one FR-049
carves out. Its fields, per D8:

- `what` names **both** supplied values — the key and the name — because naming only one leaves the
  caller guessing which we objected to.
- `next` directs the caller to supply exactly one, and says what each choice means.
- `retryable: false`. Repeating the identical call cannot succeed.

**Invariant preserved** (Out of Scope, review §7): `next` remains required by the type. The new
error is subject to the same discipline as every existing one.

---

## 3. Remembered Resolution — `TtlCache`

**Where**: `packages/mcp-server/src/gbif/cache.ts`.

A name-to-outcome map, keyed by normalised name plus rank and kingdom hints, holding either a
resolved taxon or a preserved failure.

**Delta A — a ceiling** (D3, FR-012 – FR-015):

| Member | Change |
|---|---|
| `constructor(options)` | gains `maxEntries?: number`, default `2_000` |
| `set(key, outcome)` | evicts before inserting when at the ceiling with a new key; re-inserts on an existing key so a refresh moves to the back |
| `size` | unchanged getter; now bounded by `maxEntries` |

**State transitions on `set`**:

```
key already present        -> delete, then insert          (moves to back, size unchanged)
new key, size <  maxEntries -> insert                      (size + 1)
new key, size >= maxEntries -> delete oldest, then insert  (size unchanged, at ceiling)
```

"Oldest" is the first key of `Map.prototype.keys()`, which is insertion order — the
longest-ago-*recorded* entry, which is what FR-013 asks for. Not last-access order; a read does not
reorder.

**Validation rules**:

- `0 <= size <= maxEntries` at all times.
- An evicted key is indistinguishable from a never-seen key: the next `get` is a miss, and a miss
  resolves upstream (FR-014). This needs no new code — it is a property of the existing read path.

**Delta B — which failures may be held** (D2, FR-007 – FR-009):

The cache itself is unchanged here; the *caller* narrows. In
`packages/mcp-server/src/domain/resolution.ts`, the guard around `setNegative` becomes:

```
remember the failure  <=>  error.retryable === false  AND  error.code !== 'CANCELLED'
```

| Failure | `retryable` | Remembered? | Was remembered before? |
|---|---|---|---|
| `NOT_FOUND`, `AMBIGUOUS`, `LOW_CONFIDENCE`, `HIGHER_RANK` | `false` | yes | yes |
| `UPSTREAM_RATE_LIMITED`, `UPSTREAM_TIMEOUT`, `UPSTREAM_UNAVAILABLE` | `true` | **no** | yes — the defect |
| `CANCELLED` | `false` | **no** | no |

A remembered failure is still replayed verbatim, candidate list intact (FR-008) — that behaviour is
untouched.

---

## 4. Filter Set — year bounds

**Where**: `packages/mcp-server/src/domain/filters.ts`.

**Delta** (D4, FR-016, FR-017): the acceptable year range is evaluated when a value is parsed, not
when the schema is constructed.

| | Before | After |
|---|---|---|
| Upper bound | `maxYear()` called once at module load | `maxYear()` called per parse |
| JSON Schema | carries a literal `maximum` | carries `minimum` only; the upper bound is described in prose |
| Rejection message | may name a range containing the rejected value | always names the range actually applied |

`MIN_YEAR` is a constant and stays a declared schema constraint. `maxYear(now)` already accepts an
injected clock, which is what makes FR-020's request-time test possible without touching the system
clock.

---

## 5. Taxon Selection

**Where**: `packages/mcp-server/src/domain/taxon-input.ts` (`selectTaxon`).

**Delta** (D8, FR-028 – FR-030): a new first branch, before the existing `taxonKey` branch.

| Input | Before | After |
|---|---|---|
| key only | query the key, `taxon: null` | unchanged (FR-030) |
| name only | resolve, then query | unchanged (FR-030) |
| **both** | key silently wins, name discarded | **`CONTRADICTORY_TAXON`**, before any upstream call |
| neither | `MISSING_TAXON` | unchanged |

The refusal applies whether or not the two agree — the system cannot check agreement without
performing the very lookup the key exists to avoid.

`TaxonSelection`'s shape is unchanged.

---

## 6. Conversation Transcript

**Where**: `packages/agent/src/session.ts` (`Session`).

An ordered array of `Turn` held in memory for the life of the process, sent in full on each
question. Never persisted — that stays true.

**Delta** (D7, FR-023 – FR-025):

| Member | Change |
|---|---|
| `SessionOptions` | gains `maxTurns?: number`, default `40` (20 exchanges) |
| after each successful exchange | drop from the front in `user`/`assistant` pairs until `length <= maxTurns` |
| on any drop | write one line naming how many exchanges were dropped (FR-024) |

**Invariant**: entries are dropped in pairs, so the transcript never begins with an `assistant`
entry. An orphaned leading assistant message is rejected by some providers — which would turn a
graceful truncation into the exact failure this ceiling exists to prevent.

`40` is inside the spec's assumed twenty-to-thirty exchanges and far above the longest eval
scenario (three questions), so FR-025 holds with a wide margin.

---

## 7. Agent Definition

**Where**: new `packages/agent/src/agent.ts`; consumed by `src/index.ts` and
`evals/run-scenario.ts`.

Today this entity exists twice — once in each consumer — with no mechanism keeping the copies
equal.

**Delta** (D9, FR-031, FR-032): one exported factory.

| Export | Responsibility |
|---|---|
| `serverEntrypoint()` | resolve the built server path, honouring `GBIF_MCP_SERVER_PATH`; moved out of both consumers |
| `createAgent(options)` | name, instructions, model, tools, `memory: false`, `maxSteps`, optional `hooks` and `observability` |

`options` carries only what genuinely differs between the two consumers: the eval runner supplies
`hooks`, the CLI supplies `observability`. Everything else is fixed in one place, which is what
makes FR-032 a property of the structure rather than of discipline.

**Constitution VII note**: this is agent-internal. The agent package still has no dependency on
`mcp-server` and still launches the built server by path over stdio. `biome.json`'s
`noRestrictedImports` override is untouched and continues to enforce that mechanically.

---

## 8. Tool Call Record (eval)

**Where**: `packages/agent/evals/scorers/run-record.ts` (`ToolCallRecord`), written by the hooks in
`run-scenario.ts`.

**Delta** (D9, FR-033): the *shape* is unchanged; the *attribution* is fixed.

| | Before | After |
|---|---|---|
| `onToolEnd` matches | the most recent call with the same tool name | the invocation that produced it — by call id where available, else the most recent **unresolved** call of that name |

With two calls to one capability in flight, the old rule marks the wrong record. That record feeds
`scoreChainCorrectness`'s "does not repeat a call that already failed" check, so a mis-attribution
becomes a wrong score with no signal.

An internal `pending` set (or a resolved flag on the record) is the only new state; it does not
appear in the serialised `RunRecord`, which stays byte-compatible with recorded runs.

---

## Entity relationships

```
ToolError ──code──> ToolErrorCode ──recorded as──> ToolCallLog.errorCode
    │                                                    │
    │ retryable                                          └──> stderr + MCP notification
    ▼
TtlCache.setNegative        (only when retryable === false and not CANCELLED)
    │
    └──> bounded by maxEntries, evicting oldest-recorded

selectTaxon ──both key and name──> CONTRADICTORY_TAXON (a ToolError, so it flows the path above)

createAgent ──one definition──> CLI Session          ──> Conversation Transcript (bounded)
                            └──> eval runScenario    ──> RunRecord ──> structural scorers
```
