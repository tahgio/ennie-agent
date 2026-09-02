/**
 * `search_occurrences` — a bounded, trimmed page of individual records.
 *
 * Registered last of the three, and described in a way that actively steers
 * callers away from it for distribution questions. That is deliberate: listing
 * records is the exception, and a model that reaches for this to answer "where
 * has it been seen" will exhaust its context long before it has an answer that
 * `summarize_occurrences` produces in one call.
 *
 * The 50-record cap is enforced here rather than delegated, because GBIF
 * accepts `limit=500`, replies HTTP 200, and quietly returns 300 (research F7).
 * A cap that only exists upstream is not a cap; it is a page size the caller
 * did not ask for and is not told about.
 *
 * Description text is verbatim from contracts/search-occurrences.md.
 */
import * as z from 'zod'
import {
  DEFAULT_RECORD_LIMIT,
  filterShape,
  MAX_OFFSET_WINDOW,
  MAX_RECORD_LIMIT,
  validateFilters,
  validatePaging,
} from '../domain/filters.js'
import { ResolvedTaxonSchema } from '../domain/resolution.js'
import { selectTaxon } from '../domain/taxon-input.js'
import { OccurrenceRecordSchema, trimRecord } from '../domain/trim.js'
import { pageSearch } from '../gbif/occurrence.js'
import type { ToolContext } from '../server.js'
import { runTool } from './run-tool.js'

/** Exact text from contracts/search-occurrences.md. */
const DESCRIPTION = `Return individual GBIF occurrence records for a taxon, filtered by country, year range, and whether coordinates are present. Accepts a taxonKey from resolve_taxon, or a name it will resolve for you. Supplying both a taxonKey and a name is refused — pass exactly one, because the two can disagree and this tool will not guess which you meant. Returns at most 50 records (default 20), each trimmed to nine fields: the GBIF occurrence key, species, event date, country code, latitude, longitude, basis of record, dataset and publisher — the occurrence key is what you use to look a record up at its source. Also returns the total number of matches so you know the size of what you did not receive. **For "where", "when", or "how many" questions use summarize_occurrences instead** — it answers from counts without transporting records. Use this tool only when specific records are genuinely wanted.`

const outputShape = {
  taxonKey: z.number().int().describe('The GBIF taxon key these records are for.'),
  taxon: ResolvedTaxonSchema.nullable().describe(
    'The resolution, when a name was supplied. Null when the caller passed a taxonKey.',
  ),
  totalCount: z
    .number()
    .int()
    .describe('Total matching records upstream — usually far more than were returned.'),
  offset: z.number().int(),
  limit: z.number().int(),
  returnedCount: z.number().int(),
  records: z.array(OccurrenceRecordSchema),
}

export function registerSearchOccurrences(context: ToolContext): void {
  context.server.registerTool(
    'search_occurrences',
    {
      title: 'List individual occurrence records',
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
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_RECORD_LIMIT, {
            error: (issue) =>
              `A limit of ${String(issue.input)} exceeds this tool's cap of ${MAX_RECORD_LIMIT}. Request at most ${MAX_RECORD_LIMIT} records, or call summarize_occurrences for totals.`,
          })
          .optional()
          .describe(
            `Records per page, 1-${MAX_RECORD_LIMIT}. Defaults to ${DEFAULT_RECORD_LIMIT}.`,
          ),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            `Records to skip. offset + limit must stay within GBIF's ${MAX_OFFSET_WINDOW.toLocaleString('en-US')}-record window.`,
          ),
        ...filterShape,
      },
      outputSchema: outputShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, extra) => {
      return await runTool(context.server, 'search_occurrences', extra, async (run) => {
        const limit = args.limit ?? DEFAULT_RECORD_LIMIT
        const offset = args.offset ?? 0
        const filters = {
          country: args.country,
          yearFrom: args.yearFrom,
          yearTo: args.yearTo,
          hasCoordinate: args.hasCoordinate,
        }

        // Everything that can be judged locally is judged before a socket opens
        // (FR-011, FR-012) — including the paging window, whose upstream error
        // is a plain-text 400 that names the number but not the remedy.
        validateFilters(filters)
        validatePaging(limit, offset)

        const selection = await selectTaxon(
          { client: context.client, cache: context.cache },
          { taxonKey: args.taxonKey, name: args.name, budget: run.budget, signal: run.signal },
        )

        const response = await pageSearch(
          context.client,
          { taxonKey: selection.taxonKey, filters, limit, offset },
          { budget: run.budget, signal: run.signal },
        )

        run.stats.cache = selection.cache
        run.stats.upstreamRequests = selection.upstreamRequests + response.upstreamRequests
        run.stats.retries = selection.retries + response.retries

        const records = response.data.results.map(trimRecord)
        const page = {
          taxonKey: selection.taxonKey,
          taxon: selection.taxon,
          totalCount: response.data.count,
          offset,
          limit,
          returnedCount: records.length,
          records,
        }

        return { content: [{ type: 'text', text: renderPage(page) }], structuredContent: page }
      })
    },
  )
}

/**
 * The text leads with the total, because the number a caller most needs is the
 * one describing what they did *not* receive (FR-010).
 */
function renderPage(page: { totalCount: number; offset: number; returnedCount: number }): string {
  if (page.totalCount === 0) {
    return 'No records match these filters. The taxon and filters are valid; GBIF simply holds no occurrences for them.'
  }

  const total = page.totalCount.toLocaleString('en-US')
  const remaining = page.totalCount - (page.offset + page.returnedCount)
  const tail =
    remaining > 0
      ? ` ${remaining.toLocaleString('en-US')} further records match and were not returned; use summarize_occurrences if you want the distribution rather than the records.`
      : ''

  return `${total} records match; showing ${page.returnedCount} (offset ${page.offset}).${tail}`
}
