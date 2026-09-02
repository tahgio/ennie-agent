/**
 * Eval scenarios (FR-041, SC-011).
 *
 * Twelve scenarios, each driven programmatically with scripted replies so a run is
 * repeatable and needs nobody at a keyboard. They are chosen to cover the
 * behaviours the design is actually betting on, not just the happy path:
 *
 *   - distribution questions must be answered from a summary, never by paging
 *   - a follow-up must not need the species restated
 *   - an ambiguous name must produce a question, not a guess
 *   - a zero total must be stated plainly rather than hedged
 *   - records must be listed only when records were actually asked for
 */
import type { StructuralExpectation } from '../scorers/run-record.js'

export interface Scenario {
  readonly name: string
  /** Turns put to the agent in order. A second turn is the scripted reply. */
  readonly questions: readonly string[]
  readonly expectation: StructuralExpectation
  /** What a judge model is asked to rate the final answer against (FR-041b). */
  readonly rubric: string
}

export const SCENARIOS: readonly Scenario[] = [
  {
    name: 'distribution-by-country',
    questions: ['Where has the polar bear been recorded?'],
    expectation: {
      mustCall: ['summarize_occurrences'],
      mustNotCall: ['search_occurrences'],
      maxCalls: { summarize_occurrences: 2 },
      answerMustContain: ['Canada'],
    },
    rubric:
      'Names the countries where the polar bear has most records, gives the total number of records, and does not present the counts as a direct measure of abundance.',
  },
  {
    name: 'follow-up-keeps-context',
    questions: ['Where has the polar bear been recorded?', 'What about just in Canada?'],
    expectation: {
      mustCall: ['summarize_occurrences'],
      mustNotCall: ['search_occurrences'],
    },
    rubric:
      'Answers the follow-up about Canada without asking which species is meant, showing the conversation context carried over.',
  },
  {
    name: 'homonym-asks-rather-than-guesses',
    questions: ['Tell me about the distribution of Prunella.'],
    expectation: {
      mustCall: ['resolve_taxon'],
      mustAskForClarification: true,
    },
    rubric:
      'Explains that Prunella names taxa in more than one kingdom, names the candidates, and asks which is meant instead of choosing one.',
  },
  {
    name: 'homonym-resolves-after-reply',
    questions: ['Tell me about the distribution of Prunella.', 'The plant, please.'],
    expectation: {
      mustCall: ['resolve_taxon', 'summarize_occurrences'],
    },
    rubric:
      'After the person clarifies that they mean the plant, reports the distribution of the plant genus rather than the bird.',
  },
  {
    name: 'common-name-resolution',
    questions: ['How many records are there for the polar bear?'],
    expectation: {
      mustCall: ['summarize_occurrences'],
      mustNotCall: ['search_occurrences'],
      answerMustContain: ['Ursus maritimus'],
    },
    rubric:
      'Gives a total record count and names the accepted scientific name the count belongs to.',
  },
  {
    name: 'synonym-reports-accepted-name',
    questions: ['Where is Felis concolor found?'],
    expectation: {
      mustCall: ['summarize_occurrences'],
      mustNotCall: ['search_occurrences'],
      answerMustContain: ['Puma concolor'],
    },
    rubric:
      'States that Felis concolor is a synonym of Puma concolor and answers for the accepted taxon.',
  },
  {
    name: 'zero-total-stated-plainly',
    questions: ['How many polar bear records are there from Antarctica?'],
    expectation: {
      mustCall: ['summarize_occurrences'],
      mustNotCall: ['search_occurrences'],
    },
    rubric:
      'States plainly that there are no records for that combination, without treating it as an error or implying the query was invalid.',
  },
  {
    name: 'records-only-when-asked',
    questions: ['Show me five individual polar bear occurrence records.'],
    expectation: {
      mustCall: ['search_occurrences'],
      maxCalls: { search_occurrences: 2 },
    },
    rubric:
      'Lists individual records with their dates and locations, since specific records were explicitly requested.',
  },
  {
    name: 'misspelling-recovers',
    questions: ['Where has Ursus maritimuss been recorded?'],
    expectation: {
      mustNotCall: ['search_occurrences'],
      answerMustContain: ['Ursus maritimus'],
    },
    rubric:
      'Recovers from the misspelling, answers for Ursus maritimus, and says which name it used.',
  },
  {
    name: 'unknown-name-does-not-fabricate',
    questions: ['Where has Zzzzqqq xxxxyy been recorded?'],
    expectation: {
      mustCall: ['resolve_taxon'],
      mustNotCall: ['search_occurrences'],
    },
    rubric:
      'Says the name could not be found and suggests checking the spelling. Invents no counts, countries, or classifications.',
  },
  {
    name: 'temporal-trend',
    questions: ['How have polar bear records changed over time?'],
    expectation: {
      mustCall: ['summarize_occurrences'],
      mustNotCall: ['search_occurrences'],
      maxCalls: { summarize_occurrences: 2 },
    },
    rubric:
      'Describes the record counts by year and notes that changes reflect recording effort as well as any real change.',
  },
  {
    name: 'prefers-summary-over-paging',
    questions: ['Which countries have the most house sparrow records?'],
    expectation: {
      mustCall: ['summarize_occurrences'],
      mustNotCall: ['search_occurrences'],
      maxCalls: { summarize_occurrences: 2 },
    },
    rubric:
      'Ranks countries by record count for the house sparrow and gives the total, without listing individual records.',
  },
]
