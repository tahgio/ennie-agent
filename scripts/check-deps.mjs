#!/usr/bin/env node
/**
 * Two pins this project cannot afford to lose, asserted mechanically because
 * both fail silently at install time and loudly much later.
 *
 * 1. `ai` must stay on major 6 (research D4). @voltagent/core peer-requires
 *    ^6.0.0, but `npm latest` resolves `ai` to 7.x and the @ai-sdk/* providers
 *    to v4 — so a routine `pnpm add ai` installs a combination VoltAgent does
 *    not support.
 * 2. Exactly one Zod version may resolve across the workspace (Constitution IV).
 *    Two majors side by side means Zod instances stop recognising each other
 *    across the MCP SDK / VoltAgent boundary.
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'packages/agent/index.js'))

const failures = []

const aiVersion = require('ai/package.json').version
const aiMajor = Number.parseInt(aiVersion.split('.')[0], 10)
if (aiMajor !== 6) {
  failures.push(
    `ai resolved to ${aiVersion}; expected major 6. @voltagent/core peer-requires ai@^6 ` +
      `(research D4). Re-pin "ai": "^6.0.0" and the @ai-sdk/* providers at "^3.0.0".`,
  )
} else {
  console.log(`ok  ai@${aiVersion} (major 6)`)
}

const lock = execFileSync('cat', [join(root, 'pnpm-lock.yaml')], { encoding: 'utf8' })
const zodVersions = [...new Set([...lock.matchAll(/^ {2}zod@([\d.]+):/gm)].map((m) => m[1]))]
if (zodVersions.length !== 1) {
  failures.push(
    `${zodVersions.length} Zod versions resolved (${zodVersions.join(', ')}); expected exactly 1 ` +
      `(Constitution IV). Check the "overrides" block in pnpm-workspace.yaml.`,
  )
} else {
  console.log(`ok  zod@${zodVersions[0]} (single version across the workspace)`)
}

if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL  ${f}`)
  process.exit(1)
}
