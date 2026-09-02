# Contract: Tool Call Diagnostic Record

**Delta to**: the logging behaviour described in `specs/001-gbif-mcp-server/` (FR-029, FR-030).
**Requirements**: FR-001 – FR-006 · **Decision**: [D1](../research.md#d1--the-failure-category-on-the-diagnostic-record-is-the-toolerrorcode)

One record is emitted per capability invocation, on two channels, from a single object.

## Shape

```jsonc
{
  "tool": "resolve_taxon",
  "durationMs": 412,
  "retries": 0,
  "cache": "miss",              // "hit" | "miss" | "n/a"
  "upstreamRequests": 1,
  "outcome": "error",           // "ok" | "error"
  "errorCode": "AMBIGUOUS"      // present iff outcome === "error"
}
```

## The change

`errorCode` currently carries the constant `"ToolError"` on every failure — `error.name`, not
`error.code`. It becomes the actual `ToolErrorCode`, and its declared type narrows from `string` to
the closed union.

| | Before | After |
|---|---|---|
| A not-found name | `"ToolError"` | `"NOT_FOUND"` |
| An ambiguous name | `"ToolError"` | `"AMBIGUOUS"` |
| An upstream 429 | `"ToolError"` | `"UPSTREAM_RATE_LIMITED"` |
| A bad country code | `"ToolError"` | `"INVALID_COUNTRY"` |
| An unexpected internal fault | `"ToolError"` | `"INTERNAL_ERROR"` |

## Guarantees

- **G1 (FR-001)** — every defined failure condition maps to a distinct `errorCode`.
- **G2 (FR-002)** — the stderr record and the MCP `notifications/message` payload carry the same
  value. Guaranteed by construction: `logToolCall` passes one `entry` object to both channels.
- **G3 (FR-003)** — `errorCode` is a member of a closed union of string literals. No caller-supplied
  value is expressible, so no sanitising step exists or is needed.
- **G4 (FR-004)** — a thrown value that is not a `ToolError` is recorded as `"INTERNAL_ERROR"`,
  never as a domain or upstream code.
- **G5** — `errorCode` is present if and only if `outcome === "error"`.

## The failure taxonomy

`ToolErrorCode`, in full, after this feature. Two members are new.

| Group | Codes |
|---|---|
| Resolution | `AMBIGUOUS`, `NOT_FOUND`, `LOW_CONFIDENCE`, `HIGHER_RANK` |
| Input validation | `EMPTY_NAME`, `INVALID_COUNTRY`, `INVALID_YEAR_RANGE`, `LIMIT_EXCEEDED`, `OFFSET_EXCEEDED`, `NO_DIMENSIONS`, `MISSING_TAXON`, **`CONTRADICTORY_TAXON`** |
| Upstream | `UPSTREAM_RATE_LIMITED`, `UPSTREAM_TIMEOUT`, `UPSTREAM_UNAVAILABLE`, `UPSTREAM_BAD_REQUEST` |
| Caller | `CANCELLED` |
| Unattributed | **`INTERNAL_ERROR`** |

`INTERNAL_ERROR` replaces the fallback's present reuse of `UPSTREAM_UNAVAILABLE`. **The text the
caller reads is unchanged** — same `what`, same `next` — so this is a diagnostic change only, not a
contract change under FR-049.

## Upstream schema mismatch (FR-005)

When a lenient upstream schema fails to parse a response, the Zod issue list and the request path
are logged at `debug` **on the developer channel only**. The message returned to the caller is
unchanged, and no part of the upstream payload reaches the caller.

This is the one place where the developer channel deliberately carries more than the client
notification, because a parse failure against a lenient schema means GBIF genuinely moved, and the
issue path is the only actionable thing about it.

## How it is observed (FR-006)

- A unit test over `runTool` provokes one failure of each family and asserts the recorded code,
  including the non-`ToolError` fallback.
- A protocol test with a client subscribed to logging asserts the notification's category matches
  the stderr record for the same call (G2).
