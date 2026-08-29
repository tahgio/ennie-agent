/**
 * The structural scorers, tested offline (FR-041, SC-011).
 *
 * These run in the default suite, which is the point of having written the
 * scorers as pure functions over a serialisable record: the scoring logic can be
 * verified without a model, a network, or a cent spent. Only the *runs* they
 * score cost money, and those live behind `pnpm eval`.
 */
import { describe, expect, it } from 'vitest'
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
