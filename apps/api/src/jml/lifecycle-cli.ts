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
 */
async function main(): Promise<void> {
  const env = loadEnv(process.env)
  const { db, pool } = createDbClient(env.databaseUrl, { max: env.dbPoolMax })

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
