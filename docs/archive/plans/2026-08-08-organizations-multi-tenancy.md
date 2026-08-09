# Organizations and Multi-Tenancy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an organization a first-class object that owns one Keycloak realm, so a new tenant can be created from the console and its realm appears in Keycloak.

**Architecture:** An organization owns exactly one root org unit, so tenancy rides on the existing ltree scope machinery rather than replacing it. Cross-tenant references are made impossible by composite foreign keys rather than checked in application code. Realm creation flows through the existing transactional outbox as a new `organization` aggregate, applied by a connector using a second, master-realm Keycloak credential.

**Tech Stack:** TypeScript, NestJS, Drizzle ORM, PostgreSQL 16 (ltree), Keycloak Admin REST, Vitest, Testcontainers, React + Vite.

**Source spec:** `docs/archive/specs/2026-08-08-organizations-multi-tenancy-design.md`. Every decision below is settled there; this plan does not re-open them.

## Global Constraints

- **Nothing is deleted.** No task adds a `DELETE` route, and no task deletes a Keycloak realm. Suspension sets `enabled: false`.
- **Slug format** is exactly `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`.
- **Reserved slugs** — `master`, and the master organization's own realm name — are rejected **only for user-supplied slugs at the API boundary**. The migration sets master's slug to `master` directly.
- **`slug` and `realm` are immutable after creation.** No route may change either.
- **No secret is ever stored in the database.** Secrets are named by environment variable and resolved at point of use.
- **Every mutation is one transaction** wrapping the write, its `audit_log` row, and its `outbox_events` row.
- **Audit snapshots name fields explicitly.** Never `{ ...row }` — a spread carries future columns into an append-only log.
- **Enum values added by `ALTER TYPE ... ADD VALUE` may not be used in the migration that adds them.** Drizzle applies all pending migrations in one transaction.
- **Run `pnpm verify:quick` before every commit**; `pnpm verify` before finishing a phase.
- **A schema task's tests must exercise the constraint, not the column list.** Where a task adds a CHECK, a unique index, a partial index, a composite FK or an enum, assert it against a real migrated database using the existing `withTestDatabase()` helper (`apps/api/test/support/pg.ts`), in the style of `apps/api/test/business-roles-schema.spec.ts:84-133` — insert the violating row and expect a rejection naming the constraint. Also assert the *permitted* neighbouring case, which is what catches a partial index that lost its `WHERE`. Asserting that `Object.keys(table)` contains a name proves nothing. This governs Tasks 2, 3, 4, 5 and 10, and overrides any thinner test written into an individual task's steps.

## File Structure

**Phase 1 — tenant foundation** (system behaves identically; master owns everything)

| File | Responsibility |
|---|---|
| `apps/api/src/db/schema/organizations.ts` | Create — the `organizations` table and its status enum |
| `apps/api/src/db/schema/index.ts` | Modify — re-export the new table so drizzle-kit discovers it |
| `apps/api/src/db/schema/{org-units,users,groups}.ts` | Modify — `organization_id`, per-org uniqueness, composite FK targets |
| `apps/api/src/db/schema/{business-roles,jml-rules}.ts` | Modify — `organization_id` |
| `apps/api/src/db/migrations/00NN_*.sql` | Create — table, backfill, constraints, in the order below |
| `apps/api/src/organizations/organizations.repository.ts` | Create — reads and writes for `organizations` |
| `apps/api/src/organizations/master-organization.ts` | Create — startup realm resolution and the refuse-to-start guard |
| `apps/api/src/main.ts` | Modify — call the adoption step before `listen` |
| `apps/api/src/org-units/org-units.controller.ts` | Modify — `parentId` becomes required |

**Phase 2 — realm provisioning** (delivers the feature)

| File | Responsibility |
|---|---|
| `apps/api/src/config/env.ts` | Modify — the two provisioning variables |
| `apps/api/src/keycloak/keycloak-admin-client.factory.ts` | Create — a per-realm client, memoized |
| `apps/api/src/connectors/organization.connector.ts` | Create — realm create, enable, disable |
| `apps/api/src/organizations/organizations.controller.ts` | Create — `POST`, `GET`, `PATCH` |
| `apps/api/src/authz/actions.ts` | Modify — `organization:create`, `organization:read`, `organization:update` |
| `apps/api/src/common/errors.ts` | Modify — `NotConfiguredError` |
| `apps/api/src/common/domain-exception.filter.ts` | Modify — `NOT_CONFIGURED` → 503 |
| `apps/api/src/outbox/outbox.writer.ts` | Modify — organization-aware fan-out |
| `apps/api/src/outbox/sync.worker.ts` | Modify — `organization` dispatch, unprovisioned deferral |
| `apps/web/src/organizations/*` | Create — list, create form, suspend/reactivate |
| `docs/*.md` | Modify — retire the single-tenancy claim |

---

# Phase 1 — Tenant foundation

At the end of this phase the system behaves exactly as it does today. Master owns every existing row, cross-tenant references are structurally impossible, and no new API surface exists.

---

### Task 1: The `organizations` table

**Files:**
- Create: `apps/api/src/db/schema/organizations.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Create: `apps/api/src/db/migrations/` (generated)
- Test: `apps/api/test/organizations.schema.spec.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `organizations` table; `organizationStatus` pg enum with values `active`, `suspended`; TypeScript row type `Organization` inferred by later tasks via `typeof organizations.$inferSelect`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/organizations.schema.spec.ts
import { describe, expect, it } from 'vitest'
import { organizations } from '../src/db/schema/organizations'

describe('organizations schema', () => {
  it('exposes the columns the design requires', () => {
    const columns = Object.keys(organizations)
    for (const name of [
      'id', 'slug', 'name', 'realm', 'status', 'isMaster', 'realmProvisionedAt',
    ]) {
      expect(columns).toContain(name)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api test -- organizations.schema`
Expected: FAIL — cannot resolve `../src/db/schema/organizations`

- [ ] **Step 3: Write the schema**

```typescript
// apps/api/src/db/schema/organizations.ts
import { sql } from 'drizzle-orm'
import {
  boolean, check, pgEnum, pgTable, timestamp, uniqueIndex, uuid, varchar,
} from 'drizzle-orm/pg-core'

export const organizationStatus = pgEnum('organization_status', ['active', 'suspended'])

/**
 * A tenant. Owns exactly one root org unit (except master — see the design's
 * decision 6) and exactly one Keycloak realm.
 *
 * There is deliberately NO `root_org_unit_id` column: it would form a FK
 * cycle with `org_units.organization_id`, and "non-null unless master"
 * cannot be a CHECK, because checks are immediate and the intermediate state
 * inside the creating transaction would violate it. The root is derived —
 * `parent_id IS NULL AND organization_id = $1`.
 */
export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: varchar('slug', { length: 63 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    // Nullable ONLY for master, and only between the migration that creates
    // the row and the first startup that resolves KEYCLOAK_ISSUER into it.
    realm: varchar('realm', { length: 63 }),
    status: organizationStatus('status').notNull().default('active'),
    isMaster: boolean('is_master').notNull().default(false),
    realmProvisionedAt: timestamp('realm_provisioned_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    slugUnique: uniqueIndex('organizations_slug_unique').on(sql`lower(${table.slug})`),
    // Exactly one master. A plain unique index on a boolean would forbid a
    // second NON-master row too, so this is partial.
    masterUnique: uniqueIndex('organizations_master_unique')
      .on(table.isMaster)
      .where(sql`${table.isMaster}`),
    realmPresent: check(
      'organizations_realm_present',
      sql`${table.realm} IS NOT NULL OR ${table.isMaster}`,
    ),
    slugFormat: check(
      'organizations_slug_format',
      sql`${table.slug} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'`,
    ),
  }),
)

/** The row type every later task refers to as `Organization`. */
export type Organization = typeof organizations.$inferSelect
```

- [ ] **Step 4: Re-export from the schema barrel**

Add to `apps/api/src/db/schema/index.ts`, keeping the file's existing alphabetical ordering:

```typescript
export * from './organizations'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @idm/api test -- organizations.schema`
Expected: PASS

- [ ] **Step 6: Generate the migration**

Run: `pnpm --filter @idm/api db:generate`

Open the generated SQL and confirm it contains `CREATE TABLE "organizations"` and both `CREATE UNIQUE INDEX` statements, and that it does **not** touch any other table. If it does, the schema barrel picked up an unrelated edit — stop and resolve that first.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/schema/organizations.ts apps/api/src/db/schema/index.ts apps/api/src/db/migrations apps/api/test/organizations.schema.spec.ts
git commit -m "feat(organizations): the organizations table"
```

---

### Task 2: Master adoption — backfill and `NOT NULL`

This is the migration that cannot be regenerated blind. Write the SQL by hand; `db:generate` cannot know the backfill.

**Files:**
- Modify: `apps/api/src/db/schema/{org-units,users,groups}.ts`
- Create: `apps/api/src/db/migrations/00NN_organizations_backfill.sql` (hand-written)
- Test: `apps/api/test/organizations.migration.spec.ts`

**Interfaces:**
- Consumes: `organizations` from Task 1
- Produces: `organization_id` — `uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT` — on `org_units`, `users`, `groups`; nullable on `audit_log`. A master row with `slug = 'master'`, `is_master = true`, `realm = NULL`.

- [ ] **Step 1: Write the failing test**

This test runs the real migrator against a Testcontainer, following the pattern in `apps/api/test/support/`. Seed **before** migrating, so the backfill has something to adopt.

```typescript
// apps/api/test/organizations.migration.spec.ts
import { describe, expect, it } from 'vitest'

describe('organizations backfill migration', () => {
  it('adopts every pre-existing root, user and group into master', async () => {
    const { db, migrateTo } = await startMigrationHarness()

    await migrateTo('0021')                       // the last pre-organizations migration
    await db.execute(sql`
      INSERT INTO org_units (name, parent_id, path) VALUES
        ('Acme', NULL, 'acme'), ('Globex', NULL, 'globex'), ('Sales', NULL, 'acme.sales')
    `)

    const before = await db.execute(sql`SELECT path FROM org_units ORDER BY path`)

    await migrateTo('latest')

    const master = await db.execute(
      sql`SELECT id, slug, realm, is_master FROM organizations WHERE is_master`,
    )
    expect(master.rows).toHaveLength(1)
    expect(master.rows[0]).toMatchObject({ slug: 'master', realm: null, is_master: true })

    const after = await db.execute(sql`SELECT path FROM org_units ORDER BY path`)
    expect(after.rows).toEqual(before.rows)      // no ltree path was rewritten

    const orphans = await db.execute(sql`SELECT count(*)::int AS n FROM org_units WHERE organization_id IS NULL`)
    expect(orphans.rows[0]).toEqual({ n: 0 })
  })
})
```

If `startMigrationHarness` does not already exist, add it to `apps/api/test/support/` alongside the existing Postgres container helper. It must expose `migrateTo(tag)` applying migrations up to and including a given numeric prefix, because this test's whole point is observing the boundary.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api test -- organizations.migration`
Expected: FAIL — `column "organization_id" does not exist`

- [ ] **Step 3: Write the migration by hand**

```sql
-- apps/api/src/db/migrations/00NN_organizations_backfill.sql

-- The master organization. `realm` stays NULL until first startup resolves
-- KEYCLOAK_ISSUER into it (see master-organization.ts) — the CHECK added in
-- the previous migration permits that for master alone.
INSERT INTO organizations (slug, name, realm, status, is_master)
VALUES ('master', 'Master', NULL, 'active', true);

ALTER TABLE org_units ADD COLUMN organization_id uuid;
ALTER TABLE users     ADD COLUMN organization_id uuid;
ALTER TABLE groups    ADD COLUMN organization_id uuid;
ALTER TABLE audit_log ADD COLUMN organization_id uuid;

UPDATE org_units SET organization_id = (SELECT id FROM organizations WHERE is_master);
UPDATE users     SET organization_id = (SELECT id FROM organizations WHERE is_master);
UPDATE groups    SET organization_id = (SELECT id FROM organizations WHERE is_master);
-- audit_log is deliberately left NULL: existing rows predate organizations,
-- and platform-level actions legitimately have none. It is also append-only,
-- so this is the one and only write those rows will ever receive.

ALTER TABLE org_units ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE users     ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE groups    ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE org_units ADD CONSTRAINT org_units_organization_fk
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE users ADD CONSTRAINT users_organization_fk
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE groups ADD CONSTRAINT groups_organization_fk
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_organization_fk
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;

CREATE INDEX org_units_organization_idx ON org_units (organization_id);
CREATE INDEX users_organization_idx     ON users (organization_id);
CREATE INDEX groups_organization_idx    ON groups (organization_id);
```

`audit_log` is append-only and its trigger rejects `UPDATE`. Adding a column via `ALTER TABLE` is DDL, not DML, so the trigger does not fire — but confirm this against the trigger definition in the audit migration before running, and if the trigger does intercept it, add the column without backfilling rather than weakening the trigger.

- [ ] **Step 4: Mirror the columns in the Drizzle schema**

In each of `org-units.ts`, `users.ts`, `groups.ts`, add to the column block:

```typescript
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
```

and in `audit-log.ts`, the same without `.notNull()`. Import `organizations` from `./organizations` in each.

- [ ] **Step 5: Set `organizationId` on every write path the NOT NULL now breaks**

The column is `NOT NULL`, and nothing populates it yet — so without this step every user and group creation fails for the whole of Phase 1, and Step 7's suite run goes red.

A user's organization is **derived from its org unit**, never taken from the request. That is what keeps it consistent with the composite FK Task 4 adds, and it means no API surface changes in this phase.

In `UsersRepository.create`, resolve it from the target org unit inside the same transaction:

```typescript
    const [unit] = await db
      .select({ organizationId: orgUnits.organizationId })
      .from(orgUnits)
      .where(eq(orgUnits.id, input.orgUnitId))
    if (unit === undefined) {
      throw new NotFoundError('org unit', input.orgUnitId)
    }
    // Derived, never client-supplied: a request cannot place a person in
    // another tenant, and this is the value Task 4's composite FK checks.
    const organizationId = unit.organizationId
```

In `GroupsRepository.create`, do the same when `orgUnitId` is set. A **global** group has no org unit, so fall back to master:

```typescript
    const organizationId =
      input.orgUnitId === null
        ? (await this.organizations.findMaster(db)).id
        : (await requireOrgUnitOrganization(db, input.orgUnitId))
```

Global groups belonging to master preserves exactly today's behaviour — they are platform-wide, and per-tenant global groups are not something this phase introduces.

Find every other insert the constraint touches:

Run: `grep -rn "insert(users)\|insert(groups)\|insert(orgUnits)" apps/api/src --include=*.ts`

The CSV import path and any test fixture builder are the likely hits. Each takes the same derivation — never a parameter threaded in from a caller.

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @idm/api test -- organizations.migration`
Expected: PASS

- [ ] **Step 7: Run the full suite**

Run: `pnpm --filter @idm/api test`
Expected: PASS. This is the step that proves Phase 1 is behaviour-preserving. A not-null violation here means a write path was missed in Step 5.

- [ ] **Step 8: Confirm the schema and the database agree**

Run: `pnpm --filter @idm/api db:generate`
Expected: **no new migration is generated.** If one appears, the hand-written SQL and the Drizzle schema have drifted — reconcile before committing, and delete the spurious file.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(organizations): adopt existing data into the master organization"
```

---

### Task 3: Per-organization uniqueness

**Files:**
- Modify: `apps/api/src/db/schema/{users,groups}.ts`
- Create: `apps/api/src/db/migrations/00NN_organizations_uniqueness.sql`
- Test: `apps/api/test/organizations.uniqueness.spec.ts`

**Interfaces:**
- Consumes: `organization_id` from Task 2
- Produces: uniqueness scoped per organization on `users.username`, `users.primary_email`, `users.employee_id`, `groups.name`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/organizations.uniqueness.spec.ts
it('permits the same username in two organizations and forbids it twice in one', async () => {
  const acme = await createOrganizationRow(db, 'acme')
  const globex = await createOrganizationRow(db, 'globex')

  await expect(insertUser(db, { organizationId: acme.id, username: 'jsmith' })).resolves.toBeDefined()
  await expect(insertUser(db, { organizationId: globex.id, username: 'jsmith' })).resolves.toBeDefined()
  await expect(insertUser(db, { organizationId: acme.id, username: 'JSmith' })).rejects.toThrow(
    /users_username_unique/,
  )
})
```

`createOrganizationRow` and `insertUser` are local helpers in this spec inserting directly with Drizzle — they exist to keep the assertion about the index, not about any repository.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api test -- organizations.uniqueness`
Expected: FAIL — the second insert is rejected, because uniqueness is still global

- [ ] **Step 3: Write the migration**

```sql
-- apps/api/src/db/migrations/00NN_organizations_uniqueness.sql
DROP INDEX users_username_unique;
DROP INDEX users_primary_email_unique;
DROP INDEX users_employee_id_unique;
DROP INDEX groups_name_unique;

CREATE UNIQUE INDEX users_username_unique
  ON users (organization_id, lower(username));
CREATE UNIQUE INDEX users_primary_email_unique
  ON users (organization_id, lower(primary_email));
CREATE UNIQUE INDEX users_employee_id_unique
  ON users (organization_id, employee_id) WHERE employee_id IS NOT NULL;
CREATE UNIQUE INDEX groups_name_unique
  ON groups (organization_id, lower(name));
```

Index names are deliberately unchanged. `translateWriteError` in the users and groups repositories matches on these names to turn a constraint violation into a `ConflictError`; renaming them would silently turn a 409 into a 500.

- [ ] **Step 4: Mirror in the Drizzle schema**

In `users.ts`:

```typescript
    emailUnique: uniqueIndex('users_primary_email_unique').on(
      table.organizationId,
      sql`lower(${table.primaryEmail})`,
    ),
    usernameUnique: uniqueIndex('users_username_unique').on(
      table.organizationId,
      sql`lower(${table.username})`,
    ),
    employeeIdUnique: uniqueIndex('users_employee_id_unique')
      .on(table.organizationId, table.employeeId)
      .where(sql`${table.employeeId} IS NOT NULL`),
```

In `groups.ts`:

```typescript
    nameUnique: uniqueIndex('groups_name_unique').on(
      table.organizationId,
      sql`lower(${table.name})`,
    ),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @idm/api test -- organizations.uniqueness`
Expected: PASS

- [ ] **Step 6: Run the full API suite**

Run: `pnpm --filter @idm/api test`
Expected: PASS. Any failure here is a test that assumed global uniqueness — fix the test, not the index, and note which ones in the commit body.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db apps/api/test
git commit -m "feat(organizations): scope username, email, employee id and group name per organization"
```

---

### Task 4: Cross-tenant references made impossible

The load-bearing task. If it is done wrong, nothing downstream notices until a tenant sees another tenant's data.

**Files:**
- Create: `apps/api/src/db/migrations/00NN_organizations_composite_fks.sql`
- Test: `apps/api/test/organizations.isolation.spec.ts`

**Interfaces:**
- Consumes: `organization_id` from Task 2
- Produces: composite FKs guaranteeing every reference stays inside one organization

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/organizations.isolation.spec.ts
it('rejects a user in one organization pointing at another organization\'s org unit', async () => {
  const acme = await createOrganizationRow(db, 'acme')
  const globex = await createOrganizationRow(db, 'globex')
  const globexUnit = await insertOrgUnit(db, { organizationId: globex.id, path: 'globex' })

  // Inserted directly with Drizzle, bypassing every repository — the point
  // is that the DATABASE refuses this, not that application code caught it.
  await expect(
    insertUser(db, { organizationId: acme.id, orgUnitId: globexUnit.id, username: 'mallory' }),
  ).rejects.toThrow(/users_org_unit_organization_fk/)
})

it('rejects a manager in a different organization', async () => {
  const acme = await createOrganizationRow(db, 'acme')
  const globex = await createOrganizationRow(db, 'globex')
  const acmeUnit = await insertOrgUnit(db, { organizationId: acme.id, path: 'acme' })
  const globexUnit = await insertOrgUnit(db, { organizationId: globex.id, path: 'globex' })
  const boss = await insertUser(db, { organizationId: globex.id, orgUnitId: globexUnit.id, username: 'boss' })

  await expect(
    insertUser(db, {
      organizationId: acme.id, orgUnitId: acmeUnit.id, username: 'report', managerId: boss.id,
    }),
  ).rejects.toThrow(/users_manager_organization_fk/)
})

it('still permits a global group, which has no org unit at all', async () => {
  const acme = await createOrganizationRow(db, 'acme')
  await expect(
    insertGroup(db, { organizationId: acme.id, orgUnitId: null, name: 'everyone' }),
  ).resolves.toBeDefined()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api test -- organizations.isolation`
Expected: FAIL — the first two inserts succeed, because nothing forbids them yet

- [ ] **Step 3: Write the migration**

```sql
-- apps/api/src/db/migrations/00NN_organizations_composite_fks.sql

-- Referencable targets. A composite FK needs a unique index over exactly the
-- referenced pair; the surrogate PK alone is not enough.
CREATE UNIQUE INDEX org_units_id_organization_key ON org_units (id, organization_id);
CREATE UNIQUE INDEX users_id_organization_key     ON users (id, organization_id);
CREATE UNIQUE INDEX groups_id_organization_key    ON groups (id, organization_id);

-- A user's org unit must be in the user's own organization.
ALTER TABLE users ADD CONSTRAINT users_org_unit_organization_fk
  FOREIGN KEY (org_unit_id, organization_id)
  REFERENCES org_units (id, organization_id) ON DELETE RESTRICT;

-- A user's manager likewise. NULL manager_id passes under MATCH SIMPLE,
-- which is the wanted behaviour — most people have no manager recorded.
ALTER TABLE users ADD CONSTRAINT users_manager_organization_fk
  FOREIGN KEY (manager_id, organization_id)
  REFERENCES users (id, organization_id) ON DELETE SET NULL;

-- A group's org unit. NULL org_unit_id means a global group and passes.
ALTER TABLE groups ADD CONSTRAINT groups_org_unit_organization_fk
  FOREIGN KEY (org_unit_id, organization_id)
  REFERENCES org_units (id, organization_id) ON DELETE RESTRICT;

-- An org unit's parent.
ALTER TABLE org_units ADD CONSTRAINT org_units_parent_organization_fk
  FOREIGN KEY (parent_id, organization_id)
  REFERENCES org_units (id, organization_id) ON DELETE RESTRICT;

-- Membership edges carry the organization so both endpoints are pinned to it.
ALTER TABLE group_user_members ADD COLUMN organization_id uuid;
UPDATE group_user_members m SET organization_id = g.organization_id
  FROM groups g WHERE g.id = m.group_id;
ALTER TABLE group_user_members ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE group_user_members ADD CONSTRAINT gum_group_organization_fk
  FOREIGN KEY (group_id, organization_id)
  REFERENCES groups (id, organization_id) ON DELETE CASCADE;
ALTER TABLE group_user_members ADD CONSTRAINT gum_user_organization_fk
  FOREIGN KEY (user_id, organization_id)
  REFERENCES users (id, organization_id) ON DELETE CASCADE;

ALTER TABLE group_group_members ADD COLUMN organization_id uuid;
UPDATE group_group_members m SET organization_id = g.organization_id
  FROM groups g WHERE g.id = m.parent_group_id;
ALTER TABLE group_group_members ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE group_group_members ADD CONSTRAINT ggm_parent_organization_fk
  FOREIGN KEY (parent_group_id, organization_id)
  REFERENCES groups (id, organization_id) ON DELETE CASCADE;
ALTER TABLE group_group_members ADD CONSTRAINT ggm_child_organization_fk
  FOREIGN KEY (child_group_id, organization_id)
  REFERENCES groups (id, organization_id) ON DELETE CASCADE;
```

Check the real column names in `apps/api/src/db/schema/group-members.ts` before running this — if the nesting edge uses names other than `parent_group_id`/`child_group_id`, use the actual ones.

- [ ] **Step 4: Mirror the edge-table column in the Drizzle schema**

Add `organizationId` (not null, referencing `organizations.id`) to both tables in `group-members.ts`, and add the composite FKs to each table's second callback argument using drizzle's `foreignKey({ columns, foreignColumns })` helper.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @idm/api test -- organizations.isolation`
Expected: PASS, all three cases

- [ ] **Step 6: Fix the writers the new column breaks**

Every insert into `group_user_members` / `group_group_members` now needs `organizationId`. Find them:

Run: `grep -rn "groupUserMembers\|groupGroupMembers" apps/api/src --include=*.ts | grep -i insert`

Set it from the group being written to, never from the actor. Re-run `pnpm --filter @idm/api test` until green.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(organizations): make cross-tenant references impossible in the database"
```

---

### Task 5: `organization_id` on business roles and JML rules

**Files:**
- Modify: `apps/api/src/db/schema/{business-roles,jml-rules}.ts`
- Create: `apps/api/src/db/migrations/00NN_organizations_roles_rules.sql`
- Test: `apps/api/test/organizations.roles-rules.spec.ts`

**Interfaces:**
- Consumes: `organizations` from Task 1
- Produces: `business_roles.organization_id`, `jml_rules.organization_id`, both `NOT NULL`, backfilled to master

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/organizations.roles-rules.spec.ts
it('requires an organization on a business role and on a JML rule', async () => {
  await expect(
    db.execute(sql`INSERT INTO business_roles (name) VALUES ('orphan')`),
  ).rejects.toThrow(/organization_id/)
  await expect(
    db.execute(sql`INSERT INTO jml_rules (name) VALUES ('orphan')`),
  ).rejects.toThrow(/organization_id/)
})
```

Adjust the column lists to whatever those tables actually require — read both schema files first. The assertion under test is the `NOT NULL`, not the rest of the row.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api test -- organizations.roles-rules`
Expected: FAIL — inserts succeed or fail for an unrelated missing column

- [ ] **Step 3: Write the migration**

```sql
-- apps/api/src/db/migrations/00NN_organizations_roles_rules.sql
ALTER TABLE business_roles ADD COLUMN organization_id uuid;
ALTER TABLE jml_rules      ADD COLUMN organization_id uuid;

UPDATE business_roles SET organization_id = (SELECT id FROM organizations WHERE is_master);
UPDATE jml_rules      SET organization_id = (SELECT id FROM organizations WHERE is_master);

ALTER TABLE business_roles ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE jml_rules      ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE business_roles ADD CONSTRAINT business_roles_organization_fk
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE jml_rules ADD CONSTRAINT jml_rules_organization_fk
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;
```

Nothing reads `business_roles` yet, which is exactly why the column goes in now — after a reconciler exists it is a far more expensive change.

- [ ] **Step 4: Mirror in the Drizzle schema**

Add the same `organizationId` column definition used in Task 2 to `businessRoles` and `jmlRules`. The three child tables of `business_roles` need no column — they reach their organization through their parent.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @idm/api test -- organizations.roles-rules`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db apps/api/test
git commit -m "feat(organizations): scope business roles and JML rules to an organization"
```

---

### Task 6: Master adoption at startup

**Files:**
- Create: `apps/api/src/organizations/master-organization.ts`
- Create: `apps/api/src/organizations/organizations.repository.ts`
- Modify: `apps/api/src/main.ts`
- Test: `apps/api/test/master-organization.spec.ts`

**Interfaces:**
- Consumes: `organizations` from Task 1
- Produces: `adoptMasterRealm(db: NodePgDatabase<typeof schema>, issuer: string): Promise<void>` — resolves the realm from an issuer URL, writes it once, and throws if it would change; `realmFromIssuer(issuer: string): string`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/master-organization.spec.ts
import { adoptMasterRealm, realmFromIssuer } from '../src/organizations/master-organization'

describe('realmFromIssuer', () => {
  it('takes the realm out of an issuer URL', () => {
    expect(realmFromIssuer('http://localhost:8080/realms/identity-manager')).toBe('identity-manager')
  })

  it('rejects a URL with no realm segment', () => {
    expect(() => realmFromIssuer('http://localhost:8080/')).toThrow(/\/realms\//)
  })
})

describe('adoptMasterRealm', () => {
  it('fills in the realm on first run', async () => {
    await adoptMasterRealm(db, 'http://localhost:8080/realms/identity-manager')
    const [row] = await db.select().from(organizations).where(eq(organizations.isMaster, true))
    expect(row.realm).toBe('identity-manager')
  })

  it('is idempotent', async () => {
    await adoptMasterRealm(db, 'http://localhost:8080/realms/identity-manager')
    await expect(
      adoptMasterRealm(db, 'http://localhost:8080/realms/identity-manager'),
    ).resolves.toBeUndefined()
  })

  it('refuses to start when the issuer names a different realm', async () => {
    await adoptMasterRealm(db, 'http://localhost:8080/realms/identity-manager')
    await expect(
      adoptMasterRealm(db, 'http://localhost:8080/realms/something-else'),
    ).rejects.toThrow(/would re-point/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api test -- master-organization`
Expected: FAIL — cannot resolve the module

- [ ] **Step 3: Write the implementation**

```typescript
// apps/api/src/organizations/master-organization.ts
import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../db/schema/index'
import { organizations } from '../db/schema/organizations'

/** `<serverRoot>/realms/<realm>` — the same shape `KeycloakAdminClient` already parses. */
export function realmFromIssuer(issuer: string): string {
  const url = new URL(issuer)
  const match = /^(.*)\/realms\/([^/]+)$/.exec(`${url.origin}${url.pathname}`)
  if (match === null) {
    throw new Error(`KEYCLOAK_ISSUER must contain /realms/<name>: ${issuer}`)
  }
  return match[2]
}

/**
 * Master's realm already exists — it is the one in KEYCLOAK_ISSUER — so this
 * makes NO Keycloak call. It only records which realm master is, once.
 *
 * Called from main.ts before `listen`, never from a Nest lifecycle hook, for
 * the same reason SyncWorker.start() is: compiling AppModule in a test must
 * have no side effect.
 */
export async function adoptMasterRealm(
  db: NodePgDatabase<typeof schema>,
  issuer: string,
): Promise<void> {
  const realm = realmFromIssuer(issuer)
  const [master] = await db.select().from(organizations).where(eq(organizations.isMaster, true))

  if (master === undefined) {
    throw new Error(
      'no master organization exists — the organizations backfill migration has not been applied',
    )
  }

  if (master.realm === null) {
    await db
      .update(organizations)
      .set({ realm, updatedAt: new Date() })
      .where(eq(organizations.id, master.id))
    return
  }

  if (master.realm !== realm) {
    // Accepting this would silently re-point every existing user at a
    // different realm, where none of their accounts exist.
    throw new Error(
      `KEYCLOAK_ISSUER names realm "${realm}" but the master organization is bound to ` +
        `"${master.realm}". Refusing to start: changing it would re-point every existing user.`,
    )
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @idm/api test -- master-organization`
Expected: PASS, all four cases

- [ ] **Step 5: Call it from `main.ts`**

In `bootstrap()`, after `NestFactory.create` and **before** `app.listen(env.port)`:

```typescript
  await adoptMasterRealm(app.get(DB_CLIENT), env.keycloakIssuer)
```

Import `adoptMasterRealm` from `./organizations/master-organization` and `DB_CLIENT` from `./common/db.token`. Placing it before `listen` is what makes a mismatch refuse to serve traffic rather than serve it wrongly.

- [ ] **Step 6: Verify**

Run: `pnpm verify:quick`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(organizations): resolve the master realm at startup, refuse a changed issuer"
```

---

### Task 7: A root org unit comes only from an organization

**Files:**
- Modify: `apps/api/src/org-units/org-units.controller.ts`
- Test: `apps/api/test/org-units.controller.spec.ts` (existing — extend)

**Interfaces:**
- Consumes: nothing
- Produces: `POST /org-units` requires `parentId`; `OrgUnitsRepository.createRoot` survives as the method organization creation calls in Task 12

- [ ] **Step 1: Write the failing test**

```typescript
it('rejects a root org unit — roots come only from creating an organization', async () => {
  const response = await request(app.getHttpServer())
    .post('/org-units')
    .set('Authorization', bearer(superAdmin))
    .send({ name: 'Rogue Root' })

  expect(response.status).toBe(400)
  expect(response.body.code).toBe('VALIDATION_FAILED')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api test -- org-units.controller`
Expected: FAIL — returns 201, creating a root

- [ ] **Step 3: Make `parentId` required**

In `org-units.controller.ts`:

```typescript
const createOrgUnitBodySchema = z
  .object({
    name: noNulChar(z.string().min(1).max(255)),
    // Required since organizations landed: a root org unit is created only
    // by creating an organization, which owns exactly one. A root with no
    // organization cannot exist, so there is no route that makes one.
    parentId: z.string().uuid(),
  })
  .strict()
```

Then remove the `createRoot` branch from the handler, along with the global-grant check that guarded it, and keep the `createChild` path. `OrgUnitsRepository.createRoot` stays — Task 12 calls it.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @idm/api test -- org-units.controller`
Expected: PASS

- [ ] **Step 5: Fix every test that created a root through the API**

Run: `pnpm --filter @idm/api test`

Tests that built fixtures by POSTing a root must now insert the root directly, or create an organization once Phase 2 exists. Prefer a direct insert in a shared fixture helper over reworking each spec.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(organizations): a root org unit comes only from an organization"
```

---

### Phase 1 gate

- [ ] Run `pnpm verify` and confirm it passes end to end.
- [ ] Confirm the API still boots against a real Keycloak and Postgres, and that people, groups and sync behave exactly as before.

---

# Phase 2 — Realm provisioning

At the end of this phase, creating an organization in the console creates a realm in Keycloak.

---

### Task 8: Provisioning credentials

**Files:**
- Modify: `apps/api/src/config/env.ts`
- Modify: `.env.example`
- Test: `apps/api/test/env.spec.ts` (existing — extend)

**Interfaces:**
- Consumes: nothing
- Produces: `env.keycloakProvisionClientId: string | null`, `env.keycloakProvisionClientSecret: string | null` — both null when unset, never throwing

- [ ] **Step 1: Write the failing test**

```typescript
it('leaves provisioning credentials null when unset, without failing', () => {
  const env = loadEnv({ ...baseEnv })
  expect(env.keycloakProvisionClientId).toBeNull()
  expect(env.keycloakProvisionClientSecret).toBeNull()
})

it('reads provisioning credentials when both are set', () => {
  const env = loadEnv({
    ...baseEnv,
    KEYCLOAK_PROVISION_CLIENT_ID: 'idm-provisioner',
    KEYCLOAK_PROVISION_CLIENT_SECRET: 'secret',
  })
  expect(env.keycloakProvisionClientId).toBe('idm-provisioner')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api test -- env`
Expected: FAIL — property does not exist

- [ ] **Step 3: Add the variables**

In the zod schema:

```typescript
  // A service account in Keycloak's MASTER realm, holding `create-realm`.
  // POST /admin/realms is a server-level endpoint, so the realm-scoped
  // KEYCLOAK_ADMIN_CLIENT_ID above structurally cannot call it.
  //
  // Optional, deliberately: a deployment that never creates organizations
  // needs no such account, and every existing path keeps working without
  // one. POST /organizations returns NOT_CONFIGURED (503) when it is absent
  // rather than accepting a row that can never provision.
  KEYCLOAK_PROVISION_CLIENT_ID: z.string().min(1).optional(),
  KEYCLOAK_PROVISION_CLIENT_SECRET: z.string().min(1).optional(),
```

and in the `Env` interface and its construction:

```typescript
  keycloakProvisionClientId: string | null
  keycloakProvisionClientSecret: string | null
```

```typescript
    keycloakProvisionClientId: parsed.data.KEYCLOAK_PROVISION_CLIENT_ID ?? null,
    keycloakProvisionClientSecret: parsed.data.KEYCLOAK_PROVISION_CLIENT_SECRET ?? null,
```

- [ ] **Step 4: Document them in `.env.example`**

```bash
# A service account in Keycloak's `master` realm holding the `create-realm`
# role. Required only to create organizations; everything else works without
# it. Create it in the master realm, enable "Service accounts roles", then
# grant `create-realm` under Service account roles.
KEYCLOAK_PROVISION_CLIENT_ID=
KEYCLOAK_PROVISION_CLIENT_SECRET=
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @idm/api test -- env`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/config/env.ts apps/api/test/env.spec.ts .env.example
git commit -m "feat(organizations): provisioning credentials for realm creation"
```

---

### Task 9: A Keycloak admin client per realm

**Files:**
- Create: `apps/api/src/keycloak/keycloak-admin-client.factory.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/keycloak-admin-client.factory.spec.ts`

**Interfaces:**
- Consumes: `env` from Task 8
- Produces: `KeycloakAdminClientFactory` with `forRealm(realm: string): KeycloakAdminClient`, `serverRoot(): string`, and `hasProvisioningCredentials(): boolean`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/keycloak-admin-client.factory.spec.ts
describe('KeycloakAdminClientFactory', () => {
  const factory = new KeycloakAdminClientFactory({
    issuer: 'http://kc:8080/realms/identity-manager',
    clientId: 'idm-admin',
    clientSecret: 'a',
    provisionClientId: 'idm-provisioner',
    provisionClientSecret: 'b',
  })

  it('returns the same instance for the same realm', () => {
    expect(factory.forRealm('acme')).toBe(factory.forRealm('acme'))
  })

  it('returns different instances for different realms', () => {
    expect(factory.forRealm('acme')).not.toBe(factory.forRealm('globex'))
  })

  it('reports provisioning as unavailable when credentials are absent', () => {
    const bare = new KeycloakAdminClientFactory({
      issuer: 'http://kc:8080/realms/identity-manager',
      clientId: 'idm-admin',
      clientSecret: 'a',
      provisionClientId: null,
      provisionClientSecret: null,
    })
    expect(bare.hasProvisioningCredentials()).toBe(false)
    expect(() => bare.forRealm('acme')).toThrow(/provisioning credentials/)
  })

  it('serves the master realm from the realm-scoped credential', () => {
    expect(factory.forRealm('identity-manager')).toBe(factory.forRealm('identity-manager'))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api test -- keycloak-admin-client.factory`
Expected: FAIL — cannot resolve the module

- [ ] **Step 3: Write the factory**

```typescript
// apps/api/src/keycloak/keycloak-admin-client.factory.ts
import { Inject, Injectable } from '@nestjs/common'
import { KeycloakAdminClient } from './keycloak-admin.client'

export const KEYCLOAK_FACTORY_CONFIG = Symbol('KEYCLOAK_FACTORY_CONFIG')

export interface KeycloakFactoryConfig {
  /** `<serverRoot>/realms/<realm>` — the master organization's issuer. */
  issuer: string
  clientId: string
  clientSecret: string
  /** Null when this deployment cannot create realms. */
  provisionClientId: string | null
  provisionClientSecret: string | null
  requestTimeoutMs?: number
}

/**
 * One `KeycloakAdminClient` per realm, memoized, so each keeps its own token
 * cache instead of thrashing a shared one.
 *
 * The master realm resolves to the realm-scoped credential this system has
 * always used. Every other realm resolves to the master-realm provisioning
 * credential, because a realm-scoped service account can only administer its
 * own realm.
 */
@Injectable()
export class KeycloakAdminClientFactory {
  private readonly clients = new Map<string, KeycloakAdminClient>()
  private readonly masterRealm: string
  private readonly root: string

  constructor(@Inject(KEYCLOAK_FACTORY_CONFIG) private readonly config: KeycloakFactoryConfig) {
    const url = new URL(config.issuer)
    const match = /^(.*)\/realms\/([^/]+)$/.exec(`${url.origin}${url.pathname}`)
    if (match === null) {
      throw new Error(`issuer must contain /realms/<name>: ${config.issuer}`)
    }
    this.root = match[1]
    this.masterRealm = match[2]
  }

  serverRoot(): string {
    return this.root
  }

  hasProvisioningCredentials(): boolean {
    return this.config.provisionClientId !== null && this.config.provisionClientSecret !== null
  }

  forRealm(realm: string): KeycloakAdminClient {
    const cached = this.clients.get(realm)
    if (cached !== undefined) {
      return cached
    }

    const isMaster = realm === this.masterRealm
    if (!isMaster && !this.hasProvisioningCredentials()) {
      throw new Error(
        `cannot administer realm "${realm}": no provisioning credentials are configured ` +
          '(set KEYCLOAK_PROVISION_CLIENT_ID and KEYCLOAK_PROVISION_CLIENT_SECRET)',
      )
    }

    const client = new KeycloakAdminClient({
      // A master-realm service account authenticates against the MASTER
      // realm's token endpoint, then calls /admin/realms/<realm>/... for
      // whichever realm it is administering.
      issuer: isMaster ? this.config.issuer : `${this.root}/realms/master`,
      clientId: isMaster ? this.config.clientId : (this.config.provisionClientId as string),
      clientSecret: isMaster ? this.config.clientSecret : (this.config.provisionClientSecret as string),
      requestTimeoutMs: this.config.requestTimeoutMs,
    })
    this.clients.set(realm, client)
    return client
  }
}
```

**Note for the implementer:** `KeycloakAdminClient` derives its admin base URL from its issuer, so a non-master client built this way would target `/admin/realms/master`, not the tenant realm. Add an optional `adminRealm` field to `KeycloakAdminClientConfig` that overrides only the realm segment of `adminBaseUrl`, defaulting to the issuer's own realm so every existing construction is unchanged. Pass `adminRealm: realm` here. Confirm with a test asserting `forRealm('acme')` issues requests against `/admin/realms/acme`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @idm/api test -- keycloak-admin-client.factory`
Expected: PASS

- [ ] **Step 5: Wire into `app.module.ts`**

Add a `KEYCLOAK_FACTORY_CONFIG` provider mirroring the existing `KEYCLOAK_ADMIN_CONFIG` factory, plus `KeycloakAdminClientFactory` in `providers`. Leave `KEYCLOAK_ADMIN_CONFIG` and the existing singleton exactly as they are — nothing that uses them changes in this task.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(organizations): a Keycloak admin client per realm"
```

---

### Task 10: The `organization` outbox aggregate

**Files:**
- Modify: `apps/api/src/db/schema/outbox-events.ts`
- Create: `apps/api/src/db/migrations/00NN_outbox_organization_aggregate.sql`
- Test: `apps/api/test/outbox-emission.spec.ts` (existing — extend)

**Interfaces:**
- Consumes: nothing
- Produces: `'organization'` as a valid `outbox_aggregate_type`

- [ ] **Step 1: Write the failing test**

```typescript
it('accepts an organization aggregate', async () => {
  await expect(
    db.insert(outboxEvents).values({
      aggregateType: 'organization',
      aggregateId: crypto.randomUUID(),
      eventType: 'created',
      payload: {},
      target: 'keycloak',
    }),
  ).resolves.toBeDefined()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api test -- outbox-emission`
Expected: FAIL — invalid input value for enum `outbox_aggregate_type`

- [ ] **Step 3: Write the migration, alone in its own file**

```sql
-- apps/api/src/db/migrations/00NN_outbox_organization_aggregate.sql
-- Alone in this migration on purpose. Postgres forbids USING a value added
-- by ALTER TYPE ... ADD VALUE inside the transaction that added it, and
-- drizzle applies every pending migration in one transaction. Nothing here
-- inserts an outbox row, so this is precautionary — see the same reasoning,
-- written out at length, in db/schema/connector-targets.ts.
ALTER TYPE outbox_aggregate_type ADD VALUE 'organization';
```

- [ ] **Step 4: Add the value to the Drizzle enum**

In `outbox-events.ts`, append `'organization'` to the `outboxAggregateType` array.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @idm/api test -- outbox-emission`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db apps/api/test
git commit -m "feat(organizations): organization as an outbox aggregate"
```

---

### Task 11: The organization connector

**Files:**
- Create: `apps/api/src/connectors/organization.connector.ts`
- Test: `apps/api/test/organization.connector.spec.ts` (against a real Keycloak container)

**Interfaces:**
- Consumes: `KeycloakAdminClientFactory` from Task 9
- Produces: `OrganizationConnector` with `ensureRealm(input: { realm: string; displayName: string }): Promise<void>` and `setRealmEnabled(realm: string, enabled: boolean): Promise<void>`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/organization.connector.spec.ts
describe('OrganizationConnector', () => {
  it('creates a realm', async () => {
    await connector.ensureRealm({ realm: 'acme', displayName: 'Acme Corp' })
    const realm = await getRealm(admin, 'acme')
    expect(realm).toMatchObject({ realm: 'acme', enabled: true, displayName: 'Acme Corp' })
  })

  it('is idempotent — creating twice is not an error', async () => {
    await connector.ensureRealm({ realm: 'acme2', displayName: 'Acme Two' })
    await expect(
      connector.ensureRealm({ realm: 'acme2', displayName: 'Acme Two' }),
    ).resolves.toBeUndefined()
  })

  it('disables a realm without deleting it', async () => {
    await connector.ensureRealm({ realm: 'acme3', displayName: 'Acme Three' })
    await connector.setRealmEnabled('acme3', false)
    expect(await getRealm(admin, 'acme3')).toMatchObject({ enabled: false })
  })

  // The design flags Keycloak's auto-grant to a creating service account as
  // UNVERIFIED. This test is what settles it. If it fails, ensureRealm must
  // also grant the provisioning account the `<realm>-realm` composite role.
  it('leaves the provisioning account able to create users in the new realm', async () => {
    await connector.ensureRealm({ realm: 'acme4', displayName: 'Acme Four' })
    const client = factory.forRealm('acme4')
    await expect(
      client.createUser(
        { username: 'probe', email: 'probe@acme4.test', firstName: 'P', lastName: 'R',
          enabled: true, attributes: {} },
        [],
      ),
    ).resolves.toMatchObject({ id: expect.any(String) })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api test -- organization.connector`
Expected: FAIL — cannot resolve the module

- [ ] **Step 3: Write the connector**

```typescript
// apps/api/src/connectors/organization.connector.ts
import { Inject, Injectable } from '@nestjs/common'
import { KeycloakAdminClientFactory } from '../keycloak/keycloak-admin-client.factory'

/**
 * Realm lifecycle — the only place in this system that calls Keycloak's
 * server-level realm endpoints.
 *
 * Not a `DirectoryConnector`: that interface is about users and groups in a
 * realm, and this operates on the realm itself. Keeping it separate leaves
 * that deliberately narrow, settled interface alone.
 */
@Injectable()
export class OrganizationConnector {
  constructor(
    @Inject(KeycloakAdminClientFactory) private readonly factory: KeycloakAdminClientFactory,
  ) {}

  /**
   * Desired state, not a create: returning normally means the realm exists
   * and is enabled. A 409 means another racer got there first, which IS the
   * desired state — the same reasoning as `KeycloakAdminClient.ensureGroup`.
   */
  async ensureRealm(input: { realm: string; displayName: string }): Promise<void> {
    const res = await this.factory
      .forRealm(input.realm)
      .requestServerLevel('POST', '/admin/realms', {
        realm: input.realm,
        displayName: input.displayName,
        enabled: true,
      })

    if (res.status === 409) {
      return
    }
    if (!res.ok) {
      throw new Error(`create realm failed: ${res.status} ${await res.text()}`)
    }
  }

  /** Never a delete. Deleting a realm destroys its users, sessions and clients irreversibly. */
  async setRealmEnabled(realm: string, enabled: boolean): Promise<void> {
    const res = await this.factory
      .forRealm(realm)
      .requestServerLevel('PUT', `/admin/realms/${encodeURIComponent(realm)}`, { realm, enabled })

    if (!res.ok) {
      throw new Error(`set realm enabled failed: ${res.status} ${await res.text()}`)
    }
  }
}
```

`requestServerLevel` does not exist yet. Add it to `KeycloakAdminClient` as a public sibling of the private `request`, taking a path relative to the **server root** rather than `/admin/realms/{realm}`, and reusing the same token handling and 401 retry. Give it a doc comment saying it exists for realm-lifecycle calls only.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @idm/api test -- organization.connector`
Expected: PASS, all four cases

If the fourth case fails, add the role grant to `ensureRealm`: read the provisioning service account's user id in the master realm, then assign the `<realm>-realm` client role. Keep it inside `ensureRealm` so a retry re-asserts it.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(organizations): realm create, enable and disable"
```

---

### Task 12: The organizations API

**Files:**
- Create: `apps/api/src/organizations/organizations.controller.ts`
- Modify: `apps/api/src/organizations/organizations.repository.ts`
- Modify: `apps/api/src/authz/actions.ts`, `apps/api/src/common/errors.ts`, `apps/api/src/common/domain-exception.filter.ts`, `apps/api/src/app.module.ts`
- Test: `apps/api/test/organizations.controller.spec.ts`

**Interfaces:**
- Consumes: `OrgUnitsRepository.createRoot`, `AuditWriter.record`, `OutboxWriter.record`, `KeycloakAdminClientFactory.hasProvisioningCredentials`
- Produces: `POST /organizations`, `GET /organizations`, `PATCH /organizations/:id`; actions `organization:read`, `organization:create`, `organization:update`; `NotConfiguredError` with code `NOT_CONFIGURED`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/organizations.controller.spec.ts
it('creates an organization, its root org unit, an audit row and one outbox event', async () => {
  const response = await post('/organizations', { slug: 'acme', name: 'Acme Corp' })

  expect(response.status).toBe(201)
  expect(response.body).toMatchObject({ slug: 'acme', name: 'Acme Corp', status: 'active' })

  const [root] = await db.select().from(orgUnits)
    .where(and(eq(orgUnits.organizationId, response.body.id), isNull(orgUnits.parentId)))
  expect(root.path).toBe('acme')

  const events = await db.select().from(outboxEvents)
    .where(eq(outboxEvents.aggregateId, response.body.id))
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ aggregateType: 'organization', target: 'keycloak' })
})

it('rejects a reserved slug', async () => {
  expect((await post('/organizations', { slug: 'master', name: 'X' })).status).toBe(409)
})

it('rejects a malformed slug', async () => {
  expect((await post('/organizations', { slug: 'Acme Corp!', name: 'X' })).status).toBe(400)
})

it('rejects a duplicate slug', async () => {
  await post('/organizations', { slug: 'acme', name: 'Acme' })
  expect((await post('/organizations', { slug: 'acme', name: 'Again' })).status).toBe(409)
})

it('returns 503 when no provisioning credential is configured', async () => {
  const response = await postWithoutProvisioning('/organizations', { slug: 'acme', name: 'Acme' })
  expect(response.status).toBe(503)
  expect(response.body.code).toBe('NOT_CONFIGURED')
})

it('refuses to change a slug', async () => {
  const created = await post('/organizations', { slug: 'acme', name: 'Acme' })
  expect((await patch(`/organizations/${created.body.id}`, { slug: 'other' })).status).toBe(400)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api test -- organizations.controller`
Expected: FAIL — 404, no such route

- [ ] **Step 3: Add the error type and its mapping**

In `common/errors.ts`:

```typescript
/** A required piece of deployment configuration is absent — not the caller's fault, and not retryable by them. */
export class NotConfiguredError extends DomainError {
  readonly code = 'NOT_CONFIGURED'
}
```

In `common/domain-exception.filter.ts`, map `NOT_CONFIGURED` to `503`, following the existing code-to-status table.

- [ ] **Step 4: Add the actions**

In `authz/actions.ts`, add `'organization:read' | 'organization:create' | 'organization:update'` to the `Action` union, the same three strings to `ALL_ACTIONS`, `organization:read` to `READ_ONLY_ACTIONS`, and all three to `super_admin` in `ROLE_PERMISSIONS`. Grant none of them to any other role: creating a tenant is a platform-operator act.

- [ ] **Step 5: Write the controller**

```typescript
// apps/api/src/organizations/organizations.controller.ts
const RESERVED_SLUGS = new Set(['master'])

const createOrganizationBodySchema = z
  .object({
    slug: noNulChar(z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/)),
    name: noNulChar(z.string().min(1).max(255)),
  })
  .strict()

const updateOrganizationBodySchema = z
  .object({ status: z.enum(['active', 'suspended']) })
  .strict()   // .strict() is what turns an attempt to PATCH `slug` into a 400

function snapshotOrganization(org: Organization): Record<string, unknown> {
  return { slug: org.slug, name: org.name, realm: org.realm, status: org.status }
}

@Controller('organizations')
@UseGuards(JwtGuard, PermissionGuard)
export class OrganizationsController {
  constructor(
    @Inject(OrganizationsRepository) private readonly organizations: OrganizationsRepository,
    @Inject(OrgUnitsRepository) private readonly orgUnits: OrgUnitsRepository,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
    @Inject(OutboxWriter) private readonly outboxWriter: OutboxWriter,
    @Inject(KeycloakAdminClientFactory) private readonly factory: KeycloakAdminClientFactory,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  @Post()
  @RequirePermission('organization:create')
  async create(
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ): Promise<Organization> {
    const input = parseBody(createOrganizationBodySchema, body)

    // Refuse up front rather than accepting a row that can never provision.
    if (!this.factory.hasProvisioningCredentials()) {
      throw new NotConfiguredError(
        'creating an organization requires KEYCLOAK_PROVISION_CLIENT_ID and ' +
          'KEYCLOAK_PROVISION_CLIENT_SECRET, which are not configured',
      )
    }

    const master = await this.organizations.findMaster()
    if (RESERVED_SLUGS.has(input.slug) || input.slug === master.realm) {
      throw new ConflictError(`the slug "${input.slug}" is reserved`)
    }

    return this.db.transaction(async (tx) => {
      const organization = await this.organizations.create(tx, {
        slug: input.slug, name: input.name, realm: input.slug,
      })
      await this.orgUnits.createRoot(input.name, tx, organization.id)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'organization:create',
        resourceType: 'organization',
        resourceId: organization.id,
        after: snapshotOrganization(organization),
      })
      await this.outboxWriter.record(tx, {
        aggregateType: 'organization',
        aggregateId: organization.id,
        eventType: 'created',
        payload: { slug: organization.slug, realm: organization.realm },
        // Its own id — an organization is its own tenant, so this event
        // takes the Keycloak-only fan-out path Task 13 installs.
        organizationId: organization.id,
      })

      return organization
    })
  }

  @Get()
  @RequirePermission('organization:read')
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: AuthorizedRequest,
  ): Promise<Page<Organization>> {
    // Global grant required: an organization has no containing org unit to
    // narrow to, the same reasoning the audit log and connector routes use.
    await this.engine.assertGlobal(request.actor, 'organization:read')
    const page = parsePageQuery(query)
    const [items, total] = await Promise.all([
      this.organizations.list(page),
      this.organizations.count(),
    ])
    return { items, total, limit: page.limit, offset: page.offset }
  }

  @Patch(':id')
  @RequirePermission('organization:update')
  async update(
    @Param('id') rawId: string,
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ): Promise<Organization> {
    await this.engine.assertGlobal(request.actor, 'organization:update')
    const id = parseId(rawId)
    const input = parseBody(updateOrganizationBodySchema, body)

    return this.db.transaction(async (tx) => {
      const before = await this.organizations.findById(id, tx)
      if (before === null) {
        throw new NotFoundError('organization', id)
      }
      if (before.isMaster) {
        // Suspending master would disable the realm every admin logs in
        // through, including whoever is making this request.
        throw new ConflictError('the master organization cannot be suspended')
      }

      const after = await this.organizations.setStatus(tx, id, input.status)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'organization:update',
        resourceType: 'organization',
        resourceId: id,
        before: snapshotOrganization(before),
        after: snapshotOrganization(after),
      })
      await this.outboxWriter.record(tx, {
        aggregateType: 'organization',
        aggregateId: id,
        eventType: 'status_changed',
        payload: { status: after.status },
        organizationId: id,
      })

      return after
    })
  }
}
```

`OrgUnitsRepository.createRoot` gains a third parameter for the organization id and sets `organizationId` on the insert. `OrganizationsRepository.create` maps a unique-violation on `organizations_slug_unique` to `ConflictError`, following `translateWriteError` in the org-units repository. `assertGlobal` is the existing `PermissionEngine` method the audit and connector routes already use for grants with no containing org unit — check its exact name there before writing this, and use whatever it is.

Add a test for the master case, since it is the one that locks an admin out of their own console:

```typescript
it('refuses to suspend the master organization', async () => {
  const master = await findMasterRow(db)
  expect((await patch(`/organizations/${master.id}`, { status: 'suspended' })).status).toBe(409)
})
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @idm/api test -- organizations.controller`
Expected: PASS, all six cases

- [ ] **Step 7: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(organizations): create, list and suspend organizations"
```

---

### Task 13: Organization-aware fan-out

**Files:**
- Modify: `apps/api/src/outbox/outbox.writer.ts`
- Test: `apps/api/test/outbox-emission.spec.ts` (existing — extend)

**Interfaces:**
- Consumes: `organizations` from Task 1
- Produces: `OutboxEvent` gains `organizationId: string | null`; a non-master organization emits only `keycloak`

- [ ] **Step 1: Write the failing test**

```typescript
it('emits every enabled target for a master user', async () => {
  await enableTargets(db, ['keycloak', 'echo'])
  await writeUserEvent(db, { organizationId: masterId })
  expect(await targetsFor(db, 'user')).toEqual(['echo', 'keycloak'])
})

it('emits keycloak only for a tenant user', async () => {
  await enableTargets(db, ['keycloak', 'echo'])
  await writeUserEvent(db, { organizationId: acmeId })
  expect(await targetsFor(db, 'user')).toEqual(['keycloak'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api test -- outbox-emission`
Expected: FAIL — the tenant case emits both

- [ ] **Step 3: Narrow the fan-out**

```typescript
  async record(tx: DbHandle, event: OutboxEvent): Promise<void> {
    const enabledTargets = await tx
      .select({ target: connectorTargets.target })
      .from(connectorTargets)
      .where(eq(connectorTargets.enabled, true))
      .orderBy(connectorTargets.target)

    if (enabledTargets.length === 0) {
      return
    }

    // Per-organization connector targets do not exist yet, and
    // `connector_targets` is keyed by target alone — one AD configuration,
    // one Entra configuration, for the whole system. Fanning a tenant out to
    // those would push its people into a directory configured for a
    // different tenant. Master keeps today's behaviour exactly.
    const targets = (await this.isMasterOrganization(tx, event.organizationId))
      ? enabledTargets
      : enabledTargets.filter(({ target }) => target === 'keycloak')

    if (targets.length === 0) {
      return
    }

    await tx.insert(outboxEvents).values(
      targets.map(({ target }) => ({
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: event.payload,
        target,
      })),
    )
  }

  /** A null organization is platform-level (nothing tenant-owned) and fans out as master does. */
  private async isMasterOrganization(tx: DbHandle, organizationId: string | null): Promise<boolean> {
    if (organizationId === null) {
      return true
    }
    const [row] = await tx
      .select({ isMaster: organizations.isMaster })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
    return row?.isMaster ?? false
  }
```

The `organizations` read uses the caller's `tx`, never `this.db` — same connection discipline the existing `connector_targets` read observes, and the reason finding C1 exists.

- [ ] **Step 4: Add `organizationId` to every caller**

Run: `grep -rn "outboxWriter.record\|outboxWriter\.record" apps/api/src --include=*.ts`

Each call site is inside a transaction that already holds the row being mutated — pass that row's `organizationId`. For the organization aggregate itself in Task 12, pass the new organization's own id.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @idm/api test -- outbox-emission`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(organizations): tenant organizations fan out to Keycloak only"
```

---

### Task 14: Realm dispatch and unprovisioned deferral

**Files:**
- Modify: `apps/api/src/outbox/sync.worker.ts`
- Test: `apps/api/test/sync.worker.spec.ts` (existing — extend)

**Interfaces:**
- Consumes: `OrganizationConnector` (Task 11), `KeycloakAdminClientFactory` (Task 9)
- Produces: `reconcileOrganization`; a `DeferredError` that reschedules without incrementing `attempts`

- [ ] **Step 1: Write the failing test**

```typescript
it('creates the realm for an organization event', async () => {
  await createOrganizationRow(db, 'acme')
  await worker.runOnce()
  expect(await getRealm(admin, 'acme')).toMatchObject({ realm: 'acme', enabled: true })
})

it('defers a user whose organization has no realm yet, without consuming an attempt', async () => {
  const acme = await createOrganizationRow(db, 'acme', { realmProvisionedAt: null })
  const user = await insertUser(db, { organizationId: acme.id, username: 'jsmith' })
  await writeUserEvent(db, { aggregateId: user.id, organizationId: acme.id })

  await worker.runOnce()

  const [event] = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, user.id))
  expect(event.status).toBe('pending')
  expect(event.attempts).toBe(0)                       // deferred, not failed
  expect(event.lastError).toMatch(/waiting on realm provisioning/)
})

it('converges once the realm lands', async () => {
  // ...same setup, then provision the realm and run again
  await worker.runOnce()
  const [event] = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, user.id))
  expect(event.status).toBe('done')
})

// The design's test 8. A tenant's people must land in the tenant's realm and
// nowhere else — this is the assertion that would catch a factory returning
// the master client for a tenant realm.
it('leaves master untouched when a tenant user syncs', async () => {
  const mastersBefore = await listRealmUsers(admin, masterRealm)

  const acme = await provisionedOrganization(db, 'acme')
  const user = await insertUser(db, { organizationId: acme.id, username: 'jsmith' })
  await writeUserEvent(db, { aggregateId: user.id, organizationId: acme.id })
  await worker.runOnce()

  expect(await listRealmUsers(admin, 'acme')).toContainEqual(
    expect.objectContaining({ username: 'jsmith' }),
  )
  expect(await listRealmUsers(admin, masterRealm)).toEqual(mastersBefore)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api test -- sync.worker`
Expected: FAIL — the organization event dead-letters as an unknown aggregate

- [ ] **Step 3: Add the deferral error**

```typescript
// apps/api/src/outbox/deferred.error.ts
/**
 * Not a failure — a "not yet". The worker reschedules the event with backoff
 * WITHOUT incrementing `attempts`, so waiting on a prerequisite never spends
 * the dead-letter budget. Distinct from a retryable error, which is a real
 * failure that happens to be worth retrying.
 */
export class DeferredError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'DeferredError'
  }
}
```

- [ ] **Step 4: Dispatch the organization aggregate**

In the `switch (event.aggregateType)` block:

```typescript
      case 'organization':
        await this.reconcileOrganization(tx, event.aggregateId)
        break
```

```typescript
  /**
   * Desired state for the realm itself. Re-reads the row rather than
   * replaying the payload, exactly as every other reconcile method does, so
   * a replayed or out-of-order event converges.
   */
  async reconcileOrganization(tx: DbHandle, organizationId: string): Promise<void> {
    const [organization] = await tx
      .select().from(organizations).where(eq(organizations.id, organizationId))
    if (organization === undefined) {
      throw new NotFoundError('organization', organizationId)
    }
    if (organization.realm === null) {
      throw new DeferredError('master realm not yet resolved from KEYCLOAK_ISSUER')
    }

    await this.organizationConnector.ensureRealm({
      realm: organization.realm,
      displayName: organization.name,
    })
    await this.organizationConnector.setRealmEnabled(
      organization.realm,
      organization.status === 'active',
    )

    await tx
      .update(organizations)
      .set({ realmProvisionedAt: new Date() })
      .where(eq(organizations.id, organizationId))
  }
```

- [ ] **Step 5: Defer users in unprovisioned organizations**

At the top of `reconcileUser`, once the user row is loaded and before any connector call:

```typescript
    if (target === 'keycloak') {
      const [organization] = await tx
        .select().from(organizations).where(eq(organizations.id, user.organizationId))
      if (organization?.realmProvisionedAt === null) {
        throw new DeferredError(
          `waiting on realm provisioning for organization ${organization.slug}`,
        )
      }
    }
```

Then route the connector at that realm: resolve `KeycloakConnector` against `factory.forRealm(organization.realm)` rather than the single injected client.

- [ ] **Step 6: Honour `DeferredError` in `runOnce`**

In the catch around the reconcile call, branch before the existing `recordFailure`: on a `DeferredError`, set `status = 'pending'`, `next_attempt_at` to the usual backoff, and `last_error` to the reason, leaving `attempts` untouched. Everything else keeps today's path.

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @idm/api test -- sync.worker`
Expected: PASS, all three cases

- [ ] **Step 8: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(organizations): provision realms and defer users until theirs exists"
```

---

### Task 15: The console

**Files:**
- Create: `apps/web/src/organizations/OrganizationsPage.tsx`, `organizations.api.ts`
- Modify: `apps/web/src/shell/` navigation
- Test: `apps/web/e2e/organizations.spec.ts`

**Interfaces:**
- Consumes: `GET/POST/PATCH /organizations`
- Produces: an Organizations page

- [ ] **Step 1: Write the failing end-to-end test**

```typescript
// apps/web/e2e/organizations.spec.ts
test('creates an organization and shows it provisioning', async ({ page }) => {
  await signInAsAdmin(page)
  await page.getByRole('link', { name: 'Organizations' }).click()
  await page.getByRole('button', { name: 'New organization' }).click()
  await page.getByLabel('Name').fill('Acme Corp')
  await page.getByLabel('Slug').fill('acme')
  await page.getByRole('button', { name: 'Create' }).click()

  const row = page.getByRole('row', { name: /Acme Corp/ })
  await expect(row).toContainText('acme')
  await expect(row).toContainText(/Provisioning|Active/)
})

test('shows a tenant organization as Keycloak-only', async ({ page }) => {
  await signInAsAdmin(page)
  await page.goto('/organizations')
  await expect(page.getByRole('row', { name: /Acme Corp/ })).toContainText('Keycloak only')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/web test:e2e -- organizations`
Expected: FAIL — no Organizations link

- [ ] **Step 3: Build the page**

Follow the existing list-page pattern in `apps/web/src/groups/`: a table of organizations with name, slug, realm, status and sync state; a "New organization" form with Name and Slug, where Slug auto-derives from Name but stays editable; and a suspend/reactivate action per row.

The slug derivation and the sync-state mapping are the two pieces worth pinning down here, because both are easy to get subtly wrong:

```typescript
// apps/web/src/organizations/slug.ts

/**
 * Name → slug, matching the server's `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`.
 * Suggestion only — the field stays editable, and the server validates
 * regardless. Deriving it saves the common case without hiding the value
 * that becomes a permanent realm name.
 */
export function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '')
}
```

```typescript
// apps/web/src/organizations/status.ts
import type { Organization } from './organizations.api'

/** Two independent facts — the org's own status, and whether its realm exists yet. */
export function syncLabel(org: Organization): 'Active' | 'Provisioning' | 'Suspended' {
  if (org.status === 'suspended') return 'Suspended'
  return org.realmProvisionedAt === null ? 'Provisioning' : 'Active'
}
```

Unit-test `slugFromName` directly — `'Acme Corp!'` → `'acme-corp'`, `'  --Acme--  '` → `'acme'`, and a 70-character name truncating to 63 with no trailing hyphen.

Use the existing design-system tokens — no new colours. Show sync state with the same badge component the people list uses, so "Provisioning" reads the same way "Pending" already does.

Render "Keycloak only" against every non-master organization, per the design's decision 5. That restriction must be visible rather than silent.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @idm/web test:e2e -- organizations`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(organizations): console page for creating and suspending organizations"
```

---

### Task 16: Documentation

**Files:**
- Modify: `docs/01-overview.md`, `02-architecture.md`, `03-data-model.md`, `06-configuration.md`, `07-admin-guide.md`, `10-api-reference.md`, `12-security.md`, `14-roadmap.md`

**Interfaces:**
- Consumes: everything above
- Produces: documentation that no longer claims single tenancy

- [ ] **Step 1: Retire the single-tenancy claims**

- `01-overview.md:91` — remove "Not multi-tenant. One organisation per deployment."
- `12-security.md:38` — replace claim 12 with what actually holds now: tenancy is enforced by composite foreign keys, admins are platform operators authenticating against the master realm, and a global role assignment spans every organization.
- `14-roadmap.md:148` — move multi-tenancy out of the non-goals, naming the four deferrals.

- [ ] **Step 2: Document the new shape**

- `03-data-model.md` — the `organizations` table, `organization_id`, the per-organization uniqueness table, and the composite FKs with the reason they exist
- `02-architecture.md` — organization-aware fan-out, and `NOT_CONFIGURED` → 503 in the error table
- `06-configuration.md` — both provisioning variables, and how to create the master-realm service account
- `10-api-reference.md` — the three `/organizations` routes, and that `POST /org-units` now requires `parentId`
- `07-admin-guide.md` — a walkthrough for creating and suspending an organization

- [ ] **Step 3: Verify**

Run: `pnpm verify`
Expected: PASS, including the docs token check

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs: organizations, multi-tenancy and realm provisioning"
```

---

### Phase 2 gate

- [ ] `pnpm verify` passes.
- [ ] Against a real Keycloak: create an organization in the console, confirm the realm appears, add a person to it, and confirm that person appears in **that** realm and not in master's.
- [ ] Suspend it, confirm the realm is disabled and still present.
- [ ] Confirm master's own people and groups are untouched throughout.
