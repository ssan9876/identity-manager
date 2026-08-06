import {
  bigserial,
  index,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { users } from './users'

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    // Nullable: system-originated actions have no human actor.
    //
    // onDelete is 'restrict', not 'set null': audit_log is append-only, and
    // append-only means attribution can't quietly erode either. 'set null'
    // would have Postgres issue an internal UPDATE against audit_log when a
    // referenced user is deleted — which the append-only trigger in
    // db/migrate.ts (enforceAuditAppendOnly) unconditionally rejects, since
    // it fires on every UPDATE statement regardless of match count. The
    // practical effect either way is the same (a user with audit history
    // can't be removed), but 'restrict' gets there via a standard FK
    // violation instead of colliding with the append-only trigger.
    actorUserId: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    action: varchar('action', { length: 64 }).notNull(),
    resourceType: varchar('resource_type', { length: 64 }).notNull(),
    resourceId: uuid('resource_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    createdIdx: index('audit_log_created_idx').on(table.createdAt),
    resourceIdx: index('audit_log_resource_idx').on(table.resourceType, table.resourceId),
    actorIdx: index('audit_log_actor_idx').on(table.actorUserId),
  }),
)
