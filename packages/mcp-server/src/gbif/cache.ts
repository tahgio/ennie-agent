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

/** Negative outcomes are cached too — an unresolvable name gets asked repeatedly. */
export type CachedOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false }

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
  /** Injectable so tests can advance time without sleeping through an hour. */
  readonly #now: () => number

  #hits = 0
  #misses = 0

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
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

  set(key: string, outcome: CachedOutcome<T>): void {
    this.#entries.set(key, { outcome, expiresAt: this.#now() + this.#ttlMs })
  }

  /** Record a resolved taxon. */
  setValue(key: string, value: T): void {
    this.set(key, { ok: true, value })
  }

  /**
   * Record that this name does not resolve. Callers ask for the same bad
   * spelling more than once, and each miss otherwise costs two upstream calls.
   */
  setNegative(key: string): void {
    this.set(key, { ok: false })
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
