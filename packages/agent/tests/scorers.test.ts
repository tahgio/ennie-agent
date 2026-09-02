/**
 * The structural scorers, tested offline (FR-041, SC-011).
 *
 * These run in the default suite, which is the point of having written the
 * scorers as pure functions over a serialisable record: the scoring logic can be
 * verified without a model, a network, or a cent spent. Only the *runs* they
 * score cost money, and those live behind `pnpm eval`.
 */
import { describe, expect, it } from 'vitest'
import { callIdOf, createToolCallRecorder } from '../evals/run-scenario.js'
import {
  asksForClarification,
  type RunRecord,
  scoreChainCorrectness,
  structuralScore,
  type ToolCallRecord,
} from '../evals/scorers/run-record.js'

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    scenario: 'test',
    questions: ['Where has the polar bear been recorded?'],
    answers: ['Canada leads with 3,554 records of 11,141 in total.'],
    toolCalls: [],
    agentModel: 'test-model',
    judgeModel: null,
    date: '2026-08-29',
    ...overrides,
  }
}

const call = (
  name: string,
  input: Record<string, unknown> = {},
  isError = false,
): ToolCallRecord => ({
  name,
  input,
  isError,
})

describe('structuralScore — capability selection', () => {
  it('rewards answering a distribution question from a summary', () => {
    const result = structuralScore(
      record({ toolCalls: [call('summarize_occurrences', { taxonKey: 2433451 })] }),
      { mustCall: ['summarize_occurrences'], mustNotCall: ['search_occurrences'] },
    )

    expect(result.score).toBe(1)
  })

  it('penalises paging through records to answer "where"', () => {
    // The exact failure this project exists to prevent. A prose-only check
    // would score this run as fine.
    const result = structuralScore(
      record({
        toolCalls: [
          call('search_occurrences', { taxonKey: 2433451, limit: 50, offset: 0 }),
          call('search_occurrences', { taxonKey: 2433451, limit: 50, offset: 50 }),
        ],
      }),
      { mustCall: ['summarize_occurrences'], mustNotCall: ['search_occurrences'] },
    )

    // Both capability checks must fail: it never summarised, and it paged.
    expect(result.checks.find((c) => c.name.includes('does not call'))?.passed).toBe(false)
    expect(result.checks.find((c) => c.name.includes('calls summarize'))?.passed).toBe(false)
    expect(result.score).toBeLessThan(1)
  })

  it('enforces a per-tool call cap', () => {
    const result = structuralScore(
      record({
        toolCalls: [
          call('summarize_occurrences', { taxonKey: 1 }),
          call('summarize_occurrences', { taxonKey: 1 }),
          call('summarize_occurrences', { taxonKey: 1 }),
        ],
      }),
      { maxCalls: { summarize_occurrences: 2 } },
    )

    expect(result.checks.find((c) => c.name.includes('at most'))?.passed).toBe(false)
  })
})

describe('structuralScore — client-side tool name prefixes', () => {
  it('matches tools that arrive namespaced by their MCP server key', () => {
    // VoltAgent exposes MCP tools as `<serverKey>_<toolName>`, so a real run
    // records `gbif_summarize_occurrences`. Exact-name matching scored every
    // run wrong: mustCall never matched, and mustNotCall passed vacuously.
    const result = structuralScore(
      record({ toolCalls: [call('gbif_summarize_occurrences', { taxonKey: 2433451 })] }),
      { mustCall: ['summarize_occurrences'], mustNotCall: ['search_occurrences'] },
    )

    expect(result.score).toBe(1)
  })

  it('still catches a forbidden tool when it arrives prefixed', () => {
    const result = structuralScore(
      record({ toolCalls: [call('gbif_search_occurrences', { taxonKey: 2433451 })] }),
      { mustNotCall: ['search_occurrences'] },
    )

    expect(result.checks.find((c) => c.name.includes('does not call'))?.passed).toBe(false)
  })

  it('does not match an unrelated tool', () => {
    const result = structuralScore(record({ toolCalls: [call('gbif_resolve_taxon')] }), {
      mustCall: ['summarize_occurrences'],
    })

    expect(result.checks.find((c) => c.name.includes('calls summarize'))?.passed).toBe(false)
  })
})

describe('scoreChainCorrectness', () => {
  it('accepts resolving first and reusing the returned key', () => {
    const checks = scoreChainCorrectness(
      record({
        toolCalls: [
          call('resolve_taxon', { name: 'polar bear' }),
          call('summarize_occurrences', { taxonKey: 2433451 }),
        ],
      }),
    )

    expect(checks.every((check) => check.passed)).toBe(true)
  })

  it('accepts delegating resolution to the occurrence tool', () => {
    const checks = scoreChainCorrectness(
      record({ toolCalls: [call('summarize_occurrences', { name: 'polar bear' })] }),
    )

    expect(checks.every((check) => check.passed)).toBe(true)
  })

  it('flags resolving and then re-sending the name, which resolves twice', () => {
    const checks = scoreChainCorrectness(
      record({
        toolCalls: [
          call('resolve_taxon', { name: 'polar bear' }),
          call('summarize_occurrences', { name: 'polar bear' }),
        ],
      }),
    )

    expect(checks.find((c) => c.name.includes('passes the resolved taxonKey'))?.passed).toBe(false)
  })

  it('flags repeating a call that already failed', () => {
    // The error told the model what to do instead; repeating it verbatim means
    // the error was not acted on.
    const failing = call('resolve_taxon', { name: 'Prunella' }, true)
    const checks = scoreChainCorrectness(record({ toolCalls: [failing, failing] }))

    expect(checks.find((c) => c.name.includes('does not repeat'))?.passed).toBe(false)
  })

  it('does not flag a corrected retry after a failure', () => {
    const checks = scoreChainCorrectness(
      record({
        toolCalls: [
          call('resolve_taxon', { name: 'Prunella' }, true),
          call('resolve_taxon', { name: 'Prunella', kingdom: 'Plantae' }),
        ],
      }),
    )

    expect(checks.find((c) => c.name.includes('does not repeat'))?.passed).toBe(true)
  })
})

describe('asksForClarification', () => {
  it('recognises an answer that ends by asking the person', () => {
    expect(
      asksForClarification(
        'Prunella names both a plant genus and a bird genus. Which of the two did you mean?',
      ),
    ).toBe(true)
  })

  it('rejects an answer that silently picked one', () => {
    expect(
      asksForClarification('Prunella is a plant genus with 4,210 records, mostly in Europe.'),
    ).toBe(false)
  })

  it('rejects an empty answer', () => {
    expect(asksForClarification('   ')).toBe(false)
  })
})

describe('structuralScore — failures and reproducibility', () => {
  it('scores a failed run as zero, recording why rather than throwing', () => {
    const result = structuralScore(record({ error: 'model refused' }), {
      mustCall: ['summarize_occurrences'],
    })

    expect(result.score).toBe(0)
    expect(result.checks[0]?.detail).toBe('model refused')
  })

  it('is deterministic — the same record scores the same every time', () => {
    // SC-011: a structural score that moved between runs would be useless as a
    // regression signal.
    const sample = record({
      toolCalls: [
        call('resolve_taxon', { name: 'x' }),
        call('summarize_occurrences', { taxonKey: 1 }),
      ],
    })
    const expectation = { mustCall: ['summarize_occurrences'], mustNotCall: ['search_occurrences'] }

    const scores = Array.from({ length: 5 }, () => structuralScore(sample, expectation).score)

    expect(new Set(scores).size).toBe(1)
  })

  it('scores an expectation-free run as 1 rather than dividing by zero', () => {
    expect(structuralScore(record(), {}).score).toBe(1)
  })
})

/**
 * Attribution under concurrency (FR-033, SC-008).
 *
 * The suite records which capability calls failed. It used to match each
 * completion back to "the most recent call of the same name", which is exactly
 * wrong when a model issues two calls to one capability at once: whichever
 * finished first claimed the later record. That record then feeds the check
 * asking whether the agent repeated a call it had already been told had failed
 * — so a wrong attribution produces a confidently wrong score.
 */
describe('tool-call attribution', () => {
  it('lands each outcome on its own invocation when two calls overlap', () => {
    const recorder = createToolCallRecorder()

    // Two calls to the same capability, in flight together.
    recorder.started('gbif_resolve_taxon', { name: 'Prunella' }, 'call-a')
    recorder.started('gbif_resolve_taxon', { name: 'Ursus maritimus' }, 'call-b')

    // The second one finishes first, and succeeds. The first fails.
    recorder.finished('gbif_resolve_taxon', false, 'call-b')
    recorder.finished('gbif_resolve_taxon', true, 'call-a')

    expect(recorder.toolCalls).toEqual([
      { name: 'gbif_resolve_taxon', input: { name: 'Prunella' }, isError: true },
      { name: 'gbif_resolve_taxon', input: { name: 'Ursus maritimus' }, isError: false },
    ])
  })

  it('still separates two overlapping calls when no call id is supplied', () => {
    const recorder = createToolCallRecorder()

    recorder.started('gbif_search_occurrences', { taxonKey: 1 })
    recorder.started('gbif_search_occurrences', { taxonKey: 2 })

    // Without ids the rule is "most recent *unresolved*", so the first
    // completion takes the later call and the second cannot overwrite it.
    recorder.finished('gbif_search_occurrences', true)
    recorder.finished('gbif_search_occurrences', false)

    const failures = recorder.toolCalls.filter((call) => call.isError)
    // One outcome each — never both landing on one record.
    expect(failures).toHaveLength(1)
    expect(recorder.toolCalls).toHaveLength(2)
  })

  it('does not let one completion overwrite an outcome already attributed', () => {
    const recorder = createToolCallRecorder()

    recorder.started('gbif_resolve_taxon', { name: 'a' }, 'call-a')
    recorder.finished('gbif_resolve_taxon', true, 'call-a')

    // A stray completion with no id must not reclaim the resolved record.
    recorder.finished('gbif_resolve_taxon', false)

    expect(recorder.toolCalls[0]?.isError).toBe(true)
  })

  it('ignores a completion for a call that was never recorded as started', () => {
    const recorder = createToolCallRecorder()

    recorder.finished('gbif_resolve_taxon', true, 'unknown')

    expect(recorder.toolCalls).toEqual([])
  })

  it('feeds the repeat check the record that actually failed', () => {
    const recorder = createToolCallRecorder()

    // The same failing call, issued twice — what the check exists to catch.
    recorder.started('gbif_resolve_taxon', { name: 'Prunella' }, 'call-a')
    recorder.started('gbif_resolve_taxon', { name: 'Prunella' }, 'call-b')
    recorder.finished('gbif_resolve_taxon', true, 'call-a')
    recorder.finished('gbif_resolve_taxon', true, 'call-b')

    const checks = scoreChainCorrectness(record({ toolCalls: recorder.toolCalls }))
    const repeat = checks.find(
      (check) => check.name === 'does not repeat a call that already failed',
    )

    expect(repeat?.passed).toBe(false)
  })

  it('does not accuse the agent of repeating when only one call failed', () => {
    const recorder = createToolCallRecorder()

    recorder.started('gbif_resolve_taxon', { name: 'Prunella' }, 'call-a')
    recorder.started('gbif_resolve_taxon', { name: 'Prunella' }, 'call-b')
    // The retry succeeded, which is the agent acting on the error correctly.
    recorder.finished('gbif_resolve_taxon', true, 'call-a')
    recorder.finished('gbif_resolve_taxon', false, 'call-b')

    const checks = scoreChainCorrectness(record({ toolCalls: recorder.toolCalls }))
    const repeat = checks.find(
      (check) => check.name === 'does not repeat a call that already failed',
    )

    expect(repeat?.passed).toBe(true)
  })

  it('reads the call id the AI SDK supplies, and tolerates its absence', () => {
    expect(callIdOf({ toolContext: { callId: 'abc' } })).toBe('abc')
    expect(callIdOf({ toolContext: {} })).toBeUndefined()
    expect(callIdOf({})).toBeUndefined()
    expect(callIdOf(undefined)).toBeUndefined()
    // An empty id is no id.
    expect(callIdOf({ toolContext: { callId: '' } })).toBeUndefined()
  })
})
