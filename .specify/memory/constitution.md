<!--
Sync Impact Report
==================
Version change: (unversioned template scaffold) → 1.0.0
Bump rationale: Initial ratification. The prior file contained only unreplaced
placeholder tokens, so this is the first substantive constitution.

Modified principles: none (no prior principles existed)

Added sections:
  - Core Principles I. Protocol Correctness Is Non-Negotiable
  - Core Principles II. Context Economy
  - Core Principles III. Tools Model Intents, Not Endpoints
  - Core Principles IV. Validate At Every Boundary
  - Core Principles V. Errors Are Messages To A Model
  - Core Principles VI. Deterministic By Default, Networked By Choice
  - Core Principles VII. The Package Boundary Is The Architecture
  - Core Principles VIII. Dependencies Are Justified Individually
  - Core Principles IX. Decisions Are Documented With Their Trade-Offs
  - Technology And Architecture Constraints
  - Development Workflow And Quality Gates
  - Governance

Removed sections: none

Template slot notes: the resolved scaffold provides five principle slots; the
project defines nine. Slot count was expanded per the authoring instruction to
respect the requested principle count. Sections 2 and 3 were named
"Technology And Architecture Constraints" and "Development Workflow And Quality
Gates" respectively.

Deferred TODOs: none. RATIFICATION_DATE set to the date of first adoption
(2026-08-29), matching the initial repository scaffold.
-->

# Ennie Agent Constitution

This constitution governs an MCP (Model Context Protocol) server written in
TypeScript that exposes three tools backed by the GBIF biodiversity API, and a
CLI agent built with VoltAgent and the Vercel AI SDK that consumes that server
over stdio.

## Core Principles

### I. Protocol Correctness Is Non-Negotiable

The server MUST behave as a well-formed MCP citizen, not as a JSON-RPC-shaped
proxy for HTTP calls.

- **stdout belongs to the protocol.** In stdio mode, nothing but JSON-RPC frames
  MAY be written to stdout. All logging, diagnostics, and progress output MUST go
  to stderr. A stray `console.log` corrupts the stream and surfaces to the user
  as an unexplainable client parse error.
- Tool failures MUST be returned as tool results with `isError: true`, carrying a
  message the *model* can act on. Thrown exceptions are reserved for genuine
  protocol faults, because a thrown error is invisible to the model's reasoning.
- Every tool MUST declare an `outputSchema` and return `structuredContent`,
  always paired with a human-readable text block for clients that do not render
  structured output.
- The server's `instructions` field and every tool `description` field are prompt
  surface. They MUST be written, reviewed, and revised with the same care as
  code.

Rationale: an MCP server's only contract with its client is the protocol. A
violation is not a cosmetic defect; it makes the server unusable in ways that are
extremely hard for a user to diagnose.

### II. Context Economy

The scarce resource in an MCP server is the model's context window, not
bandwidth. A tool that faithfully returns five thousand records is a badly
designed tool.

- Where the question is aggregate in nature, the server MUST aggregate
  server-side and return the aggregate, not the underlying records.
- Every list-returning tool MUST declare a hard cap in its schema, and MUST
  enforce that cap in code.
- Response payloads MUST be trimmed to the fields a caller needs. Upstream
  response shapes MUST NOT be mirrored wholesale.

### III. Tools Model Intents, Not Endpoints

Each tool MUST answer a question a caller actually has.

- Parameters that exist only because the upstream API happens to expose them MUST
  be rejected in review.
- Tools MUST compose: the output of one tool is designed to be usable as the
  input of another.

### IV. Validate At Every Boundary

- Tool inputs MUST be validated with Zod before any network call is made, using
  constraints and descriptions the model can read.
- Upstream responses MUST be parsed defensively with lenient schemas: fields the
  code depends on are checked, unknown fields are tolerated, and missing data is
  represented as a typed absence rather than a runtime surprise.
- TypeScript MUST run in `strict` mode with `noUncheckedIndexedAccess` enabled.
- Exactly one Zod version MUST be resolved across the workspace.

### V. Errors Are Messages To A Model

Every error a tool can return MUST name what went wrong and what the caller
should do instead.

- A bare `"Invalid input"` is a defect, not an error message.
- The target for every failure path is recoverability: the model should be able
  to correct course on its next turn using only the text of the error.

### VI. Deterministic By Default, Networked By Choice

- `test` MUST NOT touch the network. Upstream HTTP MUST be stubbed from fixtures
  captured from real GBIF responses.
- Tests MUST exercise the protocol, not only internal functions: a real MCP
  client talks to a real server instance over an in-memory transport.
- Tests that hit the live API, and evals that call an LLM, MUST live behind
  separate opt-in commands, MUST be documented as such, and MUST NOT run in CI.

### VII. The Package Boundary Is The Architecture

The agent package MUST communicate with the server package only through MCP.
Direct imports of server internals from the agent package are forbidden. The
boundary is what proves the integration is real rather than simulated.

### VIII. Dependencies Are Justified Individually

Prefer the platform: native `fetch`, native `AbortSignal`, and Node's own APIs.
Every production dependency MUST survive the question "why is this here?" in
review. A dependency added for convenience alone MUST be removed.

### IX. Decisions Are Documented With Their Trade-Offs

Every non-obvious choice MUST be recorded in the README in Context / Decision /
Trade-off form. Recording what was deliberately *not* built, and why, carries as
much weight as recording what was. Scope MAY be cut; the explanation MAY NOT.

## Technology And Architecture Constraints

- Language and runtime: TypeScript on Node.js, `strict` mode with
  `noUncheckedIndexedAccess`.
- Workspace layout: at minimum a server package and an agent package, separated
  so that Principle VII is mechanically enforceable.
- Server: MCP over stdio, exposing exactly three GBIF-backed tools unless this
  constitution is amended.
- Agent: VoltAgent with the Vercel AI SDK, consuming the server as an MCP stdio
  client.
- Upstream: the public GBIF biodiversity API, accessed via native `fetch` with
  native `AbortSignal` for cancellation and timeouts.
- Validation: Zod, at a single version across the workspace, for both tool input
  schemas and lenient upstream response schemas.

## Development Workflow And Quality Gates

- CI MUST run typecheck, lint, and the deterministic `test` command. CI MUST NOT
  run live-network tests or LLM evals.
- A change that adds or modifies a tool MUST include: a Zod input schema, an
  `outputSchema`, a declared cap if it returns a list, error messages that satisfy
  Principle V, and a protocol-level test over an in-memory transport.
- A change that adds a production dependency MUST state its justification in the
  commit body (Principle VIII) and, when the choice is non-obvious, in the README
  (Principle IX).
- Commit history MUST read as a deliberate build sequence and MUST use
  Conventional Commits.

## Governance

- This constitution supersedes convenience, habit, and prior practice. Where a
  principle and a deadline conflict, scope MUST be cut rather than a principle
  violated.
- Amendments MUST be made by editing this document in a dedicated commit that
  states the rationale, and MUST update the version and amendment date below.
- Versioning policy follows semantic versioning: MAJOR for backward-incompatible
  removal or redefinition of a principle, MINOR for a new principle or materially
  expanded guidance, PATCH for clarifications and non-semantic refinements.
- Every pull request review MUST verify compliance with the principles that the
  change touches. A reviewer MAY block on a principle violation alone.
- Deviations are not granted informally. A deviation that is genuinely warranted
  becomes an amendment.

**Version**: 1.0.0 | **Ratified**: 2026-08-29 | **Last Amended**: 2026-08-29
