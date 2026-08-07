#!/usr/bin/env node
// `pnpm verify` / `pnpm verify:quick` — the gate that actually protects this
// project TODAY.
//
// This repository has no git remote (see `.github/workflows/ci.yml`'s own
// header comment) — a workflow file alone protects nothing until something
// pushes to a remote that runs it. This script is CI's local twin: same
// stages, same "any failure stops the run," runnable by a human before every
// commit with no runner and no network dependency beyond what's already on
// this machine (Docker, for the API suite's Testcontainers).
//
// Two known defect classes motivated this (see
// docs/superpowers/plans/2026-08-06-idp-milestone-9-ci-and-polish.md, Task 1):
//   1. `apps/api/scripts/` sat outside the `tsc` program (apps/api/tsconfig.json's
//      `include`) — `smoke-dev.ts` was never typechecked, only ever run through
//      `tsx`, which strips types without checking them.
//   2. `pnpm test` never invokes `tsc` at all — vitest's transform (unplugin-swc)
//      does not typecheck either. So even code that WAS inside the tsc program
//      (apps/api/src/**, which already covered bootstrap-admin-cli.ts,
//      reconcile-cli.ts and the jml lifecycle scheduler) had no gate actually
//      running `tsc` against it as part of anything a human or CI runs
//      routinely — `pnpm build` existed but nothing required it.
// This script is the fix for #2 (an actual gate); the apps/api/tsconfig.json
// `include` change is the fix for #1.
//
// Stages, in order — cheapest/fastest failures surface first:
//   1. typecheck   — tsc --noEmit, both packages (apps/api's `include` now
//                     covers src/, test/ AND scripts/)
//   2. lint        — only if an ESLint config is actually present; this repo
//                     has none configured yet, so today this stage logs and
//                     skips rather than silently pretending to run something
//                     that isn't there
//   3. build       — `pnpm -r build`: tsc emit for the API, `tsc -b && vite
//                     build` for the web console — proves both packages
//                     actually produce their real build artifacts, not just
//                     that --noEmit is happy
//   4. API suite   — `pnpm --filter @idm/api test` (vitest + Testcontainers,
//                     ~756 tests, ~150s). SKIPPED by `--quick`: this is the
//                     only stage that needs Docker containers, and the one
//                     `verify:quick` exists to avoid for a fast pre-commit
//                     check.
//
// No stage is ever skipped silently on failure and nothing here uses
// `continue-on-error`-style swallowing — the first non-zero exit stops the
// run and this process exits non-zero too.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

const quick = process.argv.includes('--quick')
const label = quick ? 'verify:quick' : 'verify'

function log(message) {
  console.log(`[${label}] ${message}`)
}

/** Runs a command with output streamed live to this process's own stdio. */
function runInherited(command, args) {
  return spawnSync(command, args, { stdio: 'inherit', cwd: repoRoot, shell: true })
}

/** Runs one gate stage; throws (stopping the whole run) on a non-zero exit. */
function stage(name, command, args) {
  log(`${name} ...`)
  const result = runInherited(command, args)
  if (result.error) {
    throw new Error(`${name} could not be started: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(
      `${name} FAILED (exit code ${result.status ?? 'unknown'}) — see output above for the real error.`,
    )
  }
  log(`${name} OK.`)
}

/**
 * Deliberately simple: known ESLint config filenames at the repo root or
 * either package. No devDependency-sniffing — a config file is what actually
 * makes lint runnable. Add a "lint" script to the relevant package.json(s)
 * alongside whichever config file lands; this function starts running the
 * `lint` stage for real the moment it finds one, no other wiring needed here.
 */
function isLintConfigured() {
  const configNames = [
    '.eslintrc',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.json',
    '.eslintrc.yml',
    '.eslintrc.yaml',
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    'eslint.config.ts',
  ]
  const candidateDirs = [repoRoot, path.join(repoRoot, 'apps', 'api'), path.join(repoRoot, 'apps', 'web')]
  return candidateDirs.some((dir) => configNames.some((name) => fs.existsSync(path.join(dir, name))))
}

async function main() {
  log(`starting (${quick ? 'typecheck + build only, no containers' : 'full gate, including the API suite'}) ...`)

  stage('typecheck', 'pnpm', ['run', 'typecheck'])

  if (isLintConfigured()) {
    stage('lint', 'pnpm', ['-r', 'run', 'lint'])
  } else {
    log('lint: no ESLint config found at the repo root or in apps/api or apps/web — skipping.')
  }

  stage('build', 'pnpm', ['run', 'build'])

  if (quick) {
    log('--quick: skipping the API suite (needs Docker/Testcontainers).')
  } else {
    stage('API suite', 'pnpm', ['--filter', '@idm/api', 'run', 'test'])
  }

  console.log('')
  log('passed.')
}

main().catch((error) => {
  console.error(`\n[${label}] FAILED: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
