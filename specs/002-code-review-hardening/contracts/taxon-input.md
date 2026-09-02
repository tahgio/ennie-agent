# Contract: Contradictory Taxon Input

**Delta to**: [`search-occurrences.md`](../../001-gbif-mcp-server/contracts/search-occurrences.md)
and [`summarize-occurrences.md`](../../001-gbif-mcp-server/contracts/summarize-occurrences.md).
**Requirements**: FR-028 – FR-030 · **Decision**: [D8](../research.md#d8--contradictory-taxon-inputs-are-refused)
**Clarification**: Session 2026-09-02, Question 1.

Both occurrence tools accept *either* a `taxonKey` from `resolve_taxon` *or* a `name` to resolve.
Supplying both has until now selected the key and discarded the name with no signal on any channel.

## The change

| Input | Before | After |
|---|---|---|
| `taxonKey` only | query the key; `taxon` is `null` | **unchanged** (FR-030) |
| `name` only | resolve, then query | **unchanged** (FR-030) |
| both | key wins, name silently discarded | **`isError: true`**, `CONTRADICTORY_TAXON` |
| neither | `MISSING_TAXON` | **unchanged** |

This is the one place the feature deliberately changes a previously-succeeding input shape. FR-049
carves it out for exactly this reason.

## The failure

Raised in `selectTaxon`, **before any upstream request**, so it costs nothing and cannot be
attributed to GBIF.

```jsonc
{
  "isError": true,
  "content": [{
    "type": "text",
    "text": "Both taxonKey (2433451) and name ('Puma concolor') were supplied, and they may not describe the same taxon. Pass taxonKey alone to query the key you already resolved, or name alone to resolve it here."
  }]
}
```

- `code`: `CONTRADICTORY_TAXON`
- `retryable`: `false` — repeating the identical call cannot succeed.
- `what` names **both** supplied values. Naming only one would leave the caller guessing which we
  objected to.
- `next` names both remedies and what each means, so the model can choose on its next turn using
  the text alone (Constitution V).
- No `structuredContent`, consistent with every other failure: an `outputSchema` describes the
  success shape.

## Why refuse rather than report

Every other genuinely ambiguous input in this system is returned to the caller as a recoverable
question rather than resolved by a silent choice — a homonym across kingdoms, a weak fuzzy match, a
name that reaches only a genus. A silent precedence rule is the single exception, and it is the one
that can label polar bear counts with nothing.

The refusal applies **whether or not the two agree**. Checking agreement would require resolving the
name — the exact upstream request the `taxonKey` form exists to avoid — so the system declines to
guess in both cases (spec Edge Cases).

## Prompt surface (FR-029)

Both tool descriptions state the behaviour. Today they say "Supply this or `name`", which is
guidance; the description must say what happens when both are supplied, so a model can predict the
refusal rather than discover it.

Descriptions are prompt surface and reviewed as code (Constitution I).

## How it is observed

- A protocol test issues a request carrying both and asserts `isError: true`, the text naming both
  values, and that **no upstream request was made**.
- Protocol tests for the key-only and name-only paths already exist and must pass unmodified —
  that is FR-030 stated as a test.
