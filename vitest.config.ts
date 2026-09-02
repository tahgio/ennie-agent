import { defineConfig } from 'vitest/config'

/**
 * Three suites, per FR-038 / FR-040 and Constitution VI:
 *
 *   unit      pure logic, no network            } the default `pnpm test` run,
 *   protocol  real MCP client <-> real server   } which CI executes
 *   live      hits api.gbif.org                 opt-in only, never in CI
 *
 * `live` is declared here so it is runnable, but the root `test` script names
 * only `unit` and `protocol`, so no default invocation can reach the network.
 */
export default defineConfig({
  test: {
    /**
     * Coverage is **produced, never enforced** (FR-041, clarification Q2).
     *
     * There is deliberately no `thresholds` key here, and adding one would
     * change what the project promises: a threshold gives an unrelated change a
     * new way to fail, and the decision on record is that the number stays
     * visible for judgement rather than becoming a gate. CI uploads the report
     * as an artefact.
     */
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['packages/*/src/**/*.ts'],
      // The entrypoints are process-level wiring, exercised by the teardown
      // tests through a real child process rather than by an importing test.
      exclude: ['packages/*/dist/**', 'packages/*/src/index.ts'],
    },
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          setupFiles: ['packages/mcp-server/tests/helpers/no-network.ts'],
          include: [
            'packages/mcp-server/tests/unit/**/*.test.ts',
            'packages/agent/tests/**/*.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'protocol',
          environment: 'node',
          setupFiles: ['packages/mcp-server/tests/helpers/no-network.ts'],
          include: ['packages/mcp-server/tests/protocol/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'live',
          environment: 'node',
          include: ['packages/mcp-server/tests/live/**/*.test.ts'],
          testTimeout: 30_000,
        },
      },
    ],
  },
})
