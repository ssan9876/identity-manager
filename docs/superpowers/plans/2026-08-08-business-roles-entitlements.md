# Business Roles and Entitlements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the directory a declarative answer to *who should have what* — a business role owns a membership formula over user fields and a set of entitlements, and an engine reconciles the two continuously.

**Architecture:** Per `docs/superpowers/specs/2026-08-08-business-roles-entitlements-design.md`. A pure evaluator (`user + roles → desired grants`) plus an impure reconciler that diffs against `group_user_members` and `user_target_accounts` and writes through existing repositories, inside one transaction with its audit row and outbox events. Nothing downstream of the outbox changes: `SyncWorker`, `DirectoryConnector` and the dead-letter path are untouched.

**Tech Stack:** TypeScript, NestJS 10, Drizzle ORM 0.36, Postgres 16, Vitest 2, Testcontainers, React + Vite + Playwright for the console.

**Builds on:** Milestones 1–14 and the mail-server connector. Read the spec before Task 1 — its nine settled decisions are binding and no task here re-opens them.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-08-business-roles-entitlements-design.md`. Its "Settled decisions — do not re-litigate" section governs every task below.
- **Rules are DATA, never code.** No `eval`, no `new Function`, no bare `Function(...)`, no template interpolation of rule fields into anything executable, anywhere in `apps/api/src/business-roles/`. Task 6 adds the static source scan that proves it; do not weaken it.
- **A role with zero conditions matches NOBODY.** Not vacuously everybody. This is the single most dangerous default in the design — it is a named, tested case, never an emergent property of a `reduce`.
- **The reconciler only ever revokes rows whose `grant_source` is `business_role`.** A `manual` row is never touched by automation, in any code path.
- **Offboarding never depends on role evaluation.** The existing unconditional disable-on-deactivate and `revoke-access` session kill stay exactly as they are. Role evaluation is a second belt, never the braces.
- Every mutation stays permission-checked, scope-narrowed, audited **and** outboxed in one transaction. A rejected mutation writes zero audit rows and zero outbox events.
- **Never open a second database connection inside an open transaction.** Everything takes the caller's `tx`. This project has deadlocked its own pool doing otherwise (finding C1, `docs/superpowers/audit-integrity.md`; guarded by `test/pool-exhaustion.spec.ts`).
- Authorization is enforced in the API, never the UI.
- `strict: true`. No `any`, no `@ts-ignore`, no `as` used to silence a structural check (see `authz/actions.ts`'s own note on how an `as` on an `any` expression checks nothing).
- Any schema change commits its migration **and** `src/db/migrations/meta/`. Any `package.json` change commits `pnpm-lock.yaml`.
- **Postgres forbids using an enum value added by `ALTER TYPE ... ADD VALUE` inside the transaction that added it**, and all pending migrations run in one transaction on a fresh database. New enum *types* (`CREATE TYPE`) are unaffected; every enum this plan introduces is a new type.
- Testcontainers, never mocks, for anything touching the database. Pure logic gets pure tests with no container.
- Audit rows pin users via a `restrict` FK — no new spec file may `DELETE FROM users`.
- Test runner is Vitest. Single file: `pnpm --filter @idm/api exec vitest run <path>`.
- Full gate before anything that matters: `pnpm verify`. Fast gate for every commit: `pnpm verify:quick`.

**Test files this plan creates** — pure and DB-backed are split so the evaluator's tests never drag in a container:

| File | Covers |
|---|---|
| `apps/api/test/business-roles-schema.spec.ts` | Tasks 1–3 (DB-backed) |
| `apps/api/test/business-role-evaluator.spec.ts` | Tasks 4–6 (pure, no container) |
| `apps/api/test/business-roles.spec.ts` | Tasks 7–10 (DB-backed) |
| `apps/api/test/business-roles.controller.spec.ts` | Tasks 11–12 (DB-backed) |
| `apps/api/test/business-role-sync.spec.ts` | Tasks 13–15 (DB-backed) |
| `apps/web/e2e/business-roles.spec.ts` | Task 20 (Playwright) |

---

## Milestone 15 — Schema and provenance

### Task 1: Provenance on group membership

**Files:**
- Create: `apps/api/src/db/schema/grant-source.ts`
- Modify: `apps/api/src/db/schema/group-members.ts:6-23`
- Modify: `apps/api/src/db/schema/index.ts`
- Create: `apps/api/src/db/migrations/0019_<generated>.sql`
- Test: `apps/api/test/business-roles-schema.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `grantSource` pgEnum with values `'business_role' | 'manual'`; `groupUserMembers.grantSource`, `.grantedBy`, `.grantedAt`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/business-roles-schema.spec.ts`:

```ts
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { grantSource } from '../src/db/schema/grant-source'
import { withTestDatabase } from './support/pg'

const ctx = withTestDatabase()

describe('grant provenance (Milestone 15, Task 1)', () => {
  it('grant_source carries exactly two values', () => {
    expect([...grantSource.enumValues].sort()).toEqual(['business_role', 'manual'])
  })

  it('group_user_members.grant_source is NOT NULL and defaults to manual, so pre-existing rows backfill safely', async () => {
    const rows = await ctx.db.execute(sql`
      SELECT is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'group_user_members' AND column_name = 'grant_source'
    `)

    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]).toMatchObject({ is_nullable: 'NO' })
    expect(String(rows.rows[0].column_default)).toContain('manual')
  })

  it('granted_at is NOT NULL and granted_by is nullable', async () => {
    const rows = await ctx.db.execute(sql`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'group_user_members' AND column_name IN ('granted_by', 'granted_at')
      ORDER BY column_name
    `)

    expect(rows.rows).toEqual([
      { column_name: 'granted_at', is_nullable: 'NO' },
      { column_name: 'granted_by', is_nullable: 'YES' },
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api exec vitest run test/business-roles-schema.spec.ts`
Expected: FAIL — `../src/db/schema/grant-source` does not resolve.

- [ ] **Step 3: Create the shared enum**

Create `apps/api/src/db/schema/grant-source.ts`:

```ts
import { pgEnum } from 'drizzle-orm/pg-core'

/**
 * Where a grant came from — shared by `group_user_members` and
 * `user_target_accounts`, because the reconciler's central rule ("only ever
 * revoke what you granted") applies identically to both.
 *
 * EXACTLY TWO VALUES, deliberately. A `jml_rule` value would be dead on
 * arrival: Milestone 19 removes JML's `add_to_group`/`remove_from_group`, so
 * nothing in JML will ever grant a membership again. An `import` value would
 * be dead too — the CSV import does not touch group membership at all. Both
 * are tempting to add speculatively and both would be permanent, because
 * Postgres can `ADD VALUE` to an enum but can never drop one. That asymmetry
 * decides it: ship the two sources that genuinely exist, and add a third the
 * day something genuinely becomes a third.
 */
export const grantSource = pgEnum('grant_source', ['business_role', 'manual'])
```

- [ ] **Step 4: Add provenance columns to group_user_members**

In `apps/api/src/db/schema/group-members.ts`, add the import and the three columns to `groupUserMembers` (leave `groupGroupMembers` alone — nested-group edges are structure, not a grant, and no role produces one):

```ts
import { grantSource } from './grant-source'
```

```ts
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
```

Add `AnyPgColumn` to the existing `drizzle-orm/pg-core` import in that file.

- [ ] **Step 5: Export the new schema module**

In `apps/api/src/db/schema/index.ts`, add alongside the existing exports:

```ts
export * from './grant-source'
```

- [ ] **Step 6: Generate the migration**

Run: `pnpm --filter @idm/api db:generate`
Expected: a new `src/db/migrations/0019_*.sql` plus an updated `src/db/migrations/meta/_journal.json`. Open the SQL and confirm it contains `CREATE TYPE "public"."grant_source"` and `ADD COLUMN "grant_source" "grant_source" DEFAULT 'manual' NOT NULL` — the `DEFAULT ... NOT NULL` pair is the backfill.

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @idm/api exec vitest run test/business-roles-schema.spec.ts`
Expected: PASS, 3 tests.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/db/schema/grant-source.ts apps/api/src/db/schema/group-members.ts apps/api/src/db/schema/index.ts apps/api/src/db/migrations apps/api/test/business-roles-schema.spec.ts
git commit -m "feat(business-roles): provenance on group membership"
```

---

### Task 2: The business role tables

**Files:**
- Create: `apps/api/src/db/schema/business-roles.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Create: `apps/api/src/db/migrations/0020_<generated>.sql`
- Test: `apps/api/test/business-roles-schema.spec.ts`

**Interfaces:**
- Consumes: `grantSource` (Task 1).
- Produces: tables `businessRoles`, `businessRoleConditions`, `businessRoleGrants`, `businessRoleExceptions`; enums `businessRoleConditionOperator` (`equals | not_equals | in | in_org_subtree`), `businessRoleGrantKind` (`group_membership | target_account`), `businessRoleExceptionMode` (`include | exclude`).

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/business-roles-schema.spec.ts`:

```ts
import {
  businessRoleConditionOperator,
  businessRoleExceptionMode,
  businessRoleGrantKind,
  businessRoles,
} from '../src/db/schema/business-roles'

describe('business role tables (Milestone 15, Task 2)', () => {
  it('declares the closed operator, grant-kind and exception-mode vocabularies', () => {
    expect([...businessRoleConditionOperator.enumValues].sort()).toEqual([
      'equals',
      'in',
      'in_org_subtree',
      'not_equals',
    ])
    expect([...businessRoleGrantKind.enumValues].sort()).toEqual(['group_membership', 'target_account'])
    expect([...businessRoleExceptionMode.enumValues].sort()).toEqual(['exclude', 'include'])
  })

  it('a new role is disabled, undrafted and unsimulated', async () => {
    const [role] = await ctx.db.insert(businessRoles).values({ name: 'Sales AE' }).returning()

    expect(role.enabled).toBe(false)
    expect(role.draftDefinition).toBeNull()
    expect(role.simulatedAt).toBeNull()
    expect(role.simulatedDraftHash).toBeNull()
  })

  it('a grant must set exactly one of group_id / target, matching its kind', async () => {
    const [role] = await ctx.db.insert(businessRoles).values({ name: 'Check constraint' }).returning()

    // group_membership with no group_id
    await expect(
      ctx.db.execute(sql`
        INSERT INTO business_role_grants (business_role_id, kind, group_id, target)
        VALUES (${role.id}, 'group_membership', NULL, NULL)
      `),
    ).rejects.toThrow(/business_role_grants_kind_matches_reference/)

    // group_membership carrying a target as well
    await expect(
      ctx.db.execute(sql`
        INSERT INTO business_role_grants (business_role_id, kind, group_id, target)
        VALUES (${role.id}, 'target_account', NULL, 'keycloak'), (${role.id}, 'group_membership', NULL, 'keycloak')
      `),
    ).rejects.toThrow(/business_role_grants_kind_matches_reference/)
  })

  it('an exception requires a reason', async () => {
    const [role] = await ctx.db.insert(businessRoles).values({ name: 'Reason required' }).returning()

    await expect(
      ctx.db.execute(sql`
        INSERT INTO business_role_exceptions (business_role_id, user_id, mode, reason)
        VALUES (${role.id}, gen_random_uuid(), 'include', NULL)
      `),
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api exec vitest run test/business-roles-schema.spec.ts`
Expected: FAIL — `../src/db/schema/business-roles` does not resolve.

- [ ] **Step 3: Create the schema module**

Create `apps/api/src/db/schema/business-roles.ts`:

```ts
import { sql } from 'drizzle-orm'
import {
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { groups } from './groups'
import { outboxTarget } from './outbox-events'
import { users } from './users'

export const businessRoleConditionOperator = pgEnum('business_role_condition_operator', [
  'equals',
  'not_equals',
  'in',
  'in_org_subtree',
])

export const businessRoleGrantKind = pgEnum('business_role_grant_kind', [
  'group_membership',
  'target_account',
])

export const businessRoleExceptionMode = pgEnum('business_role_exception_mode', ['include', 'exclude'])

/**
 * A business role: a membership formula plus a set of entitlements.
 *
 * TWO SEPARATE GATES live on this table and they do different jobs.
 *
 * `enabled` is the KILL SWITCH. The reconciler's desired set is the union
 * over ENABLED roles, so disabling a role removes its rows from that set and
 * they are revoked on the next pass. Disable is a revocation, not a pause —
 * the console must say so before it happens.
 *
 * `draft_definition` + `simulated_draft_hash` are the CHANGE GATE. Edits to
 * conditions and grants land in the draft and affect nobody; publishing
 * refuses unless a simulation ran against that exact draft. An earlier
 * version of this design instead froze conditions while enabled, forcing a
 * disable-edit-re-enable cycle — which, because disable revokes, would have
 * revoked and re-granted every entitlement on every edit, churning every
 * downstream target and locking people out of real systems mid-edit.
 */
export const businessRoles = pgTable(
  'business_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),

    enabled: boolean('enabled').notNull().default(false),

    /**
     * Pending edits. Shape is validated by the application on write and again
     * on publish (see business-roles.repository.ts) — jsonb because a draft is
     * scratch, deliberately NOT the typed child tables below, which are what
     * the engine actually reads.
     */
    draftDefinition: jsonb('draft_definition').$type<Record<string, unknown>>(),

    simulatedAt: timestamp('simulated_at', { withTimezone: true }),
    /** SHA-256 of the canonicalised draft that simulation ran against. */
    simulatedDraftHash: varchar('simulated_draft_hash', { length: 64 }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nameIdx: uniqueIndex('business_roles_name_idx').on(table.name),
    // The reconciler's hot read: every enabled role, on every evaluation.
    enabledIdx: index('business_roles_enabled_idx').on(table.enabled),
  }),
)

/**
 * The flat AND-list, and the PUBLISHED definition — these rows are what the
 * evaluator reads. Edits do not land here; they land in
 * `business_roles.draft_definition` and are copied down transactionally on
 * publish.
 *
 * `field` is deliberately NOT a Postgres enum, for exactly the reason
 * `jml_rules.condition_field` is not: it names a column on `users` plus the
 * open-ended `attributes.<key>` form, so the vocabulary is closed by an
 * application-code allowlist (CONDITION_FIELD_EXTRACTORS), not by the schema.
 */
export const businessRoleConditions = pgTable(
  'business_role_conditions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessRoleId: uuid('business_role_id')
      .notNull()
      .references(() => businessRoles.id, { onDelete: 'cascade' }),
    field: varchar('field', { length: 128 }).notNull(),
    operator: businessRoleConditionOperator('operator').notNull(),
    /** Nullable so a condition can compare against the JSON literal `null`, matching `jml_rules.condition_value`. */
    value: jsonb('value'),
  },
  (table) => ({
    roleIdx: index('business_role_conditions_role_idx').on(table.businessRoleId),
  }),
)

/**
 * What a role grants. Part of the published definition, on the same terms as
 * the conditions above.
 *
 * `onDelete: restrict` on `group_id` is deliberate: deleting a group that a
 * role grants must fail loudly rather than silently stripping access from
 * everyone who holds that role.
 */
export const businessRoleGrants = pgTable(
  'business_role_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessRoleId: uuid('business_role_id')
      .notNull()
      .references(() => businessRoles.id, { onDelete: 'cascade' }),
    kind: businessRoleGrantKind('kind').notNull(),
    groupId: uuid('group_id').references(() => groups.id, { onDelete: 'restrict' }),
    target: outboxTarget('target'),
  },
  (table) => ({
    roleIdx: index('business_role_grants_role_idx').on(table.businessRoleId),
    uniqueGroup: uniqueIndex('business_role_grants_unique_group').on(table.businessRoleId, table.groupId),
    uniqueTarget: uniqueIndex('business_role_grants_unique_target').on(table.businessRoleId, table.target),
    // Exactly one reference, and it must be the one this kind names. Belt and
    // braces alongside the repository's own validation, in the same posture
    // as `attribute_target_mappings_exactly_one_source`.
    kindMatchesReference: check(
      'business_role_grants_kind_matches_reference',
      sql`(${table.kind} = 'group_membership' AND ${table.groupId} IS NOT NULL AND ${table.target} IS NULL)
       OR (${table.kind} = 'target_account'   AND ${table.target}  IS NOT NULL AND ${table.groupId} IS NULL)`,
    ),
  }),
)

/**
 * The audited overrides. `reason` is NOT NULL because an unexplained
 * exception is precisely what a later recertification campaign cannot act on.
 */
export const businessRoleExceptions = pgTable(
  'business_role_exceptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessRoleId: uuid('business_role_id')
      .notNull()
      .references(() => businessRoles.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mode: businessRoleExceptionMode('mode').notNull(),
    reason: text('reason').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniquePerUser: uniqueIndex('business_role_exceptions_unique').on(table.businessRoleId, table.userId),
    userIdx: index('business_role_exceptions_user_idx').on(table.userId),
  }),
)
```

Add `boolean` to the `drizzle-orm/pg-core` import list at the top of the file.

- [ ] **Step 4: Export the new schema module**

In `apps/api/src/db/schema/index.ts`:

```ts
export * from './business-roles'
```

- [ ] **Step 5: Generate the migration**

Run: `pnpm --filter @idm/api db:generate`
Expected: `src/db/migrations/0020_*.sql` creating three enum types, four tables, and the `business_role_grants_kind_matches_reference` check.

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @idm/api exec vitest run test/business-roles-schema.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/schema/business-roles.ts apps/api/src/db/schema/index.ts apps/api/src/db/migrations apps/api/test/business-roles-schema.spec.ts
git commit -m "feat(business-roles): role, condition, grant and exception tables"
```

---

### Task 3: Target-account entitlement state

**Files:**
- Create: `apps/api/src/db/schema/user-target-accounts.ts`
- Modify: `apps/api/src/db/schema/connector-targets.ts:49-95`
- Modify: `apps/api/src/db/schema/index.ts`
- Create: `apps/api/src/db/migrations/0021_<generated>.sql`
- Test: `apps/api/test/business-roles-schema.spec.ts`

**Interfaces:**
- Consumes: `grantSource` (Task 1).
- Produces: table `userTargetAccounts` (`userId`, `target`, provenance); `provisioningMode` pgEnum (`all_users | entitled_only`) and `connectorTargets.provisioningMode`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/business-roles-schema.spec.ts`:

```ts
import { provisioningMode, userTargetAccounts } from '../src/db/schema/user-target-accounts'
import { connectorTargets } from '../src/db/schema/connector-targets'

describe('target-account entitlement (Milestone 15, Task 3)', () => {
  it('provisioning_mode carries exactly two values', () => {
    expect([...provisioningMode.enumValues].sort()).toEqual(['all_users', 'entitled_only'])
  })

  it('every existing connector target migrates to all_users, so behaviour is unchanged on the day this ships', async () => {
    const rows = await ctx.db.execute(sql`
      SELECT is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'connector_targets' AND column_name = 'provisioning_mode'
    `)

    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]).toMatchObject({ is_nullable: 'NO' })
    expect(String(rows.rows[0].column_default)).toContain('all_users')

    // And the seeded keycloak row really did land on all_users, not merely
    // that the column *could* default — the regression this guards is a
    // silent directory-wide provisioning stop.
    const seeded = await ctx.db.select().from(connectorTargets)
    for (const row of seeded) {
      expect(row.provisioningMode).toBe('all_users')
    }
  })

  it('a user has at most one account entitlement per target', async () => {
    const userId = await insertUser(ctx.db, { username: 'dupe-check' })

    await ctx.db.insert(userTargetAccounts).values({ userId, target: 'keycloak', grantSource: 'business_role' })

    await expect(
      ctx.db.insert(userTargetAccounts).values({ userId, target: 'keycloak', grantSource: 'manual' }),
    ).rejects.toThrow(/user_target_accounts_unique/)
  })
})
```

`insertUser` is the local fixture helper defined in Step 2 below — this suite constructs its own fixtures rather than reaching for a shared helpers layer, matching the existing convention (there is no `test/helpers/` directory in this repo).

- [ ] **Step 2: Add the fixture helper**

At the top of `apps/api/test/business-roles-schema.spec.ts`, below the imports:

```ts
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../src/db/schema/index'
import { orgUnits } from '../src/db/schema/org-units'
import { users } from '../src/db/schema/users'

let fixtureSeq = 0

async function insertUser(
  db: NodePgDatabase<typeof schema>,
  overrides: { username?: string; jobTitle?: string | null; location?: string | null } = {},
): Promise<string> {
  fixtureSeq += 1
  const [unit] = await db
    .insert(orgUnits)
    .values({ name: `Unit ${fixtureSeq}`, path: `root${fixtureSeq}` })
    .returning()

  const username = overrides.username ?? `fixture${fixtureSeq}`
  const [user] = await db
    .insert(users)
    .values({
      status: 'active',
      primaryEmail: `${username}@example.com`,
      username,
      firstName: 'Fixture',
      lastName: `User ${fixtureSeq}`,
      displayName: `Fixture User ${fixtureSeq}`,
      jobTitle: overrides.jobTitle ?? null,
      location: overrides.location ?? null,
      orgUnitId: unit.id,
    })
    .returning()

  return user.id
}
```

Check `apps/api/src/db/schema/org-units.ts` for the exact column names `orgUnits` requires before running — if the root path column is not `path`, use whatever that file declares. Do not guess.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @idm/api exec vitest run test/business-roles-schema.spec.ts`
Expected: FAIL — `../src/db/schema/user-target-accounts` does not resolve.

- [ ] **Step 4: Create the table**

Create `apps/api/src/db/schema/user-target-accounts.ts`:

```ts
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
```

- [ ] **Step 5: Add provisioning_mode to connector_targets**

In `apps/api/src/db/schema/connector-targets.ts`, import `provisioningMode` from `./user-target-accounts` and add the column immediately after `enabled`:

```ts
    /**
     * Milestone 15, Task 3. `all_users` reproduces the pre-business-roles
     * behaviour exactly and is the default for every existing row; a target
     * only starts consulting `user_target_accounts` when an operator
     * deliberately moves it to `entitled_only`. See that enum's own doc
     * comment for why the default is not the other way round.
     */
    provisioningMode: provisioningMode('provisioning_mode').notNull().default('all_users'),
```

- [ ] **Step 6: Export the new schema module**

In `apps/api/src/db/schema/index.ts`:

```ts
export * from './user-target-accounts'
```

- [ ] **Step 7: Generate the migration and run the tests**

Run: `pnpm --filter @idm/api db:generate`
Then: `pnpm --filter @idm/api exec vitest run test/business-roles-schema.spec.ts`
Expected: PASS, 10 tests.

- [ ] **Step 8: Run the full gate**

Run: `pnpm verify`
Expected: PASS. Milestone 15 adds tables only — no existing behaviour changes, so every pre-existing test must still be green. If anything in `outbox-emission.spec.ts` or the connector suites fails here, a schema change leaked into behaviour; fix that before proceeding.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/db/schema apps/api/src/db/migrations apps/api/test/business-roles-schema.spec.ts
git commit -m "feat(business-roles): target-account entitlement state and per-target provisioning mode"
```

---

## Milestone 16 — The evaluator

Pure, total, no database, no ambient clock. This milestone ships before anything can write, because a pure evaluator is provably correct on its own and every later milestone depends on it being right.

### Task 4: Condition matching, and refusing to act on the unknown

**Files:**
- Create: `apps/api/src/business-roles/role-evaluator.ts`
- Test: `apps/api/test/business-role-evaluator.spec.ts`

**Interfaces:**
- Consumes: `ConnectorTarget` from `../connectors/connector`, `UserStatus` from `../users/users.repository`.
- Produces:
  - `interface EvaluableUser { id, status, jobTitle, location, orgUnitId, orgUnitPath, attributes }`
  - `interface RoleCondition { field: string; operator: ConditionOperator; value: unknown }`
  - `type ConditionMatch = { known: true; matched: boolean } | { known: false; reason: string }`
  - `function matchesConditions(conditions: readonly RoleCondition[], user: EvaluableUser): ConditionMatch`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/business-role-evaluator.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { type EvaluableUser, type RoleCondition, matchesConditions } from '../src/business-roles/role-evaluator'

let userSeq = 0
function makeUser(overrides: Partial<EvaluableUser> = {}): EvaluableUser {
  userSeq += 1
  return {
    id: `user-${userSeq}`,
    status: 'active',
    jobTitle: 'Account Executive',
    location: 'London',
    orgUnitId: `unit-${userSeq}`,
    orgUnitPath: 'acme.sales.emea',
    attributes: {},
    ...overrides,
  }
}

function condition(overrides: Partial<RoleCondition> = {}): RoleCondition {
  return { field: 'jobTitle', operator: 'equals', value: 'Account Executive', ...overrides }
}

describe('matchesConditions (Milestone 16, Task 4)', () => {
  it('a role with ZERO conditions matches NOBODY', () => {
    // The single most dangerous default in this design. A naive
    // "every condition must match" fold over an empty list returns true,
    // which would grant an unfinished role's entitlements to the entire
    // directory the moment it was enabled.
    const result = matchesConditions([], makeUser())

    expect(result).toEqual({ known: true, matched: false })
  })

  it('equals matches and not_equals inverts it', () => {
    const user = makeUser({ jobTitle: 'Account Executive' })

    expect(matchesConditions([condition()], user)).toEqual({ known: true, matched: true })
    expect(matchesConditions([condition({ operator: 'not_equals' })], user)).toEqual({
      known: true,
      matched: false,
    })
  })

  it('equals compares against the JSON literal null', () => {
    const user = makeUser({ jobTitle: null })

    expect(matchesConditions([condition({ value: null })], user)).toEqual({ known: true, matched: true })
  })

  it('in gives OR within a single field', () => {
    const conditions = [condition({ operator: 'in', value: ['Account Executive', 'SDR'] })]

    expect(matchesConditions(conditions, makeUser({ jobTitle: 'SDR' }))).toEqual({ known: true, matched: true })
    expect(matchesConditions(conditions, makeUser({ jobTitle: 'Manager' }))).toEqual({
      known: true,
      matched: false,
    })
  })

  it('in against a non-array value is unknown, not silently false', () => {
    const result = matchesConditions([condition({ operator: 'in', value: 'Account Executive' })], makeUser())

    expect(result.known).toBe(false)
  })

  it('every condition must match — the list is an AND', () => {
    const conditions = [condition(), condition({ field: 'location', value: 'Berlin' })]

    expect(matchesConditions(conditions, makeUser({ location: 'London' }))).toEqual({
      known: true,
      matched: false,
    })
    expect(matchesConditions(conditions, makeUser({ location: 'Berlin' }))).toEqual({
      known: true,
      matched: true,
    })
  })

  it('status is evaluable, so a deactivated person falls out of every role', () => {
    const conditions = [condition({ field: 'status', value: 'active' })]

    expect(matchesConditions(conditions, makeUser({ status: 'deactivated' }))).toEqual({
      known: true,
      matched: false,
    })
  })

  it('an unknown FIELD is unknown — it neither grants nor strips', () => {
    const result = matchesConditions([condition({ field: 'managerId' })], makeUser())

    expect(result.known).toBe(false)
    if (!result.known) expect(result.reason).toContain('managerId')
  })

  it('an unknown OPERATOR is unknown', () => {
    const result = matchesConditions(
      [condition({ operator: 'matches_regex' as RoleCondition['operator'] })],
      makeUser(),
    )

    expect(result.known).toBe(false)
  })

  it('a field colliding with an Object.prototype name is unknown, not an inherited value', () => {
    for (const field of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(matchesConditions([condition({ field })], makeUser()).known).toBe(false)
    }
  })

  it('an operator colliding with an Object.prototype name is unknown', () => {
    for (const operator of ['constructor', 'toString', '__proto__']) {
      const result = matchesConditions(
        [condition({ operator: operator as RoleCondition['operator'] })],
        makeUser(),
      )
      expect(result.known).toBe(false)
    }
  })

  it('one unknown condition makes the whole list unknown, even when another already failed', () => {
    // Order must not decide the answer: a list that contains anything
    // unevaluable is unevaluable, full stop. Short-circuiting on the first
    // FALSE would let a "matched: false" hide a condition the code cannot
    // understand, and the reconciler would then silently strip access.
    const conditions = [condition({ value: 'Nobody' }), condition({ field: 'managerId' })]

    expect(matchesConditions(conditions, makeUser()).known).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api exec vitest run test/business-role-evaluator.spec.ts`
Expected: FAIL — `../src/business-roles/role-evaluator` does not resolve.

- [ ] **Step 3: Write the evaluator's condition half**

Create `apps/api/src/business-roles/role-evaluator.ts`:

```ts
import type { UserStatus } from '../users/users.repository'

/**
 * THE core safety property of this module, inherited verbatim from
 * `jml/rule-engine.ts`: conditions are DATA, never code. There is no
 * expression language here — no `eval`, no `new Function`, no template
 * interpolation of a condition's own fields into anything executable.
 * Matching is a CLOSED comparison (one of exactly four operators) over a
 * CLOSED set of nameable fields. An identity provider that runs
 * admin-supplied script against its own directory is a privilege-escalation
 * vector by construction — see test/business-role-evaluator.spec.ts's static
 * source scan, which asserts this directory contains none of the above.
 */

export type ConditionOperator = 'equals' | 'not_equals' | 'in' | 'in_org_subtree'

export interface RoleCondition {
  field: string
  operator: ConditionOperator
  value: unknown
}

export interface EvaluableUser {
  id: string
  status: UserStatus
  jobTitle: string | null
  location: string | null
  orgUnitId: string
  /** The ltree path of the user's org unit, e.g. `acme.sales.emea`. */
  orgUnitPath: string
  attributes: Record<string, unknown>
}

/**
 * Deliberately three-valued rather than a boolean.
 *
 * `{ known: false }` is NOT "did not match". A condition this code cannot
 * understand — an operator or field written by a migration newer than the
 * running binary — must not fail open (skip it, and grant access nobody
 * intended) and must not fail closed (treat the role as non-matching, and
 * silently STRIP access). It refuses to answer, and the reconciler then
 * refuses to act at all for that user: nothing granted, nothing revoked,
 * error surfaced. A user who looks healthy while something dead-lettered is
 * the worst outcome this product can produce, and an engine that quietly
 * removes access is that same failure wearing a different hat.
 */
export type ConditionMatch = { known: true; matched: boolean } | { known: false; reason: string }

/**
 * Why every "is this one of the known ones" check below reads
 * `Object.hasOwn(MAP, value)` against an `Object.create(null)` catalog rather
 * than a plain `{}` literal or a bare `MAP[value] !== undefined`: `field` and
 * `operator` are admin-authored DATA read back from Postgres, not values this
 * code minted. A plain object literal inherits `Object.prototype`, so a row
 * carrying `field: 'constructor'` or `operator: 'toString'` would resolve to a
 * real, truthy, non-nullish inherited value instead of `undefined` — defeating
 * a `?? fallback` and dispatching to something that was never one of the four
 * real operators. This is the same hazard `ROLE_PERMISSIONS`/`ROLE_RANK`
 * (`authz/actions.ts`) and `KNOWN_TRIGGERS`/`KNOWN_ACTIONS`
 * (`jml/rule-engine.ts`) were hardened against, for the same reason.
 */
function nullPrototypeMap<T>(entries: readonly (readonly [string, T])[]): Record<string, T> {
  const map = Object.create(null) as Record<string, T>
  for (const [key, value] of entries) {
    map[key] = value
  }
  return map
}

type FieldExtractor = (user: EvaluableUser) => unknown

/**
 * The allowlist. EXACTLY these, plus the open-ended `attributes.<key>` form
 * handled in `extractField` — and it must stay identical to the trigger list
 * in `RoleReconciler` (Milestone 17, Task 9). A field that can be named in a
 * formula but does not trigger re-evaluation when it changes is a mover whose
 * access silently fails to follow them, which is the exact failure this
 * sub-project exists to remove.
 *
 * Three fields are excluded on purpose. `managerId` immediately raises whether
 * "reports to X" means direct reports or the whole subtree, and the org-unit
 * hierarchy already answers the question people reach for it to ask.
 * `startDate` and `endDate` are inputs to JML state transitions, not standing
 * truths: a date that has passed should already have moved `status`, and
 * keying a formula off the raw date as well would put two disagreeing clocks
 * in the system.
 */
const CONDITION_FIELD_EXTRACTORS: Record<string, FieldExtractor> = nullPrototypeMap<FieldExtractor>([
  ['jobTitle', (user) => user.jobTitle],
  ['location', (user) => user.location],
  ['status', (user) => user.status],
  ['orgUnitId', (user) => user.orgUnitId],
])

const ATTRIBUTE_PREFIX = 'attributes.'

type FieldLookup = { known: true; value: unknown } | { known: false }

function extractField(field: string, user: EvaluableUser): FieldLookup {
  if (Object.hasOwn(CONDITION_FIELD_EXTRACTORS, field)) {
    return { known: true, value: CONDITION_FIELD_EXTRACTORS[field](user) }
  }

  if (field.startsWith(ATTRIBUTE_PREFIX)) {
    const key = field.slice(ATTRIBUTE_PREFIX.length)
    // Same null-prototype reasoning as above, applied to a value the admin
    // controls twice over (the key AND the stored attributes object).
    if (key.length === 0) return { known: false }
    return { known: true, value: Object.hasOwn(user.attributes, key) ? user.attributes[key] : null }
  }

  return { known: false }
}

/**
 * Scalar equality over jsonb-shaped values. `Object.is` rather than `===` so
 * `NaN` compares equal to itself; non-scalars never compare equal, because a
 * formula comparing against an object or array is not a comparison anyone
 * meant to write.
 */
function scalarEquals(left: unknown, right: unknown): boolean {
  if (left !== null && typeof left === 'object') return false
  if (right !== null && typeof right === 'object') return false
  return Object.is(left, right)
}

type Matcher = (fieldValue: unknown, conditionValue: unknown, user: EvaluableUser) => ConditionMatch

const KNOWN: (matched: boolean) => ConditionMatch = (matched) => ({ known: true, matched })

const OPERATOR_MATCHERS: Record<string, Matcher> = nullPrototypeMap<Matcher>([
  ['equals', (fieldValue, conditionValue) => KNOWN(scalarEquals(fieldValue, conditionValue))],
  ['not_equals', (fieldValue, conditionValue) => KNOWN(!scalarEquals(fieldValue, conditionValue))],
  [
    'in',
    (fieldValue, conditionValue) => {
      if (!Array.isArray(conditionValue)) {
        return { known: false, reason: `operator "in" requires an array value` }
      }
      return KNOWN(conditionValue.some((candidate) => scalarEquals(fieldValue, candidate)))
    },
  ],
])

/**
 * Every condition must match. A list with ZERO conditions matches NOBODY —
 * stated as its own early return rather than left to the fold below, which
 * would return the vacuous `true` and hand an unfinished role's entitlements
 * to the entire directory.
 *
 * The loop deliberately does NOT short-circuit on the first `matched: false`.
 * A list containing anything unevaluable is unevaluable regardless of the
 * order its conditions happen to be stored in — short-circuiting would let a
 * false hide an unknown, and the reconciler would then silently strip access.
 */
export function matchesConditions(
  conditions: readonly RoleCondition[],
  user: EvaluableUser,
): ConditionMatch {
  if (conditions.length === 0) {
    return { known: true, matched: false }
  }

  let matchedAll = true

  for (const condition of conditions) {
    if (!Object.hasOwn(OPERATOR_MATCHERS, condition.operator)) {
      return { known: false, reason: `unknown operator "${condition.operator}"` }
    }

    const lookup = extractField(condition.field, user)
    if (!lookup.known) {
      return { known: false, reason: `unknown field "${condition.field}"` }
    }

    const result = OPERATOR_MATCHERS[condition.operator](lookup.value, condition.value, user)
    if (!result.known) return result
    if (!result.matched) matchedAll = false
  }

  return KNOWN(matchedAll)
}
```

Note `in_org_subtree` is intentionally absent from `OPERATOR_MATCHERS` at this point — Task 5 adds it, and the "unknown operator" test above is what proves the refusal path works before it exists.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @idm/api exec vitest run test/business-role-evaluator.spec.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/business-roles/role-evaluator.ts apps/api/test/business-role-evaluator.spec.ts
git commit -m "feat(business-roles): closed condition matching that refuses to act on the unknown"
```

---

### Task 5: The org-subtree operator and custom attributes

**Files:**
- Modify: `apps/api/src/business-roles/role-evaluator.ts`
- Test: `apps/api/test/business-role-evaluator.spec.ts`

**Interfaces:**
- Consumes: `matchesConditions`, `EvaluableUser`, `RoleCondition` (Task 4).
- Produces: `in_org_subtree` as a working member of `OPERATOR_MATCHERS`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/business-role-evaluator.spec.ts`:

```ts
describe('in_org_subtree (Milestone 16, Task 5)', () => {
  function subtree(value: string): RoleCondition {
    return { field: 'orgUnitId', operator: 'in_org_subtree', value }
  }

  it('matches the named unit itself', () => {
    const user = makeUser({ orgUnitPath: 'acme.sales' })

    expect(matchesConditions([subtree('acme.sales')], user)).toEqual({ known: true, matched: true })
  })

  it('matches a descendant at any depth', () => {
    const user = makeUser({ orgUnitPath: 'acme.sales.emea.uk' })

    expect(matchesConditions([subtree('acme.sales')], user)).toEqual({ known: true, matched: true })
  })

  it('does not match a sibling', () => {
    const user = makeUser({ orgUnitPath: 'acme.marketing' })

    expect(matchesConditions([subtree('acme.sales')], user)).toEqual({ known: true, matched: false })
  })

  it('does not match on a shared label PREFIX — acme.sales is not an ancestor of acme.salesops', () => {
    // A naive startsWith() gets this wrong, and getting it wrong grants
    // Sales entitlements to a whole unrelated department.
    const user = makeUser({ orgUnitPath: 'acme.salesops.emea' })

    expect(matchesConditions([subtree('acme.sales')], user)).toEqual({ known: true, matched: false })
  })

  it('is unknown against a non-string value', () => {
    const user = makeUser({ orgUnitPath: 'acme.sales' })

    expect(matchesConditions([{ field: 'orgUnitId', operator: 'in_org_subtree', value: 42 }], user).known).toBe(
      false,
    )
  })

  it('is unknown on any field other than orgUnitId — the operator implies the path comparison', () => {
    const user = makeUser({ orgUnitPath: 'acme.sales' })

    expect(
      matchesConditions([{ field: 'jobTitle', operator: 'in_org_subtree', value: 'acme.sales' }], user).known,
    ).toBe(false)
  })
})

describe('custom attributes (Milestone 16, Task 5)', () => {
  it('reads attributes.<key> from the user attribute bag', () => {
    const user = makeUser({ attributes: { costCentre: 'CC-100' } })
    const conditions: RoleCondition[] = [{ field: 'attributes.costCentre', operator: 'equals', value: 'CC-100' }]

    expect(matchesConditions(conditions, user)).toEqual({ known: true, matched: true })
  })

  it('an absent attribute reads as null rather than being unknown', () => {
    // An attribute nobody has set yet is a legitimate, answerable state —
    // unlike a field name the code does not recognise at all.
    const user = makeUser({ attributes: {} })
    const conditions: RoleCondition[] = [{ field: 'attributes.costCentre', operator: 'equals', value: null }]

    expect(matchesConditions(conditions, user)).toEqual({ known: true, matched: true })
  })

  it('an attribute key colliding with an Object.prototype name reads as null, not an inherited value', () => {
    const user = makeUser({ attributes: {} })
    const conditions: RoleCondition[] = [
      { field: 'attributes.constructor', operator: 'equals', value: null },
    ]

    expect(matchesConditions(conditions, user)).toEqual({ known: true, matched: true })
  })

  it('a bare "attributes." with no key is unknown', () => {
    expect(matchesConditions([{ field: 'attributes.', operator: 'equals', value: null }], makeUser()).known).toBe(
      false,
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api exec vitest run test/business-role-evaluator.spec.ts`
Expected: FAIL — the six `in_org_subtree` tests fail, because the operator is not in `OPERATOR_MATCHERS` and every call returns `{ known: false }`. The four attribute tests already pass from Task 4's `extractField`.

- [ ] **Step 3: Add the subtree matcher**

In `apps/api/src/business-roles/role-evaluator.ts`, add to the `OPERATOR_MATCHERS` list:

```ts
  [
    'in_org_subtree',
    (fieldValue, conditionValue, user) => {
      // The operator implies the comparison: it is only meaningful against
      // the org hierarchy, so naming any other field is a formula that does
      // not mean what its author thought it did. Refuse rather than guess.
      if (fieldValue !== user.orgUnitId) {
        return { known: false, reason: 'operator "in_org_subtree" applies only to orgUnitId' }
      }
      if (typeof conditionValue !== 'string' || conditionValue.length === 0) {
        return { known: false, reason: 'operator "in_org_subtree" requires a non-empty ltree path' }
      }
      return KNOWN(isAtOrBelow(user.orgUnitPath, conditionValue))
    },
  ],
```

And add the helper above `OPERATOR_MATCHERS`:

```ts
/**
 * ltree ancestry, done on labels rather than characters.
 *
 * A plain `path.startsWith(ancestor)` is WRONG and dangerously so:
 * `'acme.salesops.emea'.startsWith('acme.sales')` is true, which would hand
 * every Sales entitlement to an unrelated department. Ancestry requires the
 * next character after the prefix to be a label separator.
 */
function isAtOrBelow(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}.`)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @idm/api exec vitest run test/business-role-evaluator.spec.ts`
Expected: PASS, 22 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/business-roles/role-evaluator.ts apps/api/test/business-role-evaluator.spec.ts
git commit -m "feat(business-roles): org-subtree matching on labels, not characters"
```

---

### Task 6: Role evaluation, exceptions, and the source scan

**Files:**
- Modify: `apps/api/src/business-roles/role-evaluator.ts`
- Test: `apps/api/test/business-role-evaluator.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 4–5.
- Produces:
  - `interface RoleGrant { kind: 'group_membership' | 'target_account'; groupId: string | null; target: ConnectorTarget | null }`
  - `interface RoleException { userId: string; mode: 'include' | 'exclude'; expiresAt: Date | null }`
  - `interface EvaluableRole { id: string; name: string; conditions: RoleCondition[]; grants: RoleGrant[]; exceptions: RoleException[] }`
  - `type Evaluation = { evaluable: true; groupIds: string[]; targets: ConnectorTarget[]; matchedRoleIds: string[] } | { evaluable: false; roleId: string; roleName: string; reason: string }`
  - `function evaluateRoles(user: EvaluableUser, roles: readonly EvaluableRole[], now: Date): Evaluation`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/business-role-evaluator.spec.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { type EvaluableRole, evaluateRoles } from '../src/business-roles/role-evaluator'

const NOW = new Date('2026-08-08T12:00:00.000Z')

let roleSeq = 0
function makeRole(overrides: Partial<EvaluableRole> = {}): EvaluableRole {
  roleSeq += 1
  return {
    id: `role-${roleSeq}`,
    name: `Role ${roleSeq}`,
    conditions: [{ field: 'jobTitle', operator: 'equals', value: 'Account Executive' }],
    grants: [{ kind: 'group_membership', groupId: `group-${roleSeq}`, target: null }],
    exceptions: [],
    ...overrides,
  }
}

describe('evaluateRoles (Milestone 16, Task 6)', () => {
  it('a matching role contributes its grants', () => {
    const role = makeRole({ grants: [{ kind: 'group_membership', groupId: 'g1', target: null }] })

    const result = evaluateRoles(makeUser({ jobTitle: 'Account Executive' }), [role], NOW)

    expect(result).toEqual({ evaluable: true, groupIds: ['g1'], targets: [], matchedRoleIds: [role.id] })
  })

  it('entitlements are the UNION of every role held, so one group granted twice appears once', () => {
    const a = makeRole({ grants: [{ kind: 'group_membership', groupId: 'shared', target: null }] })
    const b = makeRole({
      conditions: [{ field: 'location', operator: 'equals', value: 'London' }],
      grants: [{ kind: 'group_membership', groupId: 'shared', target: null }],
    })

    const result = evaluateRoles(makeUser({ jobTitle: 'Account Executive', location: 'London' }), [a, b], NOW)

    expect(result).toMatchObject({ evaluable: true, groupIds: ['shared'] })
    if (result.evaluable) expect(result.matchedRoleIds.sort()).toEqual([a.id, b.id].sort())
  })

  it('collects target-account grants separately from group grants', () => {
    const role = makeRole({
      grants: [
        { kind: 'group_membership', groupId: 'g1', target: null },
        { kind: 'target_account', groupId: null, target: 'keycloak' },
      ],
    })

    const result = evaluateRoles(makeUser(), [role], NOW)

    expect(result).toEqual({
      evaluable: true,
      groupIds: ['g1'],
      targets: ['keycloak'],
      matchedRoleIds: [role.id],
    })
  })

  it('a non-matching role contributes nothing', () => {
    const result = evaluateRoles(makeUser({ jobTitle: 'Manager' }), [makeRole()], NOW)

    expect(result).toEqual({ evaluable: true, groupIds: [], targets: [], matchedRoleIds: [] })
  })

  it('include grants membership regardless of the formula', () => {
    const user = makeUser({ jobTitle: 'Manager' })
    const role = makeRole({ exceptions: [{ userId: user.id, mode: 'include', expiresAt: null }] })

    const result = evaluateRoles(user, [role], NOW)

    expect(result).toMatchObject({ evaluable: true, matchedRoleIds: [role.id] })
  })

  it('exclude beats everything, including a formula that matches', () => {
    const user = makeUser({ jobTitle: 'Account Executive' })
    const role = makeRole({ exceptions: [{ userId: user.id, mode: 'exclude', expiresAt: null }] })

    const result = evaluateRoles(user, [role], NOW)

    expect(result).toEqual({ evaluable: true, groupIds: [], targets: [], matchedRoleIds: [] })
  })

  it('exclude beats include when both somehow exist for one person', () => {
    const user = makeUser({ jobTitle: 'Manager' })
    const role = makeRole({
      exceptions: [
        { userId: user.id, mode: 'include', expiresAt: null },
        { userId: user.id, mode: 'exclude', expiresAt: null },
      ],
    })

    expect(evaluateRoles(user, [role], NOW)).toMatchObject({ matchedRoleIds: [] })
  })

  it("an exception for somebody else does not affect this user", () => {
    const user = makeUser({ jobTitle: 'Account Executive' })
    const role = makeRole({ exceptions: [{ userId: 'someone-else', mode: 'exclude', expiresAt: null }] })

    expect(evaluateRoles(user, [role], NOW)).toMatchObject({ matchedRoleIds: [role.id] })
  })

  it('an EXPIRED exception is absent, not a denial — an expired exclude stops excluding', () => {
    const user = makeUser({ jobTitle: 'Account Executive' })
    const expired = new Date(NOW.getTime() - 1)
    const role = makeRole({ exceptions: [{ userId: user.id, mode: 'exclude', expiresAt: expired }] })

    expect(evaluateRoles(user, [role], NOW)).toMatchObject({ matchedRoleIds: [role.id] })
  })

  it('an expired include stops including', () => {
    const user = makeUser({ jobTitle: 'Manager' })
    const expired = new Date(NOW.getTime() - 1)
    const role = makeRole({ exceptions: [{ userId: user.id, mode: 'include', expiresAt: expired }] })

    expect(evaluateRoles(user, [role], NOW)).toMatchObject({ matchedRoleIds: [] })
  })

  it('an exception expiring exactly now is still live — expiry is exclusive at the boundary', () => {
    const user = makeUser({ jobTitle: 'Manager' })
    const role = makeRole({ exceptions: [{ userId: user.id, mode: 'include', expiresAt: NOW }] })

    expect(evaluateRoles(user, [role], NOW)).toMatchObject({ matchedRoleIds: [role.id] })
  })

  it('ONE unevaluable role makes the WHOLE evaluation unevaluable', () => {
    // Not "skip that role and carry on" — a partial desired set would be
    // acted on by the reconciler as if it were complete, revoking whatever
    // the broken role was justifying.
    const good = makeRole()
    const broken = makeRole({ conditions: [{ field: 'managerId', operator: 'equals', value: 'x' }] })

    const result = evaluateRoles(makeUser(), [good, broken], NOW)

    expect(result.evaluable).toBe(false)
    if (!result.evaluable) {
      expect(result.roleId).toBe(broken.id)
      expect(result.reason).toContain('managerId')
    }
  })

  it('no roles at all is evaluable and empty, not unevaluable', () => {
    expect(evaluateRoles(makeUser(), [], NOW)).toEqual({
      evaluable: true,
      groupIds: [],
      targets: [],
      matchedRoleIds: [],
    })
  })

  it('does not mutate the user or the roles it was given', () => {
    const user = makeUser()
    const role = makeRole()
    const userBefore = structuredClone(user)
    const roleBefore = structuredClone(role)

    evaluateRoles(user, [role], NOW)

    expect(user).toEqual(userBefore)
    expect(role).toEqual(roleBefore)
  })
})

function collectTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) return collectTsFiles(fullPath)
    return entry.name.endsWith('.ts') ? [fullPath] : []
  })
}

describe('business role formulas are DATA, never code', () => {
  it('src/business-roles contains no eval(), no `new Function(...)`, and no bare Function(...) construction', () => {
    const files = collectTsFiles(path.resolve(process.cwd(), 'src/business-roles'))
    // Sanity check on the scan itself: an empty list would pass vacuously.
    expect(files.length).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      if (/\beval\s*\(/.test(text) || /\bnew\s+Function\s*\(/.test(text) || /(?<!\w)Function\s*\(/.test(text)) {
        offenders.push(path.relative(process.cwd(), file))
      }
    }

    expect(offenders).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api exec vitest run test/business-role-evaluator.spec.ts`
Expected: FAIL — `evaluateRoles` is not exported.

- [ ] **Step 3: Implement evaluateRoles**

Append to `apps/api/src/business-roles/role-evaluator.ts`:

```ts
import type { ConnectorTarget } from '../connectors/connector'

export interface RoleGrant {
  kind: 'group_membership' | 'target_account'
  groupId: string | null
  target: ConnectorTarget | null
}

export interface RoleException {
  userId: string
  mode: 'include' | 'exclude'
  expiresAt: Date | null
}

export interface EvaluableRole {
  id: string
  name: string
  conditions: RoleCondition[]
  grants: RoleGrant[]
  exceptions: RoleException[]
}

export type Evaluation =
  | { evaluable: true; groupIds: string[]; targets: ConnectorTarget[]; matchedRoleIds: string[] }
  | { evaluable: false; roleId: string; roleName: string; reason: string }

/**
 * An exception is live until its expiry has PASSED. `expiresAt === now` is
 * still live — expiry is exclusive at the boundary, so an exception written
 * "until 5pm" covers 5pm exactly.
 */
function isLive(exception: RoleException, now: Date): boolean {
  return exception.expiresAt === null || exception.expiresAt.getTime() >= now.getTime()
}

/**
 * Precedence, in order: `exclude` beats everything, then `include` grants
 * regardless of the formula, then the formula decides. An EXPIRED exception is
 * treated as ABSENT, never as a denial — an expired `exclude` stops excluding
 * and an expired `include` stops including.
 */
function holdsRole(role: EvaluableRole, user: EvaluableUser, now: Date): ConditionMatch {
  let included = false

  for (const exception of role.exceptions) {
    if (exception.userId !== user.id || !isLive(exception, now)) continue
    if (exception.mode === 'exclude') return { known: true, matched: false }
    included = true
  }

  if (included) return { known: true, matched: true }

  return matchesConditions(role.conditions, user)
}

/**
 * A person's entitlements are the UNION of every role they hold.
 *
 * ONE unevaluable role makes the WHOLE evaluation unevaluable, rather than
 * being skipped. A partial desired set is worse than no answer: the reconciler
 * would act on it as though it were complete and revoke whatever the broken
 * role was justifying. Refusing wholesale is what keeps "nothing granted,
 * nothing revoked, error surfaced" true.
 */
export function evaluateRoles(
  user: EvaluableUser,
  roles: readonly EvaluableRole[],
  now: Date,
): Evaluation {
  const groupIds = new Set<string>()
  const targets = new Set<ConnectorTarget>()
  const matchedRoleIds: string[] = []

  for (const role of roles) {
    const held = holdsRole(role, user, now)
    if (!held.known) {
      return { evaluable: false, roleId: role.id, roleName: role.name, reason: held.reason }
    }
    if (!held.matched) continue

    matchedRoleIds.push(role.id)
    for (const grant of role.grants) {
      if (grant.kind === 'group_membership' && grant.groupId !== null) groupIds.add(grant.groupId)
      if (grant.kind === 'target_account' && grant.target !== null) targets.add(grant.target)
    }
  }

  return {
    evaluable: true,
    groupIds: [...groupIds],
    targets: [...targets],
    matchedRoleIds,
  }
}
```

Move the `import type { ConnectorTarget }` line up to join the other imports at the top of the file rather than leaving it mid-file.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @idm/api exec vitest run test/business-role-evaluator.spec.ts`
Expected: PASS, 37 tests.

- [ ] **Step 5: Run the full gate**

Run: `pnpm verify`
Expected: PASS. Milestone 16 adds a pure module nothing calls yet.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/business-roles/role-evaluator.ts apps/api/test/business-role-evaluator.spec.ts
git commit -m "feat(business-roles): role evaluation, exception precedence, and the source scan"
```

---

## Milestone 17 — The reconciler, the gate, and the API

### Task 7: The repository and the draft/simulate/publish gate

**Files:**
- Create: `apps/api/src/business-roles/business-roles.repository.ts`
- Create: `apps/api/src/business-roles/draft.ts`
- Test: `apps/api/test/business-roles.spec.ts`

**Interfaces:**
- Consumes: `EvaluableRole`, `RoleCondition`, `RoleGrant` (Milestone 16).
- Produces:
  - `interface RoleDefinition { conditions: RoleCondition[]; grants: RoleGrant[] }`
  - `function parseDefinition(input: unknown): RoleDefinition` — throws `ValidationError` on anything malformed
  - `function hashDefinition(definition: RoleDefinition): string` — SHA-256 of the canonical form
  - `class BusinessRolesRepository` with `create`, `saveDraft`, `recordSimulation`, `publish`, `setEnabled`, `listEnabledForEvaluation`, `findById`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/business-roles.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { BusinessRolesRepository } from '../src/business-roles/business-roles.repository'
import { hashDefinition, parseDefinition } from '../src/business-roles/draft'
import { withTestDatabase } from './support/pg'

const ctx = withTestDatabase()

function repo(): BusinessRolesRepository {
  return new BusinessRolesRepository(ctx.db)
}

const DEFINITION = {
  conditions: [{ field: 'jobTitle', operator: 'equals', value: 'Account Executive' }],
  grants: [{ kind: 'target_account', groupId: null, target: 'keycloak' }],
}

describe('draft canonicalisation (Milestone 17, Task 7)', () => {
  it('hashes equal definitions equally regardless of key or member order', () => {
    const a = parseDefinition({
      conditions: [
        { field: 'jobTitle', operator: 'equals', value: 'AE' },
        { field: 'location', operator: 'equals', value: 'London' },
      ],
      grants: [],
    })
    const b = parseDefinition({
      conditions: [
        { operator: 'equals', value: 'London', field: 'location' },
        { value: 'AE', field: 'jobTitle', operator: 'equals' },
      ],
      grants: [],
    })

    expect(hashDefinition(a)).toBe(hashDefinition(b))
  })

  it('hashes different definitions differently', () => {
    const a = parseDefinition({ conditions: [{ field: 'jobTitle', operator: 'equals', value: 'AE' }], grants: [] })
    const b = parseDefinition({ conditions: [{ field: 'jobTitle', operator: 'equals', value: 'SDR' }], grants: [] })

    expect(hashDefinition(a)).not.toBe(hashDefinition(b))
  })

  it('rejects an operator outside the closed set', () => {
    expect(() =>
      parseDefinition({ conditions: [{ field: 'jobTitle', operator: 'matches', value: 'x' }], grants: [] }),
    ).toThrow()
  })

  it('rejects a grant whose kind does not match its reference', () => {
    expect(() =>
      parseDefinition({ conditions: [], grants: [{ kind: 'group_membership', groupId: null, target: 'keycloak' }] }),
    ).toThrow()
  })
})

describe('the publish gate (Milestone 17, Task 7)', () => {
  it('a saved draft changes nothing about the published definition', async () => {
    const role = await repo().create({ name: 'Draft only', description: null })

    await repo().saveDraft(role.id, DEFINITION)

    const published = await repo().findById(role.id)
    expect(published?.conditions).toEqual([])
    expect(published?.grants).toEqual([])
    expect(published?.draftDefinition).not.toBeNull()
  })

  it('publish refuses when the draft was never simulated', async () => {
    const role = await repo().create({ name: 'Never simulated', description: null })
    await repo().saveDraft(role.id, DEFINITION)

    await expect(repo().publish(role.id)).rejects.toThrow(/simulat/i)
  })

  it('publish refuses when the draft changed after simulation', async () => {
    const role = await repo().create({ name: 'Edited after simulation', description: null })
    await repo().saveDraft(role.id, DEFINITION)
    await repo().recordSimulation(role.id, hashDefinition(parseDefinition(DEFINITION)))

    // Simulate something harmless, then try to ship something sweeping.
    await repo().saveDraft(role.id, {
      conditions: [{ field: 'status', operator: 'equals', value: 'active' }],
      grants: [{ kind: 'target_account', groupId: null, target: 'keycloak' }],
    })

    await expect(repo().publish(role.id)).rejects.toThrow(/simulat/i)
  })

  it('publish copies the draft down and clears it', async () => {
    const role = await repo().create({ name: 'Publishable', description: null })
    await repo().saveDraft(role.id, DEFINITION)
    await repo().recordSimulation(role.id, hashDefinition(parseDefinition(DEFINITION)))

    await repo().publish(role.id)

    const published = await repo().findById(role.id)
    expect(published?.conditions).toEqual([
      expect.objectContaining({ field: 'jobTitle', operator: 'equals', value: 'Account Executive' }),
    ])
    expect(published?.grants).toEqual([expect.objectContaining({ kind: 'target_account', target: 'keycloak' })])
    expect(published?.draftDefinition).toBeNull()
    expect(published?.simulatedDraftHash).toBeNull()
  })

  it('listEnabledForEvaluation returns only enabled roles, with their published definitions', async () => {
    const on = await repo().create({ name: 'Enabled role', description: null })
    await repo().saveDraft(on.id, DEFINITION)
    await repo().recordSimulation(on.id, hashDefinition(parseDefinition(DEFINITION)))
    await repo().publish(on.id)
    await repo().setEnabled(on.id, true)

    const off = await repo().create({ name: 'Disabled role', description: null })
    await repo().saveDraft(off.id, DEFINITION)
    await repo().recordSimulation(off.id, hashDefinition(parseDefinition(DEFINITION)))
    await repo().publish(off.id)

    const roles = await repo().listEnabledForEvaluation()

    expect(roles.map((r) => r.id)).toEqual([on.id])
    expect(roles[0].grants).toEqual([expect.objectContaining({ target: 'keycloak' })])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api exec vitest run test/business-roles.spec.ts`
Expected: FAIL — neither module resolves.

- [ ] **Step 3: Write the draft parser and hasher**

Create `apps/api/src/business-roles/draft.ts`:

```ts
import { createHash } from 'node:crypto'
import { ALL_CONNECTOR_TARGETS, type ConnectorTarget } from '../connectors/connector'
import { ValidationError } from '../common/errors'
import type { ConditionOperator, RoleCondition, RoleGrant } from './role-evaluator'

export interface RoleDefinition {
  conditions: RoleCondition[]
  grants: RoleGrant[]
}

const OPERATORS: readonly ConditionOperator[] = ['equals', 'not_equals', 'in', 'in_org_subtree']
const MAX_CONDITIONS = 32
const MAX_GRANTS = 64

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${what} must be an object`)
  }
  return value as Record<string, unknown>
}

/**
 * Validates an admin-authored draft into the shape the evaluator and the
 * published child tables both accept. Everything downstream — the hash, the
 * simulation, the publish — depends on this having actually checked, so it
 * throws rather than coercing.
 *
 * The caps are not arbitrary: a draft is admin-supplied and gets hashed,
 * stored and evaluated per user on every write, so an unbounded list is a
 * cheap way to make every user write expensive.
 */
export function parseDefinition(input: unknown): RoleDefinition {
  const raw = asRecord(input, 'definition')

  const rawConditions = raw.conditions
  const rawGrants = raw.grants
  if (!Array.isArray(rawConditions)) throw new ValidationError('definition.conditions must be an array')
  if (!Array.isArray(rawGrants)) throw new ValidationError('definition.grants must be an array')
  if (rawConditions.length > MAX_CONDITIONS) throw new ValidationError(`at most ${MAX_CONDITIONS} conditions`)
  if (rawGrants.length > MAX_GRANTS) throw new ValidationError(`at most ${MAX_GRANTS} grants`)

  const conditions: RoleCondition[] = rawConditions.map((entry, index) => {
    const condition = asRecord(entry, `conditions[${index}]`)
    const field = condition.field
    const operator = condition.operator

    if (typeof field !== 'string' || field.length === 0 || field.length > 128) {
      throw new ValidationError(`conditions[${index}].field must be a non-empty string of at most 128 characters`)
    }
    if (typeof operator !== 'string' || !OPERATORS.includes(operator as ConditionOperator)) {
      throw new ValidationError(`conditions[${index}].operator must be one of ${OPERATORS.join(', ')}`)
    }

    // `value` is deliberately unconstrained here beyond being JSON —
    // the evaluator's matchers are what decide whether a given value makes
    // sense for a given operator, and they refuse rather than guess.
    return { field, operator: operator as ConditionOperator, value: condition.value ?? null }
  })

  const grants: RoleGrant[] = rawGrants.map((entry, index) => {
    const grant = asRecord(entry, `grants[${index}]`)
    const kind = grant.kind
    const groupId = grant.groupId ?? null
    const target = grant.target ?? null

    if (kind === 'group_membership') {
      if (typeof groupId !== 'string' || target !== null) {
        throw new ValidationError(`grants[${index}] of kind group_membership needs a groupId and no target`)
      }
      return { kind, groupId, target: null }
    }

    if (kind === 'target_account') {
      if (typeof target !== 'string' || groupId !== null) {
        throw new ValidationError(`grants[${index}] of kind target_account needs a target and no groupId`)
      }
      if (!ALL_CONNECTOR_TARGETS.includes(target as ConnectorTarget)) {
        throw new ValidationError(`grants[${index}].target is not a known connector target`)
      }
      return { kind, groupId: null, target: target as ConnectorTarget }
    }

    throw new ValidationError(`grants[${index}].kind must be group_membership or target_account`)
  })

  return { conditions, grants }
}

/**
 * SHA-256 over a CANONICAL form — members sorted, object keys emitted in a
 * fixed order — so that reordering a list in the editor does not read as a
 * different draft and force a pointless re-simulation, while any real change
 * to what the role means does.
 */
export function hashDefinition(definition: RoleDefinition): string {
  const conditions = definition.conditions
    .map((c) => JSON.stringify([c.field, c.operator, c.value ?? null]))
    .sort()
  const grants = definition.grants.map((g) => JSON.stringify([g.kind, g.groupId, g.target])).sort()

  return createHash('sha256').update(JSON.stringify({ conditions, grants })).digest('hex')
}
```

Confirm `ValidationError` is the correct export name in `apps/api/src/common/errors.ts` before writing this; if the project's name differs, use the existing one rather than adding a new error class.

- [ ] **Step 4: Write the repository**

Create `apps/api/src/business-roles/business-roles.repository.ts` implementing, against the `businessRoles` / `businessRoleConditions` / `businessRoleGrants` / `businessRoleExceptions` tables:

```ts
import { Inject, Injectable } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import { ConflictError, NotFoundError } from '../common/errors'
import {
  businessRoleConditions,
  businessRoleExceptions,
  businessRoleGrants,
  businessRoles,
} from '../db/schema/business-roles'
import * as schema from '../db/schema/index'
import { hashDefinition, parseDefinition, type RoleDefinition } from './draft'
import type { EvaluableRole } from './role-evaluator'

@Injectable()
export class BusinessRolesRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>) {}

  async create(input: { name: string; description: string | null }) {
    const [row] = await this.db.insert(businessRoles).values(input).returning()
    return row
  }

  /**
   * Writing a draft clears the simulation record as well as failing the hash
   * comparison at publish time. Two mechanisms, deliberately: the cleared
   * record is what the console reads to show "draft pending simulation", and
   * the hash comparison is what makes the gate correct even if some future
   * caller forgets to clear.
   */
  async saveDraft(id: string, definition: unknown): Promise<void> {
    const parsed = parseDefinition(definition)
    const updated = await this.db
      .update(businessRoles)
      .set({ draftDefinition: parsed as unknown as Record<string, unknown>, simulatedAt: null, simulatedDraftHash: null, updatedAt: new Date() })
      .where(eq(businessRoles.id, id))
      .returning({ id: businessRoles.id })

    if (updated.length === 0) throw new NotFoundError('business role not found')
  }

  async recordSimulation(id: string, hash: string): Promise<void> {
    await this.db
      .update(businessRoles)
      .set({ simulatedAt: new Date(), simulatedDraftHash: hash })
      .where(eq(businessRoles.id, id))
  }

  /**
   * THE gate. Refuses unless a simulation ran against this exact draft, then
   * replaces the published child rows and clears the draft in ONE transaction
   * — a half-published role would be a formula with someone else's grants.
   */
  async publish(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [role] = await tx.select().from(businessRoles).where(eq(businessRoles.id, id)).for('update')
      if (!role) throw new NotFoundError('business role not found')
      if (role.draftDefinition === null) throw new ConflictError('there is no draft to publish')

      const definition = parseDefinition(role.draftDefinition)
      if (role.simulatedDraftHash === null || role.simulatedDraftHash !== hashDefinition(definition)) {
        throw new ConflictError('this draft has not been simulated — simulate it before publishing')
      }

      await tx.delete(businessRoleConditions).where(eq(businessRoleConditions.businessRoleId, id))
      await tx.delete(businessRoleGrants).where(eq(businessRoleGrants.businessRoleId, id))

      if (definition.conditions.length > 0) {
        await tx.insert(businessRoleConditions).values(
          definition.conditions.map((c) => ({ businessRoleId: id, field: c.field, operator: c.operator, value: c.value })),
        )
      }
      if (definition.grants.length > 0) {
        await tx.insert(businessRoleGrants).values(
          definition.grants.map((g) => ({ businessRoleId: id, kind: g.kind, groupId: g.groupId, target: g.target })),
        )
      }

      await tx
        .update(businessRoles)
        .set({ draftDefinition: null, simulatedDraftHash: null, updatedAt: new Date() })
        .where(eq(businessRoles.id, id))
    })
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.db.update(businessRoles).set({ enabled, updatedAt: new Date() }).where(eq(businessRoles.id, id))
  }

  /** Every enabled role, shaped for the evaluator. The reconciler's hot read. */
  async listEnabledForEvaluation(): Promise<EvaluableRole[]> {
    const roles = await this.db.select().from(businessRoles).where(eq(businessRoles.enabled, true))
    return Promise.all(roles.map((role) => this.loadDefinition(role.id, role.name)))
  }

  async findById(id: string) {
    const [role] = await this.db.select().from(businessRoles).where(eq(businessRoles.id, id))
    if (!role) return null
    const definition = await this.loadDefinition(role.id, role.name)
    return { ...role, conditions: definition.conditions, grants: definition.grants, exceptions: definition.exceptions }
  }

  private async loadDefinition(id: string, name: string): Promise<EvaluableRole> {
    const [conditions, grants, exceptions] = await Promise.all([
      this.db.select().from(businessRoleConditions).where(eq(businessRoleConditions.businessRoleId, id)),
      this.db.select().from(businessRoleGrants).where(eq(businessRoleGrants.businessRoleId, id)),
      this.db.select().from(businessRoleExceptions).where(eq(businessRoleExceptions.businessRoleId, id)),
    ])

    return {
      id,
      name,
      conditions: conditions.map((c) => ({ field: c.field, operator: c.operator, value: c.value })),
      grants: grants.map((g) => ({ kind: g.kind, groupId: g.groupId, target: g.target })),
      exceptions: exceptions.map((e) => ({ userId: e.userId, mode: e.mode, expiresAt: e.expiresAt })),
    }
  }
}
```

`ConflictError` / `NotFoundError`: use whatever `apps/api/src/common/errors.ts` already exports and whatever `domain-exception.filter.ts` already maps to 409/404. Do not add new error classes for this.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @idm/api exec vitest run test/business-roles.spec.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/business-roles apps/api/test/business-roles.spec.ts
git commit -m "feat(business-roles): repository with the draft-simulate-publish gate"
```

---

### Task 8: The reconciler

**Files:**
- Create: `apps/api/src/business-roles/role-reconciler.ts`
- Test: `apps/api/test/business-roles.spec.ts`

**Interfaces:**
- Consumes: `BusinessRolesRepository`, `evaluateRoles`, `AuditWriter.record(tx, entry)`, `OutboxWriter.record(tx, event)`.
- Produces: `class RoleReconciler` with
  `reconcileUser(tx: DbHandle, userId: string, actorUserId: string | null, now: Date): Promise<ReconcileOutcome>`
  where `type ReconcileOutcome = { status: 'applied'; groupsAdded: string[]; groupsRemoved: string[]; targetsAdded: ConnectorTarget[]; targetsRemoved: ConnectorTarget[] } | { status: 'refused'; roleId: string; roleName: string; reason: string }`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/business-roles.spec.ts`. Build the fixtures locally in this file — there is no `test/helpers/` layer in this repo:

```ts
describe('RoleReconciler (Milestone 17, Task 8)', () => {
  it('grants a matching role\'s group, marked business_role', async () => {
    const { userId, groupId, roleId } = await seedRoleGrantingGroup(ctx, { jobTitle: 'Account Executive' })

    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    const rows = await membershipsFor(ctx, userId)
    expect(rows).toEqual([expect.objectContaining({ groupId, grantSource: 'business_role' })])
    expect(roleId).toBeDefined()
  })

  it('revokes its own row when the person stops matching', async () => {
    const { userId } = await seedRoleGrantingGroup(ctx, { jobTitle: 'Account Executive' })
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    await ctx.db.update(users).set({ jobTitle: 'Manager' }).where(eq(users.id, userId))
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    expect(await membershipsFor(ctx, userId)).toEqual([])
  })

  it('NEVER revokes a manual row, even when no role justifies it', async () => {
    const { userId, groupId } = await seedRoleGrantingGroup(ctx, { jobTitle: 'Manager' })
    await ctx.db.insert(groupUserMembers).values({ groupId, userId, grantSource: 'manual' })

    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    expect(await membershipsFor(ctx, userId)).toEqual([
      expect.objectContaining({ groupId, grantSource: 'manual' }),
    ])
  })

  it('leaves a manual row alone even when a role also wants it, and the row survives the role ceasing to match', async () => {
    const { userId, groupId } = await seedRoleGrantingGroup(ctx, { jobTitle: 'Account Executive' })
    await ctx.db.insert(groupUserMembers).values({ groupId, userId, grantSource: 'manual' })

    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))
    await ctx.db.update(users).set({ jobTitle: 'Manager' }).where(eq(users.id, userId))
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    expect(await membershipsFor(ctx, userId)).toEqual([
      expect.objectContaining({ groupId, grantSource: 'manual' }),
    ])
  })

  it('re-adds a role-derived row that was removed by hand', async () => {
    const { userId, groupId } = await seedRoleGrantingGroup(ctx, { jobTitle: 'Account Executive' })
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    await ctx.db.delete(groupUserMembers).where(and(eq(groupUserMembers.userId, userId), eq(groupUserMembers.groupId, groupId)))
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    expect(await membershipsFor(ctx, userId)).toEqual([
      expect.objectContaining({ groupId, grantSource: 'business_role' }),
    ])
  })

  it('two roles justifying one group produce exactly one row, surviving one of them ceasing to match', async () => {
    const { userId, groupId } = await seedTwoRolesOneGroup(ctx)
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    expect(await membershipsFor(ctx, userId)).toHaveLength(1)

    // Break the first role's condition only.
    await ctx.db.update(users).set({ jobTitle: 'Manager' }).where(eq(users.id, userId))
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    expect(await membershipsFor(ctx, userId)).toEqual([
      expect.objectContaining({ groupId, grantSource: 'business_role' }),
    ])
  })

  it('disabling a role revokes its rows', async () => {
    const { userId, roleId } = await seedRoleGrantingGroup(ctx, { jobTitle: 'Account Executive' })
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    await new BusinessRolesRepository(ctx.db).setEnabled(roleId, false)
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    expect(await membershipsFor(ctx, userId)).toEqual([])
  })

  it('REFUSES to act when any enabled role is unevaluable — nothing granted, nothing revoked', async () => {
    const { userId, groupId, roleId } = await seedRoleGrantingGroup(ctx, { jobTitle: 'Account Executive' })
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    // A condition row naming a field the running code does not know, as a
    // migration newer than this binary would produce.
    await ctx.db.insert(businessRoleConditions).values({
      businessRoleId: roleId,
      field: 'managerId',
      operator: 'equals',
      value: 'anyone',
    })

    const outcome = await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    expect(outcome.status).toBe('refused')
    // The pre-existing grant is untouched: not revoked, not re-granted.
    expect(await membershipsFor(ctx, userId)).toEqual([
      expect.objectContaining({ groupId, grantSource: 'business_role' }),
    ])
  })

  it('writes exactly one audit row for a pass that changed something, and none for a no-op', async () => {
    const { userId } = await seedRoleGrantingGroup(ctx, { jobTitle: 'Account Executive' })

    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))
    const afterFirst = await auditRowsFor(ctx, userId)
    expect(afterFirst).toHaveLength(1)

    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))
    expect(await auditRowsFor(ctx, userId)).toHaveLength(1)
  })
})
```

Write the four helpers (`reconciler`, `seedRoleGrantingGroup`, `seedTwoRolesOneGroup`, `membershipsFor`, `auditRowsFor`) at the top of the file. `seedRoleGrantingGroup` creates an org unit, a user with the given `jobTitle`, a group, then a role whose draft is `{ conditions: [{ field: 'jobTitle', operator: 'equals', value: 'Account Executive' }], grants: [{ kind: 'group_membership', groupId, target: null }] }`, simulates it via `recordSimulation(id, hashDefinition(parseDefinition(draft)))`, publishes and enables it. `seedTwoRolesOneGroup` does the same twice against one group, the second role keyed on `location` rather than `jobTitle`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api exec vitest run test/business-roles.spec.ts`
Expected: FAIL — `../src/business-roles/role-reconciler` does not resolve.

- [ ] **Step 3: Implement the reconciler**

Create `apps/api/src/business-roles/role-reconciler.ts`. The shape:

```ts
async reconcileUser(tx: DbHandle, userId: string, actorUserId: string | null, now: Date): Promise<ReconcileOutcome> {
  const user = await this.loadEvaluableUser(tx, userId)          // joins org_units for orgUnitPath
  const roles = await this.roles.listEnabledForEvaluation()      // see connection note below
  const evaluation = evaluateRoles(user, roles, now)

  if (!evaluation.evaluable) {
    return { status: 'refused', roleId: evaluation.roleId, roleName: evaluation.roleName, reason: evaluation.reason }
  }

  const currentGroups = await tx.select().from(groupUserMembers).where(eq(groupUserMembers.userId, userId))
  const currentTargets = await tx.select().from(userTargetAccounts).where(eq(userTargetAccounts.userId, userId))

  // A row that already exists — from ANY source — satisfies the desire, so
  // it is not re-added. A manual row therefore quietly absorbs a role's
  // want, and keeps absorbing it after the role stops matching.
  const heldGroups = new Set(currentGroups.map((row) => row.groupId))
  const groupsToAdd = evaluation.groupIds.filter((id) => !heldGroups.has(id))

  // ONLY business_role rows are revocable. This is the single most important
  // line in the module.
  const desiredGroups = new Set(evaluation.groupIds)
  const groupsToRemove = currentGroups
    .filter((row) => row.grantSource === 'business_role' && !desiredGroups.has(row.groupId))
    .map((row) => row.groupId)

  // …the identical shape for targets against userTargetAccounts…

  if (nothingChanged) return { status: 'applied', groupsAdded: [], groupsRemoved: [], targetsAdded: [], targetsRemoved: [] }

  // inserts, deletes, ONE audit row, and the outbox event — all on `tx`
}
```

Rules the implementation must honour:

- **Everything runs on the caller's `tx`.** `listEnabledForEvaluation` currently uses the repository's injected `db`; give `BusinessRolesRepository` a `tx`-taking overload (or pass `tx` into it) so the reconciler never causes a second pool checkout while `tx` is open. This is finding C1 (`docs/superpowers/audit-integrity.md`), guarded by `test/pool-exhaustion.spec.ts` — a second connection here would deadlock the pool.
- **Inserted group rows carry `grantSource: 'business_role'`, `grantedBy: actorUserId`, `grantedAt: now`.** Deletes are narrowed by `and(eq(userId), inArray(groupId, …), eq(grantSource, 'business_role'))` — the `grantSource` predicate goes in the SQL, not only in the JavaScript filter above it, so a concurrent hand-grant between read and write cannot be caught by the delete.
- **One audit row per changed pass**, none for a no-op: `action: 'business_role.reconcile'`, `resourceType: 'user'`, `resourceId: userId`, `before`/`after` holding the two group/target sets. Use `AuditWriter.record(tx, entry)`.
- **Emit the same outbox event the existing membership write already emits.** Read `apps/api/src/groups/groups.controller.ts`'s member add/remove handler and mirror its `OutboxWriter.record(tx, …)` call exactly — same `aggregateType`, same `eventType`, same payload shape. Do not invent a new event type; the whole point of approach A is that nothing downstream of the outbox learns anything new.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @idm/api exec vitest run test/business-roles.spec.ts`
Expected: PASS, 19 tests.

- [ ] **Step 5: Run the pool-exhaustion guard specifically**

Run: `pnpm --filter @idm/api exec vitest run test/pool-exhaustion.spec.ts`
Expected: PASS. If it hangs, the reconciler opened a second connection inside the transaction — fix that rather than raising the pool size.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/business-roles/role-reconciler.ts apps/api/test/business-roles.spec.ts
git commit -m "feat(business-roles): reconciler that revokes only what it granted"
```

---

### Task 9: Re-evaluate on every user write

**Files:**
- Modify: `apps/api/src/users/users.controller.ts` (the create and update handlers)
- Modify: `apps/api/src/app.module.ts` (register `BusinessRolesRepository`, `RoleReconciler`)
- Test: `apps/api/test/business-roles.spec.ts`

**Interfaces:**
- Consumes: `RoleReconciler.reconcileUser` (Task 8).
- Produces: nothing new; the user write path now calls the reconciler inside its existing transaction.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/business-roles.spec.ts`:

```ts
describe('re-evaluation triggers (Milestone 17, Task 9)', () => {
  const EVALUABLE_FIELDS = ['jobTitle', 'location', 'status', 'orgUnitId', 'attributes'] as const

  it('the trigger list matches the evaluator field allowlist exactly', () => {
    // A field that can be named in a formula but does not trigger
    // re-evaluation when it changes is a mover whose access silently fails
    // to follow them. These two lists must never drift apart.
    expect([...REEVALUATION_FIELDS].sort()).toEqual([...EVALUABLE_FIELDS].sort())
  })

  it('changing a job title moves the person between roles in ONE transaction', async () => {
    const { userId, salesGroupId, financeGroupId } = await seedTwoDepartmentRoles(ctx)

    await updateUserViaController(ctx, userId, { jobTitle: 'Financial Analyst' })

    const rows = await membershipsFor(ctx, userId)
    expect(rows.map((r) => r.groupId)).toEqual([financeGroupId])
    expect(rows.map((r) => r.groupId)).not.toContain(salesGroupId)
  })

  it('a failed user update leaves no membership change and no audit row', async () => {
    const { userId } = await seedTwoDepartmentRoles(ctx)
    const before = await membershipsFor(ctx, userId)

    await expect(updateUserViaController(ctx, userId, { jobTitle: 'x'.repeat(500) })).rejects.toThrow()

    expect(await membershipsFor(ctx, userId)).toEqual(before)
  })
})
```

`REEVALUATION_FIELDS` is exported from `role-reconciler.ts` in Step 3. `updateUserViaController` builds the Nest testing module the way `apps/api/test/users.write.spec.ts` already does — copy that file's setup rather than inventing a new one.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api exec vitest run test/business-roles.spec.ts`
Expected: FAIL — `REEVALUATION_FIELDS` is not exported and the membership does not move.

- [ ] **Step 3: Export the trigger list and wire the call**

In `apps/api/src/business-roles/role-reconciler.ts`:

```ts
/**
 * The user fields whose change re-evaluates role membership. MUST stay
 * identical to CONDITION_FIELD_EXTRACTORS' key set in role-evaluator.ts, plus
 * `attributes` (which backs the open-ended `attributes.<key>` form). The test
 * in business-roles.spec.ts asserts the two lists match — a formula field
 * that does not trigger re-evaluation is a mover whose access silently fails
 * to follow them.
 */
export const REEVALUATION_FIELDS = ['jobTitle', 'location', 'status', 'orgUnitId', 'attributes'] as const
```

In `apps/api/src/users/users.controller.ts`, inside the existing `db.transaction` of both the create and the update handler — **after** the user row is written and its audit row recorded, and using the same `tx`:

```ts
const outcome = await this.roleReconciler.reconcileUser(tx, user.id, request.actor.userId, new Date())
if (outcome.status === 'refused') {
  throw new ConflictError(
    `business role "${outcome.roleName}" cannot be evaluated (${outcome.reason}) — the user was not saved`,
  )
}
```

Throwing rolls the whole transaction back, so a directory in a state the engine cannot understand refuses the write rather than saving a user whose access is silently wrong. On update, skip the call entirely when the patch touches none of `REEVALUATION_FIELDS` — an email or display-name change should not walk every role.

- [ ] **Step 4: Register the providers**

In `apps/api/src/app.module.ts`, add `BusinessRolesRepository` and `RoleReconciler` to `providers` alongside the existing repositories.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @idm/api exec vitest run test/business-roles.spec.ts test/users.write.spec.ts test/app.module.spec.ts`
Expected: PASS. `app.module.spec.ts` verifies the container still resolves; `users.write.spec.ts` is the regression net for the write path you just edited.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src apps/api/test/business-roles.spec.ts
git commit -m "feat(business-roles): re-evaluate in the same transaction as the user write"
```

---

### Task 10: The sweep job and its CLI

**Files:**
- Create: `apps/api/src/business-roles/role-reconciliation.job.ts`
- Create: `apps/api/src/business-roles/role-reconcile-cli.ts`
- Modify: `apps/api/package.json` (add `"role-reconcile"` script)
- Test: `apps/api/test/business-roles.spec.ts`

**Interfaces:**
- Consumes: `RoleReconciler.reconcileUser`.
- Produces: `class RoleReconciliationJob` with `reconcileAll(now: Date): Promise<{ scanned: number; changed: number; refused: number }>` and `reconcileRole(roleId: string, now: Date)`.

- [ ] **Step 1: Write the failing test**

```ts
describe('RoleReconciliationJob (Milestone 17, Task 10)', () => {
  it('walks EVERY user status, not only active', async () => {
    // Mirrors ReconciliationJob and TargetReconciliationJob, which walk every
    // status for the same reason: a suspended person's DESIRED state is still
    // a fact the engine must be able to assert.
    const { deactivatedUserId, groupId } = await seedDeactivatedUserInRoleGroup(ctx)

    const result = await job().reconcileAll(new Date())

    expect(result.scanned).toBeGreaterThan(0)
    // The role conditions on status = 'active', so the deactivated person
    // must have been visited AND found not to qualify.
    expect(await membershipsFor(ctx, deactivatedUserId)).toEqual([])
    expect(groupId).toBeDefined()
  })

  it('is idempotent — a second run changes nothing', async () => {
    await seedRoleGrantingGroup(ctx, { jobTitle: 'Account Executive' })

    const first = await job().reconcileAll(new Date())
    const second = await job().reconcileAll(new Date())

    expect(first.changed).toBeGreaterThan(0)
    expect(second.changed).toBe(0)
  })

  it('counts a refusal without aborting the whole sweep', async () => {
    await seedRoleGrantingGroup(ctx, { jobTitle: 'Account Executive' })
    const { roleId } = await seedUnevaluableRole(ctx)

    const result = await job().reconcileAll(new Date())

    expect(result.refused).toBeGreaterThan(0)
    expect(roleId).toBeDefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api exec vitest run test/business-roles.spec.ts`
Expected: FAIL — `role-reconciliation.job` does not resolve.

- [ ] **Step 3: Implement the job**

Create `apps/api/src/business-roles/role-reconciliation.job.ts`. Follow `apps/api/src/outbox/target-reconciliation.job.ts`'s conventions exactly — read it first. Specifically:

- `ALL_USER_STATUSES = ['pending', 'active', 'suspended', 'deactivated']`, duplicated locally with the same comment those two jobs already carry.
- The same internal pagination chunk size, and the same "this is an internal batch size, not a client-facing limit" note.
- One transaction **per user**, not one for the sweep: a single transaction over a whole directory holds locks for minutes and turns one unevaluable role into a total failure.
- A refusal increments `refused` and moves on. Log it with the role name and reason.

`reconcileRole(roleId, now)` narrows the walk to users the role could plausibly touch but must not try to be clever about it — walk every user and let the evaluator decide, exactly as `reconcileAll` does. The parameter exists so a role change enqueues a bounded, nameable unit of work, not to skip evaluation.

- [ ] **Step 4: Add the CLI and the script**

Create `apps/api/src/business-roles/role-reconcile-cli.ts` modelled on `apps/api/src/outbox/target-reconcile-cli.ts`, and add to `apps/api/package.json`:

```json
    "role-reconcile": "tsx --env-file-if-exists=../../.env src/business-roles/role-reconcile-cli.ts",
```

- [ ] **Step 5: Run the tests and commit**

Run: `pnpm --filter @idm/api exec vitest run test/business-roles.spec.ts`
Expected: PASS.

```bash
git add apps/api/src/business-roles apps/api/package.json apps/api/test/business-roles.spec.ts
git commit -m "feat(business-roles): periodic sweep job and its CLI"
```

---

### Task 11: Actions, guards and the controller

**Files:**
- Modify: `apps/api/src/authz/actions.ts:8-46,95-145`
- Create: `apps/api/src/business-roles/business-roles.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/business-roles.controller.spec.ts`, `apps/api/test/actions.spec.ts`, `apps/api/test/guard-coverage.spec.ts`

**Interfaces:**
- Consumes: `BusinessRolesRepository`, `RoleReconciliationJob`.
- Produces: actions `business_role:read` and `business_role:manage`; routes listed in the spec's "API surface" table.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/business-roles.controller.spec.ts` covering:

```ts
it('business_role:manage is held by super_admin alone', () => {
  for (const role of ALL_ROLE_KEYS) {
    expect(ROLE_PERMISSIONS[role].includes('business_role:manage')).toBe(role === 'super_admin')
  }
})

it('business_role:read is held by super_admin, user_admin, auditor and read_only', () => {
  expect(ALL_ROLE_KEYS.filter((r) => ROLE_PERMISSIONS[r].includes('business_role:read')).sort()).toEqual(
    ['auditor', 'read_only', 'super_admin', 'user_admin'].sort(),
  )
})

it('a SCOPED super_admin cannot mutate a business role', async () => {
  // Mirrors commits 2648b9f (global connector infrastructure) and 617a0b4
  // (the audit log): a formula spans the whole directory and a grant can
  // place anyone into any group, so a scoped holding must never produce a
  // directory-wide effect.
  const actor = await grantScopedSuperAdmin(ctx, salesOrgUnitId)

  await expect(post(`/api/business-roles`, { name: 'x' }, actor)).rejects.toMatchObject({ status: 403 })
})

it('a GLOBAL super_admin can', async () => { /* … */ })

it('publish returns 409 when the draft was not simulated', async () => { /* … */ })

it('a draft write does not change any membership', async () => { /* … */ })
```

Also extend `apps/api/test/actions.spec.ts` if it asserts the exact size of `ALL_ACTIONS`, and check `guard-coverage.spec.ts` — that suite asserts every route carries a permission decorator, so a new controller must satisfy it without modification.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api exec vitest run test/business-roles.controller.spec.ts test/actions.spec.ts test/guard-coverage.spec.ts`
Expected: FAIL — the actions do not exist.

- [ ] **Step 3: Add the actions**

In `apps/api/src/authz/actions.ts`, add `'business_role:read'` and `'business_role:manage'` to the `Action` union **and** to `ALL_ACTIONS` (both lists — they are maintained by hand and the second is what the guard iterates), then grant them in `ROLE_PERMISSIONS`: `business_role:read` to `super_admin`, `user_admin`, `auditor`, `read_only`; `business_role:manage` to `super_admin` only, alongside `role:assign` and with the same comment explaining why.

- [ ] **Step 4: Write the controller**

Create `apps/api/src/business-roles/business-roles.controller.ts` with the routes from the spec's API surface table. Every mutating route:

1. carries `@RequirePermission('business_role:manage')`;
2. asserts the actor's grant for that action is **global** (`scopeOrgUnitId === null`) before doing anything, throwing `ForbiddenError` otherwise — copy the assertion `connector-targets.controller.ts` already uses for the same reason rather than writing a new one;
3. writes its mutation, its audit row and any outbox events in one transaction.

`POST :id/simulate` runs the evaluator over every user without writing membership rows, returns `{ gains: [...], losses: [...], gainCount, lossCount }`, and records the simulation via `recordSimulation(id, hashDefinition(parseDefinition(draft)))`. It is a `POST` because it writes `simulated_at`; it must not write anything else.

`POST :id/enable` and `:id/disable` set the flag and then enqueue `RoleReconciliationJob.reconcileRole`. Disable's response body states how many principals lost grants, because it is a revocation.

**`POST :id/publish` must enqueue `reconcileRole` too.** Publishing a new definition to an already-enabled role changes who holds it; without this the role's grants would not move until the next periodic sweep, which is exactly the lag this sub-project exists to remove.

**Exception writes enqueue `reconcileUser` for that one person, never a sweep** — an exception is a targeted adjustment and walking the directory for it would be absurd. Both exception routes are permitted while the role is enabled, unlike a definition change: that is the entire point of an exception, the live adjustment made to a running role without touching the formula that governs everyone else. Add a test asserting an exception can be added to an **enabled, published** role and takes effect immediately:

```ts
it('an exception applies to a live role without touching its definition', async () => {
  const { roleId, roleName, outsiderId, groupId } = await seedEnabledRoleAndNonMember(ctx)

  await post(`/api/business-roles/${roleId}/exceptions`, {
    userId: outsiderId,
    mode: 'include',
    reason: 'Covering for parental leave until March',
    expiresAt: '2026-03-01T00:00:00.000Z',
  }, globalAdmin)

  expect(await membershipsFor(ctx, outsiderId)).toEqual([
    expect.objectContaining({ groupId, grantSource: 'business_role' }),
  ])
  expect(roleName).toBeDefined()
})

it('an exception without a reason is rejected', async () => {
  const { roleId, outsiderId } = await seedEnabledRoleAndNonMember(ctx)

  await expect(
    post(`/api/business-roles/${roleId}/exceptions`, { userId: outsiderId, mode: 'include' }, globalAdmin),
  ).rejects.toMatchObject({ status: 400 })
})
```

- [ ] **Step 5: Run the tests and the full gate**

Run: `pnpm verify`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(business-roles): global-scoped admin API for business roles"
```

---

### Task 12: Why does this person have this?

**Files:**
- Modify: `apps/api/src/users/users.controller.ts`
- Test: `apps/api/test/business-roles.controller.spec.ts`

**Interfaces:**
- Consumes: `evaluateRoles`, `BusinessRolesRepository.listEnabledForEvaluation`.
- Produces: `GET /api/users/:id/entitlements` returning
  `{ groups: Array<{ groupId, groupName, grantSource, grantedBy, grantedAt, justifiedBy: Array<{ roleId, roleName }> }>, targets: Array<{ target, grantSource, justifiedBy }> }`

- [ ] **Step 1: Write the failing test**

```ts
it('names the roles that justify a role-derived membership, computed live', async () => {
  const { userId, groupId, roleId, roleName } = await seedRoleGrantingGroup(ctx, { jobTitle: 'Account Executive' })
  await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

  const body = await get(`/api/users/${userId}/entitlements`, globalAdmin)

  expect(body.groups).toEqual([
    expect.objectContaining({ groupId, grantSource: 'business_role', justifiedBy: [{ roleId, roleName }] }),
  ])
})

it('shows a manual membership with NO role behind it — the recertification queue', async () => {
  const { userId, groupId } = await seedRoleGrantingGroup(ctx, { jobTitle: 'Manager' })
  await ctx.db.insert(groupUserMembers).values({ groupId, userId, grantSource: 'manual' })

  const body = await get(`/api/users/${userId}/entitlements`, globalAdmin)

  expect(body.groups).toEqual([expect.objectContaining({ grantSource: 'manual', justifiedBy: [] })])
})

it('requires user:read and is narrowed by the actor\'s scope — out of scope is 403, not 404', async () => {
  const outOfScope = await grantScopedHelpDesk(ctx, marketingOrgUnitId)

  await expect(get(`/api/users/${salesUserId}/entitlements`, outOfScope)).rejects.toMatchObject({ status: 403 })
})

it('a scoped help-desk operator CAN read it for someone inside their scope', async () => {
  const inScope = await grantScopedHelpDesk(ctx, salesOrgUnitId)

  await expect(get(`/api/users/${salesUserId}/entitlements`, inScope)).resolves.toBeDefined()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api exec vitest run test/business-roles.controller.spec.ts`
Expected: FAIL — 404, the route does not exist.

- [ ] **Step 3: Implement the route**

Add to `users.controller.ts`, gated `@RequirePermission('user:read')` and running the existing `PermissionEngine.assertCanIn` scope assertion the other single-user reads already use.

Read the current `group_user_members` and `user_target_accounts` rows, then run `evaluateRoles` **per role** to determine which enabled roles currently hold this user, and attach that list to every row whose `grantSource` is `business_role`. `justifiedBy` is computed live rather than stored, exactly as the spec settles: a stored list of justifying roles goes stale the instant a formula changes.

A `manual` row always gets `justifiedBy: []`, even when a role would also justify it — the row is the human's, and saying otherwise would misreport who owns it.

If the evaluation refuses, return the rows with `justifiedBy: null` and an `unevaluable` field naming the role and reason, rather than failing the whole read. This endpoint is diagnostic; it is the screen an admin opens *because* something is wrong.

- [ ] **Step 4: Run the tests, then the full gate**

Run: `pnpm --filter @idm/api exec vitest run test/business-roles.controller.spec.ts`
Then: `pnpm verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/users/users.controller.ts apps/api/test/business-roles.controller.spec.ts
git commit -m "feat(business-roles): explain why a person holds each entitlement"
```

---

## Milestone 18 — Sync integration

This milestone edits `OutboxWriter`, the most safety-critical shared code in the repository. Nothing downstream of it changes: `SyncWorker`, `DirectoryConnector`, the dead-letter path and attribute reconciliation are all untouched.

### Task 13: Fan out by entitlement, per target, opt-in

**Files:**
- Modify: `apps/api/src/outbox/outbox.writer.ts:113-131`
- Test: `apps/api/test/business-role-sync.spec.ts`, `apps/api/test/outbox-emission.spec.ts`

**Interfaces:**
- Consumes: `userTargetAccounts`, `connectorTargets.provisioningMode` (Task 3).
- Produces: `OutboxWriter.record` emitting one row per enabled target whose `provisioningMode` is `all_users`, plus one row per enabled `entitled_only` target for which this aggregate's user holds a `user_target_accounts` row.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/business-role-sync.spec.ts`:

```ts
describe('entitlement-driven fan-out (Milestone 18, Task 13)', () => {
  it('an all_users target still receives a row for every user — behaviour is unchanged by default', async () => {
    const userId = await insertUser(ctx.db, {})
    await enableTarget(ctx, 'keycloak', { provisioningMode: 'all_users' })

    await ctx.db.transaction((tx) => writer().record(tx, userEvent(userId)))

    expect(await outboxTargetsFor(ctx, userId)).toEqual(['keycloak'])
  })

  it('an entitled_only target receives NOTHING for a user with no account entitlement', async () => {
    const userId = await insertUser(ctx.db, {})
    await enableTarget(ctx, 'keycloak', { provisioningMode: 'entitled_only' })

    await ctx.db.transaction((tx) => writer().record(tx, userEvent(userId)))

    expect(await outboxTargetsFor(ctx, userId)).toEqual([])
  })

  it('an entitled_only target receives a row once the user holds the entitlement', async () => {
    const userId = await insertUser(ctx.db, {})
    await enableTarget(ctx, 'keycloak', { provisioningMode: 'entitled_only' })
    await ctx.db.insert(userTargetAccounts).values({ userId, target: 'keycloak', grantSource: 'business_role' })

    await ctx.db.transaction((tx) => writer().record(tx, userEvent(userId)))

    expect(await outboxTargetsFor(ctx, userId)).toEqual(['keycloak'])
  })

  it('mixes modes correctly across targets in one write', async () => {
    const userId = await insertUser(ctx.db, {})
    await enableTarget(ctx, 'keycloak', { provisioningMode: 'all_users' })
    await enableTarget(ctx, 'echo', { provisioningMode: 'entitled_only' })

    await ctx.db.transaction((tx) => writer().record(tx, userEvent(userId)))

    expect(await outboxTargetsFor(ctx, userId)).toEqual(['keycloak'])
  })

  it('a non-user aggregate is unaffected by entitlement state', async () => {
    // Group events have no user to look up; an entitled_only target must not
    // silently stop receiving group syncs.
    await enableTarget(ctx, 'keycloak', { provisioningMode: 'entitled_only' })

    await ctx.db.transaction((tx) => writer().record(tx, groupEvent(someGroupId)))

    expect(await outboxTargetsForAggregate(ctx, someGroupId)).toEqual(['keycloak'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api exec vitest run test/business-role-sync.spec.ts`
Expected: FAIL — every target currently receives a row regardless of mode.

- [ ] **Step 3: Change the fan-out**

In `apps/api/src/outbox/outbox.writer.ts`, replace the single `enabledTargets` query with one that also selects `provisioningMode`, then filter. Read `connector_targets` and `user_target_accounts` on the **same `tx`** — this method still takes no injected `DB_CLIENT` and must not acquire one.

```ts
const enabledTargets = await tx
  .select({ target: connectorTargets.target, provisioningMode: connectorTargets.provisioningMode })
  .from(connectorTargets)
  .where(eq(connectorTargets.enabled, true))
  .orderBy(connectorTargets.target)

if (enabledTargets.length === 0) return

// Only a `user` aggregate has an account entitlement to consult. Every other
// aggregate type (groups, org units) fans out to every enabled target exactly
// as before — an entitled_only target must not silently stop receiving group
// syncs just because groups have no rows in user_target_accounts.
const entitledOnly = enabledTargets.filter((row) => row.provisioningMode === 'entitled_only')
let entitled = new Set<ConnectorTarget>()

if (event.aggregateType === 'user' && entitledOnly.length > 0) {
  const rows = await tx
    .select({ target: userTargetAccounts.target })
    .from(userTargetAccounts)
    .where(eq(userTargetAccounts.userId, event.aggregateId))
  entitled = new Set(rows.map((row) => row.target))
}

const targets = enabledTargets.filter(
  (row) => row.provisioningMode === 'all_users' || event.aggregateType !== 'user' || entitled.has(row.target),
)

if (targets.length === 0) return
```

Then insert one row per surviving target, exactly as before.

Update this method's doc comment: it currently states "it writes one row PER currently-`enabled` row in `connector_targets`", which stops being true here. Say what is now true and why the default preserves the old behaviour.

- [ ] **Step 4: Run the existing outbox regression suite**

Run: `pnpm --filter @idm/api exec vitest run test/outbox-emission.spec.ts test/business-role-sync.spec.ts`
Expected: PASS, both. `outbox-emission.spec.ts` is the pre-existing net for the Keycloak path; it must pass **unmodified**. If it needs editing to go green, the default is not preserving old behaviour and that is the bug — fix the code, not the test.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/outbox/outbox.writer.ts apps/api/test/business-role-sync.spec.ts
git commit -m "feat(business-roles): fan out by account entitlement on entitled_only targets"
```

---

### Task 14: Losing an entitlement disables the account

**Files:**
- Modify: `apps/api/src/business-roles/role-reconciler.ts`
- Test: `apps/api/test/business-role-sync.spec.ts`

**Interfaces:**
- Consumes: `RoleReconciler.reconcileUser` (Task 8), the fan-out (Task 13).
- Produces: a `disable` outbox event per target whose account entitlement was revoked.

- [ ] **Step 1: Write the failing test**

```ts
describe('entitlement loss disables (Milestone 18, Task 14)', () => {
  it('revoking a target-account entitlement enqueues a disable, not silence', async () => {
    // An account silently dropped from management stays ENABLED in the target
    // forever — precisely the orphaned account the governance sub-project
    // would later have to go and find. Commit 92055ee established this for
    // the mail connector's aliases; this generalises it.
    const { userId } = await seedRoleGrantingTargetAccount(ctx, 'keycloak', { jobTitle: 'Account Executive' })
    await enableTarget(ctx, 'keycloak', { provisioningMode: 'entitled_only' })
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    await ctx.db.update(users).set({ jobTitle: 'Manager' }).where(eq(users.id, userId))
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    const events = await outboxEventsFor(ctx, userId)
    expect(events.map((e) => e.eventType)).toContain('user.disabled')
    expect(events.at(-1)).toMatchObject({ target: 'keycloak' })
  })

  it('the disable is emitted even though the user no longer passes the fan-out filter', async () => {
    // The ordering trap: by the time the disable is written, the
    // user_target_accounts row is already gone, so a naive
    // OutboxWriter.record() would emit nothing at all for that target.
    const { userId } = await seedRoleGrantingTargetAccount(ctx, 'keycloak', { jobTitle: 'Account Executive' })
    await enableTarget(ctx, 'keycloak', { provisioningMode: 'entitled_only' })
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    await ctx.db.update(users).set({ jobTitle: 'Manager' }).where(eq(users.id, userId))
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    expect(await outboxTargetsFor(ctx, userId)).toContain('keycloak')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api exec vitest run test/business-role-sync.spec.ts`
Expected: FAIL — no disable event is emitted.

- [ ] **Step 3: Emit the disable explicitly**

In `RoleReconciler.reconcileUser`, for every revoked target, write the disable outbox row **directly** rather than via the entitlement-filtered `OutboxWriter.record` path — the entitlement row it would consult has just been deleted, so the generic writer would correctly decide there is nothing to send. Insert into `outboxEvents` with `target` set to the specific revoked target, mirroring the row shape `OutboxWriter` builds, and use the same `eventType` the existing deactivation path already uses for a disable. Read `apps/api/src/keycloak/revoke-access.ts` and the deactivate handler in `users.controller.ts` to find that name; do not invent one.

Order matters: emit the disable **in the same transaction** as the `user_target_accounts` delete, so a rollback loses both or neither.

- [ ] **Step 4: Prove offboarding did NOT acquire a dependency on role evaluation**

This is settled decision 8, and it is the one property in the whole sub-project that must not regress quietly. Add to `apps/api/test/business-role-sync.spec.ts`:

```ts
describe('offboarding is independent of role evaluation (settled decision 8)', () => {
  it('deactivation disables every target even when NO role grants an account entitlement', async () => {
    const userId = await insertUser(ctx.db, { jobTitle: 'Account Executive' })
    await enableTarget(ctx, 'keycloak', { provisioningMode: 'all_users' })
    // Deliberately no business role, and therefore no user_target_accounts row.

    await deactivateUserViaController(ctx, userId)

    const events = await outboxEventsFor(ctx, userId)
    expect(events.map((e) => e.eventType)).toContain('user.disabled')
  })

  it('deactivation disables even when an enabled role is UNEVALUABLE', async () => {
    // The role engine refuses to compute a desired set here. Offboarding must
    // proceed anyway: rule correctness is the second belt, never the braces.
    const userId = await insertUser(ctx.db, { jobTitle: 'Account Executive' })
    await enableTarget(ctx, 'keycloak', { provisioningMode: 'all_users' })
    await seedUnevaluableRole(ctx)

    await deactivateUserViaController(ctx, userId)

    const events = await outboxEventsFor(ctx, userId)
    expect(events.map((e) => e.eventType)).toContain('user.disabled')
    const [row] = await ctx.db.select().from(users).where(eq(users.id, userId))
    expect(row.status).toBe('deactivated')
  })

  it('revoke-access still runs synchronously on deactivation', async () => {
    // Guards the Friday-afternoon scene in PRODUCT.md: sessions die before the
    // request returns, not whenever a sweep next runs.
    const userId = await insertUser(ctx.db, {})
    const revoked = spyOnRevokeAccess()

    await deactivateUserViaController(ctx, userId)

    expect(revoked).toHaveBeenCalledWith(expect.objectContaining({ userId }))
  })
})
```

The deactivate handler in `users.controller.ts` therefore must **not** gate its disable path behind `reconcileUser`'s outcome. If Task 9's "throw on refused" wiring was applied to the deactivate handler as well, undo that for deactivate specifically and leave it on create and update — a directory the engine cannot understand must still be able to offboard someone.

- [ ] **Step 5: Run the tests and commit**

Run: `pnpm --filter @idm/api exec vitest run test/business-role-sync.spec.ts test/users.write.spec.ts`
Expected: PASS.

```bash
git add apps/api/src/business-roles/role-reconciler.ts apps/api/src/users/users.controller.ts apps/api/test/business-role-sync.spec.ts
git commit -m "feat(business-roles): losing an account entitlement disables, never drops silently"
```

---

### Task 15: Target reconciliation respects the mode

**Files:**
- Modify: `apps/api/src/outbox/target-reconciliation.job.ts`
- Test: `apps/api/test/business-role-sync.spec.ts`

**Interfaces:**
- Consumes: `connectorTargets.provisioningMode`, `userTargetAccounts`.
- Produces: no new exports; the job's desired state now includes account existence on `entitled_only` targets.

- [ ] **Step 1: Write the failing test**

```ts
describe('target reconciliation and provisioning mode (Milestone 18, Task 15)', () => {
  it('on an all_users target the job behaves exactly as today', async () => {
    await enableTarget(ctx, 'echo', { provisioningMode: 'all_users' })
    const userId = await insertUser(ctx.db, {})

    const result = await targetReconciliationJob().reconcile('echo')

    expect(result.planned.map((p) => p.userId)).toContain(userId)
  })

  it('on an entitled_only target, an unentitled user is planned for DISABLE, not skipped', async () => {
    // Skipping would leave a live account nobody manages. "Should this
    // account exist at all" is part of the desired state the job corrects
    // toward, so an unentitled user has a desired state of disabled.
    await enableTarget(ctx, 'echo', { provisioningMode: 'entitled_only' })
    const userId = await insertUser(ctx.db, {})

    const result = await targetReconciliationJob().reconcile('echo')

    expect(result.planned).toContainEqual(expect.objectContaining({ userId, kind: 'disable' }))
  })

  it('an entitled user on an entitled_only target is planned normally', async () => {
    await enableTarget(ctx, 'echo', { provisioningMode: 'entitled_only' })
    const userId = await insertUser(ctx.db, {})
    await ctx.db.insert(userTargetAccounts).values({ userId, target: 'echo', grantSource: 'business_role' })

    const result = await targetReconciliationJob().reconcile('echo')

    expect(result.planned).toContainEqual(expect.objectContaining({ userId, kind: expect.not.stringMatching('disable') }))
  })
})
```

Adjust the assertion property names to whatever `TargetReconciliationJob.reconcile` actually returns — read the file first and match its real result shape rather than the illustrative one above.

- [ ] **Step 2: Run test to verify it fails, then implement**

Run: `pnpm --filter @idm/api exec vitest run test/business-role-sync.spec.ts`

In `target-reconciliation.job.ts`, load the target's `provisioningMode` alongside its row, and when it is `entitled_only`, load that target's `user_target_accounts` set once per run (not once per user) and treat an unentitled user's desired state as disabled.

**The blast-radius guard still applies, and this is exactly why it exists.** Flipping a populated target to `entitled_only` before any role grants accounts would plan a disable for the entire directory; the guard must halt that run and report it rather than executing it. Add a test asserting precisely that: a mode flip with no entitlements granted halts, and zero operations reach the target.

- [ ] **Step 3: Run the full gate**

Run: `pnpm verify`
Expected: PASS, including every pre-existing connector suite.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/outbox/target-reconciliation.job.ts apps/api/test/business-role-sync.spec.ts
git commit -m "feat(business-roles): target reconciliation corrects account existence on entitled_only targets"
```

---

## Milestone 19 — JML cleanup and the console

### Task 16: Remove JML's group actions

**Files:**
- Modify: `apps/api/src/jml/rule-engine.ts` (the `JmlActionType` union and `KNOWN_ACTIONS`)
- Modify: `apps/api/src/jml/rule-applier.ts` (the dispatch map)
- Create: `apps/api/src/db/migrations/0022_<generated>.sql` — hand-written, see Step 3
- Test: `apps/api/test/jml-rule-engine.spec.ts`, `apps/api/test/jml-rule-applier.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `JmlActionType` narrowed to `'set_attribute' | 'deactivate'`.

- [ ] **Step 1: Write the failing test**

```ts
it('JML no longer grants group membership — business roles own desired state', () => {
  expect([...KNOWN_ACTION_NAMES].sort()).toEqual(['deactivate', 'set_attribute'])
})

it('a stored rule naming a removed action is rejected, not silently skipped', () => {
  const rule = makeRule({ action: 'add_to_group' as JmlActionType })

  const result = evaluateRule(rule, makeUser({ jobTitle: 'Engineer' }))

  expect(result.matched).toBe(false)
  expect(result.skipReason).toContain('add_to_group')
})
```

Existing tests in both JML spec files that exercise `add_to_group` / `remove_from_group` must be rewritten to use `set_attribute`, or deleted where they only ever tested the removed action. Read both files and do this deliberately — do not bulk-delete.

- [ ] **Step 2: Run test to verify it fails, then narrow the union**

Run: `pnpm --filter @idm/api exec vitest run test/jml-rule-engine.spec.ts test/jml-rule-applier.spec.ts`

Narrow `JmlActionType`, remove both entries from `KNOWN_ACTIONS` and from `rule-applier.ts`'s dispatch map. The `jml_action` **Postgres enum keeps both labels** — Postgres cannot `DROP VALUE` — so the closed-set check in `rule-engine.ts` is what rejects them, which is exactly the hazard that file's `Object.create(null)` catalog was built for.

- [ ] **Step 3: Write the migration guard by hand**

`drizzle-kit generate` will not produce this; write `0022_jml_group_actions_removed.sql` yourself:

```sql
-- Milestone 19, Task 16. JML no longer grants group membership; business
-- roles own desired state. Postgres cannot DROP VALUE from an enum, so the
-- labels survive in jml_action and application code rejects them.
--
-- Fail LOUDLY rather than leaving behind a rule that will never fire again:
-- a silently dead rule is a permission someone believes is being maintained.
DO $$
DECLARE stranded integer;
BEGIN
  SELECT count(*) INTO stranded FROM jml_rules WHERE action IN ('add_to_group', 'remove_from_group');
  IF stranded > 0 THEN
    RAISE EXCEPTION
      'Migration 0022: % jml_rules row(s) still use add_to_group/remove_from_group. Re-create them as business roles, delete them, then re-run.', stranded;
  END IF;
END $$;
```

Add its entry to `src/db/migrations/meta/_journal.json` by hand too, matching the format of the existing entries.

- [ ] **Step 4: Test the guard actually fires**

Add to `apps/api/test/business-roles-schema.spec.ts`: insert a `jml_rules` row with `action = 'add_to_group'` using `ownerDb`, then call `ctx.runMigrationsAgain()` and assert it rejects with a message naming the count. Migrations must be idempotent, so also assert a second `runMigrationsAgain()` on a clean table succeeds.

- [ ] **Step 5: Run the full gate and commit**

Run: `pnpm verify`

```bash
git add apps/api/src/jml apps/api/src/db/migrations apps/api/test
git commit -m "refactor(jml): drop the group actions business roles now own"
```

---

### Task 17: Business roles list and detail

**Files:**
- Create: `apps/web/src/business-roles/BusinessRolesPage.tsx`, `BusinessRolesPage.css`, `BusinessRoleDetailPage.tsx`, `BusinessRoleDetailPage.css`, `api.ts`
- Modify: `apps/web/src/shell/nav-items.tsx:106-111`
- Modify: `apps/web/src/shell/AppShell.tsx` (routes)

**Interfaces:**
- Consumes: the API from Task 11.
- Produces: routes `/business-roles` and `/business-roles/:id`.

- [ ] **Step 1: Add the nav entries**

In `apps/web/src/shell/nav-items.tsx`, relabel the existing entry and add the new one:

```tsx
  { key: 'roles', label: 'Admin roles', path: '/roles', action: 'role:assign', icon: RolesIcon },
  {
    key: 'business-roles',
    label: 'Business roles',
    path: '/business-roles',
    action: 'business_role:read',
    icon: BusinessRolesIcon,
  },
```

The relabel is label-only — path, route and component are untouched. Two entries both reading "Roles" would be genuinely ambiguous, and this work is what creates the ambiguity, so fixing it belongs here.

- [ ] **Step 2: Build the list page**

A table, not a card grid (PRODUCT.md bans card grids for records). Columns: name, status, conditions summary, grants summary, last simulated. Status renders as a **word**, never colour alone, and follows DESIGN.md's rule that the norm is uncoloured — `Enabled` is `--ink-muted` with no fill; `Disabled`, `Draft pending simulation` and `Draft ready to publish` are the exceptions that earn colour (`--warn` for pending, `--primary` for ready).

Empty state teaches: what a business role is and the one action to take, never "No business roles yet".

Skeletons while loading, not spinners.

- [ ] **Step 3: Build the detail page**

Tabs, not accordions: **Definition**, **Exceptions**, **Members**. The Definition tab holds the conditions editor (field / operator / value rows) and the grants list, and it edits the **draft** — nothing on this tab changes anyone's access.

The page must make three states legible without a modal:

| State | What the header says |
|---|---|
| Published, no draft | "Published — no pending changes" |
| Draft, not simulated | "Draft pending simulation" + Simulate is the primary action |
| Draft, simulated | "Draft simulated — ready to publish" + Publish is the primary action |

Every interactive component ships all seven states (default / hover / focus / active / disabled / loading / error). Buttons keep their width while loading so nothing jumps.

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter @idm/web build && pnpm verify:quick`

```bash
git add apps/web/src
git commit -m "feat(web): business roles list and draft-editing detail page"
```

---

### Task 18: The simulate panel, publish, enable and disable

**Files:**
- Modify: `apps/web/src/business-roles/BusinessRoleDetailPage.tsx`
- Create: `apps/web/src/business-roles/SimulatePanel.tsx`, `SimulatePanel.css`

- [ ] **Step 1: Build the simulate panel**

This is the safety rail, and per PRODUCT.md it must read as one — the same job the import preview does. It shows, before anything is committed:

- **N people gain** — each with name, org unit, and exactly what they gain.
- **M people lose** — the same, and this list is what an admin actually reads, so it comes first when M > 0.
- The counts as headline numbers, because the simulation is the only blast-radius control in the design; there is deliberately no hard cap.

Publish is disabled until a simulation exists for the current draft. When the draft changes, the panel clears and the header returns to "Draft pending simulation" — the UI must never show a stale diff next to a live Publish button.

- [ ] **Step 2: Make disable read as a revocation**

Disable is a kill switch, not a pause: it revokes every grant the role is making. It therefore carries a confirmation naming the role and the number of people who lose access, in the same class as deactivating a person. Use the existing `ConfirmDialog` from `apps/web/src/shell/ConfirmDialog.tsx` rather than a new component.

The toast afterwards states consequence, not success: "Disabled — 14 people lost 2 groups", mirroring the existing "Deactivated — 2 active sessions revoked".

- [ ] **Step 3: Verify and commit**

Run: `pnpm --filter @idm/web build && pnpm verify:quick`

```bash
git add apps/web/src/business-roles
git commit -m "feat(web): simulate before publish, and disable that says what it revokes"
```

---

### Task 19: The person Entitlements tab

**Files:**
- Create: `apps/web/src/people/PersonEntitlementsTab.tsx`, `PersonEntitlementsTab.css`
- Modify: the person detail page's tab list

- [ ] **Step 1: Build the tab**

Consumes `GET /api/users/:id/entitlements` (Task 12). One table: what they have, where it came from, and — for role-derived rows — which roles justify it right now.

A **manual** row shows "Granted by hand" with the granting person and date, and no role behind it. That is not a defect to hide: it is the queue a later recertification campaign works from, so it should be legible at a glance rather than buried.

When the API returns `unevaluable`, the tab shows the rows it has plus a clear banner naming the role and reason. This is the screen someone opens *because* something is wrong; it must not fail closed and show nothing.

- [ ] **Step 2: Verify and commit**

Run: `pnpm --filter @idm/web build && pnpm verify:quick`

```bash
git add apps/web/src/people
git commit -m "feat(web): show why a person holds each entitlement"
```

---

### Task 20: End to end

**Files:**
- Create: `apps/web/e2e/business-roles.spec.ts`

- [ ] **Step 1: Write the journey**

```ts
test('a business role grants access, and the person page explains why', async ({ page }) => {
  await signInAsAdmin(page)

  await page.goto('/business-roles')
  await page.getByRole('button', { name: 'New business role' }).click()
  await page.getByLabel('Name').fill('Sales AE')
  await page.getByRole('button', { name: 'Create' }).click()

  // Draft a condition and a grant.
  await page.getByRole('button', { name: 'Add condition' }).click()
  await page.getByLabel('Field').selectOption('jobTitle')
  await page.getByLabel('Operator').selectOption('equals')
  await page.getByLabel('Value').fill('Account Executive')
  await page.getByRole('button', { name: 'Add grant' }).click()
  await page.getByLabel('Group').selectOption({ label: 'Sales' })
  await page.getByRole('button', { name: 'Save draft' }).click()

  // Publish is refused until this exact draft has been simulated.
  await expect(page.getByRole('button', { name: 'Publish' })).toBeDisabled()

  await page.getByRole('button', { name: 'Simulate' }).click()
  await expect(page.getByText(/people gain/i)).toBeVisible()
  await page.getByRole('button', { name: 'Publish' }).click()
  await page.getByRole('button', { name: 'Enable' }).click()

  // The access actually moved.
  await page.goto(`/people/${seededAeUserId}`)
  await page.getByRole('tab', { name: 'Entitlements' }).click()
  await expect(page.getByRole('row', { name: /Sales/ })).toContainText('Sales AE')

  // Editing the draft again re-arms the gate.
  await page.goto('/business-roles')
  await page.getByRole('link', { name: 'Sales AE' }).click()
  await page.getByLabel('Value').fill('SDR')
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.getByRole('button', { name: 'Publish' })).toBeDisabled()
  await expect(page.getByText(/pending simulation/i)).toBeVisible()
})
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @idm/web test:e2e -- business-roles`
Expected: PASS against the running Compose stack.

- [ ] **Step 3: Run the whole gate**

Run: `pnpm verify`
Then: `pnpm --filter @idm/web test:e2e`
Expected: PASS, everything.

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e/business-roles.spec.ts
git commit -m "test(web): end-to-end from drafting a role to explaining the access it granted"
```

---

## Definition of done

- [ ] `pnpm verify` green, and the Playwright suite green against the Compose stack.
- [ ] `outbox-emission.spec.ts` passes **unmodified** — the entitled-only fan-out preserved the default behaviour rather than being made to look like it did.
- [ ] `pnpm --filter @idm/api role-reconcile` runs twice in a row and reports zero changes on the second pass.
- [ ] A role with zero conditions grants nothing, asserted by test.
- [ ] No `eval`, `new Function` or bare `Function(` anywhere under `apps/api/src/business-roles`, asserted by the source scan.
- [ ] Every existing `connector_targets` row is `all_users` after migrating — nobody lost an account on the day this shipped.
- [ ] Deactivation disables every target and kills sessions with **no** enabled business role present, and again with an **unevaluable** one present. Settled decision 8 is asserted, not assumed.
- [ ] An exception can be added to an enabled, published role and takes effect for that one person without a sweep.
- [ ] `README.md`'s "SECURITY STATUS" section gains the two new actions and the global-grant requirement for `business_role:manage`.
