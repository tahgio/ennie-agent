# Quickstart & Validation Guide

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Contracts**: [contracts/](./contracts/)

How to bring this up from a clean clone and prove it works. Each scenario names the requirement it
validates, so this doubles as the acceptance walk-through. It is a run guide — implementation
belongs in `tasks.md`.

## Prerequisites

- Node 24 LTS (`node --version` → v24.x)
- pnpm 9+
- One model API key — Anthropic, OpenAI, or Google. **No GBIF account is needed**; every endpoint
  used is anonymous (SC-001).

## Setup

```bash
pnpm install
pnpm build
cp .env.example .env      # then set MODEL and one provider key
```

## Scenario 1 — Offline test suite (FR-038, SC-007, SC-009)

The gate that must pass before anything else.

```bash
pnpm test
```

**Expected**: all suites pass **with no network access**. To prove it rather than assume it, run it
airgapped:

```bash
unshare -rn pnpm test     # Linux; no route to any host
```

A pass here also covers SC-009: the protocol suite asserts stdout carried only JSON-RPC frames.

## Scenario 2 — Inspector, three tools, real answer (SC-001, SC-006, FR-019)

```bash
npx @modelcontextprotocol/inspector node packages/mcp-server/dist/index.js
```

**Expected**:

1. The server connects, and the Inspector shows the `instructions` text
   ([contract](./contracts/server-instructions.md)) — this is what every client receives (FR-021).
2. `tools/list` shows exactly three tools, each with a complete input **and** output schema and a
   description stating its caps (FR-019, SC-006).
3. `prompts/list` shows `species_distribution_report` taking a `species` argument (FR-022).
4. Call `resolve_taxon` with `{"name": "Ursus maritimus"}` → taxonKey **2433451**, `matchType`
   `EXACT`, confidence ~98, full classification.
5. Call `summarize_occurrences` with `{"taxonKey": 2433451, "dimensions": ["country"]}` → a total
   in the low tens of thousands and a country ranking led by **CA**, then **US**, then **GL**.

Counts drift as GBIF ingests data; the ranking order is the stable part.

## Scenario 3 — Context economy (SC-002, SC-003, SC-004, FR-013)

The point of the whole server.

| Check | Expectation |
|-------|-------------|
| Summary response contains records | **Zero.** The output schema has no `records` field. |
| One distribution question | **One** upstream request (`limit=0` + facets), never paged fetches. |
| Summary size, common vs. rare species | Same bound. Compare *Ursus maritimus* against a species with millions of records. |
| `search_occurrences` with `limit: 51` | Rejected naming the cap of 50 — **not** clamped silently. |
| A returned record | 8 data fields, not GBIF's 95. |

The `limit: 51` check matters: GBIF itself accepts `limit=500` and silently returns 300 with HTTP
200 (research F7), so the cap only exists if we enforce it.

## Scenario 4 — Recoverable errors (SC-005, FR-004, FR-004a, FR-005, FR-024)

Every row must return `isError: true` with actionable text — never a crash, never a fabricated
taxon.

| Input | Expected |
|-------|----------|
| `{"name": "Zzzzqqq xxxxyy"}` | Not found; suggests checking spelling. **Watch for**: GBIF reports this as `confidence: 100` (F1) — a confidence-first check would wrongly accept it. |
| `{"name": "Prunella"}` | Ambiguous; **lists both candidates** — Plantae key 2926553 and Animalia key 2495070 — and asks for a kingdom hint. |
| `{"name": "Prunella", "kingdom": "Plantae"}` | Resolves cleanly to key 2926553. |
| `{"name": "Puma notarealspecies"}` | Higher-rank error naming genus Puma (key 2435098); does **not** return the genus as the answer. |
| `{"name": "polar bear"}` | Resolves to *Ursus maritimus* via the vernacular path, `matchType: VERNACULAR`. **Watch for**: unfiltered, GBIF ranks a sponge first (F4). |
| `{"name": "Felis concolor"}` | `wasSynonym: true`, accepted key **2435099** (*Puma concolor*) — not the synonym's own key 2435104. |
| `country: "USA"` | Rejected naming ISO 3166-1 alpha-2 and suggesting `US`. |
| `yearFrom: 2010, yearTo: 2000` | Rejected before any network call, naming which bound is wrong. |
| `offset: 100001` | Rejected naming GBIF's 100,000-record window. |
| A valid species with filters matching nothing | **Success**, `totalCount: 0` — not an error. |

## Scenario 5 — Interactive agent (FR-031–FR-036a, SC-001)

```bash
MODEL=anthropic:claude-opus-5 pnpm --filter agent start
```

**Expected**:

1. Resolved model identity printed before the first prompt (FR-033).
2. Ask *"Where has the polar bear been recorded?"* → answered from **one** `summarize_occurrences`
   call. Paging through records is a failure (SC-002).
3. Ask a follow-up — *"What about just in Canada?"* — without repeating the species. Context
   carries (FR-031a).
4. Ask about *"Prunella"* → the agent asks **you** which kingdom, then continues from your reply
   (FR-036a). It must not surface the raw error or pick one.
5. `/exit`, then confirm no orphan: `pgrep -f mcp-server` returns nothing (FR-035). Repeat with
   Ctrl-C mid-answer — same result.

**Failure modes to check deliberately**:

```bash
unset ANTHROPIC_API_KEY; MODEL=anthropic:claude-opus-5 pnpm --filter agent start
# exit 2, message naming ANTHROPIC_API_KEY, no server spawned (FR-034)

MODEL=nonsense pnpm --filter agent start
# exit 2, names MODEL and shows both accepted forms
```

## Scenario 6 — Resilience (FR-026a, FR-026b, SC-010, SC-012)

Driven by fixtures in the offline suite, so it is reproducible:

| Simulated | Expected |
|-----------|----------|
| 429 with `Retry-After: 2` | Waits ~2s, retries, succeeds. |
| 429 with no `Retry-After` | Exponential backoff with jitter. |
| 429 with `Retry-After: 600` | **Fails immediately** naming the 600s wait — does not stall the turn (FR-026b). |
| 503 × 4 | Retries 3×, then a recoverable error naming the status. |
| Attempt exceeding 10s | Abandoned, counted against the retry budget. |
| Whole call exceeding 30s | Recoverable error naming the timeout. **No call exceeds 30s** (SC-012). |
| 400 with a plain-text body | Parsed as text, not JSON (F8); surfaced as a recoverable error. |
| Client cancels mid-flight | Upstream request aborted, no result emitted, no unhandled rejection (FR-028). |

## Scenario 7 — Opt-in suites (FR-040, FR-041, SC-011)

Never run in CI.

```bash
pnpm test:live      # hits GBIF; confirms fixtures still match reality
pnpm eval           # calls models; costs money
```

The eval run reports a **structural score** (capability selection and chain correctness from the
recorded call sequence — reproducible for a fixed model) and, separately, a **judge-model answer
rating**. Both are stamped with agent model, judge model, and date (FR-041a). A judge failure must
not fail the run; the structural score still reports (FR-041c).

Re-run `pnpm eval` against the same models: the structural score must be identical (SC-011).

## Scenario 8 — Third-party client (SC-006, Constitution VII)

Add to an MCP client's config — the snippet the README carries:

```json
{
  "mcpServers": {
    "gbif": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp-server/dist/index.js"]
    }
  }
}
```

**Expected**: the client shows the same three tools, the same instructions, and
`species_distribution_report` as an invocable command. Nothing about the guidance is specific to the
bundled agent — which is the point of putting it in the server (FR-021, FR-036).

## Acceptance summary

| Scenario | Validates |
|----------|-----------|
| 1 | SC-007, SC-009, FR-038, FR-039 |
| 2 | SC-001, SC-006, FR-019, FR-021, FR-022 |
| 3 | SC-002, SC-003, SC-004, FR-008, FR-009, FR-013 |
| 4 | SC-005, FR-004, FR-004a, FR-005, FR-011, FR-012, FR-024 |
| 5 | SC-001, FR-031–FR-036a |
| 6 | SC-010, SC-012, FR-026a, FR-026b, FR-027, FR-028 |
| 7 | SC-011, FR-040, FR-041 |
| 8 | SC-006, FR-021, FR-037 |
