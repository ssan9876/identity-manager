import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Test hygiene (H2 race-flake investigation, "Shared dev-database growth"):
 * `apps/web/e2e`'s own fixtures create real `users`/`groups`/`org_units`
 * rows against the persistent compose-stack Postgres and, before this file
 * existed, never cleaned any of it up — confirmed growing 504 -> 581 -> 747
 * users across sessions. There is no `DELETE /users/:id` (or `/groups/:id`,
 * `/org-units/:id`) anywhere in this product, by design (see
 * `apps/api/src/outbox/sync.worker.ts`'s own "There is no delete for users"
 * doc comment) — so a spec cannot clean up through the ordinary API the way
 * `e2e/connectors.spec.ts` already does for `attribute-target-mappings`
 * (which DOES have a real delete route).
 *
 * This module is ONLY the recording half. Every spec that creates a
 * user/group/org-unit calls the matching `track*` function immediately
 * after creation — right next to the `expect(res.ok()).toBeTruthy()` (or
 * UI-driven equivalent) that proves it landed, so a test that fails partway
 * through still leaves behind an accurate record of whatever it already
 * created. Each call appends one JSON line to a file NAMED BY THIS WORKER
 * PROCESS's own pid, under a fixed, well-known OS-temp directory
 * (`CLEANUP_DIR`) — never a single shared file: Playwright runs several
 * workers as SEPARATE OS processes in parallel (this suite: 8 — see
 * `e2e/connectors.spec.ts`'s own doc comment), and two independent
 * processes appending to the exact same file has no atomicity guarantee
 * this codebase is willing to rely on. A single worker process only ever
 * runs one test at a time, so sequential `appendFileSync` calls from within
 * it are never a race with each other.
 *
 * The actual DELETE happens once, in `global-teardown.ts`, at the very end
 * of the whole run, going around the product's own HTTP API entirely (never
 * through it, and never adding a route to it) — see that file's and
 * `apps/api/scripts/e2e-cleanup.ts`'s own doc comments for the full
 * mechanism and why it is safe.
 */
export const CLEANUP_DIR = join(tmpdir(), 'idm-e2e-cleanup')

type TrackedKind = 'user' | 'group' | 'orgUnit'

function trackedFilePath(): string {
  return join(CLEANUP_DIR, `${process.pid}.ndjson`)
}

/**
 * Never throws — a tracking-write failure (a near-impossible disk/
 * permission issue) must not fail the TEST whose real job is to prove
 * product behaviour, not bookkeeping. Logged loudly so it is not silently
 * invisible either: a fixture that goes untracked becomes exactly the
 * un-cleaned residue this whole mechanism exists to prevent.
 */
function track(kind: TrackedKind, id: string): void {
  try {
    mkdirSync(CLEANUP_DIR, { recursive: true })
    appendFileSync(trackedFilePath(), `${JSON.stringify({ kind, id })}\n`, 'utf8')
  } catch (error) {
    console.error(
      `[e2e cleanup-tracker] failed to record ${kind} ${id} for cleanup — it may be left behind: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

/** Call immediately after any `POST /users` (or UI-driven equivalent) succeeds, with the created user's own id. */
export function trackUser(id: string): void {
  track('user', id)
}

/** Call immediately after any `POST /groups` (or UI-driven equivalent) succeeds, with the created group's own id. */
export function trackGroup(id: string): void {
  track('group', id)
}

/** Call immediately after any `POST /org-units` (or UI-driven equivalent) succeeds, with the created org unit's own id. */
export function trackOrgUnit(id: string): void {
  track('orgUnit', id)
}
