# Server `instructions`

Requirements: FR-021. Sent at initialize, so **every** client receives this guidance — not only the
bundled agent (Constitution I: instructions are prompt surface).

## Exact text

> Tools for querying GBIF, the global biodiversity occurrence index (billions of species
> observation and specimen records).
>
> **Composition.** GBIF is keyed by numeric taxon identifiers, not names. Call `resolve_taxon`
> first; pass the taxonKey it returns to the other tools. Both other tools also accept a raw name
> and will resolve it internally, but resolving explicitly lets you see and confirm which taxon was
> matched.
>
> **Prefer summaries.** For "where", "when", or "how many" questions, call
> `summarize_occurrences`. It aggregates inside GBIF and returns counts only — one call, a bounded
> response, whether the species has a hundred records or ten million. Use `search_occurrences` only
> when individual records are genuinely wanted; it returns at most 50 per call and paging through a
> large result set will exhaust your context long before it answers a distribution question.
>
> **Errors are recoverable.** A failed tool result names what went wrong and what to try instead —
> a corrected spelling, a kingdom hint to break a homonym, a narrower filter. Act on it rather than
> retrying the same call.
>
> **Interpretation.** Occurrence counts reflect recording effort as well as true distribution.
> Well-surveyed countries dominate the rankings. Say so when it matters to the answer.

## Design notes

Four short sections, each earning its place: the identifier problem (which is why the server exists
at all), the context-economy steer, the error contract, and the one domain caveat a model will
otherwise get wrong. Written to be read by a model with no biodiversity background, and kept short
because it is prepended to every conversation with this server — instructions long enough to be
skimmed past defeat their own purpose.
