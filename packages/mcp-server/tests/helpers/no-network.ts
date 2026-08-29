/**
 * Make the network unreachable for the default test suite (FR-038, SC-007,
 * Constitution VI).
 *
 * Loaded as a Vitest `setupFile` for the `unit` and `protocol` projects, so
 * every test in them runs with `globalThis.fetch` replaced by something that
 * throws. The offline guarantee then does not depend on anybody remembering to
 * inject a stub: a forgotten injection fails loudly, and names the URL it tried
 * to reach, instead of quietly succeeding on a developer's machine and failing
 * in CI — or worse, passing everywhere while silently depending on GBIF being
 * up.
 *
 * The `live` project deliberately does not load this file.
 */
/** `fetch`'s own first parameter type, which is not a global in this tsconfig. */
type FetchInput = Parameters<typeof fetch>[0]

const message = (url: string): string =>
  [
    `Network access is disabled in the default test suite, but something tried to fetch:`,
    `  ${url}`,
    ``,
    `The default suite must run offline (FR-038). Inject a stubbed fetch via`,
    `\`createFixtureFetch()\` from tests/helpers/stub-gbif.ts, or move this test`,
    `into tests/live/ and run it with \`pnpm test:live\`.`,
  ].join('\n')

globalThis.fetch = ((input: FetchInput): never => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  throw new Error(message(url))
}) as unknown as typeof fetch
