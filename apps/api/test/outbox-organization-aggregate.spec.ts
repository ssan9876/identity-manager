import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { connectorTargets } from '../src/db/schema/connector-targets'
import { outboxEvents } from '../src/db/schema/outbox-events'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { withTestDatabase } from './support/pg'

/**
 * Organizations milestone, Task 10 — `organization` as an outbox aggregate.
 *
 * A SEPARATE file from outbox-emission.spec.ts on purpose. That file is the
 * standing regression net for fan-out (Milestone 10, Task 1 and Milestone 18,
 * Task 13) and is deliberately left byte-for-byte unmodified by this task, so
 * that "fan-out still behaves exactly as it did" and "a new aggregate type
 * behaves correctly" are two independently-failing signals rather than one
 * edited file where a regression could be masked by a rewritten expectation.
 */
describe('the organization outbox aggregate (Organizations, Task 10)', () => {
  const ctx = withTestDatabase()

  it('is accepted by the outbox_aggregate_type enum', async () => {
    // The migration's whole job. Before 0031 this insert fails with
    // `invalid input value for enum outbox_aggregate_type: "organization"`.
    await expect(
      ctx.db.insert(outboxEvents).values({
        aggregateType: 'organization',
        aggregateId: randomUUID(),
        eventType: 'created',
        payload: {},
        target: 'keycloak',
      }),
    ).resolves.toBeDefined()
  })

  describe('fan-out', () => {
    /**
     * Enables extra targets for the duration of one assertion and removes
     * them again, exactly as outbox-emission.spec.ts's own multi-target
     * tests do: no migration seeds a `connector_targets` row for any target
     * other than `keycloak` (Postgres forbids USING a value added by
     * `ALTER TYPE ... ADD VALUE` in the transaction that added it — see
     * 0017 and connector-targets.ts), so a test that needs one inserts it
     * directly.
     */
    async function withTargetsEnabled(
      targets: readonly ('active_directory' | 'entra_id' | 'mail_server' | 'keycloak_sso')[],
      body: () => Promise<void>,
    ): Promise<void> {
      for (const target of targets) {
        await ctx.pool.query(
          `INSERT INTO connector_targets (target, enabled) VALUES ($1, true)
           ON CONFLICT (organization_id, target) DO UPDATE SET enabled = true`,
          [target],
        )
      }
      try {
        await body()
      } finally {
        for (const target of targets) {
          await ctx.pool.query(`DELETE FROM connector_targets WHERE target = $1`, [target])
        }
      }
    }

    it('reaches keycloak and NOTHING else, even with every other target enabled', async () => {
      const organizationId = randomUUID()
      const writer = new OutboxWriter()

      await withTargetsEnabled(
        ['active_directory', 'entra_id', 'mail_server', 'keycloak_sso'],
        async () => {
          await ctx.db.transaction(async (tx) => {
            await writer.record(tx, {
              aggregateType: 'organization',
              aggregateId: organizationId,
              eventType: 'created',
              payload: { slug: 'acme' },
            })
          })
        },
      )

      const rows = await ctx.db
        .select({ target: outboxEvents.target })
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, organizationId))

      // A realm exists only in Keycloak. AD/Entra/Google have no realm
      // concept, the mail server addresses principals by our user id, and
      // keycloak_sso speaks only about applications — each of those rows
      // would fail, retry and dead-letter.
      expect(rows.map((row) => row.target)).toEqual(['keycloak'])
    })

    it('is not entitlement-filtered — an entitled_only keycloak still receives it', async () => {
      // Milestone 18, Task 13 fans `user` aggregates out BY ENTITLEMENT, and
      // gates that behind `consultsEntitlement` precisely so a non-`user`
      // aggregate is never filtered by an empty `user_target_accounts` read.
      // An organization has no account row anywhere and never will, so
      // without that gate this event would silently vanish the moment an
      // operator switched keycloak to `entitled_only`.
      const organizationId = randomUUID()
      const writer = new OutboxWriter()

      await ctx.pool.query(
        `UPDATE connector_targets SET provisioning_mode = 'entitled_only' WHERE target = 'keycloak'`,
      )
      try {
        await ctx.db.transaction(async (tx) => {
          await writer.record(tx, {
            aggregateType: 'organization',
            aggregateId: organizationId,
            eventType: 'created',
            payload: {},
          })
        })
      } finally {
        await ctx.pool.query(
          `UPDATE connector_targets SET provisioning_mode = 'all_users' WHERE target = 'keycloak'`,
        )
      }

      const rows = await ctx.db
        .select({ target: outboxEvents.target })
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.aggregateId, organizationId),
            eq(outboxEvents.aggregateType, 'organization'),
          ),
        )
      expect(rows).toHaveLength(1)
    })

    it('leaves connector_targets as it found it', async () => {
      // Guards the two tests above against leaking enabled rows into
      // whatever runs next in this file.
      const rows = await ctx.db
        .select({ target: connectorTargets.target })
        .from(connectorTargets)
        .where(eq(connectorTargets.enabled, true))
      expect(rows.map((row) => row.target)).toEqual(['keycloak'])
    })
  })
})
