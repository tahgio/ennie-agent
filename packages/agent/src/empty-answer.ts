/**
 * Why a turn produced no text at all (FR-031, FR-036).
 *
 * A model can end a turn without writing anything, and **it is not an error**:
 * `generateText` resolves with `text: ''` and a finish reason, so nothing
 * throws and nothing upstream reports it. With Gemini alone this is reachable
 * five separate ways — `MALFORMED_FUNCTION_CALL`, a content filter,
 * `MAX_TOKENS` reached while thinking, a plain `STOP` with an empty candidate,
 * and the step budget running out mid-investigation — and the only trace any of
 * them leaves is the finish reason.
 *
 * Both consumers of a generation live here rather than each reading the finish
 * reason for themselves: the CLI, which has to say something to the person
 * instead of printing a bare newline, and the eval runner, which has to record
 * an empty generation as a named failure instead of a blank answer that scores
 * like bad prose. Two readings of the same finish reason would drift, and the
 * disagreement would be invisible — an eval reporting a wrong answer for
 * something the CLI calls a transient glitch.
 */

/**
 * What a generation looks like when it produced no text.
 *
 * Only the shape actually read here is declared, because the concrete type is
 * whatever the SDK in play returns.
 */
export interface Generation {
  readonly text: string
  readonly finishReason?: string | undefined
  readonly steps?: readonly unknown[] | undefined
}

/** What happened, as a clause that completes "no answer came back: …". */
export function emptyAnswerReason(result: Generation): string {
  switch (result.finishReason) {
    case 'tool-calls':
      // The step budget ran out mid-investigation. Naming the count is what
      // distinguishes "the model gave up" from "the model went quiet".
      return `the model was still calling tools after ${result.steps?.length ?? 0} steps and never wrote a reply`
    case 'length':
      return "the reply hit the model's token limit before any text was produced"
    case 'content-filter':
      return 'the provider filtered the reply'
    case 'error':
      // Gemini's MALFORMED_FUNCTION_CALL lands here.
      return 'the model returned a malformed reply'
    default:
      return `the model stopped without writing anything (${result.finishReason ?? 'no reason given'})`
  }
}

/**
 * What the person should do about it.
 *
 * Only one of these causes is worth acting on differently: an exhausted step
 * budget will keep exhausting itself on the same question, so repeating it is
 * the one piece of advice that does not apply. Everything else here is
 * transient, and asking again genuinely is the fix.
 */
export function emptyAnswerAdvice(result: Generation): string {
  return result.finishReason === 'tool-calls'
    ? 'Try a narrower question.'
    : 'Asking again usually works.'
}
