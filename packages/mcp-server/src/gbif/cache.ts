/**
 * A one-hour, in-process TTL cache in front of taxon resolution — and nothing
 * else (FR-030, data-model §4, research D6).
 *
 * Scope is the interesting decision here. Resolution is the hot path: every
 * tool that accepts a name resolves first, and a conversation revisits the same
 * species turn after turn. It is also the only genuinely stable mapping in this
 * server. Occurrence counts change as datasets are published, so caching a
 * summary would serve a stale answer to a question that was explicitly about
 * current data — which is why occurrences and summaries are never cached.
 *
 * The map lives in the process and dies with it. Nothing is written to disk,
 * which keeps the spec's "no persistence" exclusion intact.
 */
import type { ToolErrorFields } from '../errors.js'

/**
 * Negative outcomes are cached too — an unresolvable name gets asked
 * repeatedly, and each miss otherwise costs two upstream calls.
 *
 * The failure is stored whole rather than as a bare flag, so a repeat of an
 * ambiguous name is answered with the same candidate list it got the first
 * time, instead of degrading into a generic "not found".
 *
 * **Which failures are remembered, and why** (FR-011, research D2). Only
 * failures that retrying cannot fix — those carrying `retryable: false`:
 *
 *   - **Remembered**: a name the index does not hold (`NOT_FOUND`), a name
 *     shared across kingdoms (`AMBIGUOUS`), a match too weak to accept
 *     (`LOW_CONFIDENCE`), a name reaching only a higher rank (`HIGHER_RANK`).
 *     These are settled facts about the name. Asking GBIF again gets the same
 *     answer, so the entry is pure economy.
 *
 *   - **Not remembered**: anything retryable — a timeout, a rate limit, an
 *     outage. These are facts about the *moment*, not about the name.
 *     Remembering one turns a thirty-second blip into an hour of confidently
 *     wrong answers for that species, and defeats the retry advice the failure
 *     message itself gives.
 *
 *   - **Not remembered**: a cancellation, excluded on its own terms. It is a
 *     fact about the caller — they stopped waiting — and says nothing at all
 *     about whether the name resolves.
 *
 * The guard that enforces this lives at the one place failures are recorded,
 * in `resolveTaxon` (domain/resolution.ts).
 */
export type CachedOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ToolErrorFields }

interface Entry<T> {
  readonly outcome: CachedOutcome<T>
  readonly expiresAt: number
}

export interface CacheKeyParts {
  readonly name: string
  readonly rank?: string | undefined
  readonly kingdom?: string | undefined
}

export const DEFAULT_TTL_MS = 60 * 60 * 1000

/**
 * The ceiling on remembered entries (FR-012, research D3).
 *
 * The store is designed for a long-lived process, but had no ceiling and no
 * sweep: it grew for as long as distinct names kept arriving. The caller that
 * fills it is exactly the caller this server is built for — a language model
 * generating name variants, each one a new key.
 *
 * Low thousands is the useful range: far beyond what any real conversation
 * touches, so eviction is unreachable in ordinary use, while still bounding
 * the process.
 */
export const DEFAULT_MAX_ENTRIES = 2_000

/**
 * Normalised so that "Ursus maritimus", "  ursus maritimus " and
 * "URSUS MARITIMUS" are one entry. The rank and kingdom hints are part of the
 * key because they change the answer: "Prunella" alone is ambiguous, while
 * "Prunella" with `kingdom=Plantae` resolves cleanly, and the two outcomes must
 * not share a slot.
 */
export function cacheKey(parts: CacheKeyParts): string {
  const name = parts.name.trim().toLowerCase().replace(/\s+/g, ' ')
  return `${name}|${parts.rank?.toUpperCase() ?? ''}|${parts.kingdom?.toLowerCase() ?? ''}`
}

export class TtlCache<T> {
  readonly #entries = new Map<string, Entry<T>>()
  readonly #ttlMs: number
  readonly #maxEntries: number
  /** Injectable so tests can advance time without sleeping through an hour. */
  readonly #now: () => number

  #hits = 0
  #misses = 0

  constructor(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    // Settable so the eviction boundary is directly testable without inserting
    // two thousand entries to reach it (FR-015).
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.#now = options.now ?? Date.now
  }

  /** Returns `undefined` on a miss; an expired entry is a miss and is evicted. */
  get(key: string): CachedOutcome<T> | undefined {
    const entry = this.#entries.get(key)
    if (entry === undefined) {
      this.#misses += 1
      return undefined
    }

    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key)
      this.#misses += 1
      return undefined
    }

    this.#hits += 1
    return entry.outcome
  }

  /**
   * Record an outcome, evicting the longest-ago-recorded entry at the ceiling.
   *
   * Eviction is **insertion-order**, not least-recently-used: `Map` iterates in
   * insertion order, so the first key it yields is the one recorded longest
   * ago — regardless of how recently it was *read* (FR-013, research D3).
   *
   * True LRU would need a re-link on every `get`, turning reads into writes for
   * a store whose entries expire on a one-hour clock anyway. The cost of the
   * cheaper rule is bounded and small: an evicted key is a miss, and a miss
   * resolves upstream and returns the correct answer. Eviction can therefore
   * cost one extra upstream lookup, and can never produce a wrong answer —
   * which is why correctness under eviction needs no code of its own (FR-014).
   *
   * Re-recording an existing key deletes first, so a refresh moves that key to
   * the back rather than evicting an innocent neighbour while leaving the
   * refreshed key in its original, stale position.
   */
  set(key: string, outcome: CachedOutcome<T>): void {
    if (this.#entries.has(key)) {
      this.#entries.delete(key)
    } else if (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next()
      if (!oldest.done) this.#entries.delete(oldest.value)
    }

    this.#entries.set(key, { outcome, expiresAt: this.#now() + this.#ttlMs })
  }

  /** Record a resolved taxon. */
  setValue(key: string, value: T): void {
    this.set(key, { ok: true, value })
  }

  /** Record why this name does not resolve, preserving the exact failure. */
  setNegative(key: string, error: ToolErrorFields): void {
    this.set(key, { ok: false, error })
  }

  get size(): number {
    return this.#entries.size
  }

  /** Hit/miss counts, reported on every tool log entry (FR-029, FR-030). */
  get stats(): { readonly hits: number; readonly misses: number } {
    return { hits: this.#hits, misses: this.#misses }
  }

  clear(): void {
    this.#entries.clear()
    this.#hits = 0
    this.#misses = 0
  }
}
