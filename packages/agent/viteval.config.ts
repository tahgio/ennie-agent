import { defineConfig } from 'viteval/config'

/**
 * Evals are opt-in and cost money, so they live behind `pnpm eval` and are
 * never part of `pnpm test` or CI (FR-040, Constitution VI).
 */
export default defineConfig({
  eval: {
    include: ['evals/**/*.eval.ts'],
  },
})
