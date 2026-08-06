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
 * `pnpm run reconcile`, in the same on-demand style as `db:migrate` — no
 * scheduler (see the milestone plan / task-4-brief.md).
 */
async function main(): Promise<void> {
  const env = loadEnv(process.env)
  const { db, pool } = createDbClient(env.databaseUrl, { max: env.dbPoolMax })

  try {
    const usersRepository = new UsersRepository(db)
    const groupsRepository = new GroupsRepository(db)
    const keycloak = new KeycloakAdminClient({
      issuer: env.keycloakIssuer,
      clientId: env.keycloakAdminClientId,
      clientSecret: env.keycloakAdminClientSecret,
    })
    const outboxWriter = new OutboxWriter()
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
