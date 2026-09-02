# Contracts — Post-Review Hardening

This feature adds no interface. Every contract here is a **delta** to one already published under
[`specs/001-gbif-mcp-server/contracts/`](../../001-gbif-mcp-server/contracts/), and each states what
changes, what deliberately does not, and how the change is observed.

| Contract | Delta | Requirements |
|---|---|---|
| [tool-call-log.md](./tool-call-log.md) | The diagnostic record's failure category becomes real and closed | FR-001 – FR-006 |
| [taxon-input.md](./taxon-input.md) | Both a key and a name is now a refusal, not a silent choice | FR-028 – FR-030 |
| [agent-cli.md](./agent-cli.md) | Interrupt exit status, history-truncation notice, `LOG_LEVEL` forwarding | FR-021 – FR-027 |
| [toolchain.md](./toolchain.md) | The automated gates a change must now pass | FR-036 – FR-045 |

**What does not change** (FR-049)

The three tools keep their names, input schemas, output schemas and result shapes. The prompt keeps
its arguments. `instructions` is unchanged. Two exceptions, both specification-sanctioned and both
recorded in the contracts above:

1. An occurrence request supplying **both** `taxonKey` and `name` now fails where it previously
   succeeded ([taxon-input.md](./taxon-input.md)).
2. A CLI session past its history ceiling now drops old exchanges and says so
   ([agent-cli.md](./agent-cli.md)).

**What must not change** (FR-051)

The seven load-bearing decisions in `docs/code-review.md` §7. Two sit directly under work in this
feature and are called out where they apply: the output-channel guard stays the first import of the
server entrypoint, and `next` stays a required field on every failure the type can express.
