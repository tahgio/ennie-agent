/**
 * Startup refusals and teardown across every exit path (FR-034, FR-035).
 *
 * These spawn the real CLI as a child process, because the properties being
 * checked are properties of a *process*: the exit code it returns, and whether
 * the MCP server it started is still running afterwards. An orphaned stdio
 * server is invisible — nothing fails, nothing logs — right up until a machine
 * is quietly full of them, so it is worth testing for directly.
 *
 * No model is ever contacted: each case either fails before startup completes,
 * or exits at the first prompt. A placeholder key satisfies the preflight,
 * which is enough to reach the part being tested.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = join(PACKAGE_ROOT, '..', '..')
const AGENT_ENTRYPOINT = join(PACKAGE_ROOT, 'dist', 'index.js')
const SERVER_ENTRYPOINT = join(REPO_ROOT, 'packages', 'mcp-server', 'dist', 'index.js')

function ensureBuilt(): void {
  if (existsSync(AGENT_ENTRYPOINT) && existsSync(SERVER_ENTRYPOINT)) return
  execFileSync(join(REPO_ROOT, 'node_modules', '.bin', 'tsc'), ['--build', REPO_ROOT], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  })
}

/** PIDs of any running GBIF MCP server, identified by its entrypoint path. */
function serverPids(): number[] {
  const listing = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
  return listing
    .split('\n')
    .filter((line) => line.includes(SERVER_ENTRYPOINT))
    .map((line) => Number.parseInt(line.trim().split(/\s+/)[0] ?? '', 10))
    .filter((pid) => Number.isInteger(pid))
}

interface Run {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  /** Servers still alive afterwards that were not alive before. */
  readonly orphans: number[]
}

interface RunOptions {
  readonly env?: Record<string, string | undefined>
  readonly stdin?: string
  /** Send this signal once the line appears on stdout. */
  readonly signalAfter?: { readonly line: string; readonly signal: NodeJS.Signals }
  readonly closeStdin?: boolean
}

async function runCli(options: RunOptions = {}): Promise<Run> {
  const before = new Set(serverPids())

  const child = spawn(process.execPath, [AGENT_ENTRYPOINT], {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MODEL: 'anthropic:claude-opus-5',
      ANTHROPIC_API_KEY: 'placeholder-not-used',
      ...options.env,
    } as NodeJS.ProcessEnv,
  })

  let stdout = ''
  let stderr = ''
  let signalled = false
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
    const after = options.signalAfter
    if (after !== undefined && !signalled && stdout.includes(after.line)) {
      signalled = true
      child.kill(after.signal)
    }
  })
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })

  if (options.stdin !== undefined) child.stdin.write(options.stdin)
  if (options.closeStdin !== false) child.stdin.end()

  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(null)
    }, 25_000)
    child.on('close', (value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })

  // Give a departing child a moment to be reaped before counting survivors.
  await new Promise((resolve) => setTimeout(resolve, 400))
  const orphans = serverPids().filter((pid) => !before.has(pid))

  return { code, stdout, stderr, orphans }
}

describe('startup refusals', () => {
  beforeAll(() => {
    ensureBuilt()
  }, 180_000)

  it('exits 2 naming the missing variable, without spawning a server', async () => {
    const run = await runCli({ env: { ANTHROPIC_API_KEY: undefined } })

    expect(run.code).toBe(2)
    expect(run.stderr).toContain('ANTHROPIC_API_KEY')
    // FR-034: the credential is checked before anything is spawned or contacted.
    expect(run.orphans).toEqual([])
    expect(run.stdout).not.toContain('Connected to the GBIF MCP server')
  }, 60_000)

  it('exits 2 on a malformed MODEL, showing both accepted forms', async () => {
    const run = await runCli({ env: { MODEL: 'nonsense' } })

    expect(run.code).toBe(2)
    expect(run.stderr).toContain('MODEL')
    expect(run.stderr).toContain('anthropic:claude-opus-5')
    expect(run.stderr).toContain('anthropic/claude-opus-5')
    expect(run.orphans).toEqual([])
  }, 60_000)

  it('exits 2 when the server it was pointed at is not built', async () => {
    const run = await runCli({ env: { GBIF_MCP_SERVER_PATH: '/nonexistent/server.js' } })

    expect(run.code).toBe(2)
    expect(run.stderr).toContain('not built')
  }, 60_000)
})

describe('teardown leaves no orphaned server', () => {
  beforeAll(() => {
    ensureBuilt()
  }, 180_000)

  it('prints the resolved model before the first prompt', async () => {
    const run = await runCli({ stdin: '/exit\n' })

    // FR-033: any answer must be attributable to a named model.
    expect(run.stdout).toContain('Model: claude-opus-5 via anthropic (direct)')
  }, 60_000)

  it('exits cleanly on /exit', async () => {
    const run = await runCli({ stdin: '/exit\n' })

    expect(run.code).toBe(0)
    expect(run.stdout).toContain('Exiting.')
    expect(run.orphans).toEqual([])
  }, 60_000)

  it('exits cleanly on EOF', async () => {
    const run = await runCli({ stdin: '' })

    expect(run.code).toBe(0)
    expect(run.orphans).toEqual([])
  }, 60_000)

  it('exits on SIGINT, tearing the server down with it', async () => {
    const run = await runCli({
      signalAfter: { line: 'Connected to the GBIF MCP server', signal: 'SIGINT' },
      closeStdin: false,
    })

    expect(run.orphans).toEqual([])
  }, 60_000)

  it('exits on SIGTERM, tearing the server down with it', async () => {
    const run = await runCli({
      signalAfter: { line: 'Connected to the GBIF MCP server', signal: 'SIGTERM' },
      closeStdin: false,
    })

    expect(run.orphans).toEqual([])
  }, 60_000)

  it('discovers the three tools over the protocol boundary', async () => {
    const run = await runCli({ stdin: '/exit\n' })

    // Constitution VII: this package has no dependency on mcp-server. These
    // names arrived over stdio, from a server launched as a child process.
    expect(run.stdout).toContain('resolve_taxon')
    expect(run.stdout).toContain('summarize_occurrences')
    expect(run.stdout).toContain('search_occurrences')
  }, 60_000)
})
