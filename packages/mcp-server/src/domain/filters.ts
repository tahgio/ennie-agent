/**
 * The filter set shared by both occurrence tools (FR-016, data-model §2).
 *
 * Four filters, and only four. They are here because a caller actually asks for
 * them — "where", "when", "only mapped records" — not because GBIF happens to
 * expose a hundred parameters (Principle III). A parameter that exists solely
 * to mirror the upstream API is a parameter a model has to reason about for no
 * benefit.
 *
 * Everything in this file runs *before* any network call (FR-011, FR-012).
 * That is partly latency, but mostly message quality: GBIF answers a backwards
 * year range with `Invalid range: (2010,2000)` and a bad code with
 * `Cannot parse XX into a known Country` (research F9), neither of which tells
 * a model what to do next.
 *
 * Two different mechanisms are used, deliberately:
 *
 *   - **Single-field rules live in the Zod schema**, with a custom message.
 *     The constraint then appears in the JSON Schema the model reads *and*
 *     the rejection still carries a what/next sentence.
 *   - **Cross-field rules live in `validate*` functions** called by the
 *     handler, because a `ToolError` there renders exactly the contract text,
 *     without the SDK's validation-error prefix.
 */
import * as z from 'zod'
import { ToolError } from '../errors.js'

/** GBIF's own paging window; beyond it the API returns a plain-text 400 (F8). */
export const MAX_OFFSET_WINDOW = 100_000
/** Records per page. Never delegated upstream — GBIF silently clamps to 300 (F7). */
export const MAX_RECORD_LIMIT = 50
export const DEFAULT_RECORD_LIMIT = 20
/** Ranked values per summary dimension (FR-018). */
export const MAX_TOP_N = 20
export const DEFAULT_TOP_N = 10

export const MIN_YEAR = 1000
export const maxYear = (now: Date = new Date()): number => now.getFullYear() + 1

/**
 * Uppercased before it is validated, so `ca` and `CA` are both accepted and
 * `USA` is not. The normalisation is why this is a transform rather than a
 * plain `.regex()`: the value that reaches GBIF is always the canonical form.
 */
export const countrySchema = z
  .string()
  .transform((value) => value.trim().toUpperCase())
  .refine((value) => /^[A-Z]{2}$/.test(value), {
    error: (issue) =>
      `'${String(issue.input)}' is not a country code. Use a two-letter ISO 3166-1 alpha-2 code, e.g. 'CA' for Canada.`,
  })
  .describe(
    "ISO 3166-1 alpha-2 country code — two letters, e.g. 'CA' for Canada or 'US' for the United States. Case-insensitive.",
  )

const yearSchema = (label: 'yearFrom' | 'yearTo') =>
  z
    .number()
    .int()
    .min(MIN_YEAR, {
      error: (issue) =>
        `${label} of ${String(issue.input)} is earlier than ${MIN_YEAR}, before which GBIF holds no dated records. Use a year between ${MIN_YEAR} and ${maxYear()}.`,
    })
    .max(maxYear(), {
      error: (issue) =>
        `${label} of ${String(issue.input)} is in the future. Use a year no later than ${maxYear()}.`,
    })

/**
 * The shared shape fragment. Both occurrence tools spread this into their input
 * schema, so the two tools cannot drift apart (FR-016).
 */
export const filterShape = {
  country: countrySchema.optional(),
  yearFrom: yearSchema('yearFrom')
    .optional()
    .describe(`Earliest year of the event date, inclusive. ${MIN_YEAR} or later.`),
  yearTo: yearSchema('yearTo')
    .optional()
    .describe('Latest year of the event date, inclusive. Must not be earlier than yearFrom.'),
  hasCoordinate: z
    .boolean()
    .optional()
    .describe(
      'When true, only records carrying latitude and longitude. Useful for mapping; it also excludes records that are real but unmapped.',
    ),
}

export const FilterSetSchema = z.object(filterShape)
export type FilterSet = z.infer<typeof FilterSetSchema>

/**
 * The cross-field rule Zod cannot express field by field.
 *
 * Contract text (data-model §3): naming both bounds is what lets the model fix
 * the call without guessing which one we objected to.
 */
export function validateFilters(filters: FilterSet): void {
  const { yearFrom, yearTo } = filters
  if (yearFrom !== undefined && yearTo !== undefined && yearFrom > yearTo) {
    throw new ToolError({
      code: 'INVALID_YEAR_RANGE',
      what: `The year range runs backwards (${yearFrom}–${yearTo}).`,
      next: 'Swap the bounds so yearFrom is the earlier year.',
      retryable: false,
    })
  }
}

/**
 * GBIF's 100,000-record paging window (F8).
 *
 * Checked here rather than upstream because the upstream answer is a 400 with
 * the body `Max offset of 100001 exceeded: 100001 + 1`, which names the number
 * but not the remedy — and the remedy is usually to stop paging altogether and
 * ask for a summary instead.
 */
export function validatePaging(limit: number, offset: number): void {
  if (offset + limit > MAX_OFFSET_WINDOW) {
    throw new ToolError({
      code: 'OFFSET_EXCEEDED',
      what: `Offset ${offset} with a limit of ${limit} passes GBIF's ${MAX_OFFSET_WINDOW.toLocaleString('en-US')}-record window.`,
      next: 'Narrow the filters, or use summarize_occurrences instead of paging.',
      retryable: false,
    })
  }
}

/**
 * Translate the filter set into GBIF query parameters.
 *
 * GBIF expresses a year range as a single `year=from,to` parameter. An
 * open-ended range is closed against the allowed bounds rather than sent as a
 * wildcard, which keeps the request explicit about what it asked for.
 */
export function toGbifFilterParams(
  filters: FilterSet,
  now: Date = new Date(),
): Record<string, string | boolean | undefined> {
  const params: Record<string, string | boolean | undefined> = {}

  if (filters.country !== undefined) params.country = filters.country
  if (filters.hasCoordinate !== undefined) params.hasCoordinate = filters.hasCoordinate

  const { yearFrom, yearTo } = filters
  if (yearFrom !== undefined || yearTo !== undefined) {
    const from = yearFrom ?? MIN_YEAR
    const to = yearTo ?? maxYear(now)
    params.year = from === to ? String(from) : `${from},${to}`
  }

  return params
}
