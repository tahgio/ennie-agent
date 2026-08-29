# Tool: `summarize_occurrences`

Requirements: FR-000a, FR-013 – FR-018. Research: F6.

## Description (prompt surface — exact text)

> **Preferred tool for "where", "when", and "how many" questions.** Answers distribution questions
> about a species using GBIF's own aggregation: it returns a total count plus ranked counts by
> country, year, and/or basis of record, and transports no individual records at all. One call
> replaces paging through thousands of records, and the response is the same size whether the
> species has a hundred occurrences or ten million. Accepts a taxonKey from resolve_taxon, or a
> name it will resolve for you. Reach for this before search_occurrences.

## Input

| Field | Type | Required | Constraint |
|-------|------|----------|------------|
| `taxonKey` | integer | one of | Positive. |
| `name` | string | one of | Resolved internally. |
| `dimensions` | array | yes | Non-empty, unique, from `country \| year \| basisOfRecord`. |
| `country` / `yearFrom` / `yearTo` / `hasCoordinate` | | no | Identical to `search_occurrences` (FR-016). |
| `topN` | integer | no | 1–**20**, default 10. Values per dimension. |

## Output (`structuredContent`)

```
{ taxon: ResolvedTaxon, totalCount,
  dimensions: [{ dimension, counts: [{ value, count }],
                 truncated, distinctValuesReturned }] }
```

No `records` field exists on this schema (FR-013) — the guarantee is structural, not a convention.
`truncated` states plainly when a `topN` cut hid values (FR-018).

Text block: `11,141 records total. Top countries: CA 3,554 · US 2,788 · GL 1,251 …`

## Errors

Same filter-validation and upstream errors as [search-occurrences.md](./search-occurrences.md), plus:

| Condition | `what` | `next` |
|-----------|--------|--------|
| `NO_DIMENSIONS` | "No summary dimensions were requested." | "Pass at least one of: country, year, basisOfRecord." |

Zero matches is a success, not an error: `totalCount: 0`, empty counts, and text stating no records
matched these filters.

## Behavioural notes

1. One upstream request: `occurrence/search?…&limit=0&facet=…`, which returns counts and an empty
   `results[]` (F6). This is the mechanism behind Principle II.
2. Multiple dimensions are multiple `facet` parameters on the **same** request, so an N-dimension
   summary still costs one call.
3. `topN` maps to the per-facet `{facet}.facetLimit` form, verified working.
4. GBIF returns facet fields upper-snake (`COUNTRY`, `BASIS_OF_RECORD`); they are mapped back to the
   contract's dimension names, and an unrecognised facet field is dropped rather than throwing.
