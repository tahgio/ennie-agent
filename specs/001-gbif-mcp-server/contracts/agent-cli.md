# Contract: CLI agent

Requirements: FR-031, FR-031a, FR-031b, FR-032 – FR-037.

## Invocation

```
pnpm --filter agent start          # interactive session
```

An optional first question may be passed as an argument; the session stays open afterwards either
way (FR-031).

## Environment

| Variable | Required | Purpose |
|----------|----------|---------|
| `MODEL` | yes | Model selection. Two accepted forms, below. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` | one, by provider | Credential for the chosen provider. |
| `AI_GATEWAY_API_KEY` | gateway form only | Credential for the Vercel AI Gateway. |
| `VOLTOPS_PUBLIC_KEY` / `VOLTOPS_SECRET_KEY` | no | Enable trace export; flushed before exit. |
| `GBIF_USER_AGENT_CONTACT` | no | Contact appended to the server's User-Agent. |
| `GBIF_CALL_BUDGET_MS` | no | Per-call budget against GBIF, milliseconds. Default 60000. |

**`MODEL` resolution (FR-032)**

| Form | Example | Route |
|------|---------|-------|
| `provider:model` | `anthropic:claude-opus-5` | Direct against `@ai-sdk/anthropic`, `@ai-sdk/openai`, or `@ai-sdk/google`. Providers restricted to `anthropic`, `openai`, `google`. |
| `provider/model` | `anthropic/claude-opus-5` | Falls through to the Vercel AI Gateway. |

The colon form is checked first; an unknown provider before a colon is an error naming the three
supported providers, not a silent fall-through to the gateway.

## Startup and exit

1. Resolve `MODEL`. Unset or malformed → exit **2**, message naming `MODEL` and showing both forms.
2. Check the credential for the resolved route. Missing → exit **2**, message naming **the exact
   variable** (FR-034). Neither the server nor the model is contacted first.
3. Print the resolved model identity before the first prompt (FR-033).
4. Spawn the server over stdio via VoltAgent `MCPConfiguration`, and print the tools discovered.
5. Loop: read a question, answer it, keep the context (FR-031a).
6. Exit on `/exit`, EOF, or SIGINT (FR-031b).

| Code | Meaning |
|------|---------|
| 0 | Clean exit |
| 1 | Runtime failure |
| 2 | Configuration error (missing/invalid `MODEL` or credential) |
| 130 | Interrupted (SIGINT) while an answer was being generated |

`130` is 128 + SIGINT(2), the shell convention for "terminated by an interrupt". It was added by
feature 002; see [specs/002-code-review-hardening/contracts/agent-cli.md](../../002-code-review-hardening/contracts/agent-cli.md).
An interruption at an idle prompt still exits `0` — nothing was in flight to abandon.

**Teardown (FR-035)**: `disconnect()` runs in a `finally` covering every path — clean exit, throw,
and signal — with SIGINT/SIGTERM handlers routing into the same teardown. VoltOps traces flush
before the process ends. No orphaned server process on any path.

## Boundary (FR-037, Constitution VII)

`packages/agent` does **not** list `mcp-server` as a dependency. It launches the built server by
path as a child process, exactly as a third-party client would. Enforced by a lint rule banning
deep imports and by the absence of a workspace reference. The boundary is what proves the
integration is real rather than a function call wearing a protocol costume.

## Agent instructions (FR-036)

Cover presentation and clarification **only** — formatting counts readably, stating totals
including zero, noting truncation, and putting a server-reported ambiguity to the person as a
plain-language question (FR-036a). Tool semantics come from the server's `instructions` and tool
descriptions, so a third-party client gets identical guidance.
