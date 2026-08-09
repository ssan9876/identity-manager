# SSO Application Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an administrator register a downstream OIDC application in the Identity Manager console, mastered in Postgres and asserted into Keycloak as a client through the existing transactional outbox.

**Architecture:** An `sso_apps` row is the system of record. Writes go into one transaction alongside their `audit_log` and `outbox_events` rows. A new `keycloak_sso` connector target — a third connector interface family alongside the user and group families — consumes those events and asserts the full desired `ClientRepresentation` into Keycloak using a second, `manage-clients`-scoped credential. Correlation is on Keycloak's client UUID.

**Tech Stack:** TypeScript, NestJS, Drizzle ORM, Postgres, Zod, Vitest (+ Testcontainers), React + React Router (console), Playwright (e2e).

**Source spec:** `docs/archive/specs/2026-08-08-sso-app-onboarding-design.md` (branch `docs/sso-app-onboarding`, commit `ee86bbb`).

---

## Base Branch Prerequisite

Branch from a commit that contains **both**:

- `7adaed9` — *docs: one authoritative documentation set under docs/*. The spec cites `docs/02`, `docs/05`, `docs/09`, `docs/12` by number. Those numbered files do not exist on `master`; before this commit the tree used `docs/superpowers/`. Every documentation step below assumes the post-reorg layout.
- `414508d` — *fix(web): add mail_server to the console's connector target list*. `apps/web/src/connectors/api.ts` on `master` still carries a five-entry `ALL_CONNECTOR_TARGETS` missing `mail_server`. Task 1 edits that exact array; starting from the stale copy silently reintroduces the drift bug the catalog invariant exists to prevent.

Both are on `feat/business-roles-entitlements` and neither is on `master` as of writing. Verify before starting:

```bash
git merge-base --is-ancestor 7adaed9 HEAD && git merge-base --is-ancestor 414508d HEAD && echo "base OK"
```

If that prints nothing, stop and rebase onto a branch that has them.

---

## Global Constraints

- **No semicolons, single quotes, 2-space indent.** Match the surrounding files; the repo has no formatter enforcing this at commit time.
- **Zod `.strict()` on every request body schema.** An unknown key is a 400 naming that key.
- **Every write handler calls `AuditWriter.record` and `OutboxWriter.record` inside the same `db.transaction` as the mutation** — never a second transaction, never a pooled handle. `DbHandle` accepts only a live transaction handle, so the compiler enforces the first half of this.
- **No connector may read an environment variable not matching `^CONNECTOR_[A-Za-z0-9_]+$`.** Always go through `resolveSecret` (`apps/api/src/connectors/secrets.ts`).
- **No `DELETE` route and no delete method** anywhere in this feature. Disable only.
- **The minted client secret is never persisted.** Not in `sso_apps`, not in `outbox_events.payload`, not in `audit_log.before`/`after`, not in a log line, not in an error message.
- **New pgEnum values may not be used in the same migration transaction that adds them.** See the Migration Rule below — this is not a style preference, it is a Postgres constraint that will fail a fresh-database migrate.
- **Run tests with at most 3 vitest forks:** `pnpm --filter @idm/api test -- --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3`. Testcontainers fills the disk otherwise and reports spurious failures. `minForks` must be set too: this machine has 16 cores, so vitest's default minimum exceeds a max of 3 and tinypool aborts the run with `options.minThreads and options.maxThreads must not conflict` before a single test executes. Do NOT also pass `--pool=forks`.

### Migration Rule (correction to the spec)

The spec's "Migration order" section says the enum values land in one migration and the `connector_targets` seed row in **a separate one**. **Do not do this.** Every pending migration runs in ONE transaction on a fresh database, so a later migration file is still the same transaction as the `ALTER TYPE`. Migration `0017_youthful_cyclops.sql` records this in its own header comment and is the tested precedent:

> Postgres forbids USING a value added by ALTER TYPE ... ADD VALUE within the transaction that added it, and every pending migration runs in ONE transaction on a fresh database. So no migration may INSERT a connector_targets row keyed 'mail_server' — that row is created at runtime.

**Therefore: no migration inserts a `connector_targets` row for `keycloak_sso` at all.** That row is created at runtime by an admin through `PATCH /connector-targets/keycloak_sso`, or directly by a test — exactly as `mail_server`, `active_directory`, `entra_id` and `google_workspace` already are. Creating the type `sso_app_protocol` and creating tables that use it in one migration is fine; `CREATE TYPE` carries no such restriction.

### Directory-Target Narrowing (addition beyond the spec)

The spec establishes that outbox fan-out must become aggregate-aware. Studying the consumers shows the same principle applies to five more places that enumerate `ALL_CONNECTOR_TARGETS`, because `keycloak_sso` carries applications, not people:

| Consumer | Correct list |
|---|---|
| `attributes/attribute-target-mappings.controller.ts:25` | `DIRECTORY_TARGETS` — an application has no user attributes to map |
| `outbox/target-reconcile-cli.ts:22` | `DIRECTORY_TARGETS` — reconcile pushes every *user* to a target |
| `web/src/connectors/AttributeMappingsEditor.tsx` | `DIRECTORY_TARGETS` — same reason |
| `outbox/outbox.controller.ts:18` (dead-letter filter) | `ALL_CONNECTOR_TARGETS` — an `sso_app` event *can* dead-letter |
| `connectors/connector-targets.controller.ts` (list/detail) | `ALL_CONNECTOR_TARGETS` — `keycloak_sso` is configurable and disable-able like any target |

Task 1 introduces `DIRECTORY_TARGETS` and applies it. Without this, the console offers attribute mappings for a target with no users and `pnpm target-reconcile keycloak_sso` walks every user against a connector that cannot accept one.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `apps/api/src/db/schema/sso-apps.ts` | `sso_app_protocol` pgEnum, `sso_apps` table |
| `apps/api/src/db/schema/external-sso-app-identities.ts` | Correlation table, mirrors `external-group-identities.ts` |
| `apps/api/src/sso-apps/sso-apps.repository.ts` | All `sso_apps` reads/writes |
| `apps/api/src/sso-apps/sso-app-validation.ts` | Pure guards: redirect URIs, web origins, reserved client ids |
| `apps/api/src/sso-apps/sso-apps.controller.ts` | The seven routes |
| `apps/api/src/connectors/keycloak-sso.connector.ts` | `SsoConnector` implementation |
| `apps/api/src/outbox/target-fanout.ts` | `targetsForAggregate` — the single source of truth for fan-out |
| `apps/web/src/sso-apps/*` | Console Applications section |

**Modified:** `connectors/connector.ts` (catalogs + `SsoConnector` types), `connectors/connector-registry.ts` (third family + `healthFor`), `keycloak/keycloak-admin.client.ts` (client CRUD), `outbox/outbox.writer.ts` (fan-out), `outbox/sync.worker.ts` (dispatch), `authz/actions.ts`, `db/schema/{outbox-events,external-identities,index}.ts`, `app.module.ts`, `scripts/keycloak-setup.sh`, `.env.example`, `docs/*`.

---

## Task 1: Widen the target and aggregate catalogs

Adds the `keycloak_sso` target name and the `sso_app` aggregate name everywhere they must exist consistently, and splits the directory-only surfaces onto a narrower list. No tables, no connector, no routes yet — this task's whole deliverable is that the catalogs agree and the suite proves it.

**Files:**
- Modify: `apps/api/src/connectors/connector.ts:36-45`
- Modify: `apps/api/src/db/schema/outbox-events.ts` (`outboxAggregateType`, `outboxTarget`)
- Modify: `apps/api/src/db/schema/external-identities.ts` (`externalIdentitySystem`)
- Modify: `apps/api/src/outbox/outbox.writer.ts` (`OutboxAggregateType`)
- Modify: `apps/api/src/attributes/attribute-target-mappings.controller.ts:25`
- Modify: `apps/api/src/outbox/target-reconcile-cli.ts:22`
- Modify: `apps/web/src/connectors/api.ts`
- Modify: `apps/web/src/connectors/AttributeMappingsEditor.tsx`
- Create: `apps/api/src/db/migrations/0022_sso_app_catalog.sql`
- Test: `apps/api/test/connector-target-catalog.spec.ts`

**Interfaces:**
- Produces: `ALL_CONNECTOR_TARGETS` (now 7 entries, adds `'keycloak_sso'`), `DIRECTORY_TARGETS: readonly ConnectorTarget[]` (the 6 that carry users), `type ConnectorTarget`, `type DirectoryTarget`. `OutboxAggregateType` gains `'sso_app'`.

- [ ] **Step 1: Write the failing catalog assertions**

Append to `apps/api/test/connector-target-catalog.spec.ts`, inside the existing `describe('connector target catalog', ...)`:

```ts
  it('includes keycloak_sso — the SSO application target', () => {
    expect(ALL_CONNECTOR_TARGETS).toContain('keycloak_sso')
  })

  it('DIRECTORY_TARGETS is every target that carries users — i.e. all but keycloak_sso', () => {
    // keycloak_sso carries APPLICATIONS. Attribute mappings and the
    // per-target reconcile CLI both walk users, so they must iterate this
    // list, never the full catalog.
    expect([...DIRECTORY_TARGETS].sort()).toEqual(
      [...ALL_CONNECTOR_TARGETS].filter((t) => t !== 'keycloak_sso').sort(),
    )
  })

  it('every target is classified — DIRECTORY_TARGETS plus keycloak_sso covers the catalog', () => {
    // Fails when a future target is added to ALL_CONNECTOR_TARGETS and
    // nobody decided whether it carries users.
    const classified = new Set<string>([...DIRECTORY_TARGETS, 'keycloak_sso'])
    expect([...classified].sort()).toEqual([...ALL_CONNECTOR_TARGETS].sort())
  })
```

Add a second `describe` block in the same file:

```ts
describe('outbox aggregate catalog', () => {
  it('matches the outbox_aggregate_type pgEnum exactly, in both directions', () => {
    expect([...ALL_OUTBOX_AGGREGATE_TYPES].sort()).toEqual([...outboxAggregateType.enumValues].sort())
  })

  it('includes sso_app', () => {
    expect(ALL_OUTBOX_AGGREGATE_TYPES).toContain('sso_app')
  })
})
```

Update the file's imports:

```ts
import { ALL_CONNECTOR_TARGETS, DIRECTORY_TARGETS } from '../src/connectors/connector'
import { externalIdentitySystem } from '../src/db/schema/external-identities'
import { outboxAggregateType, outboxTarget } from '../src/db/schema/outbox-events'
import { ALL_OUTBOX_AGGREGATE_TYPES } from '../src/outbox/outbox.writer'
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @idm/api test -- --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3 connector-target-catalog`
Expected: FAIL — `DIRECTORY_TARGETS` and `ALL_OUTBOX_AGGREGATE_TYPES` are not exported.

- [ ] **Step 3: Widen the TypeScript catalogs**

In `apps/api/src/connectors/connector.ts`, extend the array and add the narrowed list directly below `ConnectorTarget`:

```ts
export const ALL_CONNECTOR_TARGETS = [
  'keycloak',
  'active_directory',
  'entra_id',
  'google_workspace',
  'echo',
  'mail_server',
  'keycloak_sso',
] as const

export type ConnectorTarget = (typeof ALL_CONNECTOR_TARGETS)[number]

// Targets that carry USERS. `keycloak_sso` carries applications: it has no
// user attributes to map and no principals to reconcile, so the attribute
// mapping editor and the per-target reconcile CLI iterate this list rather
// than the full catalog. Kept as a filter of ALL_CONNECTOR_TARGETS — not a
// second hand-written literal — so a target added to the catalog and
// forgotten here is impossible; the classification test in
// test/connector-target-catalog.spec.ts asserts the split stays total.
export const DIRECTORY_TARGETS = ALL_CONNECTOR_TARGETS.filter(
  (target): target is Exclude<ConnectorTarget, 'keycloak_sso'> => target !== 'keycloak_sso',
)

export type DirectoryTarget = (typeof DIRECTORY_TARGETS)[number]
```

In `apps/api/src/outbox/outbox.writer.ts`, replace the hand-rolled aggregate union with a catalog plus derived type:

```ts
export const ALL_OUTBOX_AGGREGATE_TYPES = ['user', 'group', 'membership', 'org_unit', 'sso_app'] as const

export type OutboxAggregateType = (typeof ALL_OUTBOX_AGGREGATE_TYPES)[number]
```

- [ ] **Step 4: Widen the pgEnums**

`apps/api/src/db/schema/outbox-events.ts`:

```ts
export const outboxAggregateType = pgEnum('outbox_aggregate_type', [
  'user',
  'group',
  'membership',
  'org_unit',
  'sso_app',
])
```

and add `'keycloak_sso'` as the last entry of `outboxTarget`. In `apps/api/src/db/schema/external-identities.ts`, add `'keycloak_sso'` as the last entry of `externalIdentitySystem`.

- [ ] **Step 5: Write the migration**

Create `apps/api/src/db/migrations/0022_sso_app_catalog.sql`:

```sql
-- Postgres forbids USING a value added by ALTER TYPE ... ADD VALUE within the
-- transaction that added it, and every pending migration runs in ONE
-- transaction on a fresh database. So no migration -- not this one and not a
-- later one -- may INSERT a connector_targets row keyed 'keycloak_sso'. That
-- row is created at runtime through PATCH /connector-targets/keycloak_sso, or
-- directly by a test, exactly as every other non-keycloak target already is.
-- See migration 0017 and outbox-events.ts's outboxTarget doc comment.
ALTER TYPE "public"."outbox_target" ADD VALUE 'keycloak_sso';--> statement-breakpoint
ALTER TYPE "public"."external_identity_system" ADD VALUE 'keycloak_sso';--> statement-breakpoint
ALTER TYPE "public"."outbox_aggregate_type" ADD VALUE 'sso_app';
```

Regenerate the drizzle snapshot so `meta/` stays consistent: `pnpm --filter @idm/api db:generate`. If drizzle-kit emits its own duplicate migration for the same enum change, delete the generated `.sql` and keep the hand-written one, but **keep** the regenerated `meta/0022_snapshot.json`.

- [ ] **Step 6: Narrow the directory-only consumers**

`apps/api/src/attributes/attribute-target-mappings.controller.ts` — change the import and the schema:

```ts
import { DIRECTORY_TARGETS } from '../connectors/connector'
// ...
const connectorTargetSchema = z.enum(DIRECTORY_TARGETS)
```

`apps/api/src/outbox/target-reconcile-cli.ts`:

```ts
import { DIRECTORY_TARGETS, type ConnectorTarget } from '../connectors/connector'
// ...
// Reconcile walks every USER against one target, so an application-only
// target is not a valid argument here.
const KNOWN_TARGETS: readonly ConnectorTarget[] = DIRECTORY_TARGETS
```

- [ ] **Step 7: Update the console catalog**

`apps/web/src/connectors/api.ts` — add the target to the union, the array and the label map:

```ts
export type ConnectorTarget =
  | 'keycloak'
  | 'active_directory'
  | 'entra_id'
  | 'google_workspace'
  | 'echo'
  | 'mail_server'
  | 'keycloak_sso'

export const ALL_CONNECTOR_TARGETS: readonly ConnectorTarget[] = [
  'keycloak',
  'active_directory',
  'entra_id',
  'google_workspace',
  'echo',
  'mail_server',
  'keycloak_sso',
]

// Attribute mappings apply to targets that carry users. Mirrors
// DIRECTORY_TARGETS in apps/api/src/connectors/connector.ts.
export const DIRECTORY_TARGETS: readonly ConnectorTarget[] = ALL_CONNECTOR_TARGETS.filter(
  (target) => target !== 'keycloak_sso',
)

export const CONNECTOR_TARGET_LABEL: Record<ConnectorTarget, string> = {
  keycloak: 'Keycloak',
  active_directory: 'Active Directory',
  entra_id: 'Entra ID',
  google_workspace: 'Google Workspace',
  echo: 'Echo (in-repo test target)',
  mail_server: 'Mail server',
  keycloak_sso: 'Keycloak (SSO applications)',
}
```

In `apps/web/src/connectors/AttributeMappingsEditor.tsx`, change both `ALL_CONNECTOR_TARGETS` iterations (around lines 187 and 201) to `DIRECTORY_TARGETS`, and update the import on line 7.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm --filter @idm/api test -- --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3 connector-target-catalog`
Expected: PASS.

Then the full API suite and both typechecks:

```bash
pnpm --filter @idm/api test -- --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3
pnpm typecheck
```

Expected: PASS. `attribute-target-mappings.controller.spec.ts` may assert on the target list in an error message — if it fails, update the expected string to the narrowed list; that is the correct new behaviour, not a regression.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/connectors/connector.ts apps/api/src/db/schema apps/api/src/db/migrations \
        apps/api/src/outbox/outbox.writer.ts apps/api/src/outbox/target-reconcile-cli.ts \
        apps/api/src/attributes/attribute-target-mappings.controller.ts \
        apps/web/src/connectors/api.ts apps/web/src/connectors/AttributeMappingsEditor.tsx \
        apps/api/test/connector-target-catalog.spec.ts
git commit -m "feat(sso-apps): the keycloak_sso target and the sso_app aggregate"
```

---

## Task 2: The `sso_apps` and `external_sso_app_identities` tables

**Files:**
- Create: `apps/api/src/db/schema/sso-apps.ts`
- Create: `apps/api/src/db/schema/external-sso-app-identities.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Create: `apps/api/src/db/migrations/0023_sso_apps_tables.sql`
- Create: `apps/api/src/sso-apps/sso-apps.repository.ts`
- Test: `apps/api/test/sso-apps.repository.spec.ts`

**Interfaces:**
- Consumes: `externalIdentitySyncState`, `externalIdentitySystem` (Task 1).
- Produces: `ssoApps`, `ssoAppProtocol`, `externalSsoAppIdentities` tables; `SsoAppsRepository` with `create(input, tx)`, `findById(id, tx?)`, `findByClientId(clientId, tx?)`, `list(tx?)`, `update(id, patch, tx)`, `setEnabled(id, enabled, tx)`, `findExternalId(appId, tx?)`; `interface SsoApp` and `interface SsoAppInput`.

- [ ] **Step 1: Write the failing repository test**

Create `apps/api/test/sso-apps.repository.spec.ts`. Copy the container/harness bootstrap from `apps/api/test/groups.repository.spec.ts` verbatim — same `beforeAll`, same migration run, same cleanup — then:

```ts
describe('SsoAppsRepository', () => {
  it('creates an application and reads it back', async () => {
    const created = await db.transaction((tx) =>
      repo.create(
        {
          clientId: 'billing-portal',
          name: 'Billing Portal',
          description: 'Customer billing self-service',
          protocol: 'openid-connect',
          publicClient: false,
          redirectUris: ['https://billing.example.com/callback'],
          webOrigins: ['https://billing.example.com'],
          groupsClaim: true,
        },
        tx,
      ),
    )

    expect(created.clientId).toBe('billing-portal')
    expect(created.enabled).toBe(true)
    expect(created.redirectUris).toEqual(['https://billing.example.com/callback'])

    const found = await repo.findById(created.id)
    expect(found?.name).toBe('Billing Portal')
  })

  it('rejects a duplicate client_id at the database level', async () => {
    const input = {
      clientId: 'duplicate-app',
      name: 'First',
      description: '',
      protocol: 'openid-connect' as const,
      publicClient: true,
      redirectUris: ['https://a.example.com/cb'],
      webOrigins: ['https://a.example.com'],
      groupsClaim: true,
    }
    await db.transaction((tx) => repo.create(input, tx))

    await expect(
      db.transaction((tx) => repo.create({ ...input, name: 'Second' }, tx)),
    ).rejects.toThrow()
  })

  it('setEnabled flips enabled without touching anything else', async () => {
    const created = await db.transaction((tx) =>
      repo.create(
        {
          clientId: 'toggle-app',
          name: 'Toggle',
          description: 'd',
          protocol: 'openid-connect',
          publicClient: false,
          redirectUris: ['https://t.example.com/cb'],
          webOrigins: [],
          groupsClaim: false,
        },
        tx,
      ),
    )

    await db.transaction((tx) => repo.setEnabled(created.id, false, tx))

    const found = await repo.findById(created.id)
    expect(found?.enabled).toBe(false)
    expect(found?.name).toBe('Toggle')
    expect(found?.redirectUris).toEqual(['https://t.example.com/cb'])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @idm/api test -- --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3 sso-apps.repository`
Expected: FAIL — cannot resolve `../src/sso-apps/sso-apps.repository`.

- [ ] **Step 3: Write the schema**

Create `apps/api/src/db/schema/sso-apps.ts`:

```ts
import { boolean, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

// One value today. The discriminator exists from day one so adding SAML
// later widens this enum rather than reshaping the table.
export const ssoAppProtocol = pgEnum('sso_app_protocol', ['openid-connect'])

export const ssoApps = pgTable(
  'sso_apps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Immutable after create: downstream applications hard-code it in their
    // own configuration. Settable on create, absent from PATCH.
    clientId: text('client_id').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    protocol: ssoAppProtocol('protocol').notNull().default('openid-connect'),
    publicClient: boolean('public_client').notNull(),
    redirectUris: text('redirect_uris').array().notNull(),
    webOrigins: text('web_origins').array().notNull(),
    groupsClaim: boolean('groups_claim').notNull().default(true),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    clientIdUnique: uniqueIndex('sso_apps_client_id_unique').on(table.clientId),
  }),
)
```

Create `apps/api/src/db/schema/external-sso-app-identities.ts`:

```ts
import { pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core'
import { externalIdentitySyncState, externalIdentitySystem } from './external-identities'
import { ssoApps } from './sso-apps'

// Mirrors external_group_identities. `externalId` is the immutable UUID
// Keycloak assigns a client, NEVER `clientId` — a Keycloak admin can rename
// clientId directly, and correlating on it would turn that rename into an
// orphaned client plus a second, empty one on the next sync.
export const externalSsoAppIdentities = pgTable(
  'external_sso_app_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: uuid('app_id')
      .notNull()
      .references(() => ssoApps.id, { onDelete: 'cascade' }),
    system: externalIdentitySystem('system').notNull(),
    externalId: varchar('external_id', { length: 255 }).notNull(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    syncState: externalIdentitySyncState('sync_state').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    appSystemUnique: uniqueIndex('external_sso_app_identities_app_system_unique').on(
      table.appId,
      table.system,
    ),
  }),
)
```

Add both to the barrel `apps/api/src/db/schema/index.ts`, keeping alphabetical order:

```ts
export * from './external-sso-app-identities'
export * from './sso-apps'
```

- [ ] **Step 4: Write the migration**

Create `apps/api/src/db/migrations/0023_sso_apps_tables.sql`. `CREATE TYPE` carries no same-transaction restriction, so the type and the tables that use it may live in one file — unlike the `ALTER TYPE ... ADD VALUE` statements in 0022.

```sql
DO $$ BEGIN
 CREATE TYPE "public"."sso_app_protocol" AS ENUM('openid-connect');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sso_apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"protocol" "sso_app_protocol" DEFAULT 'openid-connect' NOT NULL,
	"public_client" boolean NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"web_origins" text[] NOT NULL,
	"groups_claim" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sso_apps_client_id_unique" ON "sso_apps" USING btree ("client_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "external_sso_app_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"system" "external_identity_system" NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"last_synced_at" timestamp with time zone,
	"sync_state" "external_identity_sync_state" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "external_sso_app_identities" ADD CONSTRAINT "external_sso_app_identities_app_id_sso_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."sso_apps"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "external_sso_app_identities_app_system_unique" ON "external_sso_app_identities" USING btree ("app_id","system");
```

- [ ] **Step 5: Write the repository**

Create `apps/api/src/sso-apps/sso-apps.repository.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import * as schema from '../db/schema/index'
import { externalSsoAppIdentities } from '../db/schema/external-sso-app-identities'
import { ssoApps } from '../db/schema/sso-apps'
import type { DbHandle } from '../outbox/outbox.writer'

export interface SsoApp {
  id: string
  clientId: string
  name: string
  description: string
  protocol: 'openid-connect'
  publicClient: boolean
  redirectUris: string[]
  webOrigins: string[]
  groupsClaim: boolean
  enabled: boolean
  createdAt: Date
  updatedAt: Date
}

export interface SsoAppInput {
  clientId: string
  name: string
  description: string
  protocol: 'openid-connect'
  publicClient: boolean
  redirectUris: string[]
  webOrigins: string[]
  groupsClaim: boolean
}

// No `clientId` and no `enabled`: clientId is immutable after create, and
// enable/disable are their own audited verb routes.
export type SsoAppPatch = Partial<Omit<SsoAppInput, 'clientId' | 'protocol'>>

@Injectable()
export class SsoAppsRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>) {}

  async create(input: SsoAppInput, tx: DbHandle): Promise<SsoApp> {
    const [row] = await tx.insert(ssoApps).values(input).returning()
    return row as SsoApp
  }

  async findById(id: string, tx?: DbHandle): Promise<SsoApp | null> {
    const handle = tx ?? this.db
    const [row] = await handle.select().from(ssoApps).where(eq(ssoApps.id, id)).limit(1)
    return (row as SsoApp | undefined) ?? null
  }

  async findByClientId(clientId: string, tx?: DbHandle): Promise<SsoApp | null> {
    const handle = tx ?? this.db
    const [row] = await handle.select().from(ssoApps).where(eq(ssoApps.clientId, clientId)).limit(1)
    return (row as SsoApp | undefined) ?? null
  }

  async list(tx?: DbHandle): Promise<SsoApp[]> {
    const handle = tx ?? this.db
    return (await handle.select().from(ssoApps).orderBy(ssoApps.clientId)) as SsoApp[]
  }

  async update(id: string, patch: SsoAppPatch, tx: DbHandle): Promise<SsoApp> {
    const [row] = await tx
      .update(ssoApps)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(ssoApps.id, id))
      .returning()
    return row as SsoApp
  }

  async setEnabled(id: string, enabled: boolean, tx: DbHandle): Promise<SsoApp> {
    const [row] = await tx
      .update(ssoApps)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(ssoApps.id, id))
      .returning()
    return row as SsoApp
  }

  /** The Keycloak client UUID, or null before the first successful sync. */
  async findExternalId(appId: string, tx?: DbHandle): Promise<string | null> {
    const handle = tx ?? this.db
    const [row] = await handle
      .select({ externalId: externalSsoAppIdentities.externalId })
      .from(externalSsoAppIdentities)
      .where(eq(externalSsoAppIdentities.appId, appId))
      .limit(1)
    return row?.externalId ?? null
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @idm/api test -- --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3 sso-apps.repository`
Expected: PASS, 3 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/schema apps/api/src/db/migrations apps/api/src/sso-apps apps/api/test/sso-apps.repository.spec.ts
git commit -m "feat(sso-apps): the sso_apps table and its Keycloak correlation table"
```

---

## Task 3: Validation rails

Pure functions with no dependencies, fully tested before anything calls them. This is where the security posture of the whole feature lives.

**Files:**
- Create: `apps/api/src/sso-apps/sso-app-validation.ts`
- Test: `apps/api/test/sso-app-validation.spec.ts`

**Interfaces:**
- Produces: `RESERVED_CLIENT_IDS: readonly string[]`, `redirectUriProblem(uri: string): string | null`, `webOriginProblem(origin: string): string | null`, `clientIdProblem(clientId: string): string | null`. Each returns `null` when the value is acceptable and a human-readable reason when it is not — callers collect the non-null results into one `ValidationError`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/sso-app-validation.spec.ts`:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RESERVED_CLIENT_IDS,
  clientIdProblem,
  redirectUriProblem,
  webOriginProblem,
} from '../src/sso-apps/sso-app-validation'

describe('redirect URI rails', () => {
  // An over-broad redirect URI is a token-theft primitive. Keycloak's own
  // admin console accepts every one of the rejected cases without complaint;
  // refusing them is the point of moving this into a reviewed system.
  it.each([
    ['*', 'a bare wildcard'],
    ['https://*', 'a wildcard host'],
    ['https://*.example.com/cb', 'a wildcard in the host'],
    ['http*://app.example.com/cb', 'a wildcard in the scheme'],
    ['not-a-url', 'an unparseable value'],
    ['javascript:alert(1)', 'a non-http scheme'],
  ])('rejects %s (%s)', (uri) => {
    expect(redirectUriProblem(uri)).not.toBeNull()
  })

  it.each([
    'https://app.example.com/callback',
    'https://app.example.com/*',
    'https://app.example.com/auth/*/done',
    'http://localhost:3000/callback',
  ])('accepts %s', (uri) => {
    expect(redirectUriProblem(uri)).toBeNull()
  })
})

describe('web origin rails', () => {
  it('accepts + — Keycloak’s "same as redirect URIs" marker', () => {
    expect(webOriginProblem('+')).toBeNull()
  })

  it('rejects * — the permit-everything marker', () => {
    expect(webOriginProblem('*')).not.toBeNull()
  })

  it('accepts a bare scheme+host origin', () => {
    expect(webOriginProblem('https://app.example.com')).toBeNull()
  })

  it('rejects an origin carrying a path', () => {
    expect(webOriginProblem('https://app.example.com/callback')).not.toBeNull()
  })
})

describe('reserved client ids', () => {
  it.each([...RESERVED_CLIENT_IDS])('rejects %s', (clientId) => {
    expect(clientIdProblem(clientId)).not.toBeNull()
  })

  it('rejects case variations — Keycloak clientId matching is not case-safe to rely on', () => {
    expect(clientIdProblem('IDM-Console')).not.toBeNull()
  })

  it('accepts an ordinary application id', () => {
    expect(clientIdProblem('billing-portal')).toBeNull()
  })

  // The static source scan. `manage-clients` is realm-wide and cannot be
  // scoped to "clients this principal created", so this denylist is the only
  // thing standing between a compromised idm-sso-admin credential and
  // rewriting idm-console's own redirectUris. It is an application-level
  // guard and strictly weaker than a structural boundary — this test at
  // least proves the list still names every client keycloak-setup.sh creates.
  it('names every client keycloak-setup.sh creates', () => {
    const setup = readFileSync(join(__dirname, '../../../scripts/keycloak-setup.sh'), 'utf8')
    const created = [...setup.matchAll(/upsert_client\s+([a-z0-9-]+)/g)].map((m) => m[1])

    expect(created.length).toBeGreaterThan(0)
    for (const clientId of created) {
      expect(RESERVED_CLIENT_IDS).toContain(clientId)
    }
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @idm/api test -- --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3 sso-app-validation`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/sso-apps/sso-app-validation.ts`:

```ts
/**
 * The rails that make an over-broad OIDC client unrepresentable through this
 * API. Pure functions, no dependencies — every one returns `null` for an
 * acceptable value and a human-readable reason otherwise, so a caller can
 * collect several problems into one ValidationError rather than failing on
 * the first.
 */

/**
 * Clients this system depends on for its own security. `manage-clients` in
 * Keycloak is realm-wide and does not scope to "clients this principal
 * created", so nothing in Keycloak stops idm-sso-admin from rewriting
 * idm-console's redirectUris and harvesting authorization codes for the admin
 * console itself. This denylist is the mitigation, and it is an
 * application-level guard on an application-level credential: strictly weaker
 * than the runtime database role that cannot violate append-only no matter
 * what code runs. Documented as an open risk in docs/12, not a solved problem.
 */
export const RESERVED_CLIENT_IDS: readonly string[] = [
  'idm-console',
  'idm-api',
  'idm-sync-service',
  'idm-sso-admin',
  'realm-management',
  'account',
  'account-console',
  'security-admin-console',
  'broker',
]

const WILDCARD = '*'

export function clientIdProblem(clientId: string): string | null {
  if (clientId.trim().length === 0) {
    return 'clientId: must not be empty'
  }
  if (RESERVED_CLIENT_IDS.some((reserved) => reserved.toLowerCase() === clientId.toLowerCase())) {
    return `clientId: "${clientId}" is reserved — it names a client this system depends on for its own security`
  }
  return null
}

export function redirectUriProblem(uri: string): string | null {
  if (uri === WILDCARD) {
    return 'redirectUris: a bare "*" permits redirection to any host — reject'
  }

  let parsed: URL
  try {
    // Parse with the wildcards still present. A wildcard in the path survives
    // URL parsing; one in the scheme or host does not produce a parseable URL
    // with a clean host, which is exactly the distinction we want.
    parsed = new URL(uri)
  } catch {
    return `redirectUris: "${uri}" is not a valid absolute URL`
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `redirectUris: "${uri}" must use http or https`
  }

  if (parsed.host.includes(WILDCARD)) {
    return `redirectUris: "${uri}" contains a wildcard in the host — wildcards are permitted only in the path`
  }

  // The scheme is already constrained to http/https above, so a wildcard
  // cannot survive there; this catches the pre-parse form (http*://…), which
  // URL parsing would otherwise reject as unparseable with a vaguer message.
  const schemeEnd = uri.indexOf('://')
  if (schemeEnd > 0 && uri.slice(0, schemeEnd).includes(WILDCARD)) {
    return `redirectUris: "${uri}" contains a wildcard in the scheme`
  }

  return null
}

export function webOriginProblem(origin: string): string | null {
  // Keycloak's marker for "the origins implied by the redirect URIs". Safe,
  // because it derives from values this module has already vetted.
  if (origin === '+') {
    return null
  }
  if (origin === WILDCARD) {
    return 'webOrigins: a bare "*" permits any origin to read responses — reject'
  }

  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return `webOrigins: "${origin}" is not a valid origin`
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `webOrigins: "${origin}" must use http or https`
  }
  if (parsed.host.includes(WILDCARD)) {
    return `webOrigins: "${origin}" contains a wildcard in the host`
  }
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    return `webOrigins: "${origin}" must be a bare scheme and host with no path`
  }

  return null
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @idm/api test -- --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3 sso-app-validation`
Expected: PASS. The source-scan test will fail until Task 10 adds `upsert_client idm-sso-admin` to `keycloak-setup.sh` **only if** `idm-sso-admin` were missing from `RESERVED_CLIENT_IDS` — it is already listed, so the scan passes now and keeps passing after Task 10.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/sso-apps/sso-app-validation.ts apps/api/test/sso-app-validation.spec.ts
git commit -m "feat(sso-apps): reject wildcard redirect URIs and reserved client ids"
```

---

## Task 4: Aggregate-aware outbox fan-out

**Files:**
- Create: `apps/api/src/outbox/target-fanout.ts`
- Modify: `apps/api/src/outbox/outbox.writer.ts` (the `record` method)
- Test: `apps/api/test/target-fanout.spec.ts`

**Interfaces:**
- Consumes: `OutboxAggregateType`, `ALL_OUTBOX_AGGREGATE_TYPES` (Task 1); `ConnectorTarget`, `ALL_CONNECTOR_TARGETS` (Task 1).
- Produces: `targetsForAggregate(aggregateType: OutboxAggregateType, enabledTargets: readonly ConnectorTarget[]): ConnectorTarget[]`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/target-fanout.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ALL_CONNECTOR_TARGETS } from '../src/connectors/connector'
import { ALL_OUTBOX_AGGREGATE_TYPES } from '../src/outbox/outbox.writer'
import { targetsForAggregate } from '../src/outbox/target-fanout'

const EVERY_TARGET = [...ALL_CONNECTOR_TARGETS]

describe('targetsForAggregate', () => {
  it('sends an sso_app event to keycloak_sso and nowhere else', () => {
    // Active Directory, Entra and Google have no concept of an application.
    // Handing them one would dead-letter at best.
    expect(targetsForAggregate('sso_app', EVERY_TARGET)).toEqual(['keycloak_sso'])
  })

  it.each(['user', 'group', 'membership', 'org_unit'] as const)(
    'never sends a %s event to keycloak_sso',
    (aggregateType) => {
      expect(targetsForAggregate(aggregateType, EVERY_TARGET)).not.toContain('keycloak_sso')
    },
  )

  it('leaves the directory fan-out otherwise unchanged', () => {
    expect(targetsForAggregate('user', EVERY_TARGET)).toEqual(
      EVERY_TARGET.filter((t) => t !== 'keycloak_sso'),
    )
  })

  it('respects the enabled list — a disabled target gets nothing', () => {
    expect(targetsForAggregate('user', ['keycloak'])).toEqual(['keycloak'])
    expect(targetsForAggregate('sso_app', ['keycloak'])).toEqual([])
  })

  it('classifies every aggregate type in the catalog', () => {
    // A future aggregate added to the pgEnum and forgotten here fails the
    // suite rather than silently fanning out to every directory.
    for (const aggregateType of ALL_OUTBOX_AGGREGATE_TYPES) {
      expect(() => targetsForAggregate(aggregateType, EVERY_TARGET)).not.toThrow()
    }
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @idm/api test -- --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3 target-fanout`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/outbox/target-fanout.ts`:

```ts
import type { ConnectorTarget } from '../connectors/connector'
import type { OutboxAggregateType } from './outbox.writer'

/**
 * Which targets a mutation of this aggregate type reaches. The single source
 * of truth for fan-out — `OutboxWriter.record` consults nothing else.
 *
 * Before this existed, `record` wrote one row per enabled target
 * unconditionally. That was correct while every aggregate described a person
 * or a group of people and every target was a directory. `sso_app` breaks
 * both halves: an application means nothing to Active Directory, Entra or
 * Google, and `keycloak_sso` has no idea what a user is.
 *
 * Deliberately a pure function over an explicitly-passed enabled list rather
 * than a database read: it is exhaustively testable against both pgEnums with
 * no container, which is what makes the "every aggregate is classified"
 * assertion in test/target-fanout.spec.ts cheap enough to be worth having.
 */
export function targetsForAggregate(
  aggregateType: OutboxAggregateType,
  enabledTargets: readonly ConnectorTarget[],
): ConnectorTarget[] {
  if (aggregateType === 'sso_app') {
    return enabledTargets.filter((target) => target === 'keycloak_sso')
  }
  return enabledTargets.filter((target) => target !== 'keycloak_sso')
}
```

- [ ] **Step 4: Wire it into the writer**

In `apps/api/src/outbox/outbox.writer.ts`, import it and replace the body of `record` after the `connector_targets` read:

```ts
    const enabledTargets = await tx
      .select({ target: connectorTargets.target })
      .from(connectorTargets)
      .where(eq(connectorTargets.enabled, true))
      .orderBy(connectorTargets.target)

    const targets = targetsForAggregate(
      event.aggregateType,
      enabledTargets.map(({ target }) => target),
    )

    if (targets.length === 0) {
      return
    }

    await tx.insert(outboxEvents).values(
      targets.map((target) => ({
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: event.payload,
        target,
      })),
    )
```

Add to `record`'s doc comment, directly after the MILESTONE 10, TASK 1 paragraph:

```
   * SSO APPLICATIONS — fan-out is now AGGREGATE-AWARE. The enabled-target
   * list is filtered through `targetsForAggregate` (target-fanout.ts) before
   * any row is written: an `sso_app` event reaches only `keycloak_sso`, and
   * every other aggregate reaches every enabled target EXCEPT
   * `keycloak_sso`. Without that filter an application would be handed to
   * Active Directory, Entra and Google, none of which know what an
   * application is.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @idm/api test -- --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3 target-fanout outbox`
Expected: PASS. `outbox-emission.spec.ts`'s existing assertions must still pass unchanged — they are the regression net proving directory fan-out is untouched.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/outbox/target-fanout.ts apps/api/src/outbox/outbox.writer.ts apps/api/test/target-fanout.spec.ts
git commit -m "feat(outbox): fan out by aggregate type, not to every enabled target"
```

---

## Task 5: The `SsoConnector` family and the Keycloak implementation

**Files:**
- Modify: `apps/api/src/connectors/connector.ts` (add `DesiredSsoApp`, `SsoConnector`)
- Modify: `apps/api/src/keycloak/keycloak-admin.client.ts` (client CRUD + mapper + secret)
- Create: `apps/api/src/connectors/keycloak-sso.connector.ts`
- Modify: `apps/api/src/connectors/connector-registry.ts` (third family + `healthFor`)
- Modify: `apps/api/src/connectors/connector-targets.controller.ts` (`summarize` uses `healthFor`)
- Test: `apps/api/test/keycloak-sso.connector.spec.ts`

**Interfaces:**
- Consumes: `ConnectorOperation`, `ConnectorHealth` (existing); `resolveSecret` (existing).
- Produces: `DesiredSsoApp`, `SsoConnector` (`planApp`, `applyApp`, `health`); `KeycloakSsoConnector` with `configure(config)`; `ConnectorRegistry.resolveSsoConnector(target, tx): Promise<SsoConnector | null>` and `ConnectorRegistry.healthFor(target, tx): Promise<ConnectorHealth>`; on `KeycloakAdminClient`: `findClientByClientId(clientId): Promise<RawClient | null>`, `createClient(rep): Promise<string>`, `updateClient(uuid, rep): Promise<void>`, `getClient(uuid): Promise<RawClient>`, `assertGroupMembershipMapper(uuid): Promise<void>`, `mintClientSecret(uuid): Promise<string>`.

- [ ] **Step 1: Verify Keycloak's update semantics empirically**

Before writing the connector, confirm against a real Keycloak 26 what a `PUT /clients/{uuid}` does to fields absent from the body. The spec requires read-modify-write on the assumption that a partial PUT clears them; verify rather than assume.

```bash
node scripts/dev.mjs   # brings up Keycloak on :8080
# then, with an admin token in $TOKEN and the realm from KEYCLOAK_ISSUER:
curl -s -H "Authorization: Bearer $TOKEN" "$KC/admin/realms/$REALM/clients?clientId=idm-console" | jq '.[0] | {id, defaultClientScopes, attributes}'
```

Record what you observe in the connector's doc comment. If a partial PUT preserves absent fields, read-modify-write is still correct (it is also what keeps admin-set `attributes` intact) — keep it, and say so.

- [ ] **Step 2: Write the failing connector test**

Create `apps/api/test/keycloak-sso.connector.spec.ts`. Follow `mail-server.connector.spec.ts`'s shape: a hand-rolled fake, no container.

```ts
import { describe, expect, it } from 'vitest'
import { KeycloakSsoConnector } from '../src/connectors/keycloak-sso.connector'
import { assertNoLeak } from './support/secret-leak'

interface FakeClient {
  id: string
  clientId: string
  name?: string
  enabled?: boolean
  redirectUris?: string[]
  attributes?: Record<string, string>
  defaultClientScopes?: string[]
}

function fakeAdmin(initial: FakeClient[] = []) {
  const clients = [...initial]
  const mappers = new Map<string, { name: string; protocolMapper: string }[]>()
  return {
    clients,
    mappers,
    async findClientByClientId(clientId: string) {
      return clients.find((c) => c.clientId === clientId) ?? null
    },
    async getClient(uuid: string) {
      const found = clients.find((c) => c.id === uuid)
      if (!found) throw new Error(`no client ${uuid}`)
      return found
    },
    async createClient(rep: FakeClient) {
      const created = { ...rep, id: `uuid-${rep.clientId}` }
      clients.push(created)
      return created.id
    },
    async updateClient(uuid: string, rep: FakeClient) {
      const index = clients.findIndex((c) => c.id === uuid)
      clients[index] = { ...rep, id: uuid }
    },
    async assertGroupMembershipMapper(uuid: string) {
      const existing = mappers.get(uuid) ?? []
      if (!existing.some((m) => m.name === 'groups')) {
        mappers.set(uuid, [...existing, { name: 'groups', protocolMapper: 'oidc-group-membership-mapper' }])
      }
    },
    async mintClientSecret() {
      return 'MINTED-SECRET-SENTINEL'
    },
    async health() {
      return { ok: true, detail: 'reachable' }
    },
  }
}

const DESIRED = {
  clientId: 'billing-portal',
  name: 'Billing Portal',
  description: 'Customer billing',
  protocol: 'openid-connect' as const,
  publicClient: false,
  redirectUris: ['https://billing.example.com/cb'],
  webOrigins: ['https://billing.example.com'],
  groupsClaim: true,
  enabled: true,
}

describe('KeycloakSsoConnector', () => {
  it('plans a create when no client exists', async () => {
    const connector = new KeycloakSsoConnector(fakeAdmin())
    const ops = await connector.planApp(DESIRED)
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe('create')
  })

  it('applies a create and returns the Keycloak UUID, not the clientId', async () => {
    const admin = fakeAdmin()
    const connector = new KeycloakSsoConnector(admin)
    const { externalId } = await connector.applyApp(DESIRED)
    expect(externalId).toBe('uuid-billing-portal')
    expect(externalId).not.toBe('billing-portal')
  })

  it('asserts the group mapper on UPDATE, not only on create', async () => {
    // Keycloak accepts protocolMappers on create and SILENTLY DROPS them on
    // update (scripts/keycloak-setup.sh:143). Everything looks configured
    // and the claim simply is not there. This is that regression guard.
    const admin = fakeAdmin([{ id: 'uuid-billing-portal', clientId: 'billing-portal' }])
    const connector = new KeycloakSsoConnector(admin)

    await connector.applyApp({ ...DESIRED, existingExternalId: 'uuid-billing-portal' })

    expect(admin.mappers.get('uuid-billing-portal')).toEqual([
      { name: 'groups', protocolMapper: 'oidc-group-membership-mapper' },
    ])
  })

  it('preserves fields it does not manage', async () => {
    const admin = fakeAdmin([
      {
        id: 'uuid-billing-portal',
        clientId: 'billing-portal',
        defaultClientScopes: ['profile', 'custom-scope'],
        attributes: { 'admin.set.by.hand': 'keep me' },
      },
    ])
    const connector = new KeycloakSsoConnector(admin)

    await connector.applyApp({ ...DESIRED, existingExternalId: 'uuid-billing-portal' })

    const after = admin.clients.find((c) => c.id === 'uuid-billing-portal')
    expect(after?.defaultClientScopes).toEqual(['profile', 'custom-scope'])
    expect(after?.attributes?.['admin.set.by.hand']).toBe('keep me')
  })

  it('forces PKCE S256 on a public client', async () => {
    const admin = fakeAdmin()
    const connector = new KeycloakSsoConnector(admin)
    await connector.applyApp({ ...DESIRED, publicClient: true })
    const created = admin.clients.find((c) => c.clientId === 'billing-portal')
    expect(created?.attributes?.['pkce.code.challenge.method']).toBe('S256')
  })

  it('never returns a minted secret from applyApp', async () => {
    const admin = fakeAdmin()
    const connector = new KeycloakSsoConnector(admin)
    const result = await connector.applyApp(DESIRED)
    assertNoLeak(JSON.stringify(result), 'MINTED-SECRET-SENTINEL', 'applyApp result')
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @idm/api test -- --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3 keycloak-sso.connector`
Expected: FAIL — module not found.

- [ ] **Step 4: Add the interface types**

Append to `apps/api/src/connectors/connector.ts`, below `DirectoryConnector`:

```ts
export interface DesiredSsoApp {
  clientId: string
  name: string
  description: string
  protocol: 'openid-connect'
  publicClient: boolean
  redirectUris: readonly string[]
  webOrigins: readonly string[]
  groupsClaim: boolean
  enabled: boolean
  existingExternalId?: string
}

/**
 * The third connector interface family, alongside DirectoryConnector (users)
 * and DirectoryGroupConnector (groups). An application is neither a user nor
 * a group, and DirectoryConnector's own doc comment calls it settled and
 * deliberately narrow — widening it to carry applications would make four
 * methods over DesiredUser mean something different per target.
 *
 * No `disable`. A person must be disable-able knowing only an external id,
 * because the offboarding path works from `external_identities`; an
 * application is always driven from its local row, so `enabled: false` in
 * the desired state covers it. No delete at all, deliberately: removing the
 * capability removes the class of disaster.
 */
export interface SsoConnector {
  planApp(desired: DesiredSsoApp): Promise<ConnectorOperation[]>
  applyApp(desired: DesiredSsoApp): Promise<{ externalId: string }>
  health(): Promise<ConnectorHealth>
}
```

- [ ] **Step 5: Extend the Keycloak admin client**

Add to `apps/api/src/keycloak/keycloak-admin.client.ts`. These call the realm's `/clients` endpoints with the **SSO credential**, not the sync-service one — the config is passed in by the connector, so this class gains a second constructor path or, simpler, the connector holds its own `KeycloakAdminClient` instance built from its own config. Prefer the latter: it keeps `manage-clients` structurally out of the user-sync client.

```ts
export interface KeycloakClientRepresentation {
  id?: string
  clientId: string
  name?: string
  description?: string
  protocol?: string
  publicClient?: boolean
  enabled?: boolean
  standardFlowEnabled?: boolean
  redirectUris?: string[]
  webOrigins?: string[]
  attributes?: Record<string, string>
  defaultClientScopes?: string[]
  [key: string]: unknown
}

export const GROUP_MEMBERSHIP_MAPPER = {
  name: 'groups',
  protocol: 'openid-connect',
  protocolMapper: 'oidc-group-membership-mapper',
  config: {
    'claim.name': 'groups',
    // Bare group names, not paths — matches the flattened names the Keycloak
    // user connector already writes as group membership.
    full: 'false',
    'access.token.claim': 'true',
    'id.token.claim': 'true',
    'userinfo.token.claim': 'true',
  },
} as const
```

and the five methods, each following the existing `request`/`describeError` helpers in that file:

```ts
  async findClientByClientId(clientId: string): Promise<KeycloakClientRepresentation | null> {
    const found = await this.request<KeycloakClientRepresentation[]>(
      'GET',
      `/clients?clientId=${encodeURIComponent(clientId)}`,
    )
    return found[0] ?? null
  }

  async getClient(uuid: string): Promise<KeycloakClientRepresentation> {
    return this.request<KeycloakClientRepresentation>('GET', `/clients/${uuid}`)
  }

  /** Returns the UUID Keycloak assigned — the only stable handle for a client. */
  async createClient(rep: KeycloakClientRepresentation): Promise<string> {
    await this.request('POST', '/clients', rep)
    const created = await this.findClientByClientId(rep.clientId)
    if (created?.id === undefined) {
      throw new Error(`created client "${rep.clientId}" but could not read back its id`)
    }
    return created.id
  }

  async updateClient(uuid: string, rep: KeycloakClientRepresentation): Promise<void> {
    await this.request('PUT', `/clients/${uuid}`, rep)
  }

  /**
   * Keycloak accepts `protocolMappers` on client CREATE and silently drops
   * them on UPDATE (scripts/keycloak-setup.sh:143 records the same trap for
   * the audience mapper). So the mapper is asserted against its own endpoint,
   * every time, rather than trusted to ride along on the client body.
   */
  async assertGroupMembershipMapper(uuid: string): Promise<void> {
    const existing = await this.request<{ name: string }[]>(
      'GET',
      `/clients/${uuid}/protocol-mappers/models`,
    )
    if (existing.some((mapper) => mapper.name === GROUP_MEMBERSHIP_MAPPER.name)) {
      return
    }
    await this.request('POST', `/clients/${uuid}/protocol-mappers/models`, GROUP_MEMBERSHIP_MAPPER)
  }

  /** Mints a NEW secret, invalidating the previous one. Never logged, never stored. */
  async mintClientSecret(uuid: string): Promise<string> {
    const result = await this.request<{ value?: string }>('POST', `/clients/${uuid}/client-secret`)
    if (result.value === undefined || result.value.length === 0) {
      throw new Error('Keycloak returned no secret value')
    }
    return result.value
  }
```

- [ ] **Step 6: Write the connector**

Create `apps/api/src/connectors/keycloak-sso.connector.ts`:

```ts
import { Injectable } from '@nestjs/common'
import type { KeycloakClientRepresentation } from '../keycloak/keycloak-admin.client'
import type { ConnectorHealth, ConnectorOperation, DesiredSsoApp, SsoConnector } from './connector'
import { resolveSecret } from './secrets'

/** The subset of KeycloakAdminClient this connector needs — narrowed so the test fake is small and honest. */
export interface SsoAdminApi {
  findClientByClientId(clientId: string): Promise<KeycloakClientRepresentation | null>
  getClient(uuid: string): Promise<KeycloakClientRepresentation>
  createClient(rep: KeycloakClientRepresentation): Promise<string>
  updateClient(uuid: string, rep: KeycloakClientRepresentation): Promise<void>
  assertGroupMembershipMapper(uuid: string): Promise<void>
  mintClientSecret(uuid: string): Promise<string>
  health(): Promise<ConnectorHealth>
}

/**
 * Asserts an Identity Manager `sso_apps` row into Keycloak as an OIDC client.
 *
 * READ-MODIFY-WRITE, never blind overwrite. Keycloak's client update takes a
 * full ClientRepresentation, so this reads the current one and overlays only
 * the fields Identity Manager manages, leaving `defaultClientScopes`,
 * `attributes` an admin set by hand, and anything a future Keycloak version
 * adds, untouched. Same discipline as `setEnabledPreservingOtherBits` for
 * AD's userAccountControl.
 */
export class KeycloakSsoConnector implements SsoConnector {
  constructor(private readonly admin: SsoAdminApi) {}

  async planApp(desired: DesiredSsoApp): Promise<ConnectorOperation[]> {
    const existing = await this.findExisting(desired)
    if (existing === null) {
      return [
        {
          kind: 'create',
          description: `create Keycloak client "${desired.clientId}" (enabled=${desired.enabled})`,
        },
      ]
    }

    const ops: ConnectorOperation[] = []
    const merged = this.merge(existing, desired)

    const changedKeys = Object.keys(merged).filter(
      (key) => JSON.stringify(merged[key]) !== JSON.stringify(existing[key]),
    )
    if (changedKeys.length > 0) {
      ops.push({
        kind: desired.enabled ? 'update' : 'disable',
        description: `update Keycloak client "${desired.clientId}" (${changedKeys.join(', ')})`,
      })
    }
    if (desired.groupsClaim) {
      ops.push({ kind: 'update', description: `assert the "groups" mapper on "${desired.clientId}"` })
    }
    return ops
  }

  async applyApp(desired: DesiredSsoApp): Promise<{ externalId: string }> {
    const existing = await this.findExisting(desired)

    if (existing === null || existing.id === undefined) {
      const uuid = await this.admin.createClient(this.merge({ clientId: desired.clientId }, desired))
      if (desired.groupsClaim) {
        await this.admin.assertGroupMembershipMapper(uuid)
      }
      return { externalId: uuid }
    }

    await this.admin.updateClient(existing.id, this.merge(existing, desired))
    if (desired.groupsClaim) {
      await this.admin.assertGroupMembershipMapper(existing.id)
    }
    return { externalId: existing.id }
  }

  async health(): Promise<ConnectorHealth> {
    return this.admin.health()
  }

  /**
   * Correlates on the stored Keycloak UUID first and falls back to clientId
   * only for an application that has never synced. A Keycloak admin CAN
   * rename clientId directly; correlating on it would turn that rename into
   * an orphaned client plus a second, empty one on the next sync.
   */
  private async findExisting(desired: DesiredSsoApp): Promise<KeycloakClientRepresentation | null> {
    if (desired.existingExternalId !== undefined) {
      return this.admin.getClient(desired.existingExternalId)
    }
    return this.admin.findClientByClientId(desired.clientId)
  }

  private merge(
    current: KeycloakClientRepresentation,
    desired: DesiredSsoApp,
  ): KeycloakClientRepresentation {
    return {
      ...current,
      clientId: desired.clientId,
      name: desired.name,
      description: desired.description,
      protocol: desired.protocol,
      publicClient: desired.publicClient,
      enabled: desired.enabled,
      standardFlowEnabled: true,
      redirectUris: [...desired.redirectUris],
      webOrigins: [...desired.webOrigins],
      attributes: {
        ...(current.attributes ?? {}),
        // Forced, not exposed as an editable field. A public client without
        // PKCE is an authorization-code interception hole; making it
        // unrepresentable is cheaper than a checkbox someone gets wrong.
        ...(desired.publicClient ? { 'pkce.code.challenge.method': 'S256' } : {}),
      },
    }
  }
}

@Injectable()
export class KeycloakSsoConnectorFactory {
  configure(config: Record<string, unknown>): KeycloakSsoConnector {
    const secretName = String(config.credentialSecretName ?? '')
    const secret = resolveSecret(secretName)
    // Build a KeycloakAdminClient bound to idm-sso-admin — a DIFFERENT
    // credential from the sync service's, holding manage-clients and nothing
    // else. The user and group sync path structurally cannot mint or alter a
    // client, rather than merely declining to.
    throw new Error(
      `not yet wired: build a KeycloakAdminClient for ${String(config.clientId)} using ${secretName} (secret length ${secret.length})`,
    )
  }
}
```

Replace that `throw` with the real construction once `KeycloakAdminClient`'s constructor shape is confirmed in Step 5; it takes `{ issuer, clientId, clientSecret }` via `KEYCLOAK_ADMIN_CONFIG`.

- [ ] **Step 7: Add the third registry family**

In `apps/api/src/connectors/connector-registry.ts`:

```ts
type SsoConnectorFactory = (config: Record<string, unknown>) => SsoConnector

type ImplementedSsoConnectorTarget = 'keycloak_sso'
```

a `private readonly ssoFactories` built with the same `Object.assign(Object.create(null), {...} satisfies ...)` shape as the other two, and:

```ts
  async resolveSsoConnector(target: ConnectorTarget, tx: DbHandle): Promise<SsoConnector | null> {
    if (!Object.hasOwn(this.ssoFactories, target)) {
      return null
    }
    const config = await this.loadConfig(target, tx)
    return this.ssoFactories[target as ImplementedSsoConnectorTarget](config)
  }

  /**
   * Health for ANY target, whichever interface family implements it. The
   * console's target list must be able to summarize every target in
   * ALL_CONNECTOR_TARGETS, and `resolve` only knows the user-directory
   * family — calling it for keycloak_sso would report "no connector
   * registered" as a health failure on a perfectly healthy target.
   */
  async healthFor(target: ConnectorTarget, tx: DbHandle): Promise<ConnectorHealth> {
    const sso = await this.resolveSsoConnector(target, tx)
    if (sso !== null) {
      return sso.health()
    }
    return (await this.resolve(target, tx)).health()
  }
```

Then in `apps/api/src/connectors/connector-targets.controller.ts`, change `summarize`'s health block:

```ts
      health = await this.db.transaction((tx) => this.registry.healthFor(target, tx))
```

(dropping the now-unused two-step resolve-then-health).

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm --filter @idm/api test -- --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3 keycloak-sso connector-registry connector-targets`
Expected: PASS. Update `connector-registry.spec.ts` if it asserts on the exact set of implemented targets.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/connectors apps/api/src/keycloak/keycloak-admin.client.ts apps/api/test/keycloak-sso.connector.spec.ts
git commit -m "feat(sso-apps): the SsoConnector family and its Keycloak implementation"
```

---

## Task 6: Sync worker dispatch for `sso_app`

**Files:**
- Modify: `apps/api/src/outbox/sync.worker.ts` (`applyEvent`, new `reconcileSsoApp`)
- Test: `apps/api/test/sync.worker.spec.ts`

**Interfaces:**
- Consumes: `SsoAppsRepository` (Task 2), `ConnectorRegistry.resolveSsoConnector` (Task 5), `externalSsoAppIdentities` (Task 2).
- Produces: `SyncWorker.reconcileSsoApp(tx, appId, target)`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/sync.worker.spec.ts`, following the existing fake-connector pattern in that file:

```ts
  it('reconciles an sso_app event and records the Keycloak UUID', async () => {
    const app = await seedSsoApp({ clientId: 'billing-portal' })
    await enqueue({ aggregateType: 'sso_app', aggregateId: app.id, target: 'keycloak_sso' })

    await worker.runOnce()

    const [identity] = await db
      .select()
      .from(externalSsoAppIdentities)
      .where(eq(externalSsoAppIdentities.appId, app.id))

    expect(identity.externalId).toBe('uuid-billing-portal')
    expect(identity.syncState).toBe('synced')
    expect(identity.system).toBe('keycloak_sso')
  })

  it('passes the stored external id back so a renamed clientId still correlates', async () => {
    const app = await seedSsoApp({ clientId: 'billing-portal' })
    await seedExternalSsoAppIdentity(app.id, 'uuid-from-a-previous-sync')
    await enqueue({ aggregateType: 'sso_app', aggregateId: app.id, target: 'keycloak_sso' })

    await worker.runOnce()

    expect(fakeSsoConnector.lastDesired?.existingExternalId).toBe('uuid-from-a-previous-sync')
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @idm/api test -- --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3 sync.worker`
Expected: FAIL — `applyEvent` silently does nothing for `sso_app` (the switch has no case), so no identity row appears.

- [ ] **Step 3: Add the dispatch**

In `apps/api/src/outbox/sync.worker.ts`, extend the switch:

```ts
      case 'sso_app':
        await this.reconcileSsoApp(tx, event.aggregateId, event.target)
        return
```

and add the method next to `reconcileGroup`:

```ts
  async reconcileSsoApp(tx: DbHandle, appId: string, target: OutboxTarget): Promise<void> {
    const connector = await this.connectorRegistry.resolveSsoConnector(target, tx)
    if (connector === null) {
      throw new Error(`sync worker: target "${target}" implements no SSO connector`)
    }

    const app = await this.ssoAppsRepository.findById(appId, tx)
    if (app === null) {
      throw new Error(`sync worker: no SSO application found for id ${appId}`)
    }

    const existingExternalId = (await this.ssoAppsRepository.findExternalId(appId, tx)) ?? undefined

    const { externalId } = await connector.applyApp({
      clientId: app.clientId,
      name: app.name,
      description: app.description,
      protocol: app.protocol,
      publicClient: app.publicClient,
      redirectUris: app.redirectUris,
      webOrigins: app.webOrigins,
      groupsClaim: app.groupsClaim,
      enabled: app.enabled,
      existingExternalId,
    })

    await tx
      .insert(externalSsoAppIdentities)
      .values({
        appId: app.id,
        system: target,
        externalId,
        lastSyncedAt: new Date(),
        syncState: 'synced',
      })
      .onConflictDoUpdate({
        target: [externalSsoAppIdentities.appId, externalSsoAppIdentities.system],
        set: { externalId, lastSyncedAt: new Date(), syncState: 'synced', updatedAt: new Date() },
      })
  }
```

Inject `SsoAppsRepository` into the constructor following the existing `@Optional() @Inject(...)` pattern used for `OrgUnitsRepository`, with the same `?? new SsoAppsRepository(db)` default.

Leave `TARGETS_NEEDING_EXTERNAL_ID_CORRELATION`, `TARGETS_NEEDING_MANAGED_ATTRIBUTE_NAMES` and `TARGETS_NEEDING_FULL_STATUS` untouched — every one of them describes how to build a `DesiredUser`, and `keycloak_sso` never receives one.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @idm/api test -- --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3 sync.worker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/outbox/sync.worker.ts apps/api/test/sync.worker.spec.ts
git commit -m "feat(sso-apps): reconcile sso_app events through the SSO connector"
```

---

## Task 7: The two authorization actions

**Files:**
- Modify: `apps/api/src/authz/actions.ts`
- Modify: `apps/web/src/shell/permissions.ts`
- Test: `apps/api/test/actions.spec.ts`

**Interfaces:**
- Produces: `Action` gains `'sso_app:read' | 'sso_app:manage'`; both appended to `ALL_ACTIONS`; both granted to `super_admin` only.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/actions.spec.ts`:

```ts
  it('grants sso_app actions to super_admin only', () => {
    // Minting OAuth clients is realm-security work, not people
    // administration — deliberately NOT user_admin.
    for (const action of ['sso_app:read', 'sso_app:manage'] as const) {
      expect(ROLE_PERMISSIONS.super_admin).toContain(action)
      for (const role of ALL_ROLE_KEYS.filter((r) => r !== 'super_admin')) {
        expect(ROLE_PERMISSIONS[role]).not.toContain(action)
      }
    }
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @idm/api test -- --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3 actions`
Expected: FAIL — `sso_app:read` is not an `Action`.

- [ ] **Step 3: Add the actions**

In `apps/api/src/authz/actions.ts`, add `| 'sso_app:read'` and `| 'sso_app:manage'` to the `Action` union and the same two strings to the end of `ALL_ACTIONS`. `super_admin` already spreads `[...ALL_ACTIONS]`, so it picks them up with no further edit; make no change to any other role. Mirror the two additions into `apps/web/src/shell/permissions.ts`'s `Action` union.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @idm/api test -- --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3 actions && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/authz/actions.ts apps/web/src/shell/permissions.ts apps/api/test/actions.spec.ts
git commit -m "feat(authz): sso_app:read and sso_app:manage, super_admin only"
```

---

## Task 8: The REST API

**Files:**
- Create: `apps/api/src/sso-apps/sso-apps.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/sso-apps.controller.spec.ts`
- Test: `apps/api/test/guard-coverage.spec.ts` (add `SsoAppsController` to the expected list)

**Interfaces:**
- Consumes: `SsoAppsRepository` (2), validation guards (3), `OutboxWriter` (4), `ConnectorRegistry.resolveSsoConnector` (5), the two actions (7).
- Produces: seven routes under `/sso-apps`.

- [ ] **Step 1: Write the failing controller test**

Create `apps/api/test/sso-apps.controller.spec.ts`, following `connector-targets.controller.spec.ts`'s harness:

```ts
describe('SsoAppsController', () => {
  it('creates an application, its audit row and its outbox row in one transaction', async () => {
    const created = await controller.create(VALID_BODY, superAdminRequest)

    expect(created.clientId).toBe('billing-portal')

    const [audit] = await db.select().from(auditLog).where(eq(auditLog.resourceId, created.id))
    expect(audit.action).toBe('sso_app:create')

    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, created.id))
    expect(events.map((e) => e.target)).toEqual(['keycloak_sso'])
  })

  it('rejects an unknown key by name', async () => {
    await expect(
      controller.create({ ...VALID_BODY, publicClinet: true }, superAdminRequest),
    ).rejects.toThrow(/publicClinet/)
  })

  it('rejects a wildcard redirect URI', async () => {
    await expect(
      controller.create({ ...VALID_BODY, redirectUris: ['https://*'] }, superAdminRequest),
    ).rejects.toThrow(/wildcard/)
  })

  it('rejects a reserved client id', async () => {
    await expect(
      controller.create({ ...VALID_BODY, clientId: 'idm-console' }, superAdminRequest),
    ).rejects.toThrow(/reserved/)
  })

  it('409s on a duplicate client id', async () => {
    await controller.create(VALID_BODY, superAdminRequest)
    await expect(controller.create(VALID_BODY, superAdminRequest)).rejects.toBeInstanceOf(ConflictError)
  })

  it('PATCH cannot change clientId', async () => {
    const created = await controller.create(VALID_BODY, superAdminRequest)
    await expect(
      controller.update(created.id, { clientId: 'renamed' }, superAdminRequest),
    ).rejects.toThrow(/clientId/)
  })

  it('requires a GLOBAL grant, not a scoped one', async () => {
    await expect(controller.create(VALID_BODY, scopedAdminRequest)).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('409s when minting a secret before the first sync', async () => {
    const created = await controller.create(VALID_BODY, superAdminRequest)
    // The application exists here; there is simply no Keycloak client yet.
    await expect(controller.mintSecret(created.id, superAdminRequest)).rejects.toBeInstanceOf(ConflictError)
  })

  it('never persists or echoes the minted secret anywhere but the one response', async () => {
    const created = await controller.create(VALID_BODY, superAdminRequest)
    await seedExternalSsoAppIdentity(created.id, 'uuid-billing-portal')

    const { secret } = await controller.mintSecret(created.id, superAdminRequest)
    expect(secret).toBe('MINTED-SECRET-SENTINEL')

    const [app] = await db.select().from(ssoApps).where(eq(ssoApps.id, created.id))
    assertNoLeak(JSON.stringify(app), secret, 'sso_apps row')

    const audits = await db.select().from(auditLog).where(eq(auditLog.resourceId, created.id))
    assertNoLeak(JSON.stringify(audits), secret, 'audit_log')

    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, created.id))
    assertNoLeak(JSON.stringify(events), secret, 'outbox_events')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @idm/api test -- --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3 sso-apps.controller`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the controller**

Create `apps/api/src/sso-apps/sso-apps.controller.ts`. Structure it exactly like `ConnectorTargetsController`: `@Controller('sso-apps')`, `@UseGuards(JwtGuard, PermissionGuard)`, a private `requireGlobalGrant`, and `@RequirePermission` on every route.

```ts
const createBodySchema = z
  .object({
    clientId: z.string().min(1).max(255),
    name: z.string().min(1).max(255),
    description: z.string().max(2000).default(''),
    publicClient: z.boolean(),
    redirectUris: z.array(z.string().min(1)).min(1),
    webOrigins: z.array(z.string().min(1)).default([]),
    groupsClaim: z.boolean().default(true),
  })
  .strict()

// No clientId: immutable after create, because downstream applications
// hard-code it. No enabled: that is its own audited verb route.
const patchBodySchema = createBodySchema.omit({ clientId: true, publicClient: true }).partial().strict()
```

The validation step, called from both create and update:

```ts
  private assertSafeUris(redirectUris: readonly string[], webOrigins: readonly string[]): void {
    const problems = [
      ...redirectUris.map(redirectUriProblem),
      ...webOrigins.map(webOriginProblem),
    ].filter((problem): problem is string => problem !== null)

    if (problems.length > 0) {
      throw new ValidationError(problems)
    }
  }
```

`create` mirrors `UsersController.create`'s transaction shape exactly:

```ts
  @Post()
  @RequirePermission('sso_app:manage')
  async create(@Body() body: unknown, @Req() request: AuthorizedRequest): Promise<SsoApp> {
    await this.requireGlobalGrant(request, 'sso_app:manage')
    const parsed = parseBody(createBodySchema, body)

    const clientIdIssue = clientIdProblem(parsed.clientId)
    if (clientIdIssue !== null) {
      throw new ValidationError([clientIdIssue])
    }
    this.assertSafeUris(parsed.redirectUris, parsed.webOrigins)

    if ((await this.apps.findByClientId(parsed.clientId)) !== null) {
      throw new ConflictError(`an application with clientId "${parsed.clientId}" already exists`)
    }

    return this.db.transaction(async (tx) => {
      const app = await this.apps.create({ ...parsed, protocol: 'openid-connect' }, tx)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'sso_app:create',
        resourceType: 'sso_app',
        resourceId: app.id,
        before: null,
        after: snapshotSsoApp(app),
      })

      await this.outboxWriter.record(tx, {
        aggregateType: 'sso_app',
        aggregateId: app.id,
        eventType: 'created',
        payload: { ...snapshotSsoApp(app), action: 'sso_app:create' },
      })

      return app
    })
  }
```

`enable`/`disable` are `@Post(':id/enable')` / `@Post(':id/disable')` calling `setEnabled` with `eventType: 'status_changed'`.

The mint route, which writes an audit row naming the act but never the value:

```ts
  @Post(':id/client-secret')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('sso_app:manage')
  async mintSecret(@Param('id') id: string, @Req() request: AuthorizedRequest): Promise<{ secret: string }> {
    await this.requireGlobalGrant(request, 'sso_app:manage')

    const app = await this.apps.findById(id)
    if (app === null) {
      throw new NotFoundError(`no SSO application with id ${id}`)
    }

    const externalId = await this.apps.findExternalId(id)
    if (externalId === null) {
      // A conflict, not a 404: the application exists HERE — there is simply
      // no Keycloak client to mint against until the first sync succeeds.
      throw new ConflictError(
        `"${app.clientId}" has not synced to Keycloak yet — no client exists to mint a secret for`,
      )
    }

    const connector = await this.db.transaction((tx) =>
      this.registry.resolveSsoConnector('keycloak_sso', tx),
    )
    if (connector === null) {
      throw new ConflictError('the keycloak_sso target is not configured')
    }

    const secret = await this.keycloakSso.mintClientSecret(externalId)

    // The act is audited; the value never is. Same rule as the Google
    // connector's one-time bootstrap password: generate it, transmit it
    // once, retain nothing.
    await this.db.transaction((tx) =>
      this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'sso_app:mint_secret',
        resourceType: 'sso_app',
        resourceId: app.id,
        before: null,
        after: { clientId: app.clientId, minted: true },
      }),
    )

    return { secret }
  }
```

Register `SsoAppsController` in `apps/api/src/app.module.ts`'s `controllers` array and `SsoAppsRepository` in `providers`.

- [ ] **Step 4: Update the guard coverage list**

`apps/api/test/guard-coverage.spec.ts` asserts the exact set of controllers. Add `'SsoAppsController'` to that array, alphabetically — the comment above it says to update the list deliberately, which is what this is.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @idm/api test -- --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3 sso-apps.controller guard-coverage`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/sso-apps apps/api/src/app.module.ts apps/api/test/sso-apps.controller.spec.ts apps/api/test/guard-coverage.spec.ts
git commit -m "feat(sso-apps): the /sso-apps routes and one-time secret minting"
```

---

## Task 9: The console Applications section

**Files:**
- Create: `apps/web/src/sso-apps/api.ts`, `SsoAppsListPage.tsx`, `SsoAppDetailPage.tsx`, `CreateSsoAppPage.tsx`, `SecretModal.tsx`, `SsoApps.css`
- Modify: `apps/web/src/App.tsx` (routes), `apps/web/src/shell/nav-items.tsx` (nav entry + icon)
- Test: `apps/web/e2e/sso-apps.spec.ts`

**Interfaces:**
- Consumes: the `/sso-apps` routes (Task 8), `authorizedRequest` from `../api/client`, the `sync badge` component in `apps/web/src/connectors/badges.tsx`.

- [ ] **Step 1: Write the failing e2e test**

Create `apps/web/e2e/sso-apps.spec.ts`, following `apps/web/e2e/connectors.spec.ts`'s login helper:

```ts
test('registers an application and shows its secret exactly once', async ({ page }) => {
  await loginAsSuperAdmin(page)
  await page.goto('/applications')

  await page.getByRole('link', { name: 'Register application' }).click()
  await page.getByLabel('Client ID').fill('billing-portal')
  await page.getByLabel('Name').fill('Billing Portal')
  await page.getByLabel('Redirect URIs').fill('https://billing.example.com/callback')
  await page.getByRole('button', { name: 'Register' }).click()

  await expect(page.getByRole('heading', { name: 'Billing Portal' })).toBeVisible()
  await expect(page.getByTestId('sync-badge')).toHaveText(/pending|synced/)
})

test('refuses a wildcard redirect URI in the UI, naming the field', async ({ page }) => {
  await loginAsSuperAdmin(page)
  await page.goto('/applications/new')

  await page.getByLabel('Client ID').fill('bad-app')
  await page.getByLabel('Name').fill('Bad App')
  await page.getByLabel('Redirect URIs').fill('https://*')
  await page.getByRole('button', { name: 'Register' }).click()

  await expect(page.getByText(/wildcard/i)).toBeVisible()
})

test('the secret modal offers no reveal affordance', async ({ page }) => {
  // There is nothing to reveal — the value is never stored. The modal is the
  // only place it will ever appear.
  await loginAsSuperAdmin(page)
  await page.goto('/applications')
  await page.getByRole('link', { name: 'Billing Portal' }).click()
  await page.getByRole('button', { name: 'Generate client secret' }).click()

  await expect(page.getByTestId('secret-value')).toBeVisible()
  await expect(page.getByText('This will not be shown again')).toBeVisible()
  await expect(page.getByRole('button', { name: /reveal|show secret/i })).toHaveCount(0)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @idm/web exec playwright test e2e/sso-apps.spec.ts`
Expected: FAIL — `/applications` 404s.

- [ ] **Step 3: Build the API client**

Create `apps/web/src/sso-apps/api.ts` with `SsoApp`, `fetchSsoApps`, `fetchSsoApp`, `createSsoApp`, `updateSsoApp`, `setSsoAppEnabled`, `mintClientSecret`, each wrapping `authorizedRequest` exactly as `apps/web/src/connectors/api.ts` does.

- [ ] **Step 4: Build the pages**

`SsoAppsListPage` renders a table of `clientId`, `name`, enabled state and the sync badge from `../connectors/badges`. `SsoAppDetailPage` reuses the Configuration/Dry run tab shape from `TargetDetailPage.tsx`. `CreateSsoAppPage` is a form; render server-returned `VALIDATION_FAILED` detail strings verbatim beneath the form rather than rewriting them, so the rail's reason reaches the admin.

`SecretModal.tsx` shows the value in a `<code data-testid="secret-value">`, the sentence "This will not be shown again", and a copy button. No reveal toggle, no masking — there is nothing to reveal.

- [ ] **Step 5: Add the route and nav entry**

In `apps/web/src/App.tsx`, inside the `<Route element={<AppShell />}>` block:

```tsx
          <Route path="/applications" element={<SsoAppsListPage />} />
          <Route path="/applications/new" element={<CreateSsoAppPage />} />
          <Route path="/applications/:id" element={<SsoAppDetailPage />} />
```

In `apps/web/src/shell/nav-items.tsx`, add an entry gated on the read action:

```tsx
  {
    key: 'applications',
    label: 'Applications',
    path: '/applications',
    action: 'sso_app:read',
    icon: ApplicationsIcon,
  },
```

with an `ApplicationsIcon` following the existing `iconProps` helper.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @idm/web exec playwright test e2e/sso-apps.spec.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/sso-apps apps/web/src/App.tsx apps/web/src/shell/nav-items.tsx apps/web/e2e/sso-apps.spec.ts
git commit -m "feat(web): the Applications section and its one-time secret modal"
```

---

## Task 10: Keycloak setup, environment, and documentation

**Files:**
- Modify: `scripts/keycloak-setup.sh`
- Modify: `.env.example`
- Modify: `docs/02`, `docs/03`, `docs/05`, `docs/06`, `docs/08`, `docs/09`, `docs/10`, `docs/12`, `docs/14`
- Test: `apps/api/test/sso-app-validation.spec.ts` (the source scan already written in Task 3 now covers the new client)

- [ ] **Step 1: Add the `idm-sso-admin` client**

In `scripts/keycloak-setup.sh`, after the `idm-sync-service` block, add an idempotent client following the same `upsert_client` + role-grant shape:

```bash
# --- idm-sso-admin: the credential that manages SSO application clients -----
# A SEPARATE credential from idm-sync-service deliberately. The sync service
# keeps exactly its four realm-management roles and structurally CANNOT mint
# or alter a client; only this one holds manage-clients.
#
# manage-clients is realm-wide -- Keycloak offers nothing finer-grained. A
# compromise of this credential could rewrite idm-console's own redirectUris.
# The mitigation is the reserved-client denylist in
# apps/api/src/sso-apps/sso-app-validation.ts, which is an application-level
# guard and weaker than a structural one. See docs/12.
SSO_UUID="$(upsert_client idm-sso-admin "$(jq -n '{
  clientId:"idm-sso-admin", enabled:true, protocol:"openid-connect",
  publicClient:false, serviceAccountsEnabled:true,
  standardFlowEnabled:false, directAccessGrantsEnabled:false,
  description:"Service account that registers SSO application clients. Holds manage-clients and nothing else."
}')")"

info "granting manage-clients to the SSO admin service account"
SSO_SA_USER_ID="$(api GET "/realms/$REALM/clients/$SSO_UUID/service-account-user" | jq -r .id)"
SSO_WANTED='["manage-clients"]'
SSO_AVAILABLE="$(api GET "/realms/$REALM/users/$SSO_SA_USER_ID/role-mappings/clients/$RM_UUID/available")"
SSO_TO_ADD="$(jq -c --argjson want "$SSO_WANTED" '[.[] | select(.name as $n | $want | index($n))]' <<<"$SSO_AVAILABLE")"

if [[ "$(jq 'length' <<<"$SSO_TO_ADD")" -gt 0 ]]; then
  api POST "/realms/$REALM/users/$SSO_SA_USER_ID/role-mappings/clients/$RM_UUID" "$SSO_TO_ADD" >/dev/null
fi
```

Print the generated secret at the end of the script the same way the other credentials are surfaced, so the operator can set `CONNECTOR_KEYCLOAK_SSO_CLIENT_SECRET`.

- [ ] **Step 2: Add the environment variable**

In `.env.example`, beside the other `CONNECTOR_*` entries:

```
# The idm-sso-admin client secret. Printed by scripts/keycloak-setup.sh.
# Only the sso_app code path resolves this; the user/group sync path never does.
CONNECTOR_KEYCLOAK_SSO_CLIENT_SECRET=
```

- [ ] **Step 3: Run the source scan**

Run: `pnpm --filter @idm/api test -- --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3 sso-app-validation`
Expected: PASS — the scan now finds `idm-sso-admin` among the created clients and confirms `RESERVED_CLIENT_IDS` already names it.

- [ ] **Step 4: Update the documentation**

| Doc | Addition |
|---|---|
| `docs/02` | The `sso_app` aggregate and the aggregate-aware fan-out rule |
| `docs/03` | `sso_apps` and `external_sso_app_identities` |
| `docs/05` | The `idm-sso-admin` client and why it is separate |
| `docs/06` | `CONNECTOR_KEYCLOAK_SSO_CLIENT_SECRET` |
| `docs/08` | `sso_app:read`, `sso_app:manage`, both global-only, super_admin only |
| `docs/09` | The `keycloak_sso` target, the third interface family, and `DIRECTORY_TARGETS` |
| `docs/10` | The seven endpoints |
| `docs/12` | The `manage-clients` risk, verbatim from the spec's own section — as an **open** risk |
| `docs/14` | Roadmap: mark OIDC app onboarding done, note SAML and Workspace still open |

- [ ] **Step 5: Full verification**

```bash
pnpm --filter @idm/api test -- --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3
pnpm typecheck
pnpm verify
```

Expected: all green. Report actual output — do not claim completion without it.

- [ ] **Step 6: Commit**

```bash
git add scripts/keycloak-setup.sh .env.example docs
git commit -m "docs(sso-apps): the idm-sso-admin credential and the manage-clients risk"
```

---

## Self-Review

**Spec coverage.** Decisions 1–8: Tasks 1/4 (outbox), 8 (immutable clientId), 2/5 (UUID correlation), 2/5/8 (no delete), 4 (fan-out), 5 (third family), 10 (separate credential), 8 (secret shown once). Data model → 2. Connector + both Keycloak behaviours → 5. Config/credentials → 5/10. Authorization → 7. API + validation rails + error mapping → 3/8. Console → 9. `manage-clients` risk → 3 (denylist + scan) and 10 (docs). All seven listed test categories appear. No spec section is unimplemented.

**Two things the spec asks for that this plan deliberately does differently**, both flagged inline above:

1. **No separate seed migration.** The spec's "Migration order" would fail a fresh-database migrate, because all pending migrations share one transaction. Migration 0017's own header records this. The `connector_targets` row is created at runtime instead, as every other non-keycloak target already is.
2. **`health()` realm-mismatch check** is specified in the spec's Configuration section; Task 5 implements `health()` by delegating to the admin client. The realm comparison against `KEYCLOAK_ISSUER` is not broken out as its own step — fold it into Step 6's `health()` when writing the connector, or it will be missed.

**One thing added beyond the spec:** `DIRECTORY_TARGETS`. The spec makes fan-out aggregate-aware but does not address the five other places that enumerate targets; two of them (attribute mappings, the reconcile CLI) walk users and would offer `keycloak_sso` as a valid choice. Task 1 covers it.

**Placeholder scan:** clean. Every code step carries the actual code. The one deliberate stub — `KeycloakSsoConnectorFactory.configure`'s `throw` — is explicitly marked to be replaced in the same step, after Step 1 confirms the admin client's constructor shape empirically.

**Type consistency:** `targetsForAggregate`, `DIRECTORY_TARGETS`, `ALL_OUTBOX_AGGREGATE_TYPES`, `SsoConnector.applyApp`, `resolveSsoConnector`, `healthFor`, `SsoAppsRepository.findExternalId` are each defined in one task and used with the same name and signature in every later one. `externalId` is the Keycloak UUID throughout — never `clientId`.
