/**
 * `resolve_taxon` — name in, one accepted taxon out, or a recoverable error.
 *
 * The description below is **prompt surface** and is reproduced verbatim from
 * contracts/resolve-taxon.md. It is what a model reads when deciding which tool
 * to reach for, so it is versioned as carefully as code and changed with the
 * same deliberation (Constitution I, FR-019).
 */
import * as z from 'zod'
import { ResolvedTaxonSchema, resolveTaxon } from '../domain/resolution.js'
import type { ToolContext } from '../server.js'
import { runTool, type ToolResult } from './run-tool.js'

/** Exact text from contracts/resolve-taxon.md. */
const DESCRIPTION = `Resolve a scientific or common species name to an accepted GBIF taxon. Call this first: the other tools take a taxonKey, and this tool absorbs the ambiguity of biological naming — synonyms, misspellings, and names shared across kingdoms. Returns the accepted taxon key, canonical name, rank, and full classification. Exact matches and close fuzzy matches (confidence 90+) resolve; a weaker match, a name that reaches only a genus or family, or a name borne by taxa in more than one kingdom returns an error naming what to try next rather than a guess.`

/**
 * `rank` and `kingdom` exist solely to break ambiguity (FR-002). They are not
 * pass-through parameters — GBIF exposes a great many more, and every one we
 * added would be another thing for a model to reason about (Principle III).
 */
export const RANK_HINTS = [
  'SPECIES',
  'GENUS',
  'FAMILY',
  'ORDER',
  'CLASS',
  'PHYLUM',
  'KINGDOM',
] as const

export const KINGDOM_HINTS = [
  'Animalia',
  'Plantae',
  'Fungi',
  'Bacteria',
  'Archaea',
  'Protozoa',
  'Chromista',
  'Viruses',
] as const

export const resolveTaxonInputShape = {
  name: z
    .string()
    .min(1, { error: 'The name was empty. Supply a scientific or common species name.' })
    .max(200, {
      error: 'That name is longer than 200 characters. Supply a single species name.',
    })
    .describe("A scientific or common species name, e.g. 'Ursus maritimus' or 'polar bear'."),
  rank: z
    .enum(RANK_HINTS)
    .optional()
    .describe('Disambiguation hint only. Narrows the search when a name is shared across ranks.'),
  kingdom: z
    .enum(KINGDOM_HINTS)
    .optional()
    .describe(
      "Disambiguation hint only. Use it to break a homonym, e.g. kingdom 'Plantae' for Prunella.",
    ),
}

export function registerResolveTaxon(context: ToolContext): void {
  context.server.registerTool(
    'resolve_taxon',
    {
      title: 'Resolve a species name to a GBIF taxon',
      description: DESCRIPTION,
      inputSchema: resolveTaxonInputShape,
      // Declared so clients get structured output and the SDK validates what we
      // send. Every field GBIF may omit is nullable, because an output schema
      // stricter than reality turns a good response into a protocol fault (D8).
      outputSchema: ResolvedTaxonSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, extra) => {
      return await runTool(context.server, 'resolve_taxon', extra, async (run) => {
        const outcome = await resolveTaxon(
          { client: context.client, cache: context.cache },
          {
            name: args.name,
            rank: args.rank,
            kingdom: args.kingdom,
            budget: run.budget,
            signal: run.signal,
          },
        )

        run.stats.cache = outcome.cache
        run.stats.upstreamRequests = outcome.upstreamRequests
        run.stats.retries = outcome.retries

        return taxonResult(outcome.taxon)
      })
    },
  )
}

/**
 * Structured content plus a human-readable line (FR-020).
 *
 * The text block is not decoration: clients that do not render structured
 * output show only this, so it has to carry the whole answer — the name, the
 * key the caller needs next, and how confident the match was.
 */
function taxonResult(taxon: z.infer<typeof ResolvedTaxonSchema>): ToolResult {
  const lineage = [
    taxon.classification.kingdom,
    taxon.classification.phylum,
    taxon.classification.class,
    taxon.classification.order,
    taxon.classification.family,
  ]
    .filter((rank): rank is string => rank !== null)
    .join(' > ')

  const synonymNote =
    taxon.wasSynonym && taxon.matchedName !== null
      ? ` Supplied as '${taxon.matchedName}', which is a synonym; the accepted taxon is used.`
      : ''

  const text =
    `${taxon.scientificName} (${taxon.rank}, key ${taxon.taxonKey})` +
    `${lineage === '' ? '' : ` — ${lineage}`}. ` +
    `Matched ${taxon.matchType} at confidence ${taxon.confidence}.${synonymNote}`

  return { content: [{ type: 'text', text }], structuredContent: taxon }
}
