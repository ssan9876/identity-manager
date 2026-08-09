import { index, pgEnum, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { grantSource } from './grant-source'
import { outboxTarget } from './outbox-events'
import { users } from './users'

/**
 * How a target decides who gets an account in it.
 *
 * `all_users` is what this system did before business roles existed:
 * `OutboxWriter` fanned every user out to every enabled target. It stays the
 * DEFAULT, and the migration sets every existing row to it, because the
 * alternative is a catastrophic silent regression — on the day this ships, if
 * no role yet grants any target account, nobody would get an account in any
 * system and the fan-out would simply stop.
 *
 * `entitled_only` is the opt-in: an operator migrates one target at a time,
 * having first simulated the roles that will feed it.
 */
export const provisioningMode = pgEnum('provisioning_mode', ['all_users', 'entitled_only'])

/**
 * Desired account existence per (user, target) — the second of the two grant
 * kinds a business role can produce.
 *
 * Carries the same provenance columns as `group_user_members` and for the same
 * reason: the reconciler only ever revokes what it granted.
 */
export const userTargetAccounts = pgTable(
  'user_target_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    target: outboxTarget('target').notNull(),

    grantSource: grantSource('grant_source').notNull().default('manual'),
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    unique: uniqueIndex('user_target_accounts_unique').on(table.userId, table.target),
    // The fan-out read in OutboxWriter (Task 13): "does this user have an
    // account entitlement for this target".
    targetIdx: index('user_target_accounts_target_idx').on(table.target, table.userId),
    sourceIdx: index('user_target_accounts_source_idx').on(table.grantSource, table.userId),
  }),
)
