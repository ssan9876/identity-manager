import { AuditWriter } from '../audit/audit.writer'
import { loadEnv } from '../config/env'
import { createDbClient } from '../db/client'
import { OrgUnitsRepository } from '../org-units/org-units.repository'
import { OutboxWriter } from '../outbox/outbox.writer'
import { BulkActivateJob } from './bulk-activate.job'
import { UsersRepository } from './users.repository'

interface ParsedArgs {
  orgUnitId: string | null
  apply: boolean
}

/**
 * `process.argv.slice(2)`, filtering out a literal `"--"` token — the same
 * defensive shape `bootstrap-admin-cli.ts` and `target-reconcile-cli.ts`
 * already document (pnpm's own arg-forwarding can deliver `['--', ...]`
 * rather than stripping it).
 *
 * DRY RUN IS THE DEFAULT. `--apply` is the only way to write anything, and
 * there is deliberately no short form: this command can flip hundreds of
 * accounts from "cannot sign in anywhere" to "can sign in everywhere" in
 * one call, which is the single most consequential thing any CLI in this
 * repo does. `target-reconcile-cli.ts` set this precedent for a materially
 * smaller blast radius; it applies with more force here.
 *
 * `--org-unit=<uuid>` narrows the run to that unit AND ITS DESCENDANTS.
 * Omitting it means the whole directory, which is a real and legitimate
 * intent (the backfill this command exists for) but must be typed as
 * `--all` rather than reached by forgetting an argument — a bare
 * `pnpm run activate --apply` that silently meant "everyone" is exactly the
 * accident this refuses to make possible.
 */
function parseArgs(argv: string[]): ParsedArgs & { all: boolean } {
  const args = argv.filter((arg) => arg !== '--')
  let orgUnitId: string | null = null
  let apply = false
  let all = false

  for (const arg of args) {
    if (arg === '--apply') {
      apply = true
      continue
    }
    if (arg === '--all') {
      all = true
      continue
    }
    if (arg.startsWith('--org-unit=')) {
      orgUnitId = arg.slice('--org-unit='.length)
      continue
    }
    throw new Error(`activate: unrecognized argument "${arg}"`)
  }

  if (orgUnitId === null && !all) {
    throw new Error(
      'activate: scope is required — pass "--org-unit=<uuid>" for one subtree, or "--all" for the whole directory',
    )
  }

  if (orgUnitId !== null && all) {
    throw new Error('activate: pass either "--org-unit=<uuid>" or "--all", not both')
  }

  return { orgUnitId, apply, all }
}

/**
 * Bulk-activates `pending` users — the operator-facing entrypoint for
 * `BulkActivateJob` (see that class's doc comment for why it exists and why
 * it mirrors `LifecycleJob`'s per-user-transaction shape).
 *
 * Connects as the RUNTIME role, same reasoning as `lifecycle-cli.ts` and
 * `reconcile-cli.ts`: every write here (status transitions, audit rows,
 * outbox events) is ordinary DML the runtime role already holds, and this
 * is part of "the application" operationally, not a schema-owning step.
 *
 * Usage:
 *   pnpm --filter @idm/api run activate -- --all                  # dry run
 *   pnpm --filter @idm/api run activate -- --all --apply
 *   pnpm --filter @idm/api run activate -- --org-unit=<uuid> --apply
 */
async function main(): Promise<void> {
  const { orgUnitId, apply, all } = parseArgs(process.argv.slice(2))
  const env = loadEnv(process.env)
  const { db, pool } = createDbClient(env.runtimeDatabaseUrl, { max: env.dbPoolMax })

  try {
    const usersRepository = new UsersRepository(db)
    const job = new BulkActivateJob(usersRepository, new AuditWriter(), new OutboxWriter(), db)

    // The job takes an ltree PATH, not an id — resolve it here so the
    // operator can pass the id they can actually see in the console, and so
    // a typo'd/unknown unit fails fast and loudly rather than silently
    // matching nothing and reporting "0 candidates", which reads exactly
    // like a legitimately empty subtree.
    let scopePath: string | undefined
    if (orgUnitId !== null) {
      const orgUnit = await new OrgUnitsRepository(db).findById(orgUnitId)
      if (orgUnit === null) {
        throw new Error(`activate: no org unit with id "${orgUnitId}"`)
      }
      scopePath = orgUnit.path
      console.log(`[activate] scope: "${orgUnit.name}" and its descendants (${orgUnit.path})`)
    } else if (all) {
      console.log('[activate] scope: the WHOLE directory')
    }

    const report = await job.run({ scopePath, apply })

    if (report.dryRun) {
      console.log(`[activate] DRY RUN — ${report.candidates} pending user(s) would be activated.`)
      console.log('[activate] nothing was changed. Re-run with --apply to perform it.')
      return
    }

    console.log(`[activate] activated ${report.activatedUserIds.length} of ${report.candidates} candidate(s)`)
    console.log('[activate] each activation queued a status_changed outbox event — the accounts')
    console.log('[activate] are enabled downstream once the sync worker drains them, not immediately.')

    // Same reasoning as lifecycle-cli.ts: the report, not a log line buried
    // mid-run, is the record of anything left unactioned.
    if (report.skipped.length > 0) {
      console.warn(`[activate] ${report.skipped.length} candidate(s) could not be actioned:`)
      for (const skip of report.skipped) {
        console.warn(`[activate]   ${skip.userId} — ${skip.reason}`)
      }
    }
  } finally {
    await pool.end()
  }
}

main()
  .then(() => {
    console.log('[activate] done.')
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[activate] failed: ${message}`)
    process.exitCode = 1
  })
