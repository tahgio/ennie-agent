# Tool: `resolve_taxon`

Requirements: FR-000a, FR-001 – FR-005, FR-004a. Research: F1–F5.

## Description (prompt surface — exact text)

> Resolve a scientific or common species name to an accepted GBIF taxon. Call this first: the other
> tools take a taxonKey, and this tool absorbs the ambiguity of biological naming — synonyms,
> misspellings, and names shared across kingdoms. Returns the accepted taxon key, canonical name,
> rank, and full classification. Exact matches and close fuzzy matches (confidence 90+) resolve; a
> weaker match, a name that reaches only a genus or family, or a name borne by taxa in more than one
> kingdom returns an error naming what to try next rather than a guess.

## Input

| Field | Type | Required | Constraint |
|-------|------|----------|------------|
| `name` | string | yes | 1–200 chars, trimmed non-empty. Scientific or common. |
| `rank` | enum | no | `SPECIES \| GENUS \| FAMILY \| ORDER \| CLASS \| PHYLUM \| KINGDOM`. Disambiguation hint only. |
| `kingdom` | enum | no | `Animalia \| Plantae \| Fungi \| Bacteria \| Archaea \| Protozoa \| Chromista \| Viruses`. Disambiguation hint only. |

`rank` and `kingdom` exist solely to break ambiguity (FR-002) — they are not pass-through
parameters (Principle III).

## Output (`structuredContent`)

```
{ taxonKey, scientificName, rank,
  classification: { kingdom, phylum, class, order, family, genus, species },  // each nullable
  confidence, matchType: "EXACT"|"FUZZY"|"VERNACULAR",
  wasSynonym, matchedName }
```

`taxonKey` is the **accepted** key: for a synonym it is `acceptedUsageKey`, so downstream counts are
not silently wrong (F5).

Text block: `Ursus maritimus (SPECIES, key 2433451) — Animalia > Chordata > Mammalia > Carnivora >
Ursidae. Matched EXACT at confidence 98.`

## Errors

| Condition | `what` | `next` |
|-----------|--------|--------|
| `AMBIGUOUS` (homonym) | "'Prunella' matches several taxa in different kingdoms: Prunella L. (Plantae, key 2926553), Prunella Vieillot, 1816 (Animalia, key 2495070)." | "Re-request with a kingdom hint, or call again with the taxonKey you want." |
| `NOT_FOUND` | "No GBIF taxon matches 'Zzzzqqq xxxxyy'." | "Check the spelling, or try the scientific name if you used a common one." |
| `LOW_CONFIDENCE` | "The closest match to '{name}' is {sci} at confidence {c}, below the 90 required." | "Confirm the spelling, or pass rank/kingdom to narrow the search." |
| `HIGHER_RANK` | "'Puma notarealspecies' matches only the genus Puma (key 2435098), not a species." | "Supply a full species name, or use taxonKey 2435098 to query the whole genus." |
| `UPSTREAM_*` | see [search-occurrences.md](./search-occurrences.md) | |

## Behavioural notes

1. Always calls GBIF with `verbose=true` — homonym candidates exist nowhere else (F2).
2. Evaluates `matchType` **before** confidence. GBIF returns `confidence: 100` on `matchType: NONE`,
   so a confidence-first check accepts every failed lookup (F1).
3. Common names never match `species/match` (F3) and fall through to the vernacular path, which
   filters on `nubKey` and verifies the query against `vernacularNames` rather than trusting rank
   order (F4).
4. Results and negative outcomes are cached for 1 hour in-process; the log entry records hit/miss.
