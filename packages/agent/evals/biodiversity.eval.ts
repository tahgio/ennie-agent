/**
 * The agent eval suite (FR-041, FR-041a, FR-041b, FR-041c, SC-011).
 *
 * Opt-in and never run in CI: it calls models, which costs money
 * (Constitution VI). Run it with `pnpm eval`.
 *
 * Two scores are reported per scenario, deliberately kept apart:
 *
 *   - a **structural score**, computed by pure functions over the recorded
 *     tool-call sequence. It is reproducible: the same model over the same
 *     scenarios yields the same number (SC-011). This is the one and only
 *     score handed to viteval's `scorers`, so it is the one and only score
 *     the pass/fail threshold gates on.
 *   - a **judge-model rating** of the final answer against the scenario's
 *     rubric. That is a different question — whether the prose was any good —
 *     and it is inherently not reproducible, so it is never blended into the
 *     structural score. It travels as metadata on the structural result
 *     instead of as its own scorer: viteval's mean/median/sum aggregation
 *     coerces a `null` score to `0` before averaging, so a second scorer
 *     that is allowed to abstain would silently drag the gating score down
 *     to (structural + 0) / 2 — capping every run at 0.5 the moment
 *     `JUDGE_MODEL` is unset, regardless of how the agent actually did.
 *
 * Every result is stamped with the agent model, the judge model, and the date,
 * because a score without those three cannot be interpreted a month later
 * (FR-041a).
 *
 * A judge failure must not fail the run (FR-041c). When the judge is
 * unavailable the rating is `null` rather than zero: an absent rating is the
 * truth, whereas a zero would read as an agent regression that never happened.
 */
import { generateObject } from 'ai'
import { evaluate, type Score } from 'viteval'
import * as z from 'zod'
import { asModelValue, createModel, parseModel, requireCredential } from '../src/model.js'
import { agentModelLabel, judgeModelLabel, runScenario } from './run-scenario.js'
import { SCENARIOS, type Scenario } from './scenarios/index.js'
import type { RunRecord, StructuralExpectation } from './scorers/run-record.js'
import { structuralScore } from './scorers/run-record.js'

/**
 * What each scorer here actually receives.
 *
 * Viteval types a task's output as the same type as its data item's `expected`,
 * which suits an eval comparing an answer against a known-good one. This suite
 * has no fixed expected answer — it scores the *recorded run*: which tools were
 * reached for, in what order, and whether the agent asked rather than guessed.
 * So the scorers are written against these types, and the config is handed to
 * `evaluate` with one cast at the call site below.
 */
interface EvalArgs {
  readonly output: RunRecord
  readonly input: Scenario
  readonly expected: StructuralExpectation
}

const JUDGE_SCHEMA = z.object({
  rating: z.number().int().min(1).max(5).describe('1 = unusable, 5 = exactly right'),
  reasoning: z.string().describe('One or two sentences justifying the rating.'),
})

/** Ask a separate model to rate the final answer against the scenario's rubric. */
async function judge(
  scenario: Scenario,
  record: RunRecord,
): Promise<{ rating: number; reasoning: string }> {
  const route = parseModel(process.env.JUDGE_MODEL)
  requireCredential(route)

  const result = await generateObject({
    model: asModelValue<Parameters<typeof generateObject>[0]['model']>(createModel(route)),
    schema: JUDGE_SCHEMA,
    prompt: [
      'You are rating an assistant answer about biodiversity data.',
      '',
      `Question(s) put to the assistant:\n${record.questions.map((q) => `- ${q}`).join('\n')}`,
      '',
      `The answer:\n${record.answers.at(-1) ?? '(no answer)'}`,
      '',
      `What a good answer does:\n${scenario.rubric}`,
      '',
      'Rate the answer from 1 to 5 against that description alone. Do not reward length.',
    ].join('\n'),
  })

  return result.object
}

/**
 * Answer quality, rated by a different model. Reported beside the structural
 * score, as metadata rather than a second `Score`, so it can never move the
 * gating number (see the file header).
 */
async function judgeVerdict(
  scenario: Scenario,
  record: RunRecord,
): Promise<Record<string, unknown>> {
  const judgeModel = judgeModelLabel()

  if (judgeModel === null) {
    return {
      status: 'skipped',
      reason: 'JUDGE_MODEL is not set, so no answer rating was requested.',
    }
  }

  try {
    const verdict = await judge(scenario, record)
    return {
      status: 'rated',
      rating: verdict.rating,
      reasoning: verdict.reasoning,
      judgeModel,
    }
  } catch (error) {
    // FR-041c: the judge is a separate system, and its outage is not an agent
    // regression.
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
      judgeModel,
    }
  }
}

/**
 * The only scorer handed to viteval, and so the only one the pass/fail
 * threshold gates on. Reads the recorded call sequence — no model is
 * consulted, and nothing here is stochastic — then attaches the separate
 * judge-model rating as metadata for a human reading the report.
 */
async function structuralScorer({ output, input, expected }: EvalArgs): Promise<Score> {
  const result = structuralScore(output, expected)
  const judgeRating = await judgeVerdict(input, output)

  return {
    name: 'structural',
    score: result.score,
    metadata: {
      agentModel: output.agentModel,
      judgeModel: output.judgeModel,
      date: output.date,
      toolSequence: output.toolCalls.map((call) => call.name),
      failed: result.checks.filter((check) => !check.passed).map((check) => check.name),
      checks: result.checks,
      judgeRating,
    },
  }
}

const config = {
  description: 'GBIF biodiversity agent — capability selection, chain correctness, and answers',

  data: async () =>
    SCENARIOS.map((scenario) => ({
      name: scenario.name,
      input: scenario,
      expected: scenario.expectation,
    })),

  task: async ({ input }: { input: Scenario }): Promise<RunRecord> => await runScenario(input),

  scorers: [structuralScorer],

  threshold: 0.8,
  timeout: 120_000,
}

evaluate('gbif-biodiversity-agent', config as unknown as Parameters<typeof evaluate>[1])

// Printed once so a captured run names what produced it (FR-041a).
process.stderr.write(
  `eval: agent=${agentModelLabel()} judge=${judgeModelLabel() ?? 'none'} date=${new Date().toISOString().slice(0, 10)}\n`,
)
