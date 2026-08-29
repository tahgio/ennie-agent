/**
 * stdout carries JSON-RPC and nothing else (SC-009, FR-025, Constitution I).
 *
 * This is the one guarantee that cannot be checked by talking to the server
 * over an in-memory transport, because an in-memory transport never touches a
 * file descriptor. So this test does the real thing: it spawns the built server
 * as a child process over actual stdio, runs a full client session against it,
 * and then parses every byte that came back on fd 1.
 *
 * The failure this prevents is nasty in production. A single stray `console.log`
 * — ours or a dependency's — lands mid-stream, the client's JSON parser chokes,
 * and the user sees an unexplainable protocol error with nothing in it that
 * points at the actual cause.
 *
 * The session is deliberately limited to offline methods (initialize,
 * tools/list, prompts/list). It needs no network, so it belongs in the default
 * suite (FR-038).
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPO_ROOT = join(PACKAGE_ROOT, '..', '..')
const ENTRYPOINT = join(PACKAGE_ROOT, 'dist', 'index.js')

/**
 * Build on demand rather than assuming someone ran `pnpm build` first.
 *
 * Node's type stripping does not rewrite the `.js` specifiers that `nodenext`
 * requires, so the entrypoint genuinely has to be compiled before a child
 * process can run it.
 */
function ensureBuilt(): void {
  if (existsSync(ENTRYPOINT)) return
  execFileSync(join(REPO_ROOT, 'node_modules', '.bin', 'tsc'), ['--build', PACKAGE_ROOT], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  })
}

interface Session {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
}

/** Drive a real stdio session and return everything each stream produced. */
async function runSession(requests: readonly unknown[]): Promise<Session> {
  const child = spawn(process.execPath, [ENTRYPOINT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LOG_LEVEL: 'info' },
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })

  for (const request of requests) {
    child.stdin.write(`${JSON.stringify(request)}\n`)
    // Let the server answer before the next frame, so responses interleave the
    // way they would with a real client rather than arriving in one burst.
    await new Promise((resolve) => setTimeout(resolve, 60))
  }

  child.stdin.end()
  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code))
    setTimeout(() => {
      child.kill('SIGTERM')
      resolve(null)
    }, 8000)
  })

  return { stdout, stderr, exitCode }
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'stdout-purity-test', version: '0.0.0' },
  },
}

const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' }
const listTools = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
const listPrompts = { jsonrpc: '2.0', id: 3, method: 'prompts/list', params: {} }

describe('stdout purity over real stdio', () => {
  beforeAll(() => {
    ensureBuilt()
  }, 120_000)

  it('emits only parseable JSON-RPC frames across a full session', async () => {
    const session = await runSession([initialize, initialized, listTools, listPrompts])

    const lines = session.stdout.split('\n').filter((line) => line.trim() !== '')
    expect(lines.length).toBeGreaterThan(0)

    for (const line of lines) {
      let frame: unknown
      expect(() => {
        frame = JSON.parse(line)
      }, `stdout carried a line that is not JSON, which would break any MCP client:\n${line}`).not.toThrow()

      expect(frame).toMatchObject({ jsonrpc: '2.0' })
    }
  }, 60_000)

  it('answers initialize with the server instructions, on stdout', async () => {
    const session = await runSession([initialize])

    const frames = session.stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { id?: number; result?: { instructions?: string } })

    const response = frames.find((frame) => frame.id === 1)
    expect(response?.result?.instructions).toContain('GBIF')
  }, 60_000)

  it('sends its own logs to stderr, where they cannot corrupt the stream', async () => {
    const session = await runSession([initialize])

    // The startup log line proves logging is wired and pointed at fd 2.
    expect(session.stderr).toContain('listening on stdio')
    expect(session.stdout).not.toContain('listening on stdio')
  }, 60_000)
})

describe('stdout-guard', () => {
  beforeAll(() => {
    ensureBuilt()
  }, 120_000)

  it('reroutes console.log to stderr, so a dependency cannot corrupt the stream', async () => {
    const guard = join(PACKAGE_ROOT, 'dist', 'stdout-guard.js')
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import ${JSON.stringify(`file://${guard}`)}; console.log('LEAKED'); console.info('ALSO_LEAKED');`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )

    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c: string) => {
      stdout += c
    })
    child.stderr.on('data', (c: string) => {
      stderr += c
    })
    await new Promise((resolve) => child.on('close', resolve))

    expect(stdout).toBe('')
    expect(stderr).toContain('LEAKED')
    expect(stderr).toContain('ALSO_LEAKED')
  }, 60_000)
})
