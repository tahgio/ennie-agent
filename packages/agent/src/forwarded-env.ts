/**
 * The variables a launched GBIF server is allowed to see, and only those
 * (FR-026).
 *
 * Shared by the CLI entrypoint and the eval runner so the server they each
 * spawn is configured identically — the eval suite is supposed to be
 * measuring the agent that ships, including whatever timeout budget an
 * operator has tuned via `GBIF_CALL_BUDGET_MS` (Constitution VII).
 */
export function forwardedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const allowlist = ['GBIF_USER_AGENT_CONTACT', 'LOG_LEVEL', 'GBIF_CALL_BUDGET_MS'] as const
  const forwarded: Record<string, string> = {}

  for (const name of allowlist) {
    const value = env[name]?.trim()
    if (value !== undefined && value !== '') forwarded[name] = value
  }

  return forwarded
}
