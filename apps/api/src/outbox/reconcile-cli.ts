import { AuditWriter } from '../audit/audit.writer'
import { loadEnv } from '../config/env'
import { createDbClient } from '../db/client'
import { GroupsRepository } from '../groups/groups.repository'
import { KeycloakAdminClient } from '../keycloak/keycloak-admin.client'
import { UsersRepository } from '../users/users.repository'
import { OutboxRepository } from './outbox.repository'
import { OutboxWriter } from './outbox.writer'
import { ReconciliationJob } from './reconciliation.job'
import { SyncWorker } from './sync.worker'

/**
 * The runtime entrypoint for running reconciliation against a real database
 * and a real Keycloak (dev, ops) — as opposed to `ReconciliationJob` itself,
 * which the test harness also constructs directly against Testcontainers.
 * Mirrors `db/migrate-cli.ts`'s split exactly: a plain `tsx` script wired to
 * `pnpm run reconcile` — invoked on demand, and daily by
 * `deploy/systemd/idm-reconcile.timer`. The milestone plan / task-4-brief.md
 * originally said "no scheduler"; that held only until it became clear that
 * several findings park their residual risk on this job as "the backstop",
 * which is worth nothing on a host where nothing ever invokes it. The script
 * itself is unchanged by that — it already exits non-zero on failure and
 * already prints every drifted user and reason on stdout, which is exactly
 * what a scheduled run needs to be diagnosable from the journal.
 *
 * Connects as the RUNTIME role (finding H1, docs/archive/audits/
 * audit-integrity.md), not the OWNER: everything this job does — reading
 * users/groups, writing an outbox event and an audit row — is ordinary DML
 * the runtime role already holds. It is operationally part of "the
 * application," not a schema-owning migration step, so it gets no more
 * database privilege than the API process itself does.
 */
async function main(): Promise<void> {
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
    const outboxWriter = new OutboxWriter()
    const auditWriter = new AuditWriter()
    const syncWorker = new SyncWorker(
      db,
      new OutboxRepository(),
      usersRepository,
      groupsRepository,
      keycloak,
    )

    const job = new ReconciliationJob(
      usersRepository,
      groupsRepository,
      keycloak,
      outboxWriter,
      syncWorker,
      auditWriter,
      db,
    )

    console.log('[reconcile] walking users and comparing against Keycloak ...')
    const report = await job.run()

    console.log(`[reconcile] checked ${report.usersChecked} user(s)`)
    if (report.usersWithDrift.length === 0) {
      console.log('[reconcile] no drift found — everyone already matches desired state')
    } else {
      console.log(`[reconcile] drift found for ${report.usersWithDrift.length} user(s):`)
      for (const drift of report.usersWithDrift) {
        console.log(`[reconcile]   - ${drift.username} (${drift.userId}): ${drift.reasons.join(', ')}`)
      }
    }
    console.log(
      `[reconcile] enqueued ${report.eventsEnqueued} repair event(s); drained ${report.eventsProcessed} outbox event(s) total`,
    )

    // Security finding 6. Reported, never repaired — see the report field's
    // own doc comment for why this system does not get to delete an account
    // in a realm it shares. The operator is told plainly and decides.
    if (report.keycloakOnlyUsernames.length > 0) {
      console.log(
        `[reconcile] ${report.keycloakOnlyUsernames.length} Keycloak account(s) correspond to no user here:`,
      )
      for (const username of report.keycloakOnlyUsernames) {
        console.log(`[reconcile]   - ${username}`)
      }
      console.log(
        '[reconcile] these are NOT repaired automatically: an account this system never created may be a',
      )
      console.log(
        '[reconcile] service account, a break-glass admin, or a federated identity. Review before removing.',
      )
    }
  } finally {
    await pool.end()
  }
}

main()
  .then(() => {
    console.log('[reconcile] done.')
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[reconcile] failed: ${message}`)
    process.exitCode = 1
  })
