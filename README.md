# ennie-agent

[![CI](https://github.com/tahgio/ennie-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/tahgio/ennie-agent/actions/workflows/ci.yml)

An [MCP](https://modelcontextprotocol.io) server over [GBIF](https://www.gbif.org), the global
biodiversity occurrence index, plus a small command-line agent that consumes it.

GBIF holds well over two billion species occurrence records. The obvious way to put that behind a
language model — expose a search endpoint and let the model page — does not work: it burns the
context window on records nobody reads, and it answers "where has the polar bear been recorded?"
with a thousand rows instead of a ranking. This server is built the other way round. It asks GBIF to
do the aggregating, and returns counts.

Three tools:

| Tool | What it does |
|------|--------------|
| `resolve_taxon` | A scientific or common name in; one accepted GBIF taxon out, or an error saying what to try next. Synonyms, misspellings, and names shared across kingdoms are absorbed here so the other tools never have to guess. |
| `summarize_occurrences` | Distribution answers — by country, year, and basis of record — from GBIF's own faceting. One upstream request, no individual records, and the same response size whether the species has a hundred occurrences or ten million. |
| `search_occurrences` | A bounded page of individual records (at most 50), trimmed from GBIF's 95 fields to nine, always with the total so the size of what you did not receive is visible. |

And one prompt, `species_distribution_report`, which sequences them.

## Requirements

- Node 24+ (`node --version` → v24.x)
- pnpm 11+
- **No GBIF account.** Every endpoint used is anonymous.
- One model API key — Anthropic, OpenAI, or Google — but only to run the bundled agent. The server
  itself needs no credentials at all.

## Quickstart

```bash
pnpm install
pnpm build
pnpm test        # offline; no network required
```

### Try it in the MCP Inspector

```bash
npx @modelcontextprotocol/inspector node packages/mcp-server/dist/index.js
```

Then call `resolve_taxon` with `{"name": "Ursus maritimus"}` → taxon key **2433451**. Pass that key
to `summarize_occurrences` with `{"dimensions": ["country"]}` → a country ranking led by Canada,
then the United States, then Greenland.

### Talk to it

```bash
cp .env.example .env       # set MODEL and one matching provider key
pnpm agent
```

```
Model: anthropic:claude-opus-5 (direct)

> Where has the polar bear been recorded?
```

`MODEL` takes two forms: `provider:model` goes direct through that provider's SDK
(`anthropic`, `openai`, `google`), and `provider/model` goes through the
[Vercel AI Gateway](https://vercel.com/docs/ai-gateway) using `AI_GATEWAY_API_KEY`. The agent checks
the credential before it spawns anything, so a missing key costs you a one-line message rather than
a stack trace.

## Use it from another MCP client

Nothing about the server is specific to the bundled agent — the guidance a model needs travels in
the server's `instructions` and tool descriptions, so any client gets the same behaviour. Build it,
then add:

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

Claude Code takes the same thing on the command line:

```bash
claude mcp add gbif -- node /absolute/path/to/packages/mcp-server/dist/index.js
```

The one optional setting is `GBIF_USER_AGENT_CONTACT` — an email address appended to the
`User-Agent` this server sends. GBIF asks for a way to reach high-volume callers, and being
reachable is how you get contacted rather than blocked.

## Layout

```
packages/
  mcp-server/     the MCP server: GBIF client, domain policy, three tools, one prompt
  agent/          the CLI agent, which depends on the server only over stdio
specs/            the specification, plan, research, and contracts this was built from
```

`packages/agent` has no workspace dependency on `packages/mcp-server`, and a lint rule fails the
build if one appears. It launches the built server by path, exactly as a third-party client would —
which is the only way the protocol boundary stays real rather than decorative.

## Testing

```bash
pnpm test        # unit + protocol. Offline, deterministic, and what CI runs.
pnpm typecheck
pnpm lint
```

The default suite never opens a socket. Every GBIF response it uses was captured from the real API
by `pnpm capture-fixtures` and is replayed from `packages/mcp-server/tests/fixtures/`, and a setup
hook fails the run if anything tries to reach the network anyway. To prove that rather than trust
it:

```bash
unshare -rn pnpm test     # Linux: no route to any host
```

The protocol tests are not unit tests wearing a costume. They stand up the SDK's own `Client`
against the server `createServer()` actually ships, joined by an in-memory transport, so input
validation, output-schema validation and the `isError` conversion are all the real code path. The
stdout-purity test goes further and spawns the built server as a child process over real stdio, then
parses every byte that came back on fd 1.

### Opt-in suites

Neither of these runs in CI, and neither is part of `pnpm test`. Both cost something real.

```bash
pnpm test:live    # hits api.gbif.org — no key needed, but it is someone else's server
pnpm eval         # calls your model provider — this one costs money
```

`pnpm test:live` re-requests the paths the fixtures were captured from and checks that the upstream
findings the design rests on still hold. It asserts shapes, never counts: a suite that failed
whenever GBIF ingested new records would be muted within a month. A failure there means GBIF moved,
not that this repository broke.

`pnpm eval` runs 12 scenarios through a real model and reports two numbers: a **structural score**,
computed by plain functions over the recorded tool-call sequence — did it pick the summary tool for
a distribution question, did it resolve before it queried, did it ask instead of guessing on a
homonym — and, separately, a **judge-model rating** of the answer text. The structural score is
reproducible for a fixed model; the judge is not, which is exactly why they are reported apart. A
judge failure does not fail the run. Set `JUDGE_MODEL` to enable the rating; without it the
structural score still reports.

## Decisions

Context / Decision / Trade-off. The full record is in
[research.md](specs/001-gbif-mcp-server/research.md); these are the ones that changed the shape of
the code.

### Summaries are a separate tool, not a mode

**Context.** A distribution question — where, when, how many — has a bounded answer, but the obvious
implementation reaches it by paging through unbounded data.

**Decision.** `summarize_occurrences` asks GBIF for facet counts at `limit=0` and returns a total
plus ranked counts. Its output schema has **no `records` field at all**.

**Trade-off.** Two tools where one flag would do, and a model that has to choose correctly between
them. Bought: "transports no records" is structural rather than conventional. A future contributor
cannot accidentally add records to a summary — the schema rejects them — and the response size is
the same for a species with 11,000 records as for one with 25 million.

### The four GBIF findings that changed the design

Each of these was verified against the live API before any code was written, and each one breaks the
implementation a reasonable person would write first.

**A total non-match arrives as `confidence: 100`.** `Zzzzqqq xxxxyy` returns
`matchType: NONE` at full confidence. The obvious policy — accept anything above a confidence
threshold — therefore fabricates a taxon for a name that does not exist. *Decision*: gate on
`matchType` **before** confidence is consulted at all. *Trade-off*: the ordering in
`domain/resolution.ts` looks arbitrary until you know why, so it is commented at the point where
someone would otherwise "simplify" it.

**Homonyms hide in `alternatives[]`, and only with `verbose=true`.** *Prunella* is both a bird and a
mint. GBIF reports it as `NONE` — indistinguishable from a name that does not exist — and the
competing taxa appear nowhere in the API unless `verbose=true` is set. *Decision*: `species/match`
is called with `verbose=true` **always**, and a cross-kingdom homonym becomes an `AMBIGUOUS` error
listing both candidates with their kingdoms. *Trade-off*: a slightly larger upstream response on
every resolution, in exchange for FR-005 being implementable at all.

**Common names do not resolve, and the fallback cannot be trusted to rank.** `species/match` returns
nothing for "polar bear". The vernacular search does return something — but it ranks a *sponge*
first, and the *Ursus* entry it does find is a synonym. *Decision*: a vernacular fallback that
discards backbone-less entries, verifies the vernacular names against the query rather than trusting
rank order, and re-resolves the survivor through its accepted taxon. *Trade-off*: two upstream
requests for a common name instead of one, and noticeably more code than "take the top hit" — which
is the version that returns a sponge.

**Synonyms carry a different key than the one you queried.** *Felis concolor* resolves with
`usageKey: 2435104` and `acceptedUsageKey: 2435099`. Both are valid keys. Only the second has the
records. *Decision*: `taxonKey` in every response is the **accepted** key, and `wasSynonym` says so.
*Trade-off*: the returned key is not always the one that matched the input, which is surprising
until stated — so it is stated, in the response and in the tool description. The alternative is a
silent under-count that looks like a correct answer.

Two more findings shaped the guardrails rather than the policy: GBIF accepts `limit=500` and
silently returns 300 with HTTP 200 (so the 50-record cap is enforced locally, never delegated), and
a 400 comes back as **plain text**, not JSON (so error bodies are read as text first and parsed only
opportunistically).

### `ai@6` and `@ai-sdk/*@3`, pinned against the `latest` tags

**Context.** `@voltagent/core@2.10.0` peer-requires `ai@^6.0.0` and depends on the provider packages
at `^3.0.0`. At the time of writing, `npm latest` resolves `ai` to **7.x** and the providers to
**v4**.

**Decision.** Pin `ai@^6.0.0` and the three providers at `^3.0.0`, and assert the resolved `ai`
major in CI via `scripts/check-deps.mjs`.

**Trade-off.** Deliberately behind `latest`, and a version bump is now a decision rather than a
reflex. Bought: a routine `pnpm add ai` cannot silently install a combination VoltAgent does not
support — the failure it prevents is a runtime type error deep in a provider call, which is
expensive to trace back to an install that appeared to succeed.

### One Zod version across the workspace

**Context.** The MCP SDK and VoltAgent both take Zod. Two majors resolving side by side means Zod
instances stop recognising each other's schemas across that boundary.

**Decision.** A `pnpm.overrides` pin, plus a lockfile assertion in `scripts/check-deps.mjs`.

**Trade-off.** The workspace cannot adopt a new Zod major piecemeal. That is the point.

### The agent talks to the server only over MCP

**Context.** Both packages live in one repository, so importing the server's functions directly
would be easy, faster, and completely misleading about whether the protocol surface works.

**Decision.** `packages/agent` has no workspace dependency on `packages/mcp-server`. It launches the
built server by path as a child process, exactly as a third-party client would. A lint rule fails
the build if an import appears.

**Trade-off.** The agent needs `pnpm build` before it can run, and a stack trace crosses a process
boundary. Bought: the boundary is real. Every guarantee the agent demonstrates is one an unrelated
client gets too — which is why the guidance lives in the server's `instructions` and tool
descriptions rather than in the agent's prompt.

### Remembered resolutions are evicted in insertion order, not by least-recent use

**Context.** The resolution store had no ceiling and no sweep, so it grew for as long as distinct
names kept arriving — and the caller this server is built for is a language model generating name
variants, each one a new key. A ceiling needs an eviction rule.

**Decision.** Evict the entry recorded longest ago, which is simply the first key a `Map` yields.
Not least-recently-*used*: reading an entry does not protect it.

**Trade-off.** A name that is read often but recorded long ago can be evicted while a
recently-recorded name nobody asks about survives. Bought: reads stay reads. True LRU would re-link
on every `get`, turning every lookup into a write, for entries that expire on a one-hour clock in
any case. The cost of being wrong is bounded and small — an evicted key is an ordinary miss, so it
resolves upstream and returns the correct answer. Eviction can cost one extra upstream lookup; it
can never produce a wrong answer.

### Contradictory taxon inputs are refused, not reconciled

**Context.** Both occurrence tools accept either a `taxonKey` or a `name`. A caller can supply both,
and they can disagree. The key used to win, the name was discarded, and nothing said so — not the
text, not the structured result, not the diagnostic record. A model holding a polar bear key while
naming a cougar got polar bear counts labelled with nothing.

**Decision.** Refuse the call with `CONTRADICTORY_TAXON`, before any upstream request, naming both
supplied values and both remedies. The refusal applies whether or not the two agree.

**Trade-off.** This is the one deliberate break in an otherwise behaviour-preserving change: a call
that used to succeed now fails, so a client relying on key-precedence must drop one argument. It is
also the reason the refusal cannot check agreement first — verifying that the key and the name match
means resolving the name, which is exactly the lookup the key exists to avoid. Bought: consistency.
Every other ambiguity here — a homonym, a weak fuzzy match, a name reaching only a genus — is
returned to the caller as a recoverable question, and this was the last place the server guessed.

### Coverage is reported, never enforced

**Context.** The deterministic suite had no coverage measurement at all, so nobody could see which
behaviours were untested — which is how ten of them stayed that way until a review found them.

**Decision.** CI produces a coverage report on every run and uploads it as a retained artefact.
There is no threshold, in `vitest.config.ts` or in the workflow, and adding one would change what
the project promises.

**Trade-off.** Nothing stops coverage drifting down; it takes a person looking. Bought: no unrelated
change acquires a new way to fail. A threshold turns a number that should inform judgement into a
gate that blocks correct work for being correct in an uncovered file, and the usual response is to
write a test that moves the number rather than one that checks a behaviour.

### Server dependencies: three, and no transport in the core

`createServer()` knows nothing about transports; `index.ts` is the stdio entrypoint and does nothing
else. Adding HTTP later is a new file, not a refactor. The server ships three production
dependencies — `@modelcontextprotocol/sdk`, `zod`, `pino` — verified with
`pnpm --filter mcp-server list --prod --depth 0`.

The agent's tree is a different story, and it is the one item this project tracks rather than
waives. `@voltagent/core` pulls **20** `@ai-sdk/*` provider packages, of which this feature uses
three. That breadth is bundled, not opt-in. It was accepted because VoltAgent supplies the MCP
client integration and tool-calling loop that the agent package exists to demonstrate, and because
the cost is confined to a dev surface: **an MCP client installing the server gets none of it.** The
mitigation is the package boundary itself.

## Deliberately not built

Recording what was excluded carries as much weight as recording what was built. Each of these was a
choice, not an oversight.

- **No web or graphical interface.** The client is whatever MCP client the user already has; a UI
  would be a second product with its own surface to keep correct.
- **No authentication, accounts, or persistence.** The one piece of state is an in-process
  resolution cache with a one-hour TTL, discarded when the process exits. Conversation context lives
  in memory for one session — no transcript file, no resumable session, no history across runs.
  Nothing to secure, nothing to migrate, nothing to leak.
- **No transport other than stdio in this iteration.** The core is arranged so adding one is
  additive (see above), which is what makes this exclusion honest rather than aspirational.
- **No bulk export or large-volume retrieval.** That is GBIF's asynchronous download service's job,
  and it is better at it. The 50-record cap reflects that boundary deliberately rather than
  conceding it reluctantly.
- **No fourth tool.** Three capabilities, each with a distinct reason to exist. Adding one is a
  governed amendment, not an incremental change — every additional tool is another choice a model
  has to get right, and the cost lands on every conversation, not just the ones that use it.
- **No occurrence source other than GBIF.** A second source would mean reconciling two taxonomies,
  which is a larger problem than the one this solves.
- **No per-record licence field.** Records carry a `license` URL, and the trimmed record surfaces
  dataset and publisher, which satisfies attribution. Adding the field later is additive and breaks
  no schema. This is the one Compliance item left outstanding, and it is left outstanding knowingly.

## On the use of LLM assistance

This project was built with Claude, working from a written specification rather than from prompts
alone: `specs/001-gbif-mcp-server/` holds the spec, the plan, the verified research, the data model,
the tool contracts, and the task list, and the code was implemented against those artefacts in
dependency order. They are committed because they are the actual record of what was decided and why
— the README's decision section is a summary of them, not a substitute.

Three things were done to keep the assistance honest, because the failure mode of LLM-written code
is confident-looking work resting on plausible but wrong assumptions:

**Every upstream assumption was verified against the live API before it was coded.** The ten
findings in `research.md` are recorded with the actual responses that produced them, and the
responses themselves are committed as fixtures. Four of them contradicted what a reasonable person —
and a model — would assume: a non-match at `confidence: 100`, homonyms hidden behind `verbose=true`,
a vernacular search that ranks a sponge above a polar bear, and synonyms carrying a different key
than the one that matched. Each of those is a bug that would have shipped, looked correct in review,
and returned a wrong answer in production.

**The tests exercise the protocol, not the functions.** A model is good at writing a test that
passes. The protocol suite makes that harder by testing through the real MCP client against the real
server, where a missing `outputSchema` or `structuredContent` that fails its own declared schema is
caught — the failures that are invisible to a unit test calling the handler directly. The
stdout-purity test spawns the built binary and parses fd 1.

**The claims in this README were checked, not asserted.** Quickstart Scenario 2 was run end to end
against live GBIF with a stripped environment to confirm no credential is consulted; the dependency
counts above come from `pnpm list`, not from memory; the live suite confirms the committed fixtures
still match reality. Three bugs were found this way and fixed rather than documented around. Two
were in the tooling: the root `eval` script filtered a package name that did not exist, and it
pointed at a path where `viteval` was not installed. The third was in the product, and it is the
instructive one — the session loop dropped every question after the first when stdin was piped,
because it treated readline's `close` event as "no more input" when in fact the whole transcript was
already buffered. Every test passed. It surfaced only by running the documented scenario by hand and
noticing that the answer to the follow-up question never appeared.

What remains a judgement call is the prose — the tool descriptions and the server `instructions` —
which is prompt surface and is reviewed as carefully as code, because it is what a model reads when
deciding which tool to reach for. The eval suite is the check on that: the structural scorers
measure whether a model actually chooses the summary tool for a distribution question, which is the
only real test of whether the description says what it means to say.

## License

MIT — see [LICENSE](LICENSE).
