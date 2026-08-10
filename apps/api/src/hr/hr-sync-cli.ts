import { AuditWriter } from '../audit/audit.writer'
import { PermissionEngine } from '../authz/permission.engine'
import { PrivilegeGuards } from '../authz/privilege.guards'
import { loadEnv } from '../config/env'
import { createDbClient } from '../db/client'
import { OrgUnitsRepository } from '../org-units/org-units.repository'
import { OutboxWriter } from '../outbox/outbox.writer'
import { UsersRepository } from '../users/users.repository'
import { HrSourcesRepository } from './hr-sources.repository'
import { HrSyncService, type HrSyncReport } from './hr-sync.service'

interface ParsedArgs {
  source: string
  actorUsername: string
  commit: boolean
  allowPartial: boolean
  force: boolean
}

/**
 * `process.argv.slice(2)`, filtering out a literal `"--"` token — the same
 * defensive shape bulk-activate-cli.ts and target-reconcile-cli.ts document
 * (pnpm's own arg-forwarding can deliver `['--', ...]`).
 *
 * DRY RUN IS THE DEFAULT — `--commit` is the only way to write anything
 * about a person, the same posture as `activate`'s `--apply` and the import
 * console's own preview-then-commit. `--allow-partial` and `--force` are
 * the two explicit guard overrides `evaluateHrRun` (hr-feed.ts) honours;
 * each does nothing without `--commit`.
 *
 * `--actor=<username>` is REQUIRED: the import pipeline's per-row scope
 * checks and every audit row this run writes are attributed to a real,
 * active user — there is deliberately no anonymous/system actor for a
 * command that creates and updates people.
 */
function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.filter((arg) => arg !== '--')
  let source: string | null = null
  let actorUsername: string | null = null
  let commit = false
  let allowPartial = false
  let force = false

  for (const arg of args) {
    if (arg === '--commit') {
      commit = true
      continue
    }
    if (arg === '--allow-partial') {
      allowPartial = true
      continue
    }
    if (arg === '--force') {
      force = true
      continue
    }
    if (arg.startsWith('--actor=')) {
      actorUsername = arg.slice('--actor='.length)
      continue
    }
    if (arg.startsWith('--')) {
      throw new Error(`hr:sync: unrecognized argument "${arg}"`)
    }
    if (source !== null) {
      throw new Error(`hr:sync: more than one source given ("${source}" and "${arg}")`)
    }
    source = arg
  }

  if (source === null) {
    throw new Error(
      'hr:sync: a source is required — usage: pnpm --filter @idm/api run hr:sync -- <source-id-or-name> --actor=<username> [--commit] [--allow-partial] [--force]',
    )
  }
  if (actorUsername === null || actorUsername.length === 0) {
    throw new Error('hr:sync: --actor=<username> is required — every run is attributed to a real user')
  }

  return { source, actorUsername, commit, allowPartial, force }
}

function printReport(report: HrSyncReport, commit: boolean): void {
  const p = report.preview
  if (p !== null) {
    console.log(
      `[hr:sync] preview: ${p.summary.total} row(s) — ${p.summary.toCreate} to create, ` +
        `${p.summary.toUpdate} to update, ${p.summary.failed} failing`,
    )
    for (const failure of p.failures.slice(0, 20)) {
      console.log(`[hr:sync]   row ${failure.row} (${failure.employeeId ?? '?'}): ${failure.reasons.join('; ')}`)
    }
    if (p.failures.length > 20) {
      console.log(`[hr:sync]   ... and ${p.failures.length - 20} more failing row(s)`)
    }
  }
  if (report.blastRadius !== null) {
    const b = report.blastRadius
    console.log(
      `[hr:sync] blast radius: ${b.changedCount} update(s) against ${b.populationSize} existing ` +
        `people (threshold ${b.thresholdPercent}%, floor ${b.floor})${b.tripped ? ' — TRIPPED' : ''}`,
    )
  }
  for (const reason of report.reasons) {
    console.log(`[hr:sync] ${reason}`)
  }
  if (report.commit !== null) {
    console.log(
      `[hr:sync] committed: ${report.commit.created} created, ${report.commit.updated} updated, ` +
        `${report.commit.unchanged} unchanged, ${report.commit.failed} failed`,
    )
    console.log(`[hr:sync] batchId: ${report.commit.batchId}`)
  } else if (!commit) {
    console.log('[hr:sync] DRY RUN — nothing was written about any user. Re-run with --commit to apply.')
  }
  console.log(`[hr:sync] outcome: ${report.outcome}`)
}

/**
 * The runtime entrypoint for pulling one HR source and feeding it through
 * the import pipeline — `pnpm --filter @idm/api run hr:sync`. Mirrors
 * jml:lifecycle/reconcile exactly: an on-demand `tsx` script, no in-process
 * scheduler anywhere — the operator (or an operator-owned timer unit) owns
 * the cadence. Connects as the RUNTIME role, same reasoning as those CLIs:
 * every write this run makes (users, audit rows, outbox events, last_run
 * metadata) is ordinary DML.
 */
async function main(): Promise<void> {
  const { source: sourceArg, actorUsername, commit, allowPartial, force } = parseArgs(process.argv.slice(2))
  const env = loadEnv(process.env)
  const { db, pool } = createDbClient(env.runtimeDatabaseUrl, { max: env.dbPoolMax })

  try {
    const sources = new HrSourcesRepository(db)
    const engine = new PermissionEngine(db)
    const service = new HrSyncService(
      sources,
      new UsersRepository(db),
      new OrgUnitsRepository(db),
      engine,
      new PrivilegeGuards(db),
      new AuditWriter(),
      new OutboxWriter(),
      db,
      { maxRows: env.importMaxRows },
    )

    // The same resolution JwtGuard+PermissionGuard perform for an HTTP
    // caller: username -> ACTIVE local user + their real role assignments.
    // The run then holds exactly the authority that human holds — a CLI
    // invocation is not an escalation path.
    const actor = await engine.resolveActor({ subject: 'cli:hr-sync', username: actorUsername, email: null })

    const source = await sources.findByIdOrName(sourceArg)
    if (source === null) {
      throw new Error(`hr:sync: no HR source with id or name "${sourceArg}"`)
    }

    console.log(`[hr:sync] source "${source.name}" (${source.id}) — ${commit ? 'COMMIT' : 'dry run'}`)
    const report = await service.run(source, { commit, allowPartial, force, actor })
    printReport(report, commit)

    // A refused commit exits non-zero so a wrapping timer/monitor sees it —
    // the report above already said exactly why.
    if (commit && report.commit === null) {
      process.exitCode = 1
    }
  } finally {
    await pool.end()
  }
}

main()
  .then(() => {
    console.log('[hr:sync] done.')
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[hr:sync] failed: ${message}`)
    process.exitCode = 1
  })
