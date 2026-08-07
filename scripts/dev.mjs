#!/usr/bin/env node
// Starts the API (`apps/api`'s `start:dev`) and the web console
// (`apps/web`'s Vite dev server) together, with clearly labelled,
// interleaved output — the third of the three commands in README.md's
// Quickstart. Assumes `pnpm setup:all` has already run (dependencies
// installed, `.env` files present, database migrated).
//
// Deliberately plain Node (no `concurrently`-style dependency, matching
// `scripts/setup.mjs`'s own reasoning): both children are just
// `pnpm --filter <pkg> run <script>` processes, and prefixing their output
// line-by-line plus forwarding a Ctrl-C to both is a small amount of code
// with only `node:child_process`.

import { execSync, spawn } from 'node:child_process'

const CHILDREN = [
  { label: 'api', filter: '@idm/api', script: 'start:dev', color: '\x1b[36m' }, // cyan
  { label: 'web', filter: '@idm/web', script: 'dev', color: '\x1b[35m' }, // magenta
]
const RESET = '\x1b[0m'
const API_PORT = 3000

function prefixAndWrite(label, color, chunk, writeFn) {
  const lines = chunk.toString().split(/\r?\n/)
  // A trailing empty element means the chunk ended exactly on a newline —
  // drop it so a full line isn't followed by a bare, empty prefixed line.
  if (lines[lines.length - 1] === '') lines.pop()
  for (const line of lines) {
    writeFn(`${color}[${label}]${RESET} ${line}\n`)
  }
}

/** PIDs currently LISTENING on `port`, Windows-only — mirrors apps/api/scripts/smoke-dev.ts's own helper. */
function listeningPids(port) {
  if (process.platform !== 'win32') return []
  try {
    const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8' })
    return [
      ...new Set(
        out
          .split('\n')
          .map((line) => line.trim().split(/\s+/).pop())
          .filter((pid) => pid && /^\d+$/.test(pid))
          .map(Number),
      ),
    ]
  } catch {
    return [] // findstr exits non-zero when nothing matches — nothing listening.
  }
}

function killPid(pid) {
  if (process.platform === 'win32') {
    // /T kills the whole tree rooted at pid — required because
    // `apps/api`'s `start:dev` (`node --watch`) supervises the real app in
    // a CHILD process with its own PID; killing only the immediate `pnpm`
    // process leaves the actual listener running (identical issue to the
    // one apps/api/scripts/smoke-dev.ts's own killPid documents).
    try {
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

const children = []
let shuttingDown = false

function shutdownAndExit(exitCode) {
  if (shuttingDown) return
  shuttingDown = true

  console.log('\n[dev] shutting down ...')
  for (const child of children) {
    if (child.proc.pid) killPid(child.proc.pid)
  }
  // Belt-and-braces, same reasoning as killPid's /T above: also kill
  // whatever the OS says is actually bound to the API port, independent of
  // which tracked PID we think owns it.
  for (const pid of listeningPids(API_PORT)) killPid(pid)

  process.exit(exitCode)
}

process.on('SIGINT', () => shutdownAndExit(0))
process.on('SIGTERM', () => shutdownAndExit(0))

console.log('[dev] starting the API and the web console — Ctrl-C stops both.')

for (const { label, filter, script, color } of CHILDREN) {
  const proc = spawn('pnpm', ['--filter', filter, 'run', script], {
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push({ label, proc })

  proc.stdout.on('data', (chunk) => prefixAndWrite(label, color, chunk, (s) => process.stdout.write(s)))
  proc.stderr.on('data', (chunk) => prefixAndWrite(label, color, chunk, (s) => process.stderr.write(s)))

  proc.on('error', (error) => {
    console.error(`\n[dev] failed to start "${label}": ${error.message}`)
    shutdownAndExit(1)
  })

  proc.on('exit', (code, signal) => {
    if (shuttingDown) return
    console.log(`\n[dev] "${label}" exited unexpectedly (code ${code}, signal ${signal ?? 'none'}) — stopping the other process too.`)
    shutdownAndExit(1)
  })
}
