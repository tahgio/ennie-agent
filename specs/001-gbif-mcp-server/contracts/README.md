# Contracts

The MCP surface is this project's public interface: it is what a model reads and selects on, and
what a third-party client sees. Tool descriptions are prompt surface and are versioned here as
carefully as code (Constitution I).

| Contract | What it covers |
|----------|----------------|
| [resolve-taxon.md](./resolve-taxon.md) | Name → accepted taxon |
| [search-occurrences.md](./search-occurrences.md) | Bounded page of trimmed records |
| [summarize-occurrences.md](./summarize-occurrences.md) | Counts only, no records |
| [species-distribution-report.md](./species-distribution-report.md) | The guided prompt |
| [server-instructions.md](./server-instructions.md) | `instructions` sent at initialize |
| [agent-cli.md](./agent-cli.md) | CLI invocation, env vars, exit codes |

**Conventions across all three tools**

- Every tool declares `inputSchema` and `outputSchema`, and returns `structuredContent` plus a
  human-readable text block (FR-019, FR-020).
- Recoverable failures return `isError: true` with a result whose text names **what went wrong and
  what to do instead**. Exceptions are reserved for protocol faults (FR-023, FR-024).
- Constraints stated in prose in a description are also enforced in the schema. A cap a model can
  read but the server does not enforce is a defect.
- Every field GBIF may omit is `.nullable()` in the output schema. Absence is typed, never
  defaulted — and a stricter schema would turn a good upstream response into a protocol fault.
