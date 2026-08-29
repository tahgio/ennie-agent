/**
 * The `instructions` string sent at initialize (FR-021).
 *
 * This is prompt surface, and it is reviewed as carefully as code
 * (Constitution I). It reaches *every* client, not just the agent in this
 * repository — which is the point. Guidance that lived only in the bundled
 * agent would leave a third-party client to rediscover, by trial and error,
 * that paging through records is the wrong way to answer "where".
 *
 * Four sections, each earning its place: the identifier problem (which is why
 * this server exists at all), the context-economy steer, the error contract,
 * and the one domain caveat a model will otherwise get wrong. It is kept short
 * on purpose — it is prepended to every conversation with this server, and
 * instructions long enough to be skimmed past defeat their own purpose.
 *
 * Exact text from contracts/server-instructions.md.
 */
export const SERVER_INSTRUCTIONS = `Tools for querying GBIF, the global biodiversity occurrence index (billions of species observation and specimen records).

**Composition.** GBIF is keyed by numeric taxon identifiers, not names. Call \`resolve_taxon\` first; pass the taxonKey it returns to the other tools. Both other tools also accept a raw name and will resolve it internally, but resolving explicitly lets you see and confirm which taxon was matched.

**Prefer summaries.** For "where", "when", or "how many" questions, call \`summarize_occurrences\`. It aggregates inside GBIF and returns counts only — one call, a bounded response, whether the species has a hundred records or ten million. Use \`search_occurrences\` only when individual records are genuinely wanted; it returns at most 50 per call and paging through a large result set will exhaust your context long before it answers a distribution question.

**Errors are recoverable.** A failed tool result names what went wrong and what to try instead — a corrected spelling, a kingdom hint to break a homonym, a narrower filter. Act on it rather than retrying the same call.

**Interpretation.** Occurrence counts reflect recording effort as well as true distribution. Well-surveyed countries dominate the rankings. Say so when it matters to the answer.`
