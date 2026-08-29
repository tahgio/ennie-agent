/**
 * `summarize_occurrences` — the tool this server exists for.
 *
 * It answers "where", "when" and "how many" from GBIF's own aggregation and
 * transports no individual records at all. The absence of records is
 * **structural**: there is no `records` field anywhere in the output schema, so
 * the guarantee cannot quietly erode into a convention that someone forgets
 * (FR-013, Principle II).
 *
 * The description is prompt surface, reproduced verbatim from
 * contracts/summarize-occurrences.md. It states outright that this tool is
 * preferred for distribution questions, because the failure mode the whole
 * design exists to prevent is a model paging through thousands of records to
 * compute something faceting already answered in one call.
 */
import * as z from 'zod'
import { DEFAULT_TOP_N, filterShape, MAX_TOP_N, validateFilters } from '../domain/filters.js'
import { ResolvedTaxonSchema } from '../domain/resolution.js'
import { selectTaxon } from '../domain/taxon-input.js'
import { ToolError } from '../errors.js'
import {
  DIMENSIONS,
  type Dimension,
  facetSearch,
  mapFacetsToDimensions,
} from '../gbif/occurrence.js'
import type { ToolContext } from '../server.js'
import { runTool } from './run-tool.js'

/** Exact text from contracts/summarize-occurrences.md. */
const DESCRIPTION = `**Preferred tool for "where", "when", and "how many" questions.** Answers distribution questions about a species using GBIF's own aggregation: it returns a total count plus ranked counts by country, year, and/or basis of record, and transports no individual records at all. One call replaces paging through thousands of records, and the response is the same size whether the species has a hundred occurrences or ten million. Accepts a taxonKey from resolve_taxon, or a name it will resolve for you. Reach for this before search_occurrences.`

const dimensionCountSchema = z.object({
  value: z.string(),
  count: z.number().int(),
})

const dimensionSummarySchema = z.object({
  dimension: z.enum(DIMENSIONS),
  counts: z.array(dimensionCountSchema),
  truncated: z.boolean().describe('True when topN hid values that exist upstream.'),
  distinctValuesReturned: z.number().int(),
})

/**
 * Note what is *not* here: no `records`, and no field that could carry one.
 */
const outputShape = {
  taxonKey: z.number().int().describe('The GBIF taxon key these counts are for.'),
  taxon: ResolvedTaxonSchema.nullable().describe(
    'The resolution, when a name was supplied. Null when the caller passed a taxonKey, because nothing was resolved.',
  ),
  totalCount: z.number().int().describe('Total matching occurrences. Zero is a valid answer.'),
  dimensions: z.array(dimensionSummarySchema),
}

export function registerSummarizeOccurrences(context: ToolContext): void {
  context.server.registerTool(
    'summarize_occurrences',
    {
      title: 'Summarise occurrences by country, year, or basis of record',
      description: DESCRIPTION,
      inputSchema: {
        taxonKey: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('A taxon key from resolve_taxon. Supply this or name.'),
        name: z
          .string()
          .optional()
          .describe('A species name, resolved internally. Supply this or taxonKey.'),
        dimensions: z
          .array(z.enum(DIMENSIONS))
          .min(1, {
            error:
              'No summary dimensions were requested. Pass at least one of: country, year, basisOfRecord.',
          })
          .describe('Which breakdowns to return. Several cost the same single upstream request.'),
        topN: z
          .number()
          .int()
          .min(1)
          .max(MAX_TOP_N, {
            error: (issue) =>
              `A topN of ${String(issue.input)} exceeds the cap of ${MAX_TOP_N}. Request at most ${MAX_TOP_N} values per dimension.`,
          })
          .optional()
          .describe(`Values per dimension, 1-${MAX_TOP_N}. Defaults to ${DEFAULT_TOP_N}.`),
        ...filterShape,
      },
      outputSchema: outputShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, extra) => {
      return await runTool(context.server, 'summarize_occurrences', extra, async (run) => {
        const dimensions = uniqueDimensions(args.dimensions)
        const filters = {
          country: args.country,
          yearFrom: args.yearFrom,
          yearTo: args.yearTo,
          hasCoordinate: args.hasCoordinate,
        }
        // Every input rule is applied before a socket is opened (FR-011/FR-012).
        validateFilters(filters)

        const topN = args.topN ?? DEFAULT_TOP_N

        const selection = await selectTaxon(
          { client: context.client, cache: context.cache },
          {
            taxonKey: args.taxonKey,
            name: args.name,
            budget: run.budget,
            signal: run.signal,
          },
        )

        const response = await facetSearch(
          context.client,
          { taxonKey: selection.taxonKey, filters, dimensions, topN },
          { budget: run.budget, signal: run.signal },
        )

        run.stats.cache = selection.cache
        run.stats.upstreamRequests = selection.upstreamRequests + response.upstreamRequests
        run.stats.retries = selection.retries + response.retries

        const summary = {
          taxonKey: selection.taxonKey,
          taxon: selection.taxon,
          totalCount: response.data.count,
          dimensions: mapFacetsToDimensions(response.data.facets, dimensions, topN),
        }

        return {
          content: [{ type: 'text', text: renderSummary(summary) }],
          structuredContent: summary,
        }
      })
    },
  )
}

/**
 * Duplicates would ask GBIF for the same facet twice and produce a repeated
 * block in the answer, so they are collapsed rather than rejected — the caller's
 * intent is unambiguous.
 */
function uniqueDimensions(requested: readonly Dimension[]): Dimension[] {
  const unique = [...new Set(requested)]
  if (unique.length === 0) {
    throw new ToolError({
      code: 'NO_DIMENSIONS',
      what: 'No summary dimensions were requested.',
      next: 'Pass at least one of: country, year, basisOfRecord.',
      retryable: false,
    })
  }
  return unique
}

const LABELS: Record<Dimension, string> = {
  country: 'countries',
  year: 'years',
  basisOfRecord: 'bases of record',
}

/**
 * The text block leads with the total, because the total is the part a reader
 * needs to judge everything else — and it is stated even when it is zero
 * (FR-013 edge case), since "no records" is an answer, not a failure.
 */
function renderSummary(summary: {
  totalCount: number
  dimensions: ReadonlyArray<{
    dimension: Dimension
    counts: ReadonlyArray<{ value: string; count: number }>
    truncated: boolean
  }>
}): string {
  const total = summary.totalCount.toLocaleString('en-US')

  if (summary.totalCount === 0) {
    return 'No records match these filters. The taxon and filters are valid; GBIF simply holds no occurrences for them.'
  }

  const parts = summary.dimensions.map((dimension) => {
    if (dimension.counts.length === 0) return `No ${LABELS[dimension.dimension]} reported.`
    const ranked = dimension.counts
      .map((count) => `${count.value} ${count.count.toLocaleString('en-US')}`)
      .join(' · ')
    const tail = dimension.truncated ? ' — more not shown' : ''
    return `Top ${LABELS[dimension.dimension]}: ${ranked}${tail}.`
  })

  return `${total} records total. ${parts.join(' ')}`
}
