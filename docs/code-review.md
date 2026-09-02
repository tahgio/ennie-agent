# Code review — `ennie-agent`

**Date:** 2026-09-02
**Scope:** whole repository (`packages/mcp-server`, `packages/agent`, `scripts/`, CI, docs)
**Baseline state:** `pnpm typecheck`, `pnpm lint` and `pnpm test` (165 tests, 16 files) all pass on `main` @ `a8a0956`.

Nothing in this document has been applied. Every item is a suggestion.

---

## Overall

This is a genuinely well-built repository. The things that usually go wrong in an MCP server are
right here: stdout is protected structurally rather than by convention, errors are modelled as
messages to a model with a required `next` field, upstream schemas are lenient while contract
schemas are strict, and the protocol tests drive a real SDK client against the server that actually
ships. The comments explain *why* rather than restating the code, and the `specs/` + `research.md`
trail means the non-obvious decisions (match-type before confidence, `verbose=true` always, accepted
key for synonyms) are defensible rather than folkloric.

So the findings below are mostly refinements. Two are real bugs, and the rest are hardening,
de-duplication, tooling ratchets, and documentation drift.

**Priority order, if you only do a few:**

1. §1.1 — the tool-call log records `"ToolError"` instead of the error code (silently breaks FR-029).
2. §1.2 — transient GBIF failures are negatively cached for a full hour.
3. §4.1 — three compiler flags that pass today, for free.
4. §2.1 — the resolution cache has no size bound.

---

## 1. Correctness

### 1.1 Every failed tool call logs `errorCode: "ToolError"` — never the actual code

`packages/mcp-server/src/tools/run-tool.ts:84`

```ts
errorCode: error instanceof Error ? error.name : 'unknown',
```

`ToolError`'s constructor sets `this.name = 'ToolError'` (`errors.ts:72`). So the field that
`logging.ts:53-54` documents as *"the `ToolErrorCode`, never the user's data"* is the literal string
`"ToolError"` on every single failure. Every stderr warn line reads
`resolve_taxon failed in 412ms: ToolError`, and the MCP `notifications/message` payload carries the
same. The one field that would let you tell an `AMBIGUOUS` from an `UPSTREAM_RATE_LIMITED` in a log
aggregate is constant.

**Suggested fix** — `isToolError` is already exported next door:

```ts
import { isToolError, toToolResult } from '../errors.js'
// ...
errorCode: isToolError(error) ? error.code : 'unknown',
```

**Why it survived:** `errorCode` appears nowhere in the test suite (`grep -rn errorCode packages/*/tests`
returns nothing). See §5.4.

---

### 1.2 A transient GBIF outage poisons the resolution cache for an hour

`packages/mcp-server/src/domain/resolution.ts:386-391`

```ts
} catch (error) {
  if (error instanceof ToolError && error.code !== 'CANCELLED') {
    deps.cache.setNegative(key, error)
  }
  throw error
}
```

The exclusion list is `CANCELLED` alone. But `resolveUncached` calls `matchName`, which can raise
`UPSTREAM_TIMEOUT`, `UPSTREAM_RATE_LIMITED` and `UPSTREAM_UNAVAILABLE` — all of which are `ToolError`
instances and all of which get written into the negative cache with the default 1-hour TTL.

Concretely: GBIF has a 30-second blip while someone asks about *Ursus maritimus*. For the next hour,
every request for that name — from every conversation in that process — is answered instantly from
cache with *"GBIF did not respond within the 30s budget"*, without a single upstream attempt. The
error even says `retryable: true`, and retrying cannot work.

The type already carries the answer:

```ts
if (error instanceof ToolError && !error.retryable) {
  deps.cache.setNegative(key, error)
}
```

That keeps the intended behaviour (a misspelling, a homonym, a genuinely unknown name are all
`retryable: false` and stay cached) and drops exactly the cases that should not be.

The doc comment at `cache.ts:18-24` is worth updating alongside — it justifies negative caching
purely in terms of unresolvable names, which is the right justification and is narrower than what
the code does.

---

### 1.3 The upper year bound is frozen at module-load time

`packages/mcp-server/src/domain/filters.ts:64`

```ts
.max(maxYear(), { error: (issue) => `... no later than ${maxYear()}.` })
```

The `.max()` bound is evaluated once, when the module is first imported. The message inside the
closure is evaluated at rejection time. A server process that starts on 2026-12-31 and is still
running on 2027-01-01 will reject `yearTo: 2028` with the message *"Use a year no later than 2028"*
— a rejection that names the value it just rejected.

An MCP server is long-lived by design (that is the whole premise of the 1-hour cache), so this is
reachable rather than theoretical. Two ways out, both fine:

- Move the upper bound into `validateFilters()` alongside the backwards-range check, where it is
  evaluated per call. This also puts both cross-cutting year rules in one place.
- Or keep it in the schema but widen it to a static ceiling (`MIN_YEAR`..`9999`) and let GBIF reject
  the absurd cases — at the cost of a worse message.

The first is more consistent with the file's own stated split between schema rules and `validate*`
rules.

---

## 2. Robustness

### 2.1 `TtlCache` is unbounded

`packages/mcp-server/src/gbif/cache.ts`

There is no maximum entry count and no pruning pass. Entries are only evicted when the *same key* is
read again after expiry (`get()`, line 76). A key that is written once and never re-read stays in
the map for the life of the process.

For an interactive session that is nothing. For a long-lived server fielding many distinct names —
or one where the caller is itself a model generating name variants — the map grows monotonically,
and every expired-but-never-reread entry is retained. Negative caching (§1.2) makes it worse, since
a stream of nonsense names is exactly what fills it.

`Map` iterates in insertion order, so a cap is about four lines:

```ts
const DEFAULT_MAX_ENTRIES = 5_000

set(key: string, outcome: CachedOutcome<T>): void {
  this.#entries.delete(key)                       // re-insert at the tail
  this.#entries.set(key, { outcome, expiresAt: this.#now() + this.#ttlMs })
  while (this.#entries.size > this.#maxEntries) {
    const oldest = this.#entries.keys().next().value
    if (oldest === undefined) break
    this.#entries.delete(oldest)
  }
}
```

The `size` getter and injectable `now` already exist, so this is cheap to test.

---

### 2.2 The CLI transcript grows without bound

`packages/agent/src/session.ts:270-274`

Every turn pushes onto `#turns`, and `ask()` resends the entire array to `generateText` each time.
Nothing trims it. A long session therefore (a) monotonically increases per-turn cost, and (b)
eventually fails with a context-length error from the provider — surfacing through the catch at
line 296 as *"That question could not be answered: …"*, which the person will read as a problem
with their question rather than with the session length.

The file's doc comment is explicit that context is held in memory and dies with the process, which
is a good property and not in question. The suggestion is only a ceiling: keep the last N turn-pairs
(or a rough token budget), and note in the output when older turns were dropped. 20–30 turns is
plenty for the follow-up behaviour the evals actually check.

---

### 2.3 Ctrl-C during a generation exits 1 with a spurious error line

`packages/agent/src/index.ts:143-153`, `packages/agent/src/session.ts:296-297`

At an idle prompt, SIGINT closes readline, the loop ends, `main()` returns `0`. Correct.

While a model call is in flight, `Session.ask` rethrows the abort (`if (this.options.signal?.aborted === true) throw error`),
`main()` propagates, and the outer catch writes the abort error's message to stderr and exits `1`.
The person sees:

```
Received SIGINT. Exiting.
This operation was aborted
```

…and a non-zero exit code for a deliberate, clean interruption.

**Suggested fix** — treat a shutdown-initiated abort as a normal exit in the outer catch:

```ts
} catch (error) {
  if (error instanceof ConfigError) { ... }
  else if (isAbortError(error)) { await exitNow(130) }   // or 0
  else { ... }
}
```

The existing SIGINT test (`teardown.test.ts:172`) only asserts `orphans` is empty and deliberately
does not check the exit code, so this is uncovered. See §5.5.

---

### 2.4 A schema mismatch from GBIF throws away the diagnostic

`packages/mcp-server/src/gbif/client.ts:372-380`

```ts
const parsed = schema.safeParse(json)
if (!parsed.success) {
  throw new ToolError({ what: 'GBIF returned a response in a shape this server does not recognise.', ... })
}
```

The message to the model is right — it names the remedy and does not leak internals. But
`parsed.error` is discarded entirely, so the operator reading stderr gets the same sentence with
nothing to act on. Given that the schemas are deliberately lenient, if this ever fires it means GBIF
genuinely moved, and the Zod issue path is the single most useful thing to have.

One line, on the developer channel only:

```ts
logger.debug({ issues: parsed.error.issues, path: request.path }, 'gbif response failed schema')
```

(`client.ts` doesn't import `logging.ts` today — that's the only cost.)

---

### 2.5 Server shutdown is neither idempotent nor bounded

`packages/mcp-server/src/index.ts:28-33`

```ts
const shutdown = (signal: string): void => {
  logger.info({ signal }, 'shutting down')
  void server.close().finally(() => process.exit(0))
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
```

Two small gaps: a second signal starts a second `close()` (use `process.once`, or a `closing` flag),
and if `close()` never settles the process hangs forever holding the pipe open. An unref'd
`setTimeout(() => process.exit(0), 2_000)` alongside makes teardown bounded — which matters here
precisely because the agent's teardown test exists to prove no orphans are left behind.

---

### 2.6 The spawned server's environment is replaced, not extended

`packages/agent/src/index.ts:70-72`

```ts
env: process.env.GBIF_USER_AGENT_CONTACT
  ? { GBIF_USER_AGENT_CONTACT: process.env.GBIF_USER_AGENT_CONTACT }
  : {},
```

Passing `env` to the MCP stdio transport replaces the child's environment rather than merging into
it. That is a defensible security posture — but `.env.example` advertises `LOG_LEVEL` as *"server log
level on stderr"*, and there is no way to set it for the server the agent launches. Setting
`LOG_LEVEL=debug` before `pnpm agent` silently does nothing.

Either forward the handful of variables the server actually reads:

```ts
env: {
  ...(process.env.GBIF_USER_AGENT_CONTACT ? { GBIF_USER_AGENT_CONTACT: process.env.GBIF_USER_AGENT_CONTACT } : {}),
  ...(process.env.LOG_LEVEL ? { LOG_LEVEL: process.env.LOG_LEVEL } : {}),
},
```

…or note in `.env.example` that `LOG_LEVEL` applies to a directly-launched server only.

---

### 2.7 `taxonKey` silently wins over `name`

`packages/mcp-server/src/domain/taxon-input.ts:38-47`

If a caller supplies both, `taxonKey` is used and `name` is discarded with no signal anywhere — not
in the result text, not in the structured output (`taxon` is `null`), not in the log line. The tool
descriptions say *"Supply this or name"*, which is guidance, not enforcement.

A model that has resolved *Ursus maritimus* and then passes `{ taxonKey: 2433451, name: "Puma concolor" }`
gets polar bear counts labelled with nothing. Cheap options, in increasing strictness:

- mention the ignored `name` in the rendered text block, or
- reject the pair with a `ToolError` naming both values (consistent with how every other ambiguity in
  this codebase is handled — *never a silent choice*).

The second reads more like the rest of the design.

---

## 3. Structure and maintainability

### 3.1 The eval runner re-implements the agent it is supposed to be evaluating

`packages/agent/src/index.ts:40-44, 93-103` vs `packages/agent/evals/run-scenario.ts:25-29, 76-82`

Both files independently define `serverEntrypoint()` (identical bodies) and independently construct
the `Agent` with `name`, `instructions`, `tools`, `memory: false`, `maxSteps: 8`.

This is the most consequential duplication in the repo, because the two copies are *supposed* to be
the same thing: the whole premise of the eval suite is that it drives "the real one — the real
instructions, the real server, the real tools" (`run-scenario.ts:4-6`). The moment someone raises
`maxSteps` in `index.ts` and not in `run-scenario.ts`, the evals silently start measuring an agent
that nobody ships, and the structural score keeps reporting confidently.

Extracting `packages/agent/src/gbif-agent.ts` with `serverEntrypoint()`, `mcpConfig()` and
`createGbifAgent(route, tools)` collapses both call sites and makes the drift impossible. The eval
would then differ from the CLI only in the ways it means to (hooks, no readline).

### 3.2 `gbifFacetParam` is an identity function

`packages/mcp-server/src/gbif/occurrence.ts:38-40`

```ts
export function gbifFacetParam(dimension: Dimension): string {
  return dimension
}
```

The comment explains that the *response* direction needs a mapping — and it has one
(`dimensionForFacetField`). The request direction does not. Three call sites go through a function
that returns its argument. Either inline it, or if the intent is a seam for a future dimension whose
request name differs, say so in the comment; as written a reader has to open it to discover it does
nothing.

### 3.3 Three type escapes around the model value

`packages/agent/src/index.ts:95`, `evals/run-scenario.ts:78`, `evals/biodiversity.eval.ts:64`

```ts
model: createModel(route) as never,
```

`createModel` returns `LanguageModel | string`, and VoltAgent's `Agent` wants something narrower. The
`as never` is the bluntest possible cast and is repeated three times with no comment. If the union is
genuinely what VoltAgent accepts at runtime (it is — the gateway string is resolved by its router),
one small documented adapter is better than three unexplained casts:

```ts
/** VoltAgent's Agent types `model` more narrowly than its router accepts; the
 *  gateway form is a plain `provider/model` string it resolves itself. */
function asAgentModel(route: ModelRoute): never {
  return createModel(route) as never
}
```

Same for the `config as unknown as Parameters<typeof evaluate>[1]` at `biodiversity.eval.ts:170` —
that one *is* explained (lines 34-43), which is exactly the right treatment; the model casts deserve
the same.

### 3.4 Tool-call attribution in the eval hooks

`packages/agent/evals/run-scenario.ts:93-95`

```ts
const last = [...toolCalls].reverse().find((call) => call.name === tool.name)
if (last === undefined) return
const index = toolCalls.lastIndexOf(last)
```

Two passes plus a full array copy to find a last index — `toolCalls.findLastIndex((c) => c.name === tool.name)`
is one pass and reads better (ES2023, already the `target`).

More substantively: matching `onToolEnd` back to `onToolStart` *by tool name* mis-attributes when the
model issues two calls to the same tool in parallel — the first to finish stamps its `isError` onto
the most recent start. That directly feeds the "does not repeat a call that already failed" check in
`scoreChainCorrectness`. If the hook payload carries a call id, key on that instead.

---

## 4. Tooling, configuration and CI

### 4.1 Three compiler flags that already pass — turn them on

`tsconfig.json`

`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride` and `noFallthroughCasesInSwitch` are all
set. These three are not:

```jsonc
"exactOptionalPropertyTypes": true,
"noUnusedLocals": true,
"noUnusedParameters": true
```

**I verified both packages compile cleanly with all three enabled** (temporary tsconfig extending each
package's `tsconfig.test.json`, `src` + `tests` + `evals`; zero errors, both packages).

`exactOptionalPropertyTypes` in particular is free here because the code is *already written for it*
— `readonly signal?: AbortSignal | undefined` throughout, and the conditional-spread pattern in
`mcp-harness.ts:55-58` and `index.ts:102` is exactly what the flag demands. Right now nothing stops
the next contributor from writing `{ signal: undefined }` into an optional-but-not-`| undefined`
property. Turning it on locks in a discipline the codebase already keeps by hand.

### 4.2 `check-deps.mjs` shells out to `cat`

`scripts/check-deps.mjs:35`

```js
const lock = execFileSync('cat', [join(root, 'pnpm-lock.yaml')], { encoding: 'utf8' })
```

`readFileSync(path, 'utf8')` does the same thing without spawning a process, and works on Windows.
`node:fs` is not currently imported here; `node:child_process` then becomes unused and can go.

### 4.3 CI additions worth the lines

`.github/workflows/ci.yml`

The workflow is correctly scoped — the deliberate absence of `test:live` and `eval` is right and the
comment saying so is right. Three additions:

- **`concurrency`.** A force-push to a PR currently runs the full matrix twice.
  ```yaml
  concurrency:
    group: ${{ github.workflow }}-${{ github.ref }}
    cancel-in-progress: true
  ```
- **A scheduled `test:live` run.** The live suite exists to detect GBIF moving underneath the
  fixtures, but it only ever runs when someone remembers to type `pnpm test:live`. A weekly `schedule:`
  job (separate workflow, so it cannot gate PRs) turns that from a good intention into a signal. It
  needs no credentials, which is what makes it cheap.
- **Coverage.** `vitest.config.ts` declares no `coverage` block. Even without a threshold, a coverage
  summary in the job log would have surfaced §5.1–§5.4 immediately.

### 4.4 No dependency-update automation, despite deliberate pins

This one matters *more* than usual precisely because of the `ai@6` / `@ai-sdk/*@3` decision. That pin
is well-reasoned and well-defended (README, `check-deps.mjs`), but it also means the repo will drift
silently behind on everything *else* — `@modelcontextprotocol/sdk`, `pino`, `zod`, `vitest`, Biome —
with nothing prompting a look.

A Renovate or Dependabot config, grouped so the pinned packages are ignored or flagged separately, is
the right complement: the bot proposes, `check-deps.mjs` refuses the ones that matter, loudly and in
CI. That is the mechanism you already built; it just has no one feeding it.

### 4.5 `.gitignore` misses `.claude/settings.local.json`

The file exists locally and does not show in `git status` — but only because it is caught by the
*user's global* ignore (`~/.config/git/ignore`). A contributor without that line gets it as untracked
noise. `.claude/skills/**` is deliberately tracked, so the entry should be specific:

```gitignore
.claude/settings.local.json
```

---

## 5. Test coverage gaps

The suite is strong where it counts (protocol-level, real client, real registration path, fixtures
captured from the live API). These are the uncovered corners, roughly in order of how much they
would have caught:

### 5.1 `domain/filters.ts` has no direct unit test

`toGbifFilterParams`, `validatePaging`, `validateFilters` and `countrySchema` appear in no test file
by name. Some behaviour is covered transitively — a two-bound year range is pinned by fixture URL
matching in `search-occurrences.test.ts:75-76` — but these are not:

- **Open-ended ranges.** `yearFrom` alone produces `year=1000,<currentYear+1>`; `yearTo` alone
  produces `year=1000,<yearTo>`. This is the branch that bakes in `MIN_YEAR` and `maxYear()`, i.e.
  the one §1.3 is about, and nothing pins it.
- `from === to` collapsing to a bare `year=2020`.
- `countrySchema` lowercase/whitespace normalisation (`" ca "` → `CA`) and the `USA` rejection.
- `validatePaging` at the exact boundary (`offset + limit === MAX_OFFSET_WINDOW` passes, `+1` fails).

All four are pure functions. This is the cheapest coverage in the repo.

### 5.2 `gbif/cache.ts` has no direct unit test

`cacheKey` and `TtlCache` are exercised only through the harness. Untested: key normalisation
(`"Ursus maritimus"` / `"  ursus   maritimus "` / `"URSUS MARITIMUS"` collapsing to one entry; rank
and kingdom hints producing *different* entries — the Prunella case the doc comment cites), TTL
expiry, eviction-on-expired-read, and the `stats` counters that feed FR-030.

The injectable `now` exists specifically to make this trivial, and it is currently unused by any test.

### 5.3 `errors.ts` — the non-`ToolError` fallback

`toToolResult()`'s defensive branch (`errors.ts:106-114`) — the one that turns an unexpected internal
throw into a recoverable result instead of a leaked stack trace — is untested. A protocol test that
registers a handler which throws a plain `Error` and asserts the `isError: true` result would pin the
guarantee the file's comment makes.

### 5.4 `logging.ts` is untested

`logToolCall` and `notify` have no test. This is where §1.1 lives, and it is why a constant
`errorCode` went unnoticed. A protocol test that subscribes to `notifications/message` and asserts
the emitted record for one failing call would cover the FR-029/FR-030 contract end to end — and the
harness already gives you a connected client to do it with.

### 5.5 SIGINT during an in-flight generation

`teardown.test.ts:172-179` signals at the prompt and asserts only `orphans`. The interesting path —
signal while a model call is running — is untested, and is where §2.3 lives. It needs no real model:
a stub entrypoint, or a `GBIF_MCP_SERVER_PATH` pointed at a server that stalls, would do.

---

## 6. Documentation drift

Small, but this repo sets a high bar for its own prose, so they stand out:

| Where | Says | Actually |
|---|---|---|
| `packages/agent/evals/scenarios/index.ts:4` | "Ten scenarios" | 12 (`SCENARIOS` has 12 entries; `README.md:146` correctly says 12) |
| `README.md:27` | "pnpm 9+" | `packageManager` is `pnpm@11.5.1`, and `pnpm-workspace.yaml` uses `overrides`, `allowBuilds` and `minimumReleaseAgeExclude` — pnpm 10/11 features. pnpm 9 will not honour the Zod override that Constitution IV depends on. |
| `README.md:20` and `domain/trim.ts:1` | "95 fields to 8" | `TRIMMED_FIELDS` has 9 entries, and `trim.ts:23` calls them "the nine keys". Both are defensible (8 data fields + the occurrence key) — but pick one number and use it in all three places. |

Also worth a line: `search_occurrences`'s description enumerates *"species, date, country,
coordinates, basis of record, dataset and publisher"* and omits the GBIF occurrence `key`. That key is
the one field a caller needs to look a record up on gbif.org, so it is worth naming in the prompt
surface rather than leaving it to be discovered in the structured output.

---

## 7. Things that are right and should not be "improved"

Flagging these explicitly, because each looks like a candidate for simplification and each is
load-bearing:

- **`applyMatchPolicy`'s branch order** (`resolution.ts:126-163`). Match type before confidence. The
  comment says why; leave it.
- **`import './stdout-guard.js'` as the first line of `index.ts`.** Import order is the mechanism, not
  a style choice.
- **Lenient upstream schemas, strict contract schemas.** The asymmetry is deliberate and correct.
- **`next` as a required field on `ToolError`.** A type that cannot express "Invalid input" is the
  single best idea in this codebase.
- **`summarize_occurrences` having no `records` field anywhere in its output schema.** Structural, not
  conventional. Do not add a `includeRecords` flag.
- **The `no-network.ts` setup file.** An offline guarantee that does not depend on anyone remembering
  to inject a stub.
- **Two packages with no workspace dependency between them, enforced by a lint rule.** This is the
  thing that makes the protocol boundary real, and it costs a build step. Worth it.

---

## Appendix — verification notes

- `pnpm typecheck`, `pnpm lint`, `pnpm test` — all pass on the reviewed commit (165 tests / 16 files, 16.4s).
- §4.1 was checked by compiling each package's `tsconfig.test.json` (which covers `src`, `tests` and
  `evals`) with `exactOptionalPropertyTypes`, `noUnusedLocals` and `noUnusedParameters` added. Zero
  errors in both packages. The temporary config files were removed.
- §1.1 and §1.2 were read from source rather than reproduced at runtime; both follow directly from
  `ToolError`'s constructor and from the `code !== 'CANCELLED'` predicate respectively.
- `.env` is correctly ignored and has never been committed (`git log --all -- .env` is empty).
