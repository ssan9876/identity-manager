import { AuditWriter } from '../audit/audit.writer'
import { loadEnv } from '../config/env'
import type { ConnectorTarget } from '../connectors/connector'
import { ConnectorRegistry } from '../connectors/connector-registry'
import { createDbClient } from '../db/client'
import { GroupsRepository } from '../groups/groups.repository'
import { KeycloakAdminClient } from '../keycloak/keycloak-admin.client'
import { UsersRepository } from '../users/users.repository'
import { OutboxRepository } from './outbox.repository'
import { SyncWorker } from './sync.worker'
import { TargetReconciliationJob, type TargetReconciliationReport } from './target-reconciliation.job'

// Mirrors `ConnectorRegistry`'s own canonical `ConnectorTarget` union
// (connectors/connector.ts) — hand-rolled here purely so an unrecognized
// `--target` value can be rejected BEFORE opening a database connection,
// with a helpful message, rather than surfacing as a downstream Postgres
// enum-cast error.
const KNOWN_TARGETS: readonly ConnectorTarget[] = [
  'keycloak',
  'active_directory',
  'entra_id',
  'google_workspace',
  'echo',
]

interface ParsedArgs {
  target: ConnectorTarget
  apply: boolean
  force: boolean
}

/**
 * `process.argv.slice(2)`, filtering out a literal `"--"` token — same
 * defensive shape `bootstrap-admin-cli.ts`'s own `resolveUsername` already
 * documents (pnpm's own arg-forwarding can deliver `['--', ...]` rather
 * than stripping it).
 *
 * The target is the one REQUIRED, positional argument — `pnpm run
 * target-reconcile echo` or `--target=echo`, either accepted, matching
 * `bootstrap-admin-cli.ts`'s own "bare positional argument" precedent.
 * `--apply`/`--force` are flags, absent by default: DRY RUN IS THE DEFAULT
 * — "halting [applying nothing] is the default; overriding is explicit"
 * (this task's own brief) extends naturally to "applying anything at all is
 * explicit" for this CLI. `--force` alone, without `--apply`, is accepted
 * but inert (a dry run never applies, so there is nothing to override) —
 * see `main`'s own dry-run branch.
 */
function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.filter((arg) => arg !== '--')
  let target: string | null = null
  let apply = false
  let force = false

  for (const arg of args) {
    if (arg === '--apply') {
      apply = true
      continue
    }
    if (arg === '--force') {
      force = true
      continue
    }
    if (arg.startsWith('--target=')) {
      target = arg.slice('--target='.length)
      continue
    }
    if (!arg.startsWith('--') && target === null) {
      target = arg
      continue
    }
    throw new Error(`target-reconcile: unrecognized argument "${arg}"`)
  }

  if (target === null || target.trim().length === 0) {
    throw new Error(
      'target-reconcile: a target is required, e.g. "pnpm run target-reconcile echo" or "pnpm run target-reconcile -- --target=echo"',
    )
  }
  if (!KNOWN_TARGETS.includes(target as ConnectorTarget)) {
    throw new Error(`target-reconcile: unknown target "${target}" — known targets: ${KNOWN_TARGETS.join(', ')}`)
  }

  return { target: target as ConnectorTarget, apply, force }
}

function printReport(report: TargetReconciliationReport): void {
  console.log(`[target-reconcile] checked ${report.populationSize} in-scope principal(s)`)
  console.log(
    `[target-reconcile] plan: ${report.toMutate.length} principal(s) would be mutated ` +
      `(threshold ${report.blastRadius.thresholdPercent}%, floor ${report.blastRadius.floor})`,
  )
  for (const principal of report.toMutate) {
    for (const op of principal.operations) {
      console.log(`[target-reconcile]   - ${principal.username}: ${op.kind} — ${op.description}`)
    }
  }
}

/**
 * The runtime entrypoint for `pnpm run target-reconcile <target>` — the
 * dry-run CLI this task's own brief names ("printing the plan for a target
 * and writing nothing — the same shape as the bulk-import preview"),
 * additionally offering `--apply` (still guarded by the blast-radius check)
 * and `--force` (an explicit, audited override) so the SAME entrypoint
 * covers the whole feature rather than needing a second script. Mirrors
 * `reconcile-cli.ts`/`bootstrap-admin-cli.ts` exactly: a plain `tsx`
 * script, connected as the RUNTIME role (finding H1, docs/superpowers/
 * audit-integrity.md) — every read/write this makes is ordinary DML the
 * runtime role already holds.
 */
async function main(): Promise<void> {
  const { target, apply, force } = parseArgs(process.argv.slice(2))
  const env = loadEnv(process.env)
  const { db, pool } = createDbClient(env.runtimeDatabaseUrl, { max: env.dbPoolMax })

  try {
    const usersRepository = new UsersRepository(db)
    const groupsRepository = new GroupsRepository(db)
    const keycloak = new KeycloakAdminClient({
      issuer: env.keycloakIssuer,
      clientId: env.keycloakAdminClientId,
      clientSecret: env.keycloakAdminClientSecret,
    })
    const connectorRegistry = new ConnectorRegistry(keycloak)
    const syncWorker = new SyncWorker(
      db,
      new OutboxRepository(),
      usersRepository,
      groupsRepository,
      keycloak,
      undefined,
      connectorRegistry,
    )
    const auditWriter = new AuditWriter()

    const job = new TargetReconciliationJob(usersRepository, connectorRegistry, syncWorker, auditWriter, db)

    const dryRun = !apply
    console.log(`[target-reconcile] ${dryRun ? 'DRY RUN — ' : ''}reconciling target "${target}" ...`)

    const report = await job.reconcile(target, { dryRun, force })
    printReport(report)

    if (report.halted) {
      console.error(
        `[target-reconcile] BLAST-RADIUS GUARD TRIPPED — halted, applied NOTHING ` +
          `(${report.toMutate.length}/${report.populationSize} would change; ` +
          `threshold ${report.blastRadius.thresholdPercent}%, floor ${report.blastRadius.floor}). ` +
          're-run with --force to override — this is audited.',
      )
      process.exitCode = 1
      return
    }

    if (report.overridden) {
      console.warn('[target-reconcile] blast-radius guard was OVERRIDDEN via --force — this run is audited.')
    }

    if (dryRun) {
      console.log('[target-reconcile] dry run — nothing was written. Re-run with --apply to reconcile for real.')
    } else {
      console.log(`[target-reconcile] applied ${report.appliedCount} change(s).`)
    }
  } finally {
    await pool.end()
  }
}

main()
  .then(() => {
    console.log('[target-reconcile] done.')
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[target-reconcile] failed: ${message}`)
    process.exitCode = 1
  })
