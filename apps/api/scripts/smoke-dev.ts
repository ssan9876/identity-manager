import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { loadEnv } from '../src/config/env'

/**
 * Boots the app exactly the way a human does — `pnpm run start:dev` — waits
 * for it to come up, mints a REAL token from the running dev Keycloak, and
 * makes one authenticated request through the whole stack.
 *
 * Why this exists: `pnpm test` cannot catch a dev-runtime-only regression.
 * The test transform (unplugin-swc, via vitest.config.ts) and the build
 * transform (tsc) both emit `design:paramtypes` decorator metadata; only the
 * dev transform can silently fail to. A controller constructor typed by bare
 * class reference (no explicit `@Inject(Token)`) resolves fine under both
 * test and build, passes every unit/integration test, compiles cleanly —
 * and then 500s on every real request once run under a transform that
 * doesn't emit that metadata. No unit test can see this: it is a property of
 * *how the dev server is started*, not of the code vitest evaluates. This
 * script is the only check in the repo that starts the app the same way a
 * human running `pnpm run start:dev` would and proves an authenticated
 * request actually reaches a repository.
 */

const HEALTH_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 500
const KEYCLOAK_CLIENT_ID = 'idm-test-client'
const KEYCLOAK_USERNAME = 'admin@example.com'
const KEYCLOAK_PASSWORD = 'dev_password_change_me'

function log(message: string): void {
  console.log(`[smoke:dev] ${message}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** PIDs currently LISTENING on `port`, Windows-only (netstat -ano parsing). */
function listeningPids(port: number): number[] {
  if (process.platform !== 'win32') return []
  try {
    const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
      encoding: 'utf8',
    })
    const pids = out
      .split('\n')
      .map((line) => line.trim().split(/\s+/).pop())
      .filter((pid): pid is string => !!pid && /^\d+$/.test(pid))
      .map(Number)
    return [...new Set(pids)]
  } catch {
    return [] // findstr exits non-zero when nothing matches — nothing listening.
  }
}

function killPid(pid: number): void {
  if (process.platform === 'win32') {
    try {
      // /T kills the whole tree rooted at pid. Necessary: `node --watch`
      // (like the `tsx watch` it replaced) supervises the real app in a
      // CHILD process with its own PID, so killing only the immediate
      // `pnpm run start:dev` process leaves the actual listener running.
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' })
    } catch {
      // Already gone — fine.
    }
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone — fine.
    }
  }
}

/**
 * Belt-and-braces shutdown: kill the spawned child's tree, THEN directly
 * kill whatever the OS says is actually bound to the port. Task 6 found
 * that stopping only the tracked wrapper process can leave the real
 * listener alive under a different PID.
 */
function shutdown(child: ChildProcess): void {
  if (child.pid) {
    killPid(child.pid)
  }
  for (const pid of listeningPids(Number(process.env.PORT) || 3000)) {
    killPid(pid)
  }
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  let lastError = 'no attempt succeeded'

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`)
      if (res.status === 200) {
        const body = (await res.json()) as { status?: string }
        if (body.status === 'ok') return
        lastError = `unexpected /health body: ${JSON.stringify(body)}`
      } else {
        lastError = `/health returned ${res.status}`
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(POLL_INTERVAL_MS)
  }

  throw new Error(`timed out waiting for ${baseUrl}/health: ${lastError}`)
}

async function mintToken(issuer: string): Promise<string> {
  const res = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: KEYCLOAK_CLIENT_ID,
      scope: 'openid profile email',
      username: KEYCLOAK_USERNAME,
      password: KEYCLOAK_PASSWORD,
    }),
  })

  if (!res.ok) {
    throw new Error(`Keycloak token request failed: ${res.status} ${await res.text()}`)
  }

  const body = (await res.json()) as { access_token?: string }
  if (!body.access_token) {
    throw new Error(`Keycloak token response had no access_token: ${JSON.stringify(body)}`)
  }
  return body.access_token
}

async function main(): Promise<void> {
  const env = loadEnv(process.env)
  const baseUrl = `http://localhost:${env.port}`

  const preExisting = listeningPids(env.port)
  if (preExisting.length > 0) {
    throw new Error(
      `port ${env.port} is already in use (pid ${preExisting.join(', ')}) — free it before running smoke:dev`,
    )
  }

  log('starting the dev server the way a human does: `pnpm run start:dev`')
  // A single command string (not `[cmd, ...args]`) avoids Node's DEP0190
  // warning about unescaped args under shell:true — there's no untrusted
  // input here, but there's also no reason to trip it.
  const child = spawn('pnpm run start:dev', {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  })

  let serverOutput = ''
  child.stdout?.on('data', (chunk: Buffer) => (serverOutput += chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => (serverOutput += chunk.toString()))

  let exitCode = 0
  try {
    log(`waiting for ${baseUrl}/health ...`)
    await waitForHealth(baseUrl)
    log('health check ok')

    log(`minting a token from ${env.keycloakIssuer} (${KEYCLOAK_USERNAME}) ...`)
    const token = await mintToken(env.keycloakIssuer)
    log('token minted')

    log('calling GET /users with the token ...')
    const res = await fetch(`${baseUrl}/users`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const text = await res.text()

    if (res.status !== 200) {
      throw new Error(`expected 200 from GET /users, got ${res.status}: ${text}`)
    }

    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`GET /users did not return valid JSON: ${text}`)
    }

    const items = (body as { items?: unknown } | null)?.items
    if (!Array.isArray(items)) {
      throw new Error(`GET /users response had no "items" array: ${text}`)
    }

    log(`SMOKE OK — GET /users -> 200, items: array (length ${items.length})`)
  } catch (error) {
    exitCode = 1
    console.error(`[smoke:dev] SMOKE FAILED: ${error instanceof Error ? error.message : String(error)}`)
    console.error('[smoke:dev] --- captured dev-server output ---')
    console.error(serverOutput || '(none captured)')
  } finally {
    log('shutting down the dev server ...')
    shutdown(child)
    await sleep(500)
  }

  process.exit(exitCode)
}

main().catch((error: unknown) => {
  console.error('[smoke:dev] unexpected error:', error)
  process.exit(1)
})
