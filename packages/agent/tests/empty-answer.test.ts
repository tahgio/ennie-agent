/**
 * The five ways a turn comes back empty (T070).
 *
 * These strings are the whole signal for a silent generation: in the CLI they
 * are what the person reads instead of a blank line, and in the eval runner
 * they are the recorded reason a run failed. The eval runner has no unit seam —
 * it spawns the server and contacts a model — so this is where the mapping
 * itself is pinned, and `session.test.ts` covers the behaviour around it.
 *
 * The finish reasons are the AI SDK's, not one provider's. Gemini reaches four
 * of them (`MALFORMED_FUNCTION_CALL` -> error, a content filter, `MAX_TOKENS`
 * hit while thinking, and `STOP` with an empty candidate); the fifth is the
 * step budget, which any provider can exhaust.
 */
import { describe, expect, it } from 'vitest'
import { emptyAnswerAdvice, emptyAnswerReason } from '../src/empty-answer.js'

describe('emptyAnswerReason', () => {
  it('names the step budget, and how many steps were spent', () => {
    const reason = emptyAnswerReason({
      text: '',
      finishReason: 'tool-calls',
      steps: new Array(8).fill({}),
    })

    expect(reason).toContain('8 steps')
    // The one cause repeating the question cannot fix.
    expect(emptyAnswerAdvice({ text: '', finishReason: 'tool-calls' })).toContain('narrower')
  })

  it('distinguishes a malformed reply, a filter and a token limit', () => {
    expect(emptyAnswerReason({ text: '', finishReason: 'error' })).toContain('malformed')
    expect(emptyAnswerReason({ text: '', finishReason: 'content-filter' })).toContain('filtered')
    expect(emptyAnswerReason({ text: '', finishReason: 'length' })).toContain('token limit')
  })

  it('still says something when the provider reports nothing at all', () => {
    // An empty candidate with a plain STOP, and the case where the finish
    // reason itself is missing: neither may collapse into silence.
    expect(emptyAnswerReason({ text: '', finishReason: 'stop' })).toContain('stopped without')
    expect(emptyAnswerReason({ text: '' })).toContain('no reason given')
  })

  it('advises asking again for everything the step budget did not cause', () => {
    for (const finishReason of ['error', 'content-filter', 'length', 'stop', undefined]) {
      expect(emptyAnswerAdvice({ text: '', finishReason })).toContain('Asking again')
    }
  })
})
