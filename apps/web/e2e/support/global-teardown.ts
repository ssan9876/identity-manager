import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLEANUP_DIR } from './cleanup-tracker'

interface CleanupManifest {
  users: string[]
  groups: string[]
  orgUnits: string[]
}

function log(message: string): void {
  console.log(`[e2e global-teardown] ${message}`)
}

interface TrackedEntry {
  kind: string
  id: string
}

function isTrackedEntry(value: unknown): value is TrackedEntry {
  const record = value as Record<string, unknown> | null
  return (
    record !== null &&
    typeof record === 'object' &&
    typeof record.kind === 'string' &&
    typeof record.id === 'string'
  )
}

/**
 * Reads every `*.ndjson` file `cleanup-tracker.ts` wrote during this run
 * (one per Playwright worker process — see that file's own doc comment) and
 * merges them into one deduplicated manifest.
 */
function collectManifest(): CleanupManifest {
  const manifest: CleanupManifest = { users: [], groups: [], orgUnits: [] }
  const files = readdirSync(CLEANUP_DIR).filter((name) => name.endsWith('.ndjson'))

  for (const file of files) {
    const content = readFileSync(join(CLEANUP_DIR, file), 'utf8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        console.warn(`[e2e global-teardown] skipping unparseable tracking line in ${file}: ${trimmed}`)
        continue
      }
      if (!isTrackedEntry(parsed)) {
        console.warn(`[e2e global-teardown] skipping malformed tracking entry in ${file}: ${trimmed}`)
        continue
      }
      if (parsed.kind === 'user') manifest.users.push(parsed.id)
      else if (parsed.kind === 'group') manifest.groups.push(parsed.id)
      else if (parsed.kind === 'orgUnit') manifest.orgUnits.push(parsed.id)
    }
  }

  return {
    users: [...new Set(manifest.users)],
    groups: [...new Set(manifest.groups)],
    orgUnits: [...new Set(manifest.orgUnits)],
  }
}

/**
 * Playwright's own `globalTeardown` hook — runs exactly ONCE, after every
 * worker and every test file in the whole run has finished (never per-test,
 * never per-file). That timing is load-bearing here, not incidental: this
 * suite runs 8 workers concurrently against ONE shared, persistent dev
 * database (see `e2e/connectors.spec.ts`'s own doc comment on why that is
 * this suite's normal operating mode), so deferring every deletion to a
 * single run-final pass means cleanup never races a still-in-flight test in
 * a DIFFERENT worker — by the time this runs, nothing else is reading or
 * writing anything.
 *
 * Self-healing by construction: `CLEANUP_DIR` (cleanup-tracker.ts) is a
 * FIXED path, not freshly generated per run, so if an EARLIER run crashed
 * before reaching its own teardown, its now-stale per-worker files are
 * still sitting there — this run's own teardown reads every file present,
 * so that previously-orphaned data gets swept up and removed here too, on
 * the next run that actually completes, not just this run's own.
 *
 * The actual deletion is delegated to `apps/api`'s own `e2e:cleanup` CLI
 * (`apps/api/scripts/e2e-cleanup.ts`) via `execSync` — the SAME
 * cross-package "shell out to a real script in @idm/api" mechanism
 * `e2e/person-picker.spec.ts`'s own `activatePendingUsers()` already
 * establishes for `jml:lifecycle`, not a new pattern invented here. See
 * that script's own doc comment for exactly what it deletes, in what order,
 * and why doing so from test/ops infrastructure — never through the
 * product's own HTTP API, never weakening the audit-log FK, never touching
 * audit_log itself — is safe.
 *
 * Never throws: a cleanup hiccup must not turn an otherwise fully green E2E
 * run into a failed one. Logged loudly instead, so it is visible rather
 * than silently swallowed.
 */
export default async function globalTeardown(): Promise<void> {
  try {
    if (!existsSync(CLEANUP_DIR)) {
      log('no tracking directory found — nothing was created this run, or nothing to clean up.')
      return
    }

    const manifest = collectManifest()
    const total = manifest.users.length + manifest.groups.length + manifest.orgUnits.length
    log(
      `collected ${manifest.users.length} user(s), ${manifest.groups.length} group(s), ${manifest.orgUnits.length} org unit(s) to remove`,
    )

    if (total === 0) {
      rmSync(CLEANUP_DIR, { recursive: true, force: true })
      return
    }

    const manifestPath = join(CLEANUP_DIR, 'manifest.json')
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8')

    // e2e/support -> e2e -> web -> apps -> repo root. Same derivation
    // `person-picker.spec.ts`'s own `activatePendingUsers()` uses, with one
    // extra `..` for this file's own extra `support/` directory level.
    const supportDir = dirname(fileURLToPath(import.meta.url))
    const repoRoot = join(supportDir, '..', '..', '..', '..')

    log("invoking apps/api's e2e:cleanup ...")
    execSync(`pnpm --filter @idm/api run e2e:cleanup -- "${manifestPath}"`, {
      cwd: repoRoot,
      stdio: 'inherit',
    })

    rmSync(CLEANUP_DIR, { recursive: true, force: true })
    log('done.')
  } catch (error) {
    console.error(
      `[e2e global-teardown] cleanup failed (non-fatal to the test run's own pass/fail result): ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}
