import { sql } from 'drizzle-orm'
import { type AnyPgColumn, check, index, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core'
import { grantSource } from './grant-source'
import { groups } from './groups'
import { users } from './users'

export const groupUserMembers = pgTable(
  'group_user_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /**
     * NOT NULL DEFAULT 'manual' is what makes the migration safe on an
     * existing database: every row that predates this column backfills to
     * `manual`, and the reconciler never revokes a `manual` row. A backfill
     * that guesses conservatively therefore cannot cause a revocation.
     */
    grantSource: grantSource('grant_source').notNull().default('manual'),
    grantedBy: uuid('granted_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.groupId, table.userId] }),
    userIdx: index('group_user_members_user_idx').on(table.userId),
    // Supports the reconciler's "every role-derived row for this user" read,
    // which is the query it runs on every single evaluation.
    sourceIdx: index('group_user_members_source_idx').on(table.grantSource, table.userId),
  }),
)

export const groupGroupMembers = pgTable(
  'group_group_members',
  {
    parentGroupId: uuid('parent_group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    childGroupId: uuid('child_group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.parentGroupId, table.childGroupId] }),
    childIdx: index('group_group_members_child_idx').on(table.childGroupId),
    noSelfEdge: check('group_group_members_no_self_edge', sql`${table.parentGroupId} <> ${table.childGroupId}`),
  }),
)
