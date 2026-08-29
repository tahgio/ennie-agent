# Prompt: `species_distribution_report`

Requirements: FR-000b, FR-022.

An MCP prompt, so it surfaces in clients as a user-invocable command (a slash command in most).

## Arguments

| Name | Required | Description |
|------|----------|-------------|
| `species` | yes | Scientific or common species name. |
| `country` | no | ISO 3166-1 alpha-2 code to narrow the report. |

## Returned messages

A single `user` message carrying the workflow. Exact text:

> Produce a distribution report for **{species}**{ in {country}}.
>
> 1. Call `resolve_taxon` with the name. If it returns an error naming several candidate taxa, stop
>    and ask which one is meant — do not pick one yourself.
> 2. Call `summarize_occurrences` with the resolved taxonKey and dimensions `["country", "year"]`.
>    One call answers both.
> 3. Write the report from those counts: where the species has been recorded, how that has changed
>    over time, and the total number of records. State the total plainly, including when it is zero.
> 4. Do **not** call `search_occurrences` unless the user asks to see individual records. The
>    summary answers the distribution question on its own.
>
> Note any caveat the data carries — a truncated ranking, or counts that reflect recording effort
> rather than true abundance.

## Design notes

The prompt encodes the composition order rather than restating tool semantics, which live in the
tool descriptions. Step 4 exists because the failure mode this server is built to prevent is a
model paging through records to answer a question that faceting already answered (Principle II).
Step 1 keeps the "never guess silently" rule intact at the workflow level, matching the agent's
clarification behaviour (FR-036a).

The final caveat line is a scientific-integrity point, not decoration: GBIF occurrence counts
measure observation effort, and a naive reading overstates abundance in well-surveyed countries.
