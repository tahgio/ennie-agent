# Feature Specification: Post-Review Hardening

**Feature Branch**: `main` (spec directory: `002-code-review-hardening`)

**Created**: 2026-09-02

**Status**: Clarified — planned

**Input**: User description: "use the @docs/code-review.md to create a spec of improvements for this project"

## Context

Feature 001 delivered a GBIF-backed MCP server and a CLI agent that consumes it over a real protocol boundary. A full-repository review (`docs/code-review.md`, 2026-09-02) found the design sound and the guarantees mostly structural rather than conventional — and found twenty-four specific places where the implementation does not yet hold the line the design draws.

Two of those are defects a user can feel. The diagnostic record attached to every failed tool call carries a constant value instead of the failure category, so an operator cannot tell a rate-limit from an ambiguous name without reading prose. And a momentary upstream outage is remembered as though it were a permanent fact about the name that was being looked up, so a thirty-second blip becomes an hour of confidently wrong answers for that species.

The rest are hardening: a memory store with no ceiling, a validity bound frozen at process start, an interruption that reports itself as a crash, a conversation that grows until the provider refuses it, an eval suite that constructs its own copy of the agent it is supposed to be measuring, and a set of automated gates that would have caught several of these before review did.

This feature is the remediation of that review. It changes no capability, adds no tool, and removes nothing a caller depends on. It makes the behaviour that is already promised actually happen, and moves the enforcement of several existing promises from human review into the toolchain.

The review also recorded seven decisions that look like candidates for simplification and are in fact load-bearing. Those are named in **Out of Scope** so that this work cannot accidentally undo them.

## Clarifications

### Session 2026-09-02

- Q: When a caller supplies both a taxon identifier and a name to the same occurrence request, should the request be refused, or should the ignored value be reported? → A: **Refuse the request**, with a recoverable failure naming both supplied values and telling the caller to pass exactly one. This is the treatment every other ambiguity in the system already receives — the choice is returned to the caller rather than made for them. It is a deliberate, specification-sanctioned change to a previously-succeeding input shape (FR-049).
- Q: Should measured test coverage act as a blocking quality gate, or be reported for information only? → A: **Reported for information only.** Coverage is produced on every automated run and published as a retained artefact, with no threshold. No new way for an unrelated change to fail, and the number stays visible for judgement.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - An operator can tell what failed, from the record alone (Priority: P1)

Someone is running the server — in a client application, in a container, in a terminal alongside other output — and calls are failing. They need to know *which* failure it is: a name the index does not hold, a name shared across kingdoms, a filter the caller got wrong, an upstream rate limit, an upstream outage, or a defect in the server itself. Today every one of those produces an identical category in the diagnostic record, so the only way to tell them apart is to read the human sentence attached to each individual call — which does not survive aggregation, and does not exist at all for someone counting failure kinds over a day.

**Why this priority**: It is the difference between "the server is failing" and "the server is being rate-limited", which are two entirely different responses. The record already exists, is already emitted on both channels, and is already documented as carrying the failure category — it simply does not. Cost is near zero and the diagnostic value is immediate.

**Independent Test**: Provoke one failure of each defined category through a connected client. Inspect the diagnostic record emitted on the developer channel and the record delivered to the client as a log notification. Verify that each category is distinguishable from every other without reading the human-readable message.

**Acceptance Scenarios**:

1. **Given** a request for a name the index does not hold, **When** the call fails, **Then** the diagnostic record identifies the failure as a not-found condition, distinct from every other category.
2. **Given** a request for a name shared by taxa in more than one kingdom, **When** the call fails, **Then** the diagnostic record identifies it as an ambiguity, not as a not-found.
3. **Given** an upstream rate limit that outlasts the call's time budget, **When** the call fails, **Then** the diagnostic record identifies it as rate limiting, distinct from a timeout and from an outage.
4. **Given** an unexpected internal fault, **When** the call fails, **Then** the diagnostic record marks it as unattributed rather than borrowing a domain category.
5. **Given** a client that has subscribed to server log notifications, **When** any call fails, **Then** the category in the notification matches the category on the developer channel.
6. **Given** any failed call, **When** the record is inspected, **Then** the category field contains no caller-supplied value.

---

### User Story 2 - A momentary upstream outage stays momentary (Priority: P1)

A person asks about a species. The upstream index happens to be slow, or briefly refusing traffic, and the call fails with a message that explicitly says the request is worth retrying. The person retries. Today they receive the identical failure instantly, without a single upstream attempt, and will keep receiving it for the remembering period — currently an hour — because the transient failure was recorded as though it were a settled fact about that name. Every other conversation in the same process gets the same stale answer for that species.

**Why this priority**: It converts a thirty-second upstream hiccup into an hour of confidently wrong answers, and it defeats the retry advice the failure message itself gives. It is the only finding in the review where following the system's own instructions cannot work.

**Independent Test**: Provoke a retryable upstream failure for a given name with the upstream unavailable, then make the upstream healthy and repeat the identical request. Verify the second request reaches upstream and succeeds. Repeat with a non-retryable failure (an unknown name) and verify the second request is still answered from memory without an upstream call.

**Acceptance Scenarios**:

1. **Given** a name whose lookup failed for a reason the system marked as worth retrying, **When** the identical lookup is repeated after upstream recovers, **Then** the lookup reaches upstream and returns the correct result.
2. **Given** a name whose lookup failed for a reason that retrying cannot fix, **When** the identical lookup is repeated, **Then** it is answered from memory without an upstream call, with the original failure text intact including any candidate list.
3. **Given** a lookup cancelled by the caller, **When** the identical lookup is repeated, **Then** it reaches upstream, as it does today.
4. **Given** a stream of lookups for names that do not exist, **When** each is repeated, **Then** each is still answered from memory — the economy that negative remembering exists for is preserved.

---

### User Story 3 - The server behaves the same on its thousandth hour as on its first (Priority: P2)

The server is designed to be long-lived: that is the entire premise of remembering resolutions for an hour. But two things in it assume a short life. The store of remembered resolutions has no ceiling and no sweep, so it grows for as long as distinct names keep arriving — and a caller that is itself a language model generating name variants is exactly the caller that fills it. Separately, the upper bound on an acceptable year is decided once, when the process starts, so a server running across a calendar year boundary rejects the new year while telling the caller that the new year is acceptable.

**Why this priority**: Neither is reachable in a short session, and both are reachable in the deployment the design is built for. The memory growth is unbounded rather than merely large; the year bound produces a self-contradictory rejection message, which is a direct violation of the project's rule that an error must name a next step the caller can act on.

**Independent Test**: Drive a large number of distinct name lookups through a single long-lived instance and verify the count of remembered entries stops rising at a defined ceiling while lookups keep succeeding. Separately, advance the instance's notion of the current date across a year boundary and verify that a filter naming the new year is accepted and that any rejection message names a bound consistent with the one applied.

**Acceptance Scenarios**:

1. **Given** an instance that has received more distinct name lookups than the defined ceiling, **When** the remembered-entry count is inspected, **Then** it is at or below the ceiling and lookups continue to succeed.
2. **Given** an instance at its ceiling, **When** a new lookup is remembered, **Then** the entry discarded is the one recorded longest ago.
3. **Given** an instance whose ceiling has evicted a previously remembered name, **When** that name is looked up again, **Then** it is resolved upstream and returns the correct result.
4. **Given** an instance started before a calendar year boundary and still running after it, **When** a filter names the new current year, **Then** it is accepted without restarting the process.
5. **Given** any rejected year value, **When** the rejection is read, **Then** the acceptable range it names does not include the value it just rejected.
6. **Given** a running instance, **When** it is asked to stop twice in quick succession, **Then** it stops once, cleanly.
7. **Given** an instance whose teardown stalls, **When** it is asked to stop, **Then** it stops within a bounded time rather than holding its connection open indefinitely.

---

### User Story 4 - The command-line session ends and continues gracefully (Priority: P2)

Two things go wrong for the person at the terminal. Interrupting while an answer is being generated prints the shutdown notice and then an additional line of failure text, and returns a status that means "this crashed" — for what was a deliberate, clean interruption. And a conversation that runs long enough eventually fails, reported as though the last question were at fault, when in fact the accumulated history has outgrown what the model will accept.

**Why this priority**: Both are visible to the only human user this product has. Neither is data loss, which is why they sit below the P1 items, but the interruption case is reached by anyone who presses Ctrl-C at the wrong moment, which is most people.

**Independent Test**: Interrupt the session while an answer is in flight and verify the exit status and the absence of failure text. Separately, drive a session past the configured history ceiling and verify it keeps answering and says that earlier exchanges were dropped.

**Acceptance Scenarios**:

1. **Given** an answer being generated, **When** the person interrupts, **Then** the session prints its shutdown notice, prints no failure text, and exits with a status conventionally meaning "interrupted".
2. **Given** an idle prompt, **When** the person interrupts, **Then** the session exits cleanly as it does today, leaving no server process behind.
3. **Given** either interruption path, **When** the process has exited, **Then** no launched server process remains running.
4. **Given** a conversation that has exceeded the history ceiling, **When** the next question is asked, **Then** it is answered, and the person is told that earlier exchanges were dropped.
5. **Given** a conversation within the ceiling, **When** a follow-up question relies on the previous turn, **Then** it is answered without the species being restated — the behaviour the eval suite already checks is unaffected.
6. **Given** a stated verbosity setting for the server's diagnostics, **When** the session launches the server, **Then** the setting takes effect for that server.

---

### User Story 5 - Contradictory taxon inputs are not silently reconciled (Priority: P2)

An occurrence request accepts either a resolved taxon identifier or a name to resolve. A caller — most often a model — can supply both, and they can disagree. Today the identifier is used, the name is discarded, and nothing anywhere says so: not the human-readable result, not the structured result (which reports no resolution at all in this case), not the diagnostic record. A model that has a polar bear identifier in hand and names a cougar in the same call receives polar bear counts labelled with nothing.

**Why this priority**: It is the one place in the system where a genuinely ambiguous input is resolved by a silent choice. Every comparable ambiguity in this codebase — a homonym, a weak fuzzy match, a name that reaches only a genus — is returned to the caller as a recoverable question rather than guessed at. The inconsistency is small in frequency and large in principle.

**Independent Test**: Issue an occurrence request supplying both an identifier and a mismatched name, and verify the outcome matches the resolved contract. Verify the tool's own description states that behaviour, so a model can predict it without discovering it.

**Acceptance Scenarios**:

1. **Given** a request supplying both a taxon identifier and a name, **When** the request is handled, **Then** the request is refused with a recoverable failure that names both supplied values and says to pass exactly one — never a silent discard.
2. **Given** a request supplying only an identifier, **When** the request is handled, **Then** behaviour is unchanged from today.
3. **Given** a request supplying only a name, **When** the request is handled, **Then** behaviour is unchanged from today.
4. **Given** the resolved behaviour, **When** a caller reads the tool's description, **Then** the description states what happens when both are supplied.

---

### User Story 6 - The eval suite measures the agent that actually ships (Priority: P3)

The eval suite exists to answer one question: does a real model, given the real guidance, reach for the right capability? Its stated premise is that it drives the real agent. In fact it constructs its own second copy — its own launch path, its own agent configuration, its own step ceiling. The two are identical today and nothing keeps them so. The first time someone changes one and not the other, the evals begin measuring an agent nobody ships and go on reporting a confident score.

Separately, the suite records which capability calls failed by matching each completion back to the most recent start bearing the same capability name. When a model issues two calls to the same capability at once, the wrong one is marked — and that record feeds the check that asks whether the agent repeated a call it had already been told had failed.

**Why this priority**: It costs nothing today and everything on the day it matters, and the failure is silent. It is P3 only because the two copies are currently in agreement, so no score is presently wrong.

**Independent Test**: Change one property of the shipped agent's configuration and verify the eval run reflects it without a second edit. Separately, record a run in which two calls to the same capability overlap and verify each completion is attributed to the invocation that produced it.

**Acceptance Scenarios**:

1. **Given** a change to the shipped agent's configuration, **When** the eval suite runs, **Then** the change is in effect, with no second definition to update.
2. **Given** a change to the path at which the server is launched, **When** the eval suite runs, **Then** the change is in effect, with no second definition to update.
3. **Given** a run in which two calls to the same capability are in flight simultaneously, **When** the record is inspected, **Then** each recorded outcome belongs to the invocation that produced it.
4. **Given** a place where the type system is deliberately bypassed, **When** a reader encounters it, **Then** the reason is stated once rather than repeated without explanation at each site.

---

### User Story 7 - The toolchain catches what review would otherwise have to (Priority: P3)

Several findings in the review are the kind a machine should have caught. An unused local, a parameter nobody reads, an explicitly-undefined value written into an optional field — none is caught today, and the codebase already keeps that discipline by hand throughout. The dependency-pin check, which exists precisely to stop a routine upgrade from installing an unsupported combination, invokes an external operating-system command to read a file in its own repository. Redundant automated runs are not cancelled when superseded. The check that detects the upstream index moving underneath the recorded fixtures only ever runs when a person remembers to run it. And the deliberate, well-defended version pins mean the project will drift silently behind on everything they do not cover, with nothing prompting a look.

**Why this priority**: None of it is user-visible. All of it lowers the cost of every subsequent change, and several items would have caught findings in this very review before it was written.

**Independent Test**: Introduce, in a scratch change, an unused local, an unused parameter, and an explicitly-undefined optional property, and verify each is rejected by the automated gate. Verify the dependency-pin check runs without invoking an external command. Verify a superseded run is cancelled and that the upstream-reality check runs on a schedule without gating ordinary changes.

**Acceptance Scenarios**:

1. **Given** a change introducing an unused local or an unused parameter, **When** the automated gate runs, **Then** the change is rejected.
2. **Given** a change writing an explicitly-undefined value into an optional field, **When** the automated gate runs, **Then** the change is rejected.
3. **Given** the existing codebase unchanged, **When** the stricter gate is applied, **Then** it passes without modification to any source file.
4. **Given** the dependency-pin check, **When** it runs on any supported development platform, **Then** it completes without invoking an external operating-system command.
5. **Given** two changes pushed to the same proposal in quick succession, **When** the automated runs are inspected, **Then** the superseded run has been cancelled.
6. **Given** no human action, **When** a defined interval elapses, **Then** the upstream-reality check has run, and its result does not gate ordinary changes.
7. **Given** a new version of a dependency that is not deliberately pinned, **When** the interval elapses, **Then** an update proposal exists for a human to consider.
8. **Given** an update proposal that would break a deliberate pin, **When** the automated gate runs, **Then** it is rejected with the existing pin message.
9. **Given** a fresh clone by a contributor with no personal configuration, **When** local tool settings are generated, **Then** they do not appear as uncommitted changes.
10. **Given** the behaviours identified as untested in the review, **When** the deterministic suite runs, **Then** each has at least one direct automated check.

---

### User Story 8 - The written record matches the code it describes (Priority: P3)

The project states its own claims precisely and expects to be held to them. Three of those claims are now wrong: the eval suite is described as ten scenarios and contains twelve; the stated minimum package-manager version predates the mechanism the workspace uses to enforce single-version dependency resolution, so a contributor honouring the stated minimum would silently lose a guarantee the constitution requires; and the count of fields a record is trimmed to is given as two different numbers in three places. The description a model reads before choosing the record-listing capability also omits one of the fields that capability returns — the identifier a person needs to look a record up at its source.

**Why this priority**: No behaviour depends on it. It is P3 for that reason and included at all because this project treats its prose, and particularly the prose a model reads, as reviewed surface rather than commentary.

**Independent Test**: For each numeric or version claim in the written documentation, verify it against the code it describes. For the record-listing capability, verify its description enumerates every field the capability returns.

**Acceptance Scenarios**:

1. **Given** any count stated in the written documentation, **When** it is checked against the code, **Then** the two agree.
2. **Given** the stated minimum package-manager version, **When** a contributor installs with exactly that version, **Then** the workspace's single-version dependency guarantee holds.
3. **Given** the record-listing capability's description, **When** a caller reads it, **Then** every field the capability returns is named.

---

### Edge Cases

- **A retryable failure that recurs.** Not remembering retryable failures means a persistently unavailable upstream is contacted on every request rather than once per remembering period. The existing per-call time budget and retry ceiling already bound the cost of each attempt; no additional suppression is introduced.
- **Ceiling reached while an entry is still useful.** Discarding the longest-ago-recorded entry can evict a name that is about to be asked again. The consequence is one extra upstream lookup, never a wrong answer.
- **Ceiling set below the number of names in one conversation.** The store must remain correct, not merely bounded: an evicted name resolves again on demand.
- **A year filter naming the current year on the day the year changes.** The bound must be derived from the time of the request, not the time the process started.
- **Interruption arriving between the shutdown notice and the exit.** Repeated interrupts must not produce repeated teardown or a different exit status.
- **History ceiling reached mid-clarification.** Dropping the exchange in which the person answered a clarifying question would silently undo the clarification. The ceiling must be large enough that ordinary clarification exchanges survive, and the person must be told when anything is dropped.
- **Both a taxon identifier and a name supplied, and they agree.** The refusal applies whether they agree or disagree — the system cannot check agreement without performing the lookup the identifier exists to avoid, so it declines to guess in both cases.
- **Two calls to the same capability in flight at once during an eval run.** Each recorded outcome belongs to its own invocation; no completion may overwrite another's.
- **The scheduled upstream-reality check failing.** It reports that the upstream index moved, which is information, not a defect in this repository. It must not block ordinary changes.
- **A dependency update proposal that trips a deliberate pin.** It must fail loudly at the existing gate rather than be quietly excluded from consideration.

## Requirements *(mandatory)*

### Functional Requirements

#### Diagnosable failures (User Story 1)

- **FR-001**: Every failed tool call MUST record a failure category that distinguishes each defined failure condition from every other defined failure condition.
- **FR-002**: The recorded failure category MUST be identical on the developer-facing diagnostic channel and in the log notification delivered to a subscribed client.
- **FR-003**: The failure category field MUST contain no caller-supplied value.
- **FR-004**: A failure that does not correspond to a defined condition MUST be recorded as unattributed rather than assigned an unrelated defined category.
- **FR-005**: When an upstream response cannot be interpreted, the developer-facing diagnostic MUST identify which part of the response failed expectation, while the message returned to the caller MUST remain unchanged.
- **FR-006**: Automated checks MUST verify the recorded category for at least one instance of each failure family, including the unattributed case.

#### Transient failures stay transient (User Story 2)

- **FR-007**: A failure the system marks as worth retrying MUST NOT be replayed as the answer to a subsequent identical request.
- **FR-008**: A failure that retrying cannot fix MUST continue to be replayed for the existing remembering period, with its original text and any candidate list intact.
- **FR-009**: A cancelled request MUST continue not to be remembered.
- **FR-010**: Automated checks MUST verify both the replayed and the not-replayed cases.
- **FR-011**: The written justification for remembering failures MUST state which failures are remembered and which are not.

#### Bounded, date-correct, predictable long uptime (User Story 3)

- **FR-012**: The store of remembered resolutions MUST have a maximum entry count that it does not exceed.
- **FR-013**: On exceeding the maximum, the entry recorded longest ago MUST be the one discarded.
- **FR-014**: A discarded entry MUST be re-derivable on demand: a subsequent request for it MUST produce the correct result.
- **FR-015**: The maximum MUST be settable when the store is created, so that the eviction behaviour is directly testable.
- **FR-016**: The acceptable range for a year filter MUST be derived from the time of the request, not from the time the process started.
- **FR-017**: A message rejecting a year value MUST name an acceptable range that excludes the rejected value.
- **FR-018**: Repeated stop signals MUST result in exactly one shutdown sequence.
- **FR-019**: Shutdown MUST complete within a bounded time even when teardown does not settle.
- **FR-020**: Automated checks MUST cover the eviction boundary and the request-time derivation of the year bound.

#### A graceful command-line session (User Story 4)

- **FR-021**: An interruption arriving while an answer is being generated MUST produce the shutdown notice, no failure text, and an exit status conventionally meaning "interrupted".
- **FR-022**: An interruption on any path MUST leave no launched server process running.
- **FR-023**: Conversation history MUST have a maximum size, beyond which the oldest exchanges are dropped first.
- **FR-024**: When history is dropped, the person MUST be told, in the session output.
- **FR-025**: The maximum MUST be large enough that a multi-turn clarification exchange completes without any part of it being dropped.
- **FR-026**: A stated diagnostic-verbosity setting MUST take effect for the server the session launches.
- **FR-027**: An automated check MUST cover interruption arriving during an in-flight answer, without contacting a model provider.

#### Contradictory taxon inputs (User Story 5)

- **FR-028**: When a request supplies both a taxon identifier and a name, the system MUST refuse the request before any upstream call, with a recoverable failure that names both supplied values and directs the caller to supply exactly one. The name MUST NOT be discarded without a signal.
- **FR-029**: The capability's description MUST state what happens when both are supplied.
- **FR-030**: Requests supplying exactly one of the two MUST behave exactly as they do today.

#### The eval measures the shipped agent (User Story 6)

- **FR-031**: The agent configuration and the server launch path used by the eval suite MUST come from the same single definition the command-line session uses.
- **FR-032**: A change to that definition MUST take effect in both without a second edit.
- **FR-033**: A recorded capability-call outcome MUST be attributed to the invocation that produced it, including when several invocations of the same capability are in flight simultaneously.
- **FR-034**: Where the type system is deliberately bypassed, the reason MUST be stated once at a single point rather than repeated unexplained at each site.
- **FR-035**: An indirection that performs no transformation MUST either be removed or carry a stated reason for existing.

#### Automated gates (User Story 7)

- **FR-036**: The automated type gate MUST reject unused locals, unused parameters, and explicitly-undefined values written into optional fields.
- **FR-037**: Enabling that gate MUST require no change to any existing source file.
- **FR-038**: The dependency-pin check MUST read repository files directly, without invoking an external operating-system command, and MUST run on every supported development platform.
- **FR-039**: A superseded automated run for the same proposal MUST be cancelled rather than run to completion.
- **FR-040**: The check that detects the upstream index moving underneath recorded fixtures MUST run on a defined schedule without human action, and MUST NOT gate ordinary changes.
- **FR-041**: The deterministic suite MUST produce coverage information on every automated run and retain it as a published artefact. It MUST NOT act as a blocking gate: no coverage threshold may fail a run.
- **FR-042**: A mechanism MUST exist that proposes updates for dependencies that are not deliberately pinned.
- **FR-043**: That mechanism MUST NOT be able to bypass the existing dependency-pin check.
- **FR-044**: Locally-generated tool configuration MUST be excluded from version control by the repository's own ignore rules, without relying on a contributor's personal configuration.
- **FR-045**: Each behaviour the review identified as untested MUST have at least one direct automated check: filter translation for open-ended and single-value ranges, the paging-window boundary, country-code normalisation and rejection, remembered-key normalisation, expiry, and hit/miss statistics, and the unexpected-internal-fault fallback.

#### The written record (User Story 8)

- **FR-046**: Every count stated in the written documentation MUST match the code it describes.
- **FR-047**: The stated minimum package-manager version MUST be one under which the workspace's single-version dependency guarantee holds.
- **FR-048**: The record-listing capability's description MUST name every field that capability returns.

#### Constraints on the change as a whole

- **FR-049**: Apart from the behaviour defined by FR-028 and the history ceiling of FR-023, no externally observable capability contract may change: the same capabilities, the same inputs, the same result shapes.
- **FR-050**: The existing deterministic suite MUST continue to pass unmodified, except where a test encodes a behaviour this specification deliberately changes.
- **FR-051**: The decisions listed in **Out of Scope** MUST remain as they are.

### Key Entities

- **Tool Call Diagnostic Record**: One record per capability invocation, carrying duration, retry count, remembered-lookup outcome, upstream request count, and — on failure — the failure category. Emitted on the developer channel and, when a client subscribes, as a protocol log notification. The failure category is the field this feature repairs.
- **Remembered Resolution**: A name-to-taxon outcome held for a period, keyed by the name and any disambiguating hints, holding either a resolved taxon or a preserved failure. This feature gives the collection a ceiling and narrows which failures may be held.
- **Conversation Transcript**: The ordered exchanges of one command-line session, held in memory for the life of the process and sent in full with each question. This feature gives it a ceiling and makes truncation visible.
- **Agent Definition**: The name, guidance, capability set, step ceiling, and server launch path that constitute the shipped agent. This feature makes it single-sourced so the eval suite cannot measure a different one.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator inspecting diagnostic records for failed calls can distinguish 100% of defined failure categories from one another without reading any human-readable message. (Today: 0% — one constant value for all.)
- **SC-002**: After an upstream disruption ends, the first repeat of a previously failing request reaches upstream. Time from upstream recovery to correct answers resuming falls from up to the full remembering period (one hour) to zero.
- **SC-003**: Memory held for remembered resolutions stays at or below a defined ceiling for an unbounded number of distinct lookups, verified by driving at least ten times the ceiling in distinct lookups through one instance without the count exceeding it.
- **SC-004**: An instance running continuously across a calendar year boundary accepts the new year as a filter value with no restart, and 100% of year rejection messages name a range that excludes the value rejected.
- **SC-005**: Interrupting the command-line session during an answer produces exactly one line of shutdown output, no failure text, and an interruption exit status — in 100% of attempts, at both the idle prompt and mid-answer.
- **SC-006**: A session of at least 100 exchanges continues to answer questions, with any dropped history reported to the person; today such a session ends in a failure attributed to the person's question.
- **SC-007**: No request supplying contradictory taxon inputs returns a result whose attribution is unstated. (Today: 100% of such requests do.)
- **SC-008**: A single-property change to the shipped agent takes effect in both the session and the eval run after one edit, verified by changing the step ceiling and observing it in a recorded run.
- **SC-009**: Every behaviour the review identified as untested has at least one direct automated check — 10 of 10 named behaviours, up from 0.
- **SC-010**: A change introducing an unused local, an unused parameter, or an explicitly-undefined optional value is rejected automatically before human review, in 3 of 3 trial cases.
- **SC-011**: The upstream-reality check runs at least once per defined interval with no human action, and has never blocked an ordinary change.
- **SC-012**: Every count and version claim in the written documentation matches the code it describes — 0 mismatches, down from 3.
- **SC-013**: The deterministic suite continues to pass in full, and the total number of automated checks increases; no existing capability contract changes shape other than as specified.

## Assumptions

- **The review is the scope.** All findings in `docs/code-review.md` §1–§6 are in scope; §7 is explicitly excluded and recorded under Out of Scope. No finding outside that document is introduced here.
- **Ceiling for remembered resolutions.** A default in the low thousands of entries is assumed sufficient: large enough that ordinary use never evicts, small enough to bound memory. The exact number is an implementation choice, provided it is settable for testing (FR-015).
- **Ceiling for conversation history.** A default of roughly twenty to thirty exchanges is assumed: comfortably beyond the multi-turn clarification flows the eval scenarios exercise, and far below any provider's limit.
- **Interruption exit status.** The conventional status for a process terminated by an interrupt signal is assumed to be acceptable; a plain success status would also satisfy FR-021's intent if the project prefers it.
- **Verbosity forwarding.** Forwarding the single documented diagnostic-verbosity setting to the launched server is assumed preferable to documenting that it has no effect. The launched server's environment otherwise remains deliberately minimal.
- **Update-proposal mechanism.** A repository-native scheduled update mechanism is assumed, requiring no third-party service and no credentials.
- **Year-bound placement.** Deriving the acceptable year range per request is assumed to be worth a slightly later rejection point than a statically declared bound, because the current arrangement can produce a self-contradictory message.
- **No new dependencies.** Every requirement here is assumed achievable with the existing dependency set and platform capabilities, consistent with the project's rule that each production dependency is justified individually.
- **Existing time budgets stand.** The per-attempt and per-call time limits, the retry ceiling, the record cap, and the remembering period are unchanged by this feature.

## Out of Scope

The review named seven decisions that resemble candidates for simplification and are in fact load-bearing. This feature must leave each intact (FR-051):

- The ordering that decides match type before match confidence.
- The position of the output-channel guard as the first import of the server entrypoint.
- The asymmetry between lenient upstream parsing and strict outward contracts.
- The requirement that every failure name a next step, enforced by the type rather than by convention.
- The absence of any record-carrying field in the summary capability's result shape.
- The mechanism that makes the deterministic suite unable to reach the network.
- The absence of a package dependency between the agent and the server, enforced automatically.

Also excluded: any new capability, any change to the number of capabilities, any transport other than the existing one, and any form of persistence.

## Traceability

Each requirement group maps to the review section that motivates it. Provenance, not implementation guidance.

| Review § | Finding | User Story | Requirements |
|---|---|---|---|
| 1.1 | Failure category recorded as a constant | US1 | FR-001 – FR-004, FR-006 |
| 1.2 | Transient failures remembered for the full period | US2 | FR-007 – FR-011 |
| 1.3 | Year bound frozen at process start | US3 | FR-016, FR-017, FR-020 |
| 2.1 | Remembered-resolution store unbounded | US3 | FR-012 – FR-015, FR-020 |
| 2.2 | Conversation history unbounded | US4 | FR-023 – FR-025 |
| 2.3 | Interruption reported as a crash | US4 | FR-021, FR-022, FR-027 |
| 2.4 | Upstream-shape diagnostic discarded | US1 | FR-005 |
| 2.5 | Shutdown neither idempotent nor bounded | US3 | FR-018, FR-019 |
| 2.6 | Verbosity setting cannot reach the launched server | US4 | FR-026 |
| 2.7 | Contradictory taxon inputs silently reconciled | US5 | FR-028 – FR-030 |
| 3.1 | Eval constructs its own copy of the agent | US6 | FR-031, FR-032 |
| 3.2 | Indirection that performs no transformation | US6 | FR-035 |
| 3.3 | Repeated unexplained type bypasses | US6 | FR-034 |
| 3.4 | Call outcomes attributed by name, not invocation | US6 | FR-033 |
| 4.1 | Three automated type gates not enabled | US7 | FR-036, FR-037 |
| 4.2 | Pin check invokes an external command | US7 | FR-038 |
| 4.3 | No run cancellation, schedule, or coverage | US7 | FR-039 – FR-041 |
| 4.4 | No update proposals despite deliberate pins | US7 | FR-042, FR-043 |
| 4.5 | Local tool configuration not ignored by the repository | US7 | FR-044 |
| 5.1 – 5.5 | Untested behaviours | US1, US2, US3, US4, US7 | FR-006, FR-010, FR-020, FR-027, FR-045 |
| 6 | Documentation claims contradict the code | US8 | FR-046 – FR-048 |
| 7 | Load-bearing decisions | — | FR-051, Out of Scope |
