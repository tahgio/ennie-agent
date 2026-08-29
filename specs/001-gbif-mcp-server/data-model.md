# Phase 1 Data Model: GBIF Biodiversity MCP Server

**Date**: 2026-08-29 | **Spec**: [spec.md](./spec.md) | **Research**: [research.md](./research.md)

Types are written as Zod-flavoured pseudocode. Two layers are kept strictly apart:

- **Upstream schemas** parse GBIF. Lenient: unknown fields pass through, every field the code does
  not strictly require is nullable (Constitution IV).
- **Contract schemas** are what tools declare and return. Narrow, capped, and trimmed.

The transformation between them is where Principle II lives.

---

## 1. Upstream (lenient, parses GBIF)

### `GbifNameMatch` — `GET /v1/species/match?verbose=true`

```
{
  usageKey:         number | null      // absent on NONE — see F1
  acceptedUsageKey: number | null      // present when status === SYNONYM (F5)
  scientificName:   string | null
  canonicalName:    string | null
  rank:             string | null
  status:           string | null      // ACCEPTED | SYNONYM | DOUBTFUL | ...
  confidence:       number             // 0–100, and -1 on some alternatives (F2)
  matchType:        string             // EXACT | FUZZY | HIGHERRANK | NONE
  note:             string | null      // free text; never parsed
  kingdom..species: string | null      // classification, each rank nullable
  kingdomKey..speciesKey: number | null
  alternatives:     GbifNameMatch[]    // only under verbose=true (F2)
}.passthrough()
```

**Parsing rules**: `confidence` accepts negatives. `matchType` is a plain string, not an enum — an
unknown value must not throw; it falls through to "unresolved". Every classification rank is
independently nullable; GBIF omits ranks freely.

### `GbifSpeciesSearch` — `GET /v1/species/search?qField=VERNACULAR`

```
{
  count: number
  results: [{
    key:              number
    nubKey:           number | null    // null => not in the backbone; discard (F4)
    canonicalName:    string | null
    scientificName:   string | null
    rank:             string | null
    taxonomicStatus:  string | null
    kingdom:          string | null
    vernacularNames:  [{ vernacularName: string, language: string | null }]
  }].passthrough()
}.passthrough()
```

### `GbifOccurrenceSearch` — `GET /v1/occurrence/search`

```
{
  offset: number, limit: number, endOfRecords: boolean, count: number
  results: [ /* 95 fields, all optional to us */ ].passthrough()
  facets: [{ field: string, counts: [{ name: string, count: number }] }]
}.passthrough()
```

`facets` is absent when no `facet` parameter was sent — it defaults to `[]` rather than failing.
Facet `field` values arrive upper-snake (`COUNTRY`, `YEAR`, `BASIS_OF_RECORD`) and are mapped back
to contract dimension names (F6).

### `GbifError`

A 400 may return a **plain-text** body, not JSON (F8: `Max offset of 100001 exceeded: 100001 + 1`).
The error path reads text first and attempts JSON only opportunistically.

---

## 2. Contract entities (what tools expose)

### `ResolvedTaxon`

| Field | Type | Notes |
|-------|------|-------|
| `taxonKey` | `number` | **The accepted key.** For a synonym this is `acceptedUsageKey`, not `usageKey` (F5). This is the value the other two tools take. |
| `scientificName` | `string` | Canonical, without the authorship suffix. |
| `rank` | `string` | e.g. `SPECIES`, `GENUS`. |
| `classification` | `{ kingdom, phylum, class, order, family, genus, species }` | Each entry `string \| null`. |
| `confidence` | `number` | 0–100 as reported. |
| `matchType` | `"EXACT" \| "FUZZY" \| "VERNACULAR"` | `VERNACULAR` marks the common-name path (FR-003, Q1). |
| `wasSynonym` | `boolean` | True when the input matched a synonym. |
| `matchedName` | `string \| null` | The synonym as supplied; null when input was already accepted. |

**Invariant**: a `ResolvedTaxon` is only ever constructed for a match that passed the policy below.
There is no "low-confidence taxon" value in the type system — unresolved is an error, not a taxon.

### `OccurrenceRecord` — 95 upstream fields trimmed to 8 (F10)

| Field | Type | Source | Notes |
|-------|------|--------|-------|
| `key` | `number` | `key` | |
| `species` | `string \| null` | `species` | |
| `eventDate` | `string \| null` | `eventDate` | Explicitly null when absent, never defaulted. |
| `countryCode` | `string \| null` | **`countryCode`** | The ISO code, *not* the `country` display name — so the value round-trips as a filter input (F10, Principle III). |
| `latitude` | `number \| null` | `decimalLatitude` | |
| `longitude` | `number \| null` | `decimalLongitude` | |
| `basisOfRecord` | `string \| null` | `basisOfRecord` | |
| `dataset` | `{ name: string \| null, key: string \| null }` | `datasetName`, `datasetKey` | Attribution. |
| `publisher` | `string \| null` | `publishedByOrgName` | Frequently null upstream; surfaced as null. |

Nine keys, eight data fields. Everything else in the 95 is dropped.

### `OccurrencePage`

```
{ taxon: ResolvedTaxon, records: OccurrenceRecord[], totalCount: number,
  offset: number, limit: number, returnedCount: number }
```

`totalCount` is mandatory (FR-010): the caller must be able to see the size of what it did not
receive.

### `DistributionSummary`

```
{ taxon: ResolvedTaxon, totalCount: number,
  dimensions: [{ dimension: "country"|"year"|"basisOfRecord",
                 counts: [{ value: string, count: number }],
                 truncated: boolean, distinctValuesReturned: number }] }
```

Carries **no records** by construction (FR-013). `truncated` states plainly when a top-20 cut hid
values (FR-018).

### `FilterSet` — shared by both occurrence tools (FR-016)

| Field | Type | Constraint |
|-------|------|------------|
| `country` | `string?` | Exactly 2 chars, `/^[A-Z]{2}$/`, uppercased before validating. |
| `yearFrom` / `yearTo` | `number?` | Integer, 1000 ≤ y ≤ current year + 1. |
| `hasCoordinate` | `boolean?` | |

Four filters, chosen because a caller asks for them — not a mirror of GBIF's parameter list
(Principle III).

### `ToolError`

```
{ what: string, next: string, retryable: boolean }
```

`next` is **required**. "Invalid input" is unrepresentable (FR-024, Constitution V). Rendered into
an `isError: true` result carrying both sentences; never thrown (FR-023).

---

## 3. Validation rules

### Input, before any network call (FR-011, FR-012, Constitution IV)

| Rule | Error `what` → `next` |
|------|------------------------|
| `name` non-empty after trim | "The name was empty." → "Supply a scientific or common species name, e.g. 'Ursus maritimus' or 'polar bear'." |
| `country` matches `^[A-Z]{2}$` | "'{v}' is not a country code." → "Use a two-letter ISO 3166-1 alpha-2 code, e.g. 'CA' for Canada." |
| `yearFrom <= yearTo` | "The year range runs backwards ({from}–{to})." → "Swap the bounds so yearFrom is the earlier year." |
| `limit <= 50` | "A limit of {v} exceeds the cap of 50." → "Request at most 50 records, or use summarize_occurrences for totals." |
| `offset + limit <= 100000` | "Offset {v} passes GBIF's 100,000-record window." → "Narrow the filters or use summarize_occurrences instead of paging." |
| `dimensions` non-empty | "No summary dimensions were requested." → "Pass at least one of: country, year, basisOfRecord." |

The last two exist because GBIF will not catch them usefully: an oversized `limit` is **silently
clamped to 300** (F7), and an oversized offset returns a plain-text 400 (F8).

### Resolution policy (F1 — order is load-bearing)

```
1. matchType === "NONE" and alternatives is non-empty  -> AMBIGUOUS  (homonym, F2)
2. matchType === "NONE"                                -> try vernacular fallback (F3)
3. matchType === "HIGHERRANK"                          -> HIGHER_RANK error (FR-004a)
4. matchType === "EXACT"                               -> resolved
5. matchType === "FUZZY" and confidence >= 90          -> resolved
6. otherwise                                           -> LOW_CONFIDENCE error
```

**Step 1 must precede any confidence test.** GBIF reports both a homonym and a total non-match as
`matchType: NONE` with `confidence: 100`; testing confidence first accepts every failed lookup.

### Vernacular fallback (F4)

```
1. GET /species/search?q={name}&qField=VERNACULAR&rank=SPECIES
2. discard results where nubKey is null            (not in the backbone)
3. keep results whose vernacularNames contain the query, case-insensitive
   -- rank order is NOT trusted: "polar bear" ranks a sponge first
4. 0 survivors  -> NOT_FOUND      | >1 survivor -> AMBIGUOUS with candidates
5. exactly 1    -> re-resolve through the accepted taxon, matchType = "VERNACULAR"
```

Step 5 matters: the surviving hit for "polar bear" is *Thalarctos maritimus*, a **synonym**.

### Upstream response handling

Unknown fields tolerated; only depended-upon fields enforced; missing data becomes typed `null`,
never a default (Constitution IV). An output schema stricter than reality would convert a
successful call into a protocol fault, so every nullable-upstream field is `.nullable()` in the
declared `outputSchema` too.

---

## 4. Cache

| Property | Value |
|----------|-------|
| Scope | Taxon resolution only — never occurrences or summaries |
| Key | `name.trim().toLowerCase()` + rank hint + kingdom hint |
| Value | `ResolvedTaxon` **and** negative outcomes (an unresolvable name is asked repeatedly) |
| TTL | 1 hour; in-process `Map`, discarded at exit |
| Observability | Every tool log entry records `cache: "hit" \| "miss"` (FR-029, FR-030) |

## 5. Transformation summary

| Stage | Size |
|-------|------|
| GBIF occurrence record | 95 fields |
| Trimmed `OccurrenceRecord` | 8 fields |
| Max records per page | 50 (upstream would allow 300 and silently clamps above that) |
| Max ranked values per dimension | 20 |
| Records in a `DistributionSummary` | 0, by construction |
