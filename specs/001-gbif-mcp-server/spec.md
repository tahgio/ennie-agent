# Feature Specification: GBIF Biodiversity MCP Server and CLI Agent

**Feature Branch**: `main` (spec directory: `001-gbif-mcp-server`)

**Created**: 2026-08-29

**Status**: Draft

**Input**: User description: "Build a Model Context Protocol server that gives AI agents structured access to global biodiversity occurrence data, together with a CLI agent that demonstrates an agent consuming it."

## Context

Global biodiversity occurrence data is published through GBIF: billions of records, freely available and openly licensed. The data is shaped for data pipelines, not for language models. Queries require internal numeric taxon identifiers rather than names; each record carries roughly a hundred fields; and a single question such as "where has this species been recorded?" can match hundreds of thousands of rows.

An agent given raw access to that source fails in one of two ways: it cannot supply the numeric identifiers the source demands, or it succeeds and is buried under the response. This feature delivers the layer between the two. It resolves names to identifiers, trims records to the fields a model actually needs, and answers distribution questions by aggregating at the source instead of transporting records into the model's context window.

A command-line agent ships alongside the server to demonstrate — and prove — that the integration works over a real protocol boundary.

## Clarifications

### Session 2026-08-29

- Q: When someone gives a common name instead of a scientific name, how should `resolve_taxon` find the right taxon? → A: Two-stage — attempt the scientific-name match first, fall back to a common-name lookup only when that match fails or falls below the confidence threshold, and state in the result that resolution came through a common name.
- Q: Should the CLI agent answer one question and exit, or hold an ongoing back-and-forth conversation? → A: Interactive session — the agent keeps a conversation open across turns, may ask the person a clarifying question mid-answer and use their reply, and exits on an explicit quit command, end-of-input, or interrupt.
- Q: How confident must a name match be before `resolve_taxon` returns a taxon rather than a recoverable error? → A: Accept exact matches and fuzzy matches scoring 90 or above; reject no-match outright; treat a higher-rank match as its own recoverable error naming the genus or family reached and asking for a valid species name.
- Q: How should the opt-in eval suite decide whether the agent got a scenario right? → A: Both — a primary deterministic score asserted on the recorded sequence of server calls, plus a secondary answer-quality rating from a judge model, reported as separate numbers.
- Q: How long may a single tool call spend on the upstream API before giving up? → A: 10 seconds per upstream attempt and 30 seconds for the whole tool call including retries and backoff; if an upstream `Retry-After` exceeds the remaining budget, stop immediately and report how long upstream asked to wait.

### Session 2026-09-02

- Q: The 30-second per-call budget was tripping on broad, unfiltered queries — legitimately slow upstream responses, not a stuck request. → A: Raise the default to 60 seconds and make it operator-tunable via `GBIF_CALL_BUDGET_MS`, so a deployment that needs more headroom for broad queries can set it without a code change. The 10-second per-attempt timeout and the fail-fast rule on an oversized `Retry-After` (FR-026b) are unchanged.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Resolve a species name to an authoritative taxon (Priority: P1)

An agent has a species name from a user — scientific or common, possibly misspelled, possibly a synonym of the currently accepted name, possibly a name shared by unrelated organisms in different kingdoms. It needs the single authoritative taxon that name refers to, along with enough context to explain the resolution to the user.

**Why this priority**: Every other capability depends on having a resolved taxon. It is also the capability that absorbs the hardest domain problem — biological naming is ambiguous, and no caller should be asked to handle that ambiguity. Delivered alone, this is already useful: it turns a colloquial name into an authoritative classification.

**Independent Test**: Call the resolution capability with a correct scientific name, a common name, a known synonym, a misspelling, and a cross-kingdom homonym. Verify each returns either one accepted taxon with full classification and a stated confidence, or a recoverable error naming a concrete next step. No call fabricates a result, and no call crashes.

**Acceptance Scenarios**:

1. **Given** an exactly-matching scientific name, **When** resolution is requested, **Then** the response carries the accepted taxon identifier, canonical scientific name, rank, full classification from kingdom to species, and a high match confidence.
2. **Given** a name that is a recognised synonym of an accepted name, **When** resolution is requested, **Then** the response reports that the input was a synonym and names the accepted taxon it resolves to.
3. **Given** a misspelled name with no confident match, **When** resolution is requested, **Then** the response is a recoverable error stating that no confident match was found and naming what the caller should try instead (corrected spelling, a rank or kingdom hint, or the closest candidates found).
4. **Given** a name shared by taxa in more than one kingdom, **When** resolution is requested without a disambiguating hint, **Then** the response is a recoverable error listing the competing candidates with their kingdoms and instructing the caller to re-request with a kingdom or rank hint.
5. **Given** the same ambiguous name plus a kingdom hint, **When** resolution is requested, **Then** exactly one accepted taxon is returned.
6. **Given** a common name that no scientific-name match resolves, **When** resolution is requested, **Then** the common-name lookup runs, one accepted taxon is returned, and the response states that the match was reached through a common name.
7. **Given** a name that matches only as far as a genus or family, **When** resolution is requested, **Then** the broader taxon is not returned as the answer; a recoverable error names the rank and taxon reached and asks for a valid name at the intended rank.

---

### User Story 2 - Answer a distribution question without transporting records (Priority: P2)

An agent is asked "where has this species been recorded?", "when was it recorded?", or "how many records exist?". It needs counts, not records. The answer must arrive as a compact ranked breakdown that fits comfortably in a model's context window regardless of whether the underlying match count is twelve or twelve million.

**Why this priority**: This is the capability that makes the whole server worth building. Without it, distribution questions degrade into paginated record fetches that exhaust context and still under-sample the data. It is independently valuable and independently testable once resolution exists.

**Independent Test**: Ask for a country breakdown, a year breakdown, and a record-basis breakdown for a widespread species. Verify each returns a total count plus ranked per-dimension counts, that the response contains no individual occurrence records, and that response size is bounded and independent of the total match count.

**Acceptance Scenarios**:

1. **Given** a resolved taxon and a request to summarise by country, **When** the summary is requested, **Then** the response carries the total match count, a ranked list of country counts, and the resolved taxon the summary describes.
2. **Given** a request to summarise across several dimensions at once, **When** the summary is requested, **Then** each requested dimension returns its own ranked counts in a single response.
3. **Given** filters that match nothing, **When** the summary is requested, **Then** the response reports a total of zero and states plainly that no records matched the given filters, rather than erroring.
4. **Given** a species with millions of records, **When** the summary is requested, **Then** the response size stays within the same bound as for a species with a hundred records.

---

### User Story 3 - Retrieve a bounded page of individual records (Priority: P3)

An agent, or a user through an agent, wants to see actual occurrence records — where and when specific individuals were observed, and who published the data. It needs a readable page of records trimmed to the fields that matter, and it needs to know how much data it did not receive.

**Why this priority**: Necessary for questions that summaries cannot answer, but deliberately ranked below summarisation so that record listing is the exception rather than the default path.

**Independent Test**: Request records for a resolved taxon with and without filters. Verify the page never exceeds the declared cap, that every record carries only the trimmed field set, and that the total match count is always reported alongside the page.

**Acceptance Scenarios**:

1. **Given** a resolved taxon, **When** records are requested, **Then** the response carries a page of records — species, event date, country, coordinates, basis of record, dataset and publisher — plus the total number of records that matched.
2. **Given** a requested page size above the declared cap, **When** records are requested, **Then** the request is rejected with an error naming the cap, or is clamped to the cap with the clamping stated in the response.
3. **Given** a year range whose start is later than its end, **When** records are requested, **Then** the request is rejected before any data is fetched, with a message naming which bound is wrong.
4. **Given** an unrecognised country code, **When** records are requested, **Then** the request is rejected with a message naming the expected form (two-letter ISO 3166-1 alpha-2) and, where possible, the likely intended code.
5. **Given** records that lack coordinates, dates, or publisher attribution, **When** records are returned, **Then** those fields are reported as explicitly absent rather than omitted silently, empty-stringed, or defaulted.

---

### User Story 4 - Hold a biodiversity conversation from the command line (Priority: P4)

A person starts a command-line agent and asks a question in plain language. The agent connects to the server, chooses and chains the right capabilities, and answers in prose. The conversation stays open: the person can follow up, and the agent can ask them a clarifying question and use the reply. The person chooses which model runs the agent.

**Why this priority**: This is the proof that the server works for its primary user. It is ranked after the server capabilities because it consumes them, but it is a stated deliverable, not a demo afterthought.

**Independent Test**: Start a session and ask a distribution question; confirm it answers using a single summarising call. Ask an ambiguous name and confirm the agent asks which one is meant, then resolves correctly from the reply. Follow up with a question that depends on the previous turn and confirm the context carries. Start it with the model key absent and confirm it fails immediately naming the variable to set. Exit and confirm no server process survives.

**Acceptance Scenarios**:

1. **Given** a configured model, **When** the session starts, **Then** the agent prints the resolved model identity before accepting the first question, so any result is attributable.
2. **Given** an open session and a distribution question, **When** the agent answers, **Then** it uses one summarising call and does not page through individual records.
3. **Given** an open session, **When** the person asks a follow-up that refers back to an earlier turn, **Then** the agent answers using the established context without asking the person to restate it.
4. **Given** a name the server reports as ambiguous, **When** the agent receives that recoverable error, **Then** it asks the person which taxon is meant and resolves using their reply, rather than guessing or surfacing a raw error.
5. **Given** a missing or invalid model credential, **When** the agent starts, **Then** it exits immediately with a message naming the exact environment variable that must be set, and makes no attempt to contact the server or the model.
6. **Given** any exit path — an explicit quit command, end of input, an error, or an interrupt — **When** the agent stops, **Then** the server process it started is terminated and no orphaned process remains.
7. **Given** a question the data cannot answer, **When** the agent responds, **Then** it says so rather than fabricating a result, and the session stays open for the next question.

---

### User Story 5 - Explore and adopt the server as a third-party client (Priority: P5)

A developer clones the repository and points a standard protocol inspector, or a third-party client such as a desktop assistant, at the server. They discover what it can do from the server itself — its capability list, its guidance on how the capabilities compose, and a ready-made guided workflow — without reading the source.

**Why this priority**: Guidance that lives only in the bundled agent does not reach third-party clients. Making the server self-describing is what makes it reusable beyond this repository.

**Independent Test**: Connect a standard inspector to the server from a clean clone following only the documented quickstart. Verify that all three capabilities are listed with complete input and output schemas, that the server's own composition guidance is delivered at connection time, and that the guided report workflow appears as an invocable command.

**Acceptance Scenarios**:

1. **Given** a clean clone and the documented quickstart, **When** the developer follows it, **Then** the server starts and answers a real query with no account signup beyond a model provider key.
2. **Given** a connected client, **When** it lists capabilities, **Then** all three appear with complete input schemas, complete output schemas, and descriptions that state their constraints and caps.
3. **Given** a connected client, **When** the connection is established, **Then** the server states how its capabilities compose: resolve names first, prefer summarising over listing.
4. **Given** a connected client, **When** it lists available guided workflows, **Then** a species distribution report workflow is offered, taking a species name and returning a sequence that resolves the name, summarises by country and year, and fetches individual records only on request.

---

### Edge Cases

- **Cross-kingdom homonyms**: a name borne by unrelated taxa in different kingdoms resolves to a recoverable error listing the competing candidates and their kingdoms, never to a silently chosen winner.
- **Valid species, zero matches**: a legitimate taxon with no occurrences under the given filters returns an empty but successful result stating that the filters matched nothing, distinguishable from a failed lookup.
- **Incomplete records**: occurrences missing coordinates, event dates, or dataset/publisher attribution are returned with those fields explicitly marked absent; absence never becomes a fabricated or default value.
- **Upstream rate limiting with `Retry-After`**: the stated delay is honoured before retrying.
- **Upstream rate limiting without `Retry-After`**: an exponential backoff with jitter is used instead.
- **Retries exhausted**: after the retry budget is spent, the caller receives an informative error naming the upstream condition and suggesting a retry later or a narrower query — not a raw status code and not a crash.
- **Oversized retry delay**: an upstream `Retry-After` longer than the remaining call budget ends the call at once with an error naming the requested wait, rather than stalling the caller's turn.
- **Slow upstream response**: an attempt that exceeds the per-attempt timeout is abandoned and counted against the retry budget, and a call that exceeds its total budget returns a recoverable error naming the timeout rather than hanging.
- **Client cancellation mid-flight**: when a client cancels a request, in-flight upstream work is abandoned promptly, no result is emitted for the cancelled request, and no unhandled error is raised.
- **Pagination beyond the upstream window**: an offset past the maximum the upstream permits is rejected with a message naming the limit and directing the caller to narrow filters or summarise instead.
- **Empty or whitespace-only name**: rejected before any network call with a message stating what a valid name looks like.
- **Unknown upstream fields**: fields the server does not recognise are tolerated without failure; only fields the server depends on are enforced.
- **High-cardinality breakdowns**: a dimension with many distinct values (for example, years spanning centuries) is truncated to a ranked top-N with the truncation stated in the response.
- **Interrupt mid-answer**: an interrupt while the agent is waiting on the server or the model stops the turn, terminates the server process, and exits without leaving an orphan.
- **Non-interactive input**: when the agent's input is piped or closed rather than typed, it processes what it receives and exits cleanly at end of input rather than blocking on a prompt that will never be answered.
- **Clarifying question left unanswered**: if the person ends the session while the agent is awaiting a clarification, the session closes cleanly with no partial or fabricated answer emitted.

## Requirements *(mandatory)*

### Functional Requirements

#### Named interface surface

The following identifiers are part of the contract, not an implementation choice: they are what a
model sees and selects on, so they are fixed here rather than left to planning.

- **FR-000a**: The three capabilities MUST be named `resolve_taxon`, `search_occurrences`, and
  `summarize_occurrences`.
- **FR-000b**: The guided workflow MUST be named `species_distribution_report` and MUST take a
  species name as its argument.

#### Taxon resolution

- **FR-001**: The system MUST accept a scientific or common species name and return the accepted
  taxon it refers to. Resolution MUST attempt a scientific-name match first, and MUST fall back to
  a common-name lookup only when that match fails or falls below the confidence threshold. The
  fallback MUST NOT run when the scientific match already succeeded.
- **FR-002**: The system MUST accept optional rank and kingdom hints used solely to disambiguate an otherwise ambiguous name.
- **FR-003**: A successful resolution MUST report the accepted taxon identifier, canonical
  scientific name, rank, full classification, match confidence, whether the supplied name was a
  synonym, the accepted name it resolves to, and whether the match was reached through a common
  name rather than a scientific one.
- **FR-004**: The system MUST return a taxon only for an exact name match, or for a fuzzy match
  scoring at least 90 out of 100. A fuzzy match below 90, or no match at all, MUST return a
  recoverable error naming what the caller should try next. The accepted threshold MUST be stated
  in the capability's description so a caller knows the bar before calling.
- **FR-004a**: When the upstream match reaches only a higher rank than the one sought — a genus or
  family rather than the species — the system MUST NOT return that broader taxon as if it were the
  answer. It MUST return a recoverable error naming the rank and taxon actually reached and asking
  for a valid name at the intended rank.
- **FR-005**: When a name matches taxa in more than one kingdom and no hint was supplied, the system MUST return a recoverable error enumerating the competing candidates rather than selecting one.

#### Occurrence retrieval

- **FR-006**: The system MUST return individual occurrence records for a taxon identified either by taxon identifier or by name, resolving the name first when a name is supplied.
- **FR-007**: The system MUST support filtering by country, by year range, and by whether coordinates are present, and MUST support a pagination offset.
- **FR-008**: The system MUST enforce a hard maximum page size that is declared in the capability's schema and set well below the upstream maximum.
- **FR-009**: Each returned record MUST be trimmed to species, event date, country, coordinates, basis of record, dataset, and publisher. Additional upstream fields MUST NOT be passed through.
- **FR-010**: Every record page MUST report the total number of records that matched, so the caller knows the size of what it did not receive.
- **FR-011**: The system MUST reject a year range whose start exceeds its end, before any network call is made.
- **FR-012**: The system MUST reject a country code that is not a valid two-letter ISO 3166-1 alpha-2 code, naming the expected form in the error.

#### Distribution summarisation

- **FR-013**: The system MUST answer distribution questions by returning counts only, computed at the source, without transporting individual records.
- **FR-014**: The system MUST support summarising over country, year, and basis of record, singly or in combination in one request.
- **FR-015**: A summary MUST report the total match count, ranked counts for each requested dimension, and the resolved taxon the summary describes.
- **FR-016**: The summarisation capability MUST accept the same optional filters as record retrieval.
- **FR-017**: The summarisation capability's description MUST state that it is the preferred capability for "where", "when", and "how many" questions, so that a model reaches for it before paginating records.
- **FR-018**: Ranked counts MUST be truncated to a bounded top-N per dimension, with any truncation stated in the response.

#### Protocol behaviour and discoverability

- **FR-019**: Every capability MUST declare both an input schema and an output schema, with human-readable descriptions that state constraints and caps.
- **FR-020**: Every capability MUST return machine-readable structured output paired with a human-readable text rendering for clients that do not display structured output.
- **FR-021**: The server MUST declare, at connection time, how its capabilities compose: resolve names first, prefer summarising over listing.
- **FR-022**: The server MUST offer a species distribution report workflow, taking a species name and guiding the caller to resolve the name, summarise by country and year, and fetch individual records only if the user asks for them.
- **FR-023**: Recoverable failures MUST be returned as failed results carrying guidance the model can act on, not as faults that terminate the exchange. Faults MUST be reserved for genuine protocol errors.
- **FR-024**: Every error message MUST name both what went wrong and what the caller should do instead. A message that states only that input was invalid is a defect.
- **FR-025**: While the server communicates over a standard-stream transport, nothing other than protocol traffic MUST ever be written to standard output.

#### Resilience and observability

- **FR-026**: Transient upstream failures and rate limiting MUST be retried with backoff, honouring
  an upstream-supplied retry delay when present and using exponential backoff with jitter when
  absent.
- **FR-026a**: Every upstream attempt MUST be bounded by a 10-second timeout, and every tool call
  MUST be bounded by a total budget covering all attempts, backoff waits, and any chained
  resolution — 60 seconds by default, operator-configurable via `GBIF_CALL_BUDGET_MS`. Exceeding
  either bound MUST produce a recoverable error, never an indefinite wait.
- **FR-026b**: When an upstream-supplied retry delay exceeds the remaining budget for the call, the
  system MUST NOT wait it out. It MUST stop immediately and return a recoverable error stating how
  long upstream asked callers to wait, so the caller can decide whether to retry later.
- **FR-027**: When the retry budget is exhausted, the caller MUST receive an informative recoverable error describing the upstream condition and a suggested next step.
- **FR-028**: Client cancellation MUST abandon in-flight upstream work promptly and produce no result for the cancelled request.
- **FR-029**: Each capability invocation MUST emit a structured log entry recording the capability name, duration, retry count, and cache outcome, written to the diagnostic stream only.
- **FR-030**: Repeated resolution of the same name within a single run MUST be served from an in-process cache, and the log entry MUST record whether the cache was used.

#### Command-line agent

- **FR-031**: The agent MUST run an interactive session: it connects to the server over the
  standard-stream transport once at startup, then accepts natural-language questions turn by turn,
  chaining the appropriate capabilities and printing an answer for each.
- **FR-031a**: The agent MUST retain conversation context across turns within a session, so that a
  follow-up referring to an earlier turn is answered without the person restating it. Context MUST
  live only for the session and MUST NOT be written to disk.
- **FR-031b**: The agent MUST end the session on an explicit quit command, on end of input, or on an
  interrupt, and MUST state that it is exiting.
- **FR-032**: The model MUST be selected by whoever runs the agent through a single environment variable, restricted to Claude, GPT, and Gemini model families.
- **FR-033**: The agent MUST print the resolved model identity at startup so that any result is attributable to a specific model.
- **FR-034**: A missing or misconfigured credential MUST cause immediate failure with a message naming the exact environment variable to set.
- **FR-035**: The agent MUST terminate the server process it started on every exit path — quit
  command, end of input, error, or interrupt — leaving no orphaned process behind.
- **FR-036**: Agent-side instructions MUST cover only presentation and clarification behaviour.
  Semantics of the capabilities MUST come from the server, so that third-party clients receive the
  same guidance.
- **FR-036a**: When the server returns a recoverable error that names a choice the person can make
  — an ambiguous name, a homonym across kingdoms — the agent MUST put that choice to the person as a
  plain-language question and continue from their reply, rather than guessing or surfacing the raw
  error text.
- **FR-037**: The agent MUST communicate with the server only through the protocol. It MUST NOT reach into the server's internals directly.

#### Verification and documentation

- **FR-038**: The default verification command MUST pass with no network access, using recorded upstream responses.
- **FR-039**: Verification MUST include protocol-level exercises in which a real client drives a real server instance, not only direct invocation of internal functions.
- **FR-040**: Exercises that contact the live upstream source, and evaluations that call a model, MUST be reachable only through separate opt-in commands, documented as such, and MUST NOT run in continuous integration.
- **FR-041**: An opt-in evaluation suite MUST report two scores per run, kept separate and never
  merged into a single figure:
  - a **primary structural score** for capability selection and chain correctness, asserted on the
    recorded sequence of server calls — which capabilities were chosen, in what order, with what
    arguments — and reproducible for a fixed model;
  - a **secondary answer-quality score** produced by a judge model rating the final prose answer,
    reported as indicative rather than authoritative because it varies between runs.
- **FR-041a**: Every evaluation run MUST record the agent model identity, the judge model identity,
  and the run date, so a reported score is attributable and reproducible.
- **FR-041b**: Because the agent is interactive, the suite MUST drive sessions programmatically
  with scripted replies, so that scenarios requiring a clarifying exchange are scored without a
  human present.
- **FR-041c**: A failure of the judge model MUST NOT fail the run. The structural score MUST still
  be reported, with the answer-quality score marked unavailable.
- **FR-042**: Project documentation MUST let a reviewer understand what was built, why each significant decision was made and at what trade-off, what was deliberately excluded and why, and how model assistance was used and validated.

### Key Entities

- **Taxon**: An accepted biological entity. Carries an identifier, a canonical scientific name, a
  rank, a full classification chain from kingdom downward, the confidence with which an input name
  matched it, whether the input was a synonym pointing at it, and whether it was reached through a
  common name rather than a scientific one.
- **Occurrence record**: A single recorded observation or specimen. Carries the species, the event date, the country, the coordinates, the basis on which it was recorded, and the dataset and publisher that provided it. Any of date, coordinates, and attribution may be explicitly absent.
- **Occurrence page**: A bounded set of occurrence records together with the total number of records that matched the query, and the offset the page starts at.
- **Distribution summary**: A total match count plus one ranked count list per requested dimension, together with the taxon the summary describes. Contains no individual records.
- **Filter set**: The shared, optional narrowing applied to both retrieval and summarisation — country, year range, and coordinate presence.
- **Recoverable error**: A failed result carrying a statement of what went wrong and a concrete next step the caller can take on its next turn.
- **Model configuration**: The single environment-provided model selection, its resolved identity, and the credential required to use it.
- **Conversation session**: One run of the agent. Holds the turns exchanged so far, the resolved
  model identity, and the single server connection opened at startup. Lives in memory only and
  ends with the process.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Starting from a clean clone with no account signup beyond one model provider key, a developer following only the documented quickstart gets a real biodiversity question answered in under 10 minutes.
- **SC-002**: A distribution question is answered with exactly one summarising request and zero individual records transported.
- **SC-003**: Response size is bounded and independent of the size of the underlying match: a summary for a taxon with millions of records is no larger than one for a taxon with a hundred.
- **SC-004**: No record page exceeds the declared cap, and every record carries only the seven specified fields.
- **SC-005**: 100% of unmatched, misspelled, and ambiguous names produce a recoverable error naming a concrete next step. 0% produce a fabricated taxon, a silently chosen candidate, or a crash.
- **SC-006**: All three capabilities are discoverable with complete input schemas, complete output schemas, and descriptions stating their constraints.
- **SC-007**: The default verification command passes with network access disabled, on every run.
- **SC-008**: At least one protocol-level exercise per capability drives a real client against a real server instance.
- **SC-009**: Across the entire verification suite, zero non-protocol bytes are written to standard output.
- **SC-010**: Simulated rate limiting and transient upstream failure are recovered without caller-visible failure within the retry budget; exhausted budgets surface an error naming the condition and a next step in 100% of cases.
- **SC-011**: The evaluation suite reports, over at least eight scenarios, a reproducible structural
  score for capability selection and chain correctness plus a separately reported answer-quality
  rating, with the agent model identity, judge model identity, and run date recorded in the output.
  Re-running the suite against the same models leaves the structural score unchanged.
- **SC-012**: No tool call exceeds its configured budget (60 seconds by default) end to end under
  any simulated upstream condition — slow responses, repeated rate limiting, or an oversized retry
  delay. Every such case returns a recoverable error naming the condition.
- **SC-013**: A reviewer reading the documentation alone can state what was built, the reasoning and trade-off behind each significant decision, what was deliberately excluded and why, and how model assistance was used and validated.

## Out of Scope

- Web or graphical user interface of any kind.
- Authentication, user accounts, and any persistence beyond in-process caching for the lifetime of a run.
- Any transport other than the standard-stream transport in this iteration. The server core is to be arranged so that adding another transport is a new entrypoint rather than a restructuring.
- Bulk export or large-volume retrieval. That is the upstream asynchronous download service's role, and the caps on these capabilities reflect that deliberately.
- Capabilities beyond the three specified. Adding a fourth is a governed amendment, not an incremental change.
- Occurrence data sources other than GBIF.

## Assumptions

These are reasonable defaults chosen where the description did not specify a detail. Each is a decision a reviewer may overturn.

- **Page size cap**: individual-record pages are capped at 50 records with a default of 20 — well below the upstream per-page maximum, consistent with the intent that record listing is the exception rather than the default path.
- **Ranked-count truncation**: each summary dimension returns at most the top 20 values, with truncation stated in the response.
- **Homonym handling**: because the description requires that the system never guesses silently, a cross-kingdom ambiguity is treated as a recoverable error listing candidates, not as a best-match result with alternatives attached.
- **Caching**: the description requires cache outcome in the logs but does not scope a cache. The assumption is an in-process, time-bounded cache of name-to-taxon resolutions only, discarded when the process exits. Occurrence and summary responses are not cached. This keeps the "no persistence" exclusion intact.
- **Session scope**: conversation context is held in memory for the life of one session only. There
  is no transcript file, no resumable session, and no history across runs — consistent with the
  no-persistence exclusion.
- **Model selection**: a single environment variable names the model, and the provider is inferred from the model identity across the three supported families. The corresponding provider credential is read from that provider's conventional environment variable, which is named explicitly in the failure message when absent.
- **Retry budget**: at most three retries for rate limiting and transient upstream failure, bounded
  in wall-clock terms by the 10-second per-attempt timeout and the per-call budget (60 seconds by
  default, `GBIF_CALL_BUDGET_MS`-tunable), so a failing request surfaces quickly rather than
  stalling a conversational turn.
- **Evaluation scenarios**: "a small set of scenarios" is taken to mean at least eight, covering
  resolution, summarisation, record retrieval, and the recoverable-error paths. Each scenario
  costs two model calls — one to run the agent, one to judge its answer — which is why the suite
  stays opt-in and out of continuous integration.
- **Upstream availability**: GBIF's public API is reachable without registration or an API key, and its published rate limits are respected rather than circumvented.
- **Deployment**: the server is run locally by a developer or launched as a child process by a client. There is no hosted deployment in this iteration.
