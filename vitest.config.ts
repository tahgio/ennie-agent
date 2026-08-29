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
