import { AuditWriter } from '../audit/audit.writer'
import { loadEnv } from '../config/env'
import { createDbClient } from '../db/client'
import { OutboxWriter } from '../outbox/outbox.writer'
import { UsersRepository } from '../users/users.repository'
import { BusinessRolesRepository } from './business-roles.repository'
import { RoleReconciliationJob } from './role-reconciliation.job'
import { RoleReconciler } from './role-reconciler'

interface ParsedArgs {
  /** `null` means "sweep for every enabled role" — `RoleReconciliationJob.reconcileAll`. */
  roleId: string | null
}

/**
 * `process.argv.slice(2)`, filtering out a literal `"--"` token — the same
 * defensive shape `target-reconcile-cli.ts` and `bootstrap-admin-cli.ts`
 * already document (pnpm's own arg-forwarding can deliver `['--', ...]`
 * rather than stripping it).
 *
 * The role id is OPTIONAL here, unlike `target-reconcile`'s required target,
 * and accepted either bare (`pnpm run role-reconcile <id>`) or as
 * `--role=<id>` — the same "bare positional argument" precedent that CLI
 * follows. Omitting it sweeps the whole directory for every enabled role,
 * because that is what a scheduled run wants and a scheduled run is the
 * ordinary case; naming one narrows only the LOG LABEL, never the work (see
 * `RoleReconciliationJob.reconcileRole`'s own doc comment on why it still
 * walks everybody).
 *
 * There is deliberately no `--dry-run`/`--apply` pair. `target-reconcile`
 * needs one because it mutates EXTERNAL directories through connectors,
 * irreversibly and at scale; this job only ever writes rows this database
 * already knows how to derive again from the published role definitions, and
 * the operation that actually decides who gains and loses access — simulate
 * — is a separate, first-class route on the role itself (Task 11), gating
 * publish. A second, weaker preview here would be a worse answer to the same
 * question.
 */
function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.filter((arg) => arg !== '--')
  let roleId: string | null = null

  for (const arg of args) {
    if (arg.startsWith('--role=')) {
      roleId = arg.slice('--role='.length)
      continue
    }
    if (!arg.startsWith('--') && roleId === null) {
      roleId = arg
      continue
    }
    throw new Error(`role-reconcile: unrecognized argument "${arg}"`)
  }

  if (roleId !== null && roleId.trim().length === 0) {
    throw new Error('role-reconcile: --role was given an empty value')
  }

  return { roleId }
}

/**
 * The runtime entrypoint for `pnpm run role-reconcile [roleId]` — Milestone
 * 17, Task 10. Mirrors `outbox/target-reconcile-cli.ts` and
 * `jml/lifecycle-cli.ts` exactly: a plain `tsx` script that wires the job's
 * dependencies by hand (this job is also Nest-registered, but a CLI must not
 * boot the HTTP app to run one pass), and connects as the RUNTIME role
 * (finding H1, docs/archive/audits/audit-integrity.md) — every write it makes
 * is ordinary DML the runtime role already holds, exactly like
 * `lifecycle-cli.ts`.
 *
 * `now` is captured ONCE, here, and threaded through the whole sweep, so
 * every exception-expiry comparison in a single pass is made against one
 * instant. A sweep that read the clock per user could grant somebody an
 * expiring exception at the top of the run and revoke it at the bottom.
 */
async function main(): Promise<void> {
  const { roleId } = parseArgs(process.argv.slice(2))
  const env = loadEnv(process.env)
  const { db, pool } = createDbClient(env.runtimeDatabaseUrl, { max: env.dbPoolMax })

  try {
    const rolesRepository = new BusinessRolesRepository(db)
    const reconciler = new RoleReconciler(rolesRepository, new AuditWriter(), new OutboxWriter())
    const job = new RoleReconciliationJob(reconciler, new UsersRepository(db), rolesRepository, db)

    const now = new Date()
    console.log(
      roleId === null
        ? '[role-reconcile] reconciling every user against every enabled business role ...'
        : `[role-reconcile] reconciling every user, on behalf of role ${roleId} ...`,
    )

    const report = roleId === null ? await job.reconcileAll(now) : await job.reconcileRole(roleId, now)

    console.log(`[role-reconcile] scanned ${report.scanned} user(s)`)
    console.log(`[role-reconcile] changed ${report.changed} user(s)' entitlements`)

    // A refusal means somebody's entitlements were NOT asserted this pass —
    // neither granted nor revoked. Printed per user with the offending role
    // and reason (this task's own brief), and made to exit non-zero, so a
    // scheduled run surfaces in the journal as a failure rather than as a
    // quiet success that happened to fix nothing. Same posture as
    // `target-reconcile`'s halted branch and `jml:lifecycle`'s skip report
    // (finding M5).
    if (report.refusals.length > 0) {
      console.error(`[role-reconcile] REFUSED to reconcile ${report.refusals.length} user(s):`)
      for (const refusal of report.refusals) {
        console.error(
          `[role-reconcile]   ${refusal.userId} — role "${refusal.roleName}" (${refusal.roleId}) ` +
            `is unevaluable: ${refusal.reason}`,
        )
      }
      console.error(
        '[role-reconcile] fix or disable the role(s) above and re-run — until then those users hold ' +
          'whatever they held before this pass.',
      )
      process.exitCode = 1
    }

    // Standing SoD violations are a REPORT, never an action — the sweep has
    // already finished and revoked nothing on their account. Printed to
    // stdout, not stderr, and without flipping the exit code: unlike a
    // refusal, a standing violation is not this pass failing to do its job,
    // it is the directory's current state, surfaced for a human to resolve
    // through the console (retire the conflict, exclude the person, or edit
    // a formula and republish through the gate).
    if (report.sod.violationCount > 0) {
      console.log(
        `[role-reconcile] ${report.sod.violationCount} standing segregation-of-duties violation(s) ` +
          `across ${report.sod.conflictsChecked} enabled conflict(s):`,
      )
      for (const violation of report.sod.violations) {
        console.log(
          `[role-reconcile]   ${violation.username} (${violation.userId}) holds both ` +
            `"${violation.roleA.roleName}" (${violation.roleA.via}) and ` +
            `"${violation.roleB.roleName}" (${violation.roleB.via}) — ${violation.conflictReason}`,
        )
      }
      if (report.sod.truncated) {
        console.log('[role-reconcile]   ... list truncated; the count above is the true total.')
      }
    }
    if (report.sod.unevaluable.length > 0) {
      console.warn(
        `[role-reconcile] ${report.sod.unevaluable.length} conflict role(s) could not be evaluated ` +
          'for at least one user — the standing-violation report above is honest but partial:',
      )
      for (const entry of report.sod.unevaluable) {
        console.warn(`[role-reconcile]   "${entry.roleName}" (${entry.roleId}): ${entry.reason}`)
      }
    }

    if (report.skipped.length > 0) {
      console.warn(
        `[role-reconcile] ${report.skipped.length} user(s) vanished mid-sweep and were skipped: ` +
          report.skipped.join(', '),
      )
    }
  } finally {
    await pool.end()
  }
}

main()
  .then(() => {
    console.log('[role-reconcile] done.')
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[role-reconcile] failed: ${message}`)
    process.exitCode = 1
  })
