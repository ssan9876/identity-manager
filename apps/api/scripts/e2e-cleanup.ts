import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { loadEnv } from '../src/config/env'
import { createDbClient } from '../src/db/client'

/**
 * Deletes exactly the rows `apps/web/e2e`'s own fixtures created — never
 * anything else — from the shared dev Postgres. This is TEST/OPS
 * infrastructure, invoked once per Playwright run from
 * `apps/web/e2e/support/global-teardown.ts` (never wired into AppModule,
 * never reachable over HTTP — see `db:migrate`/`reconcile-cli.ts`/
 * `jml/lifecycle-cli.ts`/`scripts/smoke-dev.ts` for the same "plain script,
 * no DI, no route" shape this mirrors), NOT a product feature: there is
 * still no `DELETE /users/:id` (or `/groups/:id`, or `/org-units/:id`)
 * anywhere in this codebase, and this script adds none. It reaches the
 * database the same way `scripts/smoke-dev.ts`'s own `seedActor().cleanup()`
 * already does for its one smoke-test fixture — raw `DELETE ... WHERE id =
 * $1`, connected as the RUNTIME role (`RUNTIME_DATABASE_URL` — finding H1,
 * docs/archive/audits/audit-integrity.md) — generalized here to a whole batch
 * of ids collected across an entire E2E run instead of one hand-tracked
 * fixture.
 *
 * WHY THIS IS SAFE, PRECISELY:
 *  - No new delete path on the PRODUCT's own surface: `UsersController`/
 *    `GroupsController`/`OrgUnitsController` and their repositories are
 *    completely untouched by this file. A real end user, or any other
 *    caller of the HTTP API, still has no way to delete a user, a group, or
 *    an org unit — exactly as before.
 *  - The FK is never weakened: `audit_log.actor_user_id`'s `onDelete:
 *    'restrict'` (db/schema/audit-log.ts) is left exactly as it is. If a
 *    tracked id is genuinely referenced there (it became an audit ACTOR,
 *    not merely a subject — see that column's own doc comment for the
 *    distinction), Postgres itself rejects the delete with a foreign-key
 *    violation, and this script reports that id as un-removable rather than
 *    forcing it through. In the current E2E suite this never actually
 *    happens (every write throughout apps/web/e2e is performed BY the
 *    pre-existing, permanent `admin@example.com` fixture — a test-created
 *    principal is only ever the SUBJECT of a write, never the actor —
 *    confirmed by inspection: every `auditWriter.record` call site in
 *    apps/api/src sets `actorUserId` to either `request.actor.userId`/
 *    `actor.userId` or an explicit `null`, never a value derived from the
 *    resource being acted on), but the code does not assume that.
 *  - `audit_log` itself is never touched: nothing here issues any query
 *    against that table, and the RUNTIME role could not perform a
 *    DELETE/UPDATE against it even if this script tried — `db/roles.ts`'s
 *    `provisionRuntimeRole` explicitly revokes exactly that.
 *  - This script only ever deletes an id that CALLER-SUPPLIED tracking
 *    said it created (see the cleanup-tracker/global-teardown doc comments,
 *    apps/web/e2e/support/) — never a name-based or heuristic match against
 *    the shared database's own pre-existing/other-run data.
 */

interface CleanupManifest {
  users: string[]
  groups: string[]
  orgUnits: string[]
}

function log(message: string): void {
  console.log(`[e2e-cleanup] ${message}`)
}

function readManifest(path: string): CleanupManifest {
  const raw = readFileSync(path, 'utf8')
  const parsed = JSON.parse(raw) as Partial<CleanupManifest>
  const dedupe = (value: unknown): string[] =>
    Array.isArray(value) ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string'))] : []
  return {
    users: dedupe(parsed.users),
    groups: dedupe(parsed.groups),
    orgUnits: dedupe(parsed.orgUnits),
  }
}

/** One id, one DELETE — never a single all-or-nothing batch statement, so one row genuinely blocked by a real FK (see this file's own doc comment) never stops every OTHER row in the same table from being removed. */
async function deleteRowsOneByOne(
  pool: Pool,
  table: 'users' | 'groups' | 'org_units',
  ids: readonly string[],
): Promise<{ deletedIds: string[]; failures: Map<string, string> }> {
  const deletedIds: string[] = []
  const failures = new Map<string, string>()
  for (const id of ids) {
    try {
      await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id])
      deletedIds.push(id)
    } catch (error) {
      failures.set(id, error instanceof Error ? error.message : String(error))
    }
  }
  return { deletedIds, failures }
}

/**
 * Repeats one-by-one deletion passes until either nothing remains or a full
 * pass makes zero progress. Exists for `org_units` specifically: a child org
 * unit created under an existing one is itself the parent's `parent_id`
 * target, and `org_units.parent_id` is `onDelete: 'restrict'` (db/schema/
 * org-units.ts) — a parent attempted before its own just-created child (pure
 * accident of array order, since ids are collected in creation order but a
 * PARENT can be created and tracked before a later test creates a CHILD
 * under it) would otherwise fail even though both are legitimately this
 * run's own rows. A second pass, after the child is gone, succeeds. Applied
 * uniformly to every table this script deletes from — harmless (a single
 * pass with zero failures is a no-op loop) for `users`/`groups`, which have
 * no equivalent self-referencing constraint.
 */
async function deleteWithRetry(
  pool: Pool,
  table: 'users' | 'groups' | 'org_units',
  ids: readonly string[],
): Promise<{ deletedCount: number; failures: Map<string, string> }> {
  let remaining = ids
  let deletedCount = 0
  let failures = new Map<string, string>()
  while (remaining.length > 0) {
    const result = await deleteRowsOneByOne(pool, table, remaining)
    deletedCount += result.deletedIds.length
    failures = result.failures
    if (result.deletedIds.length === 0) {
      break // a full pass removed nothing — genuinely stuck, not a mis-ordering.
    }
    remaining = [...failures.keys()]
  }
  return { deletedCount, failures }
}

/**
 * Best-effort tidiness, not required for correctness: `outbox_events.
 * aggregate_id` carries no FK (db/schema/outbox-events.ts — it cannot,
 * `aggregate_type` names one of FOUR different possible tables), so deleting
 * a user/group/org-unit never cascades here on its own, and a stray
 * historical event row referencing a since-removed id is harmless (nothing
 * re-reads `outbox_events` by joining against the aggregate it names — the
 * worker only ever reads a CLAIMED row's own columns). Removed anyway so
 * this table doesn't become the NEXT unbounded-growth surface this task's
 * own fix was written to close.
 */
async function deleteOutboxEventsFor(
  pool: Pool,
  aggregateType: 'user' | 'group' | 'org_unit',
  aggregateIds: readonly string[],
): Promise<number> {
  if (aggregateIds.length === 0) return 0
  const { rowCount } = await pool.query(
    `DELETE FROM outbox_events WHERE aggregate_type = $1::outbox_aggregate_type AND aggregate_id = ANY($2::uuid[])`,
    [aggregateType, aggregateIds],
  )
  return rowCount ?? 0
}

async function main(): Promise<void> {
  // `pnpm run e2e:cleanup -- <path>` — unlike npm, pnpm forwards the literal
  // `--` separator itself as an argument rather than consuming it (confirmed
  // empirically running this script both directly and via `pnpm run`), so
  // this filters it out rather than assuming a fixed argv INDEX.
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const manifestPath = args[0]
  if (!manifestPath) {
    throw new Error('usage: e2e-cleanup <path-to-manifest.json>')
  }
  const manifest = readManifest(manifestPath)
  const totalRequested = manifest.users.length + manifest.groups.length + manifest.orgUnits.length
  if (totalRequested === 0) {
    log('nothing to clean up (empty manifest) — done.')
    return
  }
  log(
    `manifest: ${manifest.users.length} user(s), ${manifest.groups.length} group(s), ${manifest.orgUnits.length} org unit(s)`,
  )

  const env = loadEnv(process.env)
  const { pool } = createDbClient(env.runtimeDatabaseUrl, { max: env.dbPoolMax })

  try {
    // Dependency order: users before org_units/groups (users.org_unit_id is
    // restrict — db/schema/users.ts), groups before org_units (groups.
    // org_unit_id is also restrict — db/schema/groups.ts). Everything else
    // that references users/groups (role_assignments, group_user_members,
    // group_group_members, external_identities, external_group_identities)
    // is `onDelete: 'cascade'` and needs no explicit statement of its own.
    const users = await deleteWithRetry(pool, 'users', manifest.users)
    const groups = await deleteWithRetry(pool, 'groups', manifest.groups)
    const orgUnits = await deleteWithRetry(pool, 'org_units', manifest.orgUnits)

    await deleteOutboxEventsFor(pool, 'user', users.deletedCount > 0 ? manifest.users : [])
    await deleteOutboxEventsFor(pool, 'group', groups.deletedCount > 0 ? manifest.groups : [])
    await deleteOutboxEventsFor(pool, 'org_unit', orgUnits.deletedCount > 0 ? manifest.orgUnits : [])

    log(`deleted ${users.deletedCount}/${manifest.users.length} user(s)`)
    log(`deleted ${groups.deletedCount}/${manifest.groups.length} group(s)`)
    log(`deleted ${orgUnits.deletedCount}/${manifest.orgUnits.length} org unit(s)`)

    const allFailures = [
      ...[...users.failures].map(([id, error]) => ({ kind: 'user', id, error })),
      ...[...groups.failures].map(([id, error]) => ({ kind: 'group', id, error })),
      ...[...orgUnits.failures].map(([id, error]) => ({ kind: 'org_unit', id, error })),
    ]
    if (allFailures.length > 0) {
      // Structurally unavoidable residue (per this file's own doc comment,
      // most likely a row genuinely referenced by audit_log.actor_user_id)
      // — reported loudly, never silently dropped, and never treated as a
      // reason to fail this script: a leftover row that could not be
      // removed is not this run's fault, and a hard failure here would only
      // mask the E2E suite's own real pass/fail signal.
      console.warn(`[e2e-cleanup] ${allFailures.length} row(s) could NOT be removed:`)
      for (const failure of allFailures) {
        console.warn(`[e2e-cleanup]   ${failure.kind} ${failure.id}: ${failure.error}`)
      }
    }
  } finally {
    await pool.end()
  }
}

main()
  .then(() => log('done.'))
  .catch((error: unknown) => {
    console.error(`[e2e-cleanup] failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
