/**
 * `species_distribution_report` — the server's one prompt (FR-000b, FR-022).
 *
 * A prompt is the part of the surface a *person* invokes: it appears as a slash
 * command in most clients. That makes it the shortest path from "I have a
 * species in mind" to a correct answer, and it is worth carrying precisely
 * because the correct sequence is not obvious from the tool list alone.
 *
 * The workflow encodes composition *order* and nothing else. Tool semantics
 * live in the tool descriptions, where every client reads them; restating them
 * here would create two copies to keep in step, and the copy inside a prompt is
 * the one that silently rots.
 *
 * Two steps exist for reasons worth stating plainly:
 *
 *   - **Step 1's "do not pick one yourself"** keeps the never-guess rule
 *     (FR-036a) intact even when the server is driven by a one-shot command
 *     rather than a conversation that can ask a follow-up question.
 *   - **Step 4** names the failure this whole server is built to prevent: a
 *     model paging through occurrence records to answer a question that
 *     faceting already answered in one call (Principle II).
 *
 * Exact text from contracts/species-distribution-report.md.
 */
import * as z from 'zod'
import type { ToolContext } from '../server.js'

/**
 * Prompt arguments cross the wire as strings — the protocol has no other type
 * for them — so there is no validation to do here beyond requiring a species.
 * The country is passed through to `summarize_occurrences`, which is where the
 * ISO 3166-1 alpha-2 rule is enforced against a real filter (FR-011).
 */
const argsSchema = {
  species: z
    .string()
    .min(1)
    .describe("Scientific or common species name, e.g. 'Ursus maritimus' or 'polar bear'."),
  country: z
    .string()
    .optional()
    .describe('Optional ISO 3166-1 alpha-2 country code to narrow the report, e.g. CA.'),
}

const DESCRIPTION =
  'Produce a distribution report for a species: where it has been recorded, how that has changed over time, and the total number of records. Optionally narrowed to one country.'

/**
 * The workflow text.
 *
 * The country clause is interpolated rather than templated so that omitting it
 * leaves no trace — a dangling "in" or an empty placeholder is the kind of
 * artefact a model will try to interpret.
 */
export function buildWorkflow(species: string, country?: string): string {
  const scope = country ? ` in ${country}` : ''

  return `Produce a distribution report for **${species}**${scope}.

1. Call \`resolve_taxon\` with the name. If it returns an error naming several candidate taxa, stop
   and ask which one is meant — do not pick one yourself.
2. Call \`summarize_occurrences\` with the resolved taxonKey and dimensions \`["country", "year"]\`.
   One call answers both.
3. Write the report from those counts: where the species has been recorded, how that has changed
   over time, and the total number of records. State the total plainly, including when it is zero.
4. Do **not** call \`search_occurrences\` unless the user asks to see individual records. The
   summary answers the distribution question on its own.

Note any caveat the data carries — a truncated ranking, or counts that reflect recording effort
rather than true abundance.`
}

export function registerSpeciesDistributionReport(context: ToolContext): void {
  context.server.registerPrompt(
    'species_distribution_report',
    {
      title: 'Species distribution report',
      description: DESCRIPTION,
      argsSchema,
    },
    ({ species, country }) => ({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: buildWorkflow(species, country) },
        },
      ],
    }),
  )
}
