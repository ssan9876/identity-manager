import { AuditWriter } from '../audit/audit.writer'
import { loadEnv } from '../config/env'
import { createDbClient } from '../db/client'
import { GroupsRepository } from '../groups/groups.repository'
import { KeycloakAdminClient } from '../keycloak/keycloak-admin.client'
import { OutboxWriter } from '../outbox/outbox.writer'
import { UsersRepository } from '../users/users.repository'
import { JmlRulesRepository } from './jml-rules.repository'
import { LifecycleJob } from './lifecycle.job'
import { RuleApplier } from './rule-applier'

/**
 * The runtime entrypoint for running the joiner/mover/leaver lifecycle
 * script against a real database and a real Keycloak (dev, ops) — as
 * opposed to `LifecycleJob` itself, which the test suite also constructs
 * directly against Testcontainers. Mirrors `db/migrate-cli.ts` and
 * `outbox/reconcile-cli.ts` exactly: a plain `tsx` script wired to `pnpm run
 * jml:lifecycle`, in the same on-demand style — no scheduler, no cron (see
 * the milestone plan, decision 4).
 *
 * Connects as the RUNTIME role (finding H1, docs/superpowers/
 * audit-integrity.md) — same reasoning as reconcile-cli.ts: every write this
 * job makes (status transitions, rule actions, audit rows, outbox events) is
 * ordinary DML the runtime role already holds, and it is part of "the
 * application" operationally, not a schema-owning migration step.
 */
async function main(): Promise<void> {
  const env = loadEnv(process.env)
  const { db, pool } = createDbClient(env.runtimeDatabaseUrl, { max: env.dbPoolMax })

  try {
    const usersRepository = new UsersRepository(db)
    const groupsRepository = new GroupsRepository(db)
    const rulesRepository = new JmlRulesRepository(db)
    const keycloak = new KeycloakAdminClient({
      issuer: env.keycloakIssuer,
      clientId: env.keycloakAdminClientId,
      clientSecret: env.keycloakAdminClientSecret,
    })
    const auditWriter = new AuditWriter()
    const outboxWriter = new OutboxWriter()
    const applier = new RuleApplier(usersRepository, groupsRepository, auditWriter, outboxWriter, keycloak, db)
    const job = new LifecycleJob(
      usersRepository,
      rulesRepository,
      applier,
      auditWriter,
      outboxWriter,
      keycloak,
      db,
    )

    console.log('[jml:lifecycle] evaluating start_date/end_date lifecycle transitions ...')
    const report = await job.run()

    console.log(`[jml:lifecycle] activated ${report.activatedUserIds.length} user(s)`)
    console.log(`[jml:lifecycle] deactivated ${report.deactivatedUserIds.length} user(s)`)
    console.log(`[jml:lifecycle] applied ${report.ruleActionsApplied} rule action(s)`)

    // Finding M5 (docs/superpowers/audit-integrity.md): the report, not a
    // log line buried mid-run, is now the record of anything left
    // unactioned — surfaced here so an operator (or a monitored cron
    // wrapper) sees it without having to grep every run's console output.
    // A non-empty list on an otherwise-healthy run is worth investigating:
    // the transition matrix should make every REACHABLE due state
    // actionable, so a skip here is either a genuine, ordinary race (the
    // row moved on between selection and this transaction) or a gap in
    // that matrix, same class as the one this finding closed.
    if (report.skipped.length > 0) {
      console.warn(`[jml:lifecycle] ${report.skipped.length} due user(s) could not be actioned:`)
      for (const skip of report.skipped) {
        console.warn(`[jml:lifecycle]   ${skip.phase} skipped for ${skip.userId} — ${skip.reason}`)
      }
    }
  } finally {
    await pool.end()
  }
}

main()
  .then(() => {
    console.log('[jml:lifecycle] done.')
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[jml:lifecycle] failed: ${message}`)
    process.exitCode = 1
  })
