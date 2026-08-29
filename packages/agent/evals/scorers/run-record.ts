/**
 * The structural scorers (FR-041, plan D12).
 *
 * These are **plain functions over a serialisable record**, and that is the
 * whole design. Two consequences follow, both of which the spec asks for:
 *
 *   - The structural score is *reproducible*. It reads only the recorded
 *     sequence of tool calls, so re-running the evals against the same model
 *     yields the identical number (SC-011). Nothing here consults a model, and
 *     nothing here is stochastic.
 *   - The score is *runner-independent*. Viteval wraps these; it does not own
 *     them. Swapping the eval framework touches no scoring logic.
 *
 * What they measure is capability selection and chain correctness — did the
 * agent reach for the right tool, in the right order, and did it decline to
 * guess when the server told it the name was ambiguous. That is deliberately
 * not the same question as "was the prose any good", which is what the separate
 * judge-model rating is for (FR-041b).
 */

export interface ToolCallRecord {
  readonly name: string
  readonly input: Record<string, unknown>
  readonly isError: boolean
}

/** Everything one scenario run produced, in a form that survives JSON. */
export interface RunRecord {
  readonly scenario: string
  /** Every question put to the agent, in order — several for a follow-up scenario. */
  readonly questions: readonly string[]
  /** The agent's answers, aligned with `questions`. */
  readonly answers: readonly string[]
  readonly toolCalls: readonly ToolCallRecord[]
  readonly agentModel: string
  readonly judgeModel: string | null
  /** ISO date, so a recorded score can be read months later (FR-041a). */
  readonly date: string
  /** Present when the run failed outright. */
  readonly error?: string | undefined
}

/** What a scenario expects structurally. Everything is optional but the name. */
export interface StructuralExpectation {
  /** Tools that must appear at least once. */
  readonly mustCall?: readonly string[]
  /** Tools that must not appear at all — the context-economy trap. */
  readonly mustNotCall?: readonly string[]
  /** Cap on calls to one tool, e.g. one summarise call for one question. */
  readonly maxCalls?: Readonly<Record<string, number>>
  /** The answer must end by asking the person something (FR-036a). */
  readonly mustAskForClarification?: boolean
  /** Substrings the final answer must contain, e.g. a resolved name or a total. */
  readonly answerMustContain?: readonly string[]
}

export interface CheckResult {
  readonly name: string
  readonly passed: boolean
  readonly detail: string
}

export interface StructuralScore {
  /** 0–1, the fraction of checks that passed. */
  readonly score: number
  readonly checks: readonly CheckResult[]
}

const QUESTION_MARK = /\?\s*$/

/** Did the agent ask the person something rather than deciding for them? */
export function asksForClarification(answer: string): boolean {
  const trimmed = answer.trim()
  if (trimmed === '') return false
  // A question anywhere in the closing sentence counts; models often explain
  // the ambiguity first and ask at the end.
  const lastSentence = trimmed.split(/(?<=[.!?])\s+/).at(-1) ?? trimmed
  return QUESTION_MARK.test(lastSentence) || QUESTION_MARK.test(trimmed)
}

/**
 * Match a tool by its contract name, tolerating a client-side prefix.
 *
 * VoltAgent namespaces MCP tools by the server key they came from, so
 * `resolve_taxon` arrives as `gbif_resolve_taxon`. Matching on exact equality
 * silently scored every run wrong — `mustCall` never matched, and `mustNotCall`
 * passed vacuously, so a run that paged through records looked perfect.
 */
export function isTool(call: ToolCallRecord, tool: string): boolean {
  return call.name === tool || call.name.endsWith(`_${tool}`)
}

export function callsTo(record: RunRecord, tool: string): readonly ToolCallRecord[] {
  return record.toolCalls.filter((call) => isTool(call, tool))
}

/**
 * Did the agent select the right capabilities?
 *
 * The `mustNotCall` half carries most of the weight: answering "where has it
 * been recorded" by paging through `search_occurrences` is the exact failure
 * this project exists to prevent, and it is invisible to any check that only
 * looks at whether the prose was correct.
 */
export function scoreCapabilitySelection(
  record: RunRecord,
  expectation: StructuralExpectation,
): CheckResult[] {
  const checks: CheckResult[] = []

  for (const tool of expectation.mustCall ?? []) {
    const count = callsTo(record, tool).length
    checks.push({
      name: `calls ${tool}`,
      passed: count > 0,
      detail: count > 0 ? `called ${count}x` : 'never called',
    })
  }

  for (const tool of expectation.mustNotCall ?? []) {
    const count = callsTo(record, tool).length
    checks.push({
      name: `does not call ${tool}`,
      passed: count === 0,
      detail: count === 0 ? 'not called' : `called ${count}x`,
    })
  }

  for (const [tool, max] of Object.entries(expectation.maxCalls ?? {})) {
    const count = callsTo(record, tool).length
    checks.push({
      name: `at most ${max} call(s) to ${tool}`,
      passed: count <= max,
      detail: `called ${count}x`,
    })
  }

  return checks
}

/**
 * Was the chain correct?
 *
 * Two properties, both mechanical: a name is resolved before it is queried, and
 * the key that resolution produced is the key actually used downstream. The
 * second matters because passing a *name* to an occurrence tool still works —
 * it just resolves again — so a chain can look right while quietly costing
 * double.
 */
export function scoreChainCorrectness(record: RunRecord): CheckResult[] {
  const checks: CheckResult[] = []
  const occurrenceTools = ['summarize_occurrences', 'search_occurrences']

  const firstResolveIndex = record.toolCalls.findIndex((call) => isTool(call, 'resolve_taxon'))
  const firstOccurrenceIndex = record.toolCalls.findIndex((call) =>
    occurrenceTools.some((tool) => isTool(call, tool)),
  )

  if (firstOccurrenceIndex !== -1) {
    const firstOccurrence = record.toolCalls[firstOccurrenceIndex]
    const resolvedFirst = firstResolveIndex !== -1 && firstResolveIndex < firstOccurrenceIndex
    const hasKey = firstOccurrence?.input.taxonKey !== undefined
    const hasName = firstOccurrence?.input.name !== undefined

    checks.push({
      name: 'queries with a taxon it can actually key on',
      // Three legitimate shapes: resolve first, pass a key already in hand, or
      // delegate resolution to the occurrence tool. Only querying with neither
      // a key nor a name is wrong.
      passed: resolvedFirst || hasKey || hasName,
      detail: resolvedFirst
        ? 'resolve_taxon preceded the occurrence call'
        : hasKey
          ? 'queried with a taxonKey already in hand'
          : hasName
            ? 'delegated resolution to the occurrence tool'
            : 'queried occurrences with neither a key nor a name',
    })

    if (resolvedFirst) {
      const passedKey = record.toolCalls
        .slice(firstOccurrenceIndex)
        .some(
          (call) =>
            occurrenceTools.some((tool) => isTool(call, tool)) && call.input.taxonKey !== undefined,
        )
      checks.push({
        name: 'passes the resolved taxonKey downstream',
        passed: passedKey,
        detail: passedKey ? 'taxonKey reused' : 're-sent the name instead of the resolved key',
      })
    }
  }

  const failed = record.toolCalls.filter((call) => call.isError)
  const repeatedIdenticalFailure = failed.some((call, index) =>
    failed
      .slice(index + 1)
      .some(
        (other) =>
          other.name === call.name && JSON.stringify(other.input) === JSON.stringify(call.input),
      ),
  )
  checks.push({
    name: 'does not repeat a call that already failed',
    passed: !repeatedIdenticalFailure,
    detail: repeatedIdenticalFailure
      ? 'retried an identical failing call instead of acting on the error'
      : 'no identical retry after a failure',
  })

  return checks
}

/** Clarification and answer-content checks. */
export function scoreAnswer(record: RunRecord, expectation: StructuralExpectation): CheckResult[] {
  const checks: CheckResult[] = []
  const finalAnswer = record.answers.at(-1) ?? ''

  if (expectation.mustAskForClarification === true) {
    const asked = asksForClarification(finalAnswer)
    checks.push({
      name: 'asks the person which taxon was meant',
      passed: asked,
      detail: asked ? 'ended with a question' : 'did not ask; may have guessed',
    })
  }

  for (const needle of expectation.answerMustContain ?? []) {
    const present = finalAnswer.toLowerCase().includes(needle.toLowerCase())
    checks.push({
      name: `answer mentions "${needle}"`,
      passed: present,
      detail: present ? 'present' : 'absent',
    })
  }

  return checks
}

/**
 * The whole structural score for one run: the fraction of checks that passed.
 *
 * A run that failed outright scores zero with the reason recorded, rather than
 * throwing — a broken scenario should show up as a bad score in the report, not
 * as a crashed eval run.
 */
export function structuralScore(
  record: RunRecord,
  expectation: StructuralExpectation,
): StructuralScore {
  if (record.error !== undefined) {
    return {
      score: 0,
      checks: [{ name: 'run completed', passed: false, detail: record.error }],
    }
  }

  const checks = [
    ...scoreCapabilitySelection(record, expectation),
    ...scoreChainCorrectness(record),
    ...scoreAnswer(record, expectation),
  ]

  if (checks.length === 0) return { score: 1, checks }

  const passed = checks.filter((check) => check.passed).length
  return { score: passed / checks.length, checks }
}
