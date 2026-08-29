# Tool: `search_occurrences`

Requirements: FR-000a, FR-006 – FR-012. Research: F7–F10.

## Description (prompt surface — exact text)

> Return individual GBIF occurrence records for a taxon, filtered by country, year range, and
> whether coordinates are present. Accepts a taxonKey from resolve_taxon, or a name it will resolve
> for you. Returns at most 50 records (default 20), trimmed to species, date, country, coordinates,
> basis of record, dataset and publisher, plus the total number of matches so you know the size of
> what you did not receive. **For "where", "when", or "how many" questions use
> summarize_occurrences instead** — it answers from counts without transporting records. Use this
> tool only when specific records are genuinely wanted.

## Input

| Field | Type | Required | Constraint |
|-------|------|----------|------------|
| `taxonKey` | integer | one of | Positive. From `resolve_taxon`. |
| `name` | string | one of | Resolved internally; same policy and errors as `resolve_taxon`. |
| `country` | string | no | ISO 3166-1 alpha-2, `^[A-Z]{2}$`. |
| `yearFrom` / `yearTo` | integer | no | 1000 ≤ y ≤ current year + 1. |
| `hasCoordinate` | boolean | no | |
| `limit` | integer | no | 1–**50**, default 20. |
| `offset` | integer | no | ≥ 0, and `offset + limit <= 100000`. |

Exactly one of `taxonKey` or `name` (FR-006).

## Output (`structuredContent`)

```
{ taxon: ResolvedTaxon, totalCount, offset, limit, returnedCount,
  records: [{ key, species, eventDate, countryCode, latitude, longitude,
              basisOfRecord, dataset: { name, key }, publisher }] }
```

`countryCode` is the ISO code, not GBIF's display name, so a value from this tool is valid as this
tool's `country` input (F10, Principle III). Every record field except `key` is nullable — records
routinely lack dates, coordinates, and publisher, and absence is reported as `null`, never
defaulted (FR-009).

Text block leads with the total: `11,141 records match; showing 20 (offset 0).`

## Errors

| Condition | `what` | `next` |
|-----------|--------|--------|
| `INVALID_COUNTRY` | "'USA' is not a country code." | "Use a two-letter ISO 3166-1 alpha-2 code — 'US' for the United States." |
| `INVALID_YEAR_RANGE` | "The year range runs backwards (2010–2000)." | "Swap the bounds so yearFrom is the earlier year." |
| `LIMIT_EXCEEDED` | "A limit of 500 exceeds this tool's cap of 50." | "Request at most 50 records, or call summarize_occurrences for totals." |
| `OFFSET_EXCEEDED` | "Offset 100001 passes GBIF's 100,000-record window." | "Narrow the filters, or use summarize_occurrences instead of paging." |
| `UPSTREAM_RATE_LIMITED` | "GBIF is rate limiting; {n} retries did not clear it." | "Retry in about {retryAfter}s, or narrow the query." |
| `UPSTREAM_TIMEOUT` | "GBIF did not respond within the {n}s budget for this call." | "Retry, or narrow the filters to make the query cheaper upstream." |
| `UPSTREAM_UNAVAILABLE` | "GBIF returned {status} after {n} retries." | "Retry shortly; if it persists GBIF may be having an outage." |

Empty result is **not** an error: `totalCount: 0`, `records: []`, and text saying no records matched
these filters (FR-013 edge case).

## Behavioural notes

1. All input validation happens before any network call (FR-011, FR-012).
2. The 50 cap is enforced locally because GBIF **silently clamps** an oversized limit to 300 and
   returns HTTP 200 — delegating the cap upstream would return a different page size than requested
   without saying so (F7).
3. The offset ceiling is checked locally; GBIF's own 400 body is plain text, not JSON (F8).
