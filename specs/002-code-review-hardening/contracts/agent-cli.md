# Contract: Agent CLI — interruption, history, and the launched server

**Delta to**: [`agent-cli.md`](../../001-gbif-mcp-server/contracts/agent-cli.md).
**Requirements**: FR-021 – FR-027 · **Decisions**: [D6](../research.md#d6--interruption-during-a-generation-exits-130-with-no-failure-text), [D7](../research.md#d7--conversation-history-is-bounded-by-turn-count-with-a-notice), [D15](../research.md#d15--log_level-is-forwarded-to-the-launched-server)

Three changes to the session a person actually sits in front of. Nothing about `MODEL` resolution,
the credential preflight, or the startup order changes.

## 1. Exit status on interruption (FR-021, FR-022)

| Code | Meaning | Change |
|---|---|---|
| 0 | Clean exit — `/exit`, or EOF | unchanged |
| 1 | Runtime failure | unchanged |
| 2 | Configuration error | unchanged |
| **130** | **Interrupted (SIGINT), on any path** | **new** |

Today, Ctrl-C **at the prompt** exits cleanly, and Ctrl-C **during a generation** prints the
shutdown notice, then an additional line of failure text, then exits 1 — reporting a deliberate
interruption as a crash.

After this change, both paths behave identically:

```
^C
Received SIGINT. Exiting.
$ echo $?
130
```

- Exactly one line of shutdown output. No `That question could not be answered: …` line, and no
  stack trace (FR-021).
- Teardown is untouched: `mcp.disconnect()` still runs in the `finally` that covers every path, so
  no launched server process survives either route (FR-022).
- A second Ctrl-C during teardown does not produce a second notice or a different status.

`130` is 128 + SIGINT, the shell convention, and does not collide with the reserved `1` and `2`.

## 2. Conversation history ceiling (FR-023 – FR-025)

The transcript is bounded at **40 entries — 20 exchanges**. Beyond it, the oldest exchanges are
dropped first, in `user`/`assistant` pairs.

When anything is dropped, the session says so, once, in its own output:

```
[Dropped the 3 oldest exchanges to stay within the context limit.]
```

**Guarantees**

- **G1** — a session of at least 100 exchanges keeps answering (SC-006). Today it eventually fails,
  and the failure is reported as though the person's last question were at fault.
- **G2 (FR-024)** — no exchange is dropped without the person being told.
- **G3 (FR-025)** — the ceiling is far above any multi-turn clarification flow, so an exchange in
  which the person answered a clarifying question is never the one dropped. The longest eval
  scenario is three questions.
- **G4** — entries are dropped in pairs, so the transcript never begins with an assistant message.
  An orphaned leading assistant message is rejected by some providers, which would convert a
  graceful truncation into the failure it exists to prevent.
- **G5** — nothing is persisted. The transcript still dies with the process.

Within the ceiling, behaviour is byte-identical to today, including the follow-up-without-restating
behaviour the eval suite checks.

## 3. `LOG_LEVEL` reaches the launched server (FR-026)

`.env.example` advertises `LOG_LEVEL` as "server log level on stderr". Because the stdio transport
**replaces** the child's environment rather than merging into it, setting it before `pnpm agent`
does nothing today.

`LOG_LEVEL` is added to the forwarded allowlist alongside `GBIF_USER_AGENT_CONTACT`:

```
env: {
  GBIF_USER_AGENT_CONTACT?  // as today
  LOG_LEVEL?                // new
}
```

The posture is preserved deliberately: the child's environment is still an explicit allowlist, not
`{ ...process.env }`. Two named variables, both documented, both read by the server.

## How it is observed (FR-027)

- `Session` takes an injected `agent`, so a stub whose `generateText` rejects once the shutdown
  signal aborts exercises the whole interruption path **without contacting a model provider** —
  which Constitution VI requires of anything in the default suite.
- A history test drives the same stub past the ceiling and asserts the transcript length, the pair
  boundary, and the notice.
- The existing teardown test continues to assert no orphaned server process.
