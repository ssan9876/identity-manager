# Mail Server Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `mail_server` as a second real outbox target, so this directory provisions mailboxes and mail-admin records on the counterpart mail server at `D:\mail-server`.

**Architecture:** Four required changes to shared connector machinery (`DesiredUser.userId`, `DesiredUser.status`, `NotApplicableError`, splitting the correlation gate), then a `MailServerConnector` implementing the settled `DirectoryConnector` interface, registered in `ConnectorRegistry` like every other target. Transport is WireGuard with an nginx server block bound to the tunnel address — no application code on either side depends on it.

**Tech Stack:** TypeScript, NestJS 10, Drizzle ORM, Postgres, Vitest, Testcontainers.

## Global Constraints

- **Spec:** `docs/archive/specs/2026-08-07-mail-server-connector-implementation-design.md`. Counterpart contract: `D:\mail-server\docs\superpowers\specs\2026-08-06-idm-sync-design.md`.
- **No credential may ever appear in any payload this connector builds.** The counterpart schema is `extra="forbid"` and would reject one; assert it rather than assume it.
- **Never log or persist a resolved secret.** Secrets resolve by name through `connectors/secrets.ts` `resolveSecret` only.
- **A connector must never open its own database connection.** Every method runs inside `SyncWorker`'s open transaction; a second pool connection reproduces the pool-exhaustion deadlock guarded by `test/pool-exhaustion.spec.ts`.
- **There is no delete.** No `delete` method, no `hard`/`force` flag on `disable`.
- **Postgres forbids using an enum value added by `ALTER TYPE ... ADD VALUE` inside the transaction that added it**, and all pending migrations run in one transaction on a fresh database. No migration may `INSERT` a `connector_targets` row keyed `'mail_server'`.
- Test runner is Vitest. Run a single file with `pnpm --filter @idm/api exec vitest run <path>`.
- **Two spec files**, because the connector's own tests need no database and must not drag in a Testcontainer:
  - `apps/api/test/mail-server-sync.spec.ts` — DB-backed spine changes (Tasks 1-5, 9, 10, 12), using `withTestDatabase()` from `test/support/pg`.
  - `apps/api/test/mail-server.connector.spec.ts` — pure unit tests of `MailServerConnector` with a stubbed `fetch` (Tasks 6-8), matching the existing `echo-connector.spec.ts` / `google-workspace.connector.spec.ts` convention.
- There is **no** `test/helpers/` directory. Shared fixtures live in `test/support/`; each spec file constructs its own repositories and worker locally. Follow that pattern rather than adding a helpers layer.
- Full gate before anything that matters: `pnpm verify`. Fast gate for every commit: `pnpm verify:quick`.

---

### Task 1: Widen the target enums

**Files:**
- Modify: `apps/api/src/db/schema/outbox-events.ts:75-82`
- Modify: `apps/api/src/db/schema/external-identities.ts:18-24`
- Modify: `apps/api/src/connectors/connector.ts:14`
- Create: `apps/api/src/db/migrations/0017_<generated>.sql`
- Test: `apps/api/test/mail-server-sync.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `'mail_server'` as a valid member of the `ConnectorTarget` union, the `outbox_target` pgEnum, and the `external_identity_system` pgEnum.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/mail-server-sync.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { externalIdentitySystem } from '../src/db/schema/external-identities'
import { outboxTarget } from '../src/db/schema/outbox-events'

describe('mail_server target registration', () => {
  it('is a member of the outbox_target enum', () => {
    expect(outboxTarget.enumValues).toContain('mail_server')
  })

  it('is a member of the external_identity_system enum', () => {
    expect(externalIdentitySystem.enumValues).toContain('mail_server')
  })

  it('keeps the two enums one-for-one, so event.target is assignable as system', () => {
    expect([...outboxTarget.enumValues].sort()).toEqual([...externalIdentitySystem.enumValues].sort())
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api exec vitest run test/mail-server-sync.spec.ts`
Expected: FAIL — both `toContain` assertions fail; the enums do not carry `'mail_server'`.

- [ ] **Step 3: Add the value to both enums and the canonical union**

In `apps/api/src/db/schema/outbox-events.ts`, append to `outboxTarget`:

```ts
export const outboxTarget = pgEnum('outbox_target', [
  'keycloak',
  'active_directory',
  'entra_id',
  'google_workspace',
  'echo',
  'mail_server',
])
```

In `apps/api/src/db/schema/external-identities.ts`, append to `externalIdentitySystem`:

```ts
export const externalIdentitySystem = pgEnum('external_identity_system', [
  'keycloak',
  'active_directory',
  'entra_id',
  'google_workspace',
  'echo',
  'mail_server',
])
```

In `apps/api/src/connectors/connector.ts`, widen the canonical union at line 14:

```ts
export type ConnectorTarget =
  | 'keycloak'
  | 'active_directory'
  | 'entra_id'
  | 'google_workspace'
  | 'echo'
  | 'mail_server'
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm --filter @idm/api db:generate`

This writes `apps/api/src/db/migrations/0017_<generated-name>.sql`. Open it and confirm it contains exactly these two statements and nothing else:

```sql
ALTER TYPE "public"."outbox_target" ADD VALUE 'mail_server';--> statement-breakpoint
ALTER TYPE "public"."external_identity_system" ADD VALUE 'mail_server';
```

If drizzle-kit generated anything beyond these two `ADD VALUE` lines, delete the file and investigate — an unrelated schema drift has been picked up.

Add this comment at the top of the generated file, above the first statement:

```sql
-- Postgres forbids USING a value added by ALTER TYPE ... ADD VALUE within the
-- transaction that added it, and every pending migration runs in ONE
-- transaction on a fresh database. So no migration may INSERT a
-- connector_targets row keyed 'mail_server' — that row is created at runtime
-- (or by a test inserting it directly), exactly as the other non-keycloak
-- targets already are. See outbox-events.ts's own outboxTarget doc comment.
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @idm/api exec vitest run test/mail-server-sync.spec.ts`
Expected: PASS — all three tests.

- [ ] **Step 6: Typecheck**

Run: `pnpm verify:quick`
Expected: PASS. `ConnectorRegistry`'s `ImplementedConnectorTarget` is a *narrower* union than `ConnectorTarget`, so widening the wider one does not break it — a target present in `ConnectorTarget` but absent from `ImplementedConnectorTarget` still fails safely at resolve time, by design.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/schema/outbox-events.ts apps/api/src/db/schema/external-identities.ts apps/api/src/connectors/connector.ts apps/api/src/db/migrations/ apps/api/test/mail-server-sync.spec.ts
git commit -m "feat(connectors): register mail_server as a known target"
```

---

### Task 2: Add `DesiredUser.userId`

**Files:**
- Modify: `apps/api/src/connectors/connector.ts` (the `DesiredUser` interface)
- Modify: `apps/api/src/outbox/sync.worker.ts:541-549` (`buildDesiredUser`'s return)
- Test: `apps/api/test/mail-server-sync.spec.ts`

**Interfaces:**
- Consumes: Task 1's `ConnectorTarget`.
- Produces: `DesiredUser.userId: string` — this system's own `users.id` UUID, always populated, for every target. Task 7's `apply()` uses it as the mail server's URL key.

- [ ] **Step 1: Establish the DB-backed preamble and write the failing test**

There is no `test/helpers/` directory in this repo — shared fixtures live in `test/support/`, and each spec file builds its own repos and worker locally. Follow that. Append this preamble to `apps/api/test/mail-server-sync.spec.ts`, once; every later DB-backed task appends `describe` blocks below it.

```ts
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { ConnectorRegistry } from '../src/connectors/connector-registry'
import { GroupsRepository } from '../src/groups/groups.repository'
import { KeycloakAdminClient } from '../src/keycloak/keycloak-admin.client'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { OutboxRepository } from '../src/outbox/outbox.repository'
import { SyncWorker } from '../src/outbox/sync.worker'
import { type User, UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

describe('mail server connector (DB-backed)', () => {
  const ctx = withTestDatabase()
  const usersRepo = () => new UsersRepository(ctx.db)
  const groupsRepo = () => new GroupsRepository(ctx.db)
  const outboxRepo = () => new OutboxRepository()

  let orgUnitId: string
  let tag = 0
  const nextTag = () => ++tag

  // buildDesiredUser never touches Keycloak, and KeycloakAdminClient does no
  // network I/O at construction — so a client pointed at an unreachable
  // issuer is enough, and these tests need no Keycloak container.
  const unusedKeycloak = () =>
    new KeycloakAdminClient({
      issuer: 'http://keycloak.invalid',
      clientId: 'unused',
      clientSecret: 'unused',
      requestTimeoutMs: 1_000,
    })

  const makeWorker = (registry?: ConnectorRegistry) =>
    new SyncWorker(ctx.db, outboxRepo(), usersRepo(), groupsRepo(), unusedKeycloak(), undefined, registry)

  beforeAll(async () => {
    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot(`Mail Connector Root ${Date.now()}`)).id
  })

  async function makeUser(attributes?: Record<string, unknown>): Promise<User> {
    const t = nextTag()
    const username = `mail-user-${t}@acme.com`.toLowerCase()
    return usersRepo().create({
      primaryEmail: username,
      username,
      firstName: 'Mail',
      lastName: `User${t}`,
      orgUnitId,
      attributes,
    })
  }

  describe('DesiredUser.userId', () => {
    it("carries this system's own user id, for every target", async () => {
      const user = await makeUser()
      const desired = await makeWorker().buildDesiredUser(ctx.db, user, 'keycloak')
      expect(desired.userId).toBe(user.id)
    })
  })
})
```

`buildDesiredUser` and `reconcileUser` are both public (`sync.worker.ts:471` and `:396`), so tests call them directly — no harness wrapper is needed or wanted.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api exec vitest run test/mail-server-sync.spec.ts`
Expected: FAIL — `desired.userId` is `undefined`, and TypeScript reports that `userId` does not exist on `DesiredUser`.

- [ ] **Step 3: Add the field to the interface**

In `apps/api/src/connectors/connector.ts`, add as the first field of `DesiredUser`:

```ts
export interface DesiredUser {
  /**
   * THIS system's own `users.id` — not a remote id, and not correlated with
   * anything downstream. REQUIRED and always populated, unlike the optional,
   * target-gated fields below: it costs nothing to compute (the caller
   * already holds the loaded user) and an optional field that is in practice
   * always set is a lie about the shape of the data.
   *
   * Exists because a target may address a principal by OUR id rather than by
   * one of its own. `mail_server` is the first: its provisioning API is
   * `PUT /provisioning/identities/{external_id}` where the key IS this uuid,
   * so without this field that connector cannot construct a URL at all.
   * Keying on `username` instead is explicitly rejected by the counterpart
   * spec — "keying on external_id rather than the address is what makes
   * renames correct" — and a username is mutable here too, so it has the
   * same defect. Targets that correlate by their own immutable id
   * (AD/Entra/Google, via `existingExternalId`) simply ignore this.
   */
  userId: string

  username: string
  // ... existing fields unchanged
}
```

- [ ] **Step 4: Populate it in `buildDesiredUser`**

In `apps/api/src/outbox/sync.worker.ts`, in the object literal `buildDesiredUser` returns (around line 541), add `userId` as the first property:

```ts
    return {
      userId: user.id,
      username: user.username,
      email: user.primaryEmail,
      // ... rest unchanged
    }
```

- [ ] **Step 5: Fix the test fixtures the new required field breaks**

Run: `pnpm --filter @idm/api typecheck`

Every construction site of a `DesiredUser` literal now fails to compile. These are test fixtures only — `buildDesiredUser` is the sole production construction site. For each error, add `userId: '<any stable uuid>'` to the literal. Where the fixture already has a user id in scope, use it; otherwise a fixed literal such as `'00000000-0000-0000-0000-000000000001'` is fine — no test in this repo asserts on a fixture's `userId` except the one written in Step 1.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @idm/api exec vitest run test/mail-server-sync.spec.ts`
Expected: PASS.

Run: `pnpm --filter @idm/api test`
Expected: PASS — the whole suite. No existing connector reads `userId`, so behaviour is unchanged everywhere.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/connectors/connector.ts apps/api/src/outbox/sync.worker.ts apps/api/test/
git commit -m "feat(connectors): carry this system's user id on DesiredUser"
```

---

### Task 3: Add `DesiredUser.status`, gated to `mail_server`

**Files:**
- Modify: `apps/api/src/connectors/connector.ts` (the `DesiredUser` interface)
- Modify: `apps/api/src/outbox/sync.worker.ts` (a new gate constant, and `buildDesiredUser`'s return)
- Test: `apps/api/test/mail-server-sync.spec.ts`

**Interfaces:**
- Consumes: Task 2's `DesiredUser`.
- Produces: `DesiredUser.status?: UserStatus` — the user's full four-value lifecycle status, populated for `'mail_server'` only, `undefined` for every other target. Task 7 maps it straight onto the counterpart's `status` field.

- [ ] **Step 1: Write the failing test**

Append inside the top-level `describe` from Task 2:

```ts
  describe('DesiredUser.status', () => {
    it('carries the full four-value status for mail_server', async () => {
      const user = await makeUser()
      await usersRepo().changeStatus(user.id, 'suspended')
      const reloaded = await usersRepo().findById(user.id)

      const desired = await makeWorker().buildDesiredUser(ctx.db, reloaded!, 'mail_server')
      expect(desired.status).toBe('suspended')
    })

    it('distinguishes suspended from deactivated, which enabled cannot', async () => {
      const suspended = await makeUser()
      await usersRepo().changeStatus(suspended.id, 'suspended')
      const deactivated = await makeUser()
      await usersRepo().changeStatus(deactivated.id, 'deactivated')

      const worker = makeWorker()
      const a = await worker.buildDesiredUser(ctx.db, (await usersRepo().findById(suspended.id))!, 'mail_server')
      const b = await worker.buildDesiredUser(ctx.db, (await usersRepo().findById(deactivated.id))!, 'mail_server')

      // The distinction `enabled` alone loses — and the one that decides
      // whether the counterpart stamps deactivated_at and starts its
      // retention clock.
      expect(a.enabled).toBe(b.enabled)
      expect(a.status).not.toBe(b.status)
    })

    it('is undefined for every other target', async () => {
      const user = await makeUser()
      const worker = makeWorker()
      for (const target of ['keycloak', 'echo', 'active_directory', 'entra_id', 'google_workspace'] as const) {
        const desired = await worker.buildDesiredUser(ctx.db, user, target)
        expect(desired.status).toBeUndefined()
      }
    })
  })
```

If `UsersRepository` has no `findById` returning the updated row, re-read the user with whatever method `sync.worker.spec.ts` uses after its own `changeStatus` calls (around line 389) and mirror that exactly.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api exec vitest run test/mail-server-sync.spec.ts`
Expected: FAIL — `status` does not exist on `DesiredUser`.

- [ ] **Step 3: Add the field to the interface**

In `apps/api/src/connectors/connector.ts`, import the user status type and add the field to `DesiredUser`, after `enabled`:

```ts
import type { UserStatus } from '../db/schema/users'
```

```ts
  /**
   * This user's FULL lifecycle status, for a target whose own model has more
   * than two states. OPTIONAL and target-gated, exactly like `orgUnitPath`
   * above: populated for `'mail_server'` only (see `sync.worker.ts`'s
   * `TARGETS_NEEDING_FULL_STATUS`), `undefined` everywhere else, and
   * structurally invisible to the connectors that ignore it.
   *
   * `enabled` immediately above cannot stand in for this. It is
   * `status === 'active'`, so `pending`, `suspended` and `deactivated` all
   * collapse into one value — and for the mail target that is data loss, not
   * merely lost fidelity: only `deactivated` stamps the counterpart's
   * `deactivated_at`, which starts its retention clock. Map `suspended` onto
   * `deactivated` and a suspended employee's mail is eventually purged; map
   * `deactivated` onto `suspended` and offboarded mail never purges at all.
   * The counterpart spec states the rule directly: "A suspension must never
   * stamp deactivated_at — suspension is not offboarding and must not start
   * the retention clock."
   */
  status?: UserStatus
```

If `UserStatus` is not already exported from `db/schema/users.ts`, export the pgEnum-derived type there rather than hand-rolling a second literal union:

```ts
export type UserStatus = (typeof userStatus.enumValues)[number]
```

- [ ] **Step 4: Add the gate and populate the field**

In `apps/api/src/outbox/sync.worker.ts`, below `TARGETS_NEEDING_IMMUTABLE_ID_CORRELATION` (around line 82), add:

```ts
/**
 * Targets whose own status model has more than the two states `enabled`
 * expresses — see `DesiredUser.status`'s own doc comment for why collapsing
 * four values into a boolean is data loss for the mail target specifically.
 * Its own gate rather than a reuse of the correlation gate above: these are
 * unrelated questions about a target, and `mail_server` needs exactly one of
 * them.
 */
const TARGETS_NEEDING_FULL_STATUS: readonly OutboxTarget[] = ['mail_server']
```

In `buildDesiredUser`'s return literal, after `enabled`:

```ts
      enabled: desiredEnabled,
      status: TARGETS_NEEDING_FULL_STATUS.includes(target) ? user.status : undefined,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @idm/api exec vitest run test/mail-server-sync.spec.ts`
Expected: PASS — all three `DesiredUser.status` tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/connectors/connector.ts apps/api/src/outbox/sync.worker.ts apps/api/src/db/schema/users.ts apps/api/test/mail-server-sync.spec.ts
git commit -m "feat(connectors): carry full lifecycle status for targets that model it"
```

---

### Task 4: Split the correlation gate

**Files:**
- Modify: `apps/api/src/outbox/sync.worker.ts:78-82` (the constant), `:515` and `:526` (its two uses)
- Test: `apps/api/test/mail-server-sync.spec.ts`

**Interfaces:**
- Consumes: Task 3's `sync.worker.ts` changes.
- Produces: `TARGETS_NEEDING_EXTERNAL_ID_CORRELATION` (now including `'mail_server'`) and `TARGETS_NEEDING_MANAGED_ATTRIBUTE_NAMES` (unchanged membership). Task 7's eligibility branch reads `desired.existingExternalId`.

- [ ] **Step 1: Write the failing test**

Append inside the top-level `describe` from Task 2, and add `import { externalIdentities } from '../src/db/schema/external-identities'` to the file's imports:

```ts
  describe('correlation gate', () => {
    it('gives mail_server its prior external id, so it can tell create from entitlement-removal', async () => {
      const user = await makeUser()
      await ctx.db.insert(externalIdentities).values({
        userId: user.id,
        system: 'mail_server',
        externalId: user.id,
        lastSyncedAt: new Date(),
        syncState: 'synced',
      })

      const desired = await makeWorker().buildDesiredUser(ctx.db, user, 'mail_server')
      expect(desired.existingExternalId).toBe(user.id)
    })

    it('does not pay for managed attribute names mail_server never reads', async () => {
      const user = await makeUser()
      const desired = await makeWorker().buildDesiredUser(ctx.db, user, 'mail_server')
      expect(desired.managedAttributeRemoteNames).toBeUndefined()
    })

    it('leaves both halves populated for every target that was already in the gate', async () => {
      const user = await makeUser()
      const worker = makeWorker()
      for (const target of ['active_directory', 'entra_id', 'google_workspace'] as const) {
        const desired = await worker.buildDesiredUser(ctx.db, user, target)
        expect(desired.managedAttributeRemoteNames).toBeDefined()
      }
    })
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api exec vitest run test/mail-server-sync.spec.ts`
Expected: FAIL — the first test gets `undefined` for `existingExternalId`, because `'mail_server'` is not in the single existing gate.

- [ ] **Step 3: Split the constant**

In `apps/api/src/outbox/sync.worker.ts`, replace `TARGETS_NEEDING_IMMUTABLE_ID_CORRELATION` (lines 78-82) with two constants, keeping the existing doc comment above the first and adding the rationale for the split:

```ts
/**
 * Targets that need their own PREVIOUS correlation (`DesiredUser.
 * existingExternalId`) handed to them.
 *
 * SPLIT from a single `TARGETS_NEEDING_IMMUTABLE_ID_CORRELATION` constant
 * that gated this AND `managedAttributeRemoteNames` together. They were one
 * constant only because the three vendor targets happened to need both;
 * `mail_server` needs exactly one, and gating them together would buy it a
 * per-event `listAllRemoteNamesForTarget` query for data it never reads.
 *
 * `mail_server` needs THIS half because its eligibility branch must tell
 * "never had mail" from "had mail, now revoked" — see MailServerConnector.
 * apply's own doc comment. Without it, an ineligible user would be PUT
 * unconditionally, and the counterpart's upsert CREATES on first write: a
 * mailbox row for someone who should never have had one, their address
 * reserved against future collisions, then deactivated.
 */
const TARGETS_NEEDING_EXTERNAL_ID_CORRELATION: readonly OutboxTarget[] = [
  'active_directory',
  'entra_id',
  'google_workspace',
  'mail_server',
]

/** Targets that additionally need every remote name ever mapped for them, to actively CLEAR one whose mapping was just disabled — see `DesiredUser.managedAttributeRemoteNames`'s own doc comment for why an omitted key is not enough on a partial-update API. Membership is unchanged by the split above. */
const TARGETS_NEEDING_MANAGED_ATTRIBUTE_NAMES: readonly OutboxTarget[] = [
  'active_directory',
  'entra_id',
  'google_workspace',
]
```

- [ ] **Step 4: Point each use at its own gate**

At line ~515:

```ts
    const existingExternalId = TARGETS_NEEDING_EXTERNAL_ID_CORRELATION.includes(target)
      ? await this.findExistingExternalId(tx, user.id, target)
      : undefined
```

At line ~526:

```ts
    const managedAttributeRemoteNames = TARGETS_NEEDING_MANAGED_ATTRIBUTE_NAMES.includes(target)
      ? await this.attributeTargetMappingsRepository.listAllRemoteNamesForTarget(target, tx)
      : undefined
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @idm/api exec vitest run test/mail-server-sync.spec.ts`
Expected: PASS.

Run: `pnpm --filter @idm/api test`
Expected: PASS — membership is unchanged for all three vendor targets, so no existing test changes behaviour.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/outbox/sync.worker.ts apps/api/test/mail-server-sync.spec.ts
git commit -m "refactor(outbox): split the correlation gate into its two questions"
```

---

### Task 5: `NotApplicableError` and its handling in `reconcileUser`

**Files:**
- Modify: `apps/api/src/connectors/connector.ts` (the new error class)
- Modify: `apps/api/src/outbox/sync.worker.ts:396-434` (`reconcileUser`)
- Test: `apps/api/test/mail-server-sync.spec.ts`

**Interfaces:**
- Consumes: Task 1's `ConnectorTarget`.
- Produces: `class NotApplicableError extends Error { constructor(readonly target: ConnectorTarget, readonly reason: string) }`. Thrown by a connector's `apply()`; caught by `reconcileUser`, which then commits the event as `done` with no `external_identities` write. Task 7 throws it.

- [ ] **Step 1: Write the failing test**

Append inside the top-level `describe` from Task 2. Test this against the **`echo`** target, not `mail_server`: the handling is generic, and `MailServerConnector` does not exist until Task 6 or resolve until Task 9. Add these imports:

```ts
import { and, eq } from 'drizzle-orm'
import { NotApplicableError } from '../src/connectors/connector'
import { EchoConnector } from '../src/connectors/echo.connector'
import { connectorTargets } from '../src/db/schema/connector-targets'
```

```ts
  describe('NotApplicableError', () => {
    // The connector_targets row is inserted directly rather than by a
    // migration — Postgres forbids using an enum value inside the
    // transaction that added it, which is why every non-keycloak target's
    // tests already seed their own row this way.
    async function enableEcho(): Promise<void> {
      await ctx.db
        .insert(connectorTargets)
        .values({ target: 'echo', enabled: true, config: { credentialSecretName: 'ECHO_SECRET' } })
        .onConflictDoUpdate({ target: connectorTargets.target, set: { enabled: true } })
      process.env.ECHO_SECRET = 'test-secret'
    }

    const identityRows = (userId: string, system: 'echo') =>
      ctx.db
        .select()
        .from(externalIdentities)
        .where(and(eq(externalIdentities.userId, userId), eq(externalIdentities.system, system)))

    it('completes without writing a correlation row', async () => {
      await enableEcho()
      const user = await makeUser()
      const echo = new EchoConnector()
      echo.apply = async () => {
        throw new NotApplicableError('echo', 'nothing to represent for this principal')
      }
      const worker = makeWorker(new ConnectorRegistry(unusedKeycloak(), echo))

      await expect(worker.reconcileUser(ctx.db, user.id, 'echo')).resolves.toBeUndefined()
      expect(await identityRows(user.id, 'echo')).toHaveLength(0)
    })

    it('still propagates every other error, so real failures retry', async () => {
      await enableEcho()
      const user = await makeUser()
      const echo = new EchoConnector()
      echo.apply = async () => {
        throw new Error('target returned 503')
      }
      const worker = makeWorker(new ConnectorRegistry(unusedKeycloak(), echo))

      await expect(worker.reconcileUser(ctx.db, user.id, 'echo')).rejects.toThrow('503')
    })
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api exec vitest run test/mail-server-sync.spec.ts`
Expected: FAIL — `NotApplicableError` is not exported from `connectors/connector.ts`.

- [ ] **Step 3: Define the error**

At the end of `apps/api/src/connectors/connector.ts`:

```ts
/**
 * Thrown by `DirectoryConnector.apply` when this connector has NOTHING to
 * represent for this principal — not a failure, and not something to retry.
 *
 * `apply()` returns `{ externalId: string }` with no null case, and
 * `external_identities.external_id` is `NOT NULL`, so there is otherwise
 * nowhere to express "did nothing, correlate nothing". `SyncWorker.
 * reconcileUser` catches this, skips the correlation upsert, and lets the
 * event complete normally.
 *
 * Deliberately NOT modelled as widening `apply()`'s return to `| null`: that
 * would force all six connectors to acknowledge a case exactly one of them
 * has, against the explicit "do not casually widen a settled interface"
 * discipline `DirectoryConnector`'s own doc comment records. And deliberately
 * NOT modelled as a check hoisted into `SyncWorker`: eligibility is a
 * property of a target, decided at apply time — deciding it at EMISSION time
 * instead is a correctness bug, because a user who becomes ineligible would
 * then emit no event at all and their downstream account would live forever.
 */
export class NotApplicableError extends Error {
  constructor(
    readonly target: ConnectorTarget,
    readonly reason: string,
  ) {
    super(`${target}: nothing to apply for this principal — ${reason}`)
    this.name = 'NotApplicableError'
  }
}
```

- [ ] **Step 4: Handle it in `reconcileUser`**

In `apps/api/src/outbox/sync.worker.ts`, wrap the `apply()` call and make the upsert conditional:

```ts
    const connector = await this.connectorRegistry.resolve(target, tx)

    let externalId: string
    try {
      ;({ externalId } = await connector.apply(desired))
    } catch (error) {
      if (error instanceof NotApplicableError) {
        // Not a failure: this connector has nothing to represent for this
        // user, so there is no id to correlate and nothing to retry. The
        // event completes normally — see NotApplicableError's own doc
        // comment. Every OTHER error falls through to `runOnce`'s existing
        // retry/dead-letter bookkeeping, unchanged.
        return
      }
      throw error
    }

    await tx
      .insert(externalIdentities)
      // ... unchanged
```

Import `NotApplicableError` from `../connectors/connector`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @idm/api exec vitest run test/mail-server-sync.spec.ts`
Expected: PASS — both tests.

Run: `pnpm --filter @idm/api test`
Expected: PASS. No existing connector throws this, so nothing else changes.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/connectors/connector.ts apps/api/src/outbox/sync.worker.ts apps/api/test/mail-server-sync.spec.ts
git commit -m "feat(connectors): let a connector report nothing-to-apply without failing"
```

---

### Task 6: `MailServerConnector` — config, secret, and `health()`

**Files:**
- Create: `apps/api/src/connectors/mail-server.connector.ts`
- Test: `apps/api/test/mail-server.connector.spec.ts`

**Interfaces:**
- Consumes: `resolveSecret` (`connectors/secrets.ts`), `ConnectorHealth` (`connectors/connector.ts`).
- Produces: `class MailServerConnector implements DirectoryConnector` with `configure(config): this`, and a private `request(method, path, body?)` helper returning `{ status: number, body: unknown }`. Tasks 7 and 8 build on `request`.

Config keys read from `connector_targets.config`: `baseUrl` (string, required — e.g. `http://10.8.0.2/api/v1`), `tokenSecretName` (string, required — names an env var), `requestTimeoutMs` (number, optional, default `10_000`).

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/mail-server.connector.spec.ts` — a new file, no database, no Testcontainer:

```ts
import { describe, expect, it, vi } from 'vitest'
import type { DesiredUser } from '../src/connectors/connector'
import { NotApplicableError } from '../src/connectors/connector'
import { MailServerConnector } from '../src/connectors/mail-server.connector'

const CONFIG = {
  baseUrl: 'http://mail.internal/api/v1',
  tokenSecretName: 'CONNECTOR_MAIL_SERVER_TOKEN',
}

describe('MailServerConnector.health', () => {
  it('reports ok when the provisioning health endpoint answers', async () => {
    const fetchStub = vi.fn(async () => new Response('{"status":"ok"}', { status: 200 }))
    const connector = new MailServerConnector(fetchStub).configure(CONFIG)

    const health = await connector.health({ CONNECTOR_MAIL_SERVER_TOKEN: 'tok_abc' })

    expect(health.ok).toBe(true)
    const [url, init] = fetchStub.mock.calls[0]
    expect(url).toBe('http://mail.internal/api/v1/provisioning/health')
    expect(init.headers.Authorization).toBe('Bearer tok_abc')
  })

  it('reports not-ok, never throws, when the secret is unset', async () => {
    const connector = new MailServerConnector(vi.fn()).configure(CONFIG)

    const health = await connector.health({})

    expect(health.ok).toBe(false)
    expect(health.detail).toContain('CONNECTOR_MAIL_SERVER_TOKEN')
  })

  it('never puts the secret VALUE in its health detail', async () => {
    const fetchStub = vi.fn(async () => new Response('nope', { status: 403 }))
    const connector = new MailServerConnector(fetchStub).configure(CONFIG)

    const health = await connector.health({ CONNECTOR_MAIL_SERVER_TOKEN: 'tok_sentinel_value' })

    expect(health.ok).toBe(false)
    expect(health.detail).not.toContain('tok_sentinel_value')
  })

  it('rejects a config that never named a base url', async () => {
    const connector = new MailServerConnector(vi.fn()).configure({ tokenSecretName: 'X' })
    const health = await connector.health({ X: 'tok' })
    expect(health.ok).toBe(false)
    expect(health.detail).toContain('baseUrl')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api exec vitest run test/mail-server.connector.spec.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the connector skeleton**

Create `apps/api/src/connectors/mail-server.connector.ts`:

```ts
import { Injectable } from '@nestjs/common'
import type { ConnectorHealth, DirectoryConnector } from './connector'
import { resolveSecret } from './secrets'

const BASE_URL_KEY = 'baseUrl'
const TOKEN_SECRET_NAME_KEY = 'tokenSecretName'
const REQUEST_TIMEOUT_KEY = 'requestTimeoutMs'
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

/** Injectable so `fetch` can be substituted in tests without touching the global — the same "never network I/O at construction" property every other connector has. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/**
 * The mail-server target — provisions mailboxes and mail-admin records on
 * the counterpart system at `D:\mail-server`, whose own receiving half is
 * already built and merged (its `feat/idm-sync-phase1`). Design:
 * docs/archive/specs/2026-08-07-mail-server-connector-implementation-design.md.
 *
 * NEVER sends a credential, in either direction. There is none to send —
 * Keycloak owns every credential here and does not release them — and the
 * counterpart's payload schema is `extra="forbid"`, so one would be rejected
 * outright. Asserted by test on both sides rather than assumed.
 *
 * Opens no database connection: every method here runs inside `SyncWorker`'s
 * own transaction, and everything this connector needs arrives in `desired`
 * or was bound by `configure()` before any method was called.
 */
@Injectable()
export class MailServerConnector implements DirectoryConnector {
  private config: Record<string, unknown> = {}

  constructor(private readonly fetchImpl: FetchLike = globalThis.fetch) {}

  configure(config: Record<string, unknown>): this {
    this.config = config
    return this
  }

  async health(env: NodeJS.ProcessEnv = process.env): Promise<ConnectorHealth> {
    try {
      const { status } = await this.request('GET', '/provisioning/health', undefined, env)
      return status === 200
        ? { ok: true, detail: `mail server reachable at ${this.baseUrl()}; service token accepted` }
        : { ok: false, detail: `mail server at ${this.baseUrl()} answered ${status} on /provisioning/health` }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * One authenticated round trip. Returns the status rather than throwing on
   * a non-2xx, so callers can map each status to retriable-or-permanent
   * themselves (see `apply`). The resolved token is used and discarded — it
   * is never stored on the instance, returned, or included in any thrown
   * message.
   */
  private async request(
    method: string,
    path: string,
    body: unknown | undefined,
    env: NodeJS.ProcessEnv,
  ): Promise<{ status: number; body: unknown }> {
    const token = resolveSecret(this.requiredString(TOKEN_SECRET_NAME_KEY), env)
    const timeout = typeof this.config[REQUEST_TIMEOUT_KEY] === 'number'
      ? (this.config[REQUEST_TIMEOUT_KEY] as number)
      : DEFAULT_REQUEST_TIMEOUT_MS

    const response = await this.fetchImpl(`${this.baseUrl()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    })

    let parsed: unknown = null
    try {
      parsed = await response.json()
    } catch {
      // A body that is not JSON is not itself an error — the status is what
      // callers map on, and /provisioning/health's 403 has no JSON body.
    }
    return { status: response.status, body: parsed }
  }

  private baseUrl(): string {
    return this.requiredString(BASE_URL_KEY).replace(/\/+$/, '')
  }

  /** Throws a config-shape error (distinct from `MissingSecretError`) naming only the non-sensitive KEY — never a value. Same shape `EchoConnector.secretName` already uses. */
  private requiredString(key: string): string {
    const raw = this.config[key]
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new Error(
        `mail server connector: connector_targets.config.${key} is required and must be a non-empty string`,
      )
    }
    return raw
  }
}
```

Note `health(env)` and `request(..., env)` take the environment explicitly, defaulting to `process.env`. That is what lets the Step 1 tests prove secret handling without mutating the real process environment — the same affordance `resolveSecret` itself already offers.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @idm/api exec vitest run test/mail-server.connector.spec.ts`
Expected: PASS — all four `health` tests. Note `apply`/`disable`/`plan` are not implemented yet, so TypeScript will report `MailServerConnector` does not satisfy `DirectoryConnector`; add temporary stubs that `throw new Error('not implemented')` to get a clean typecheck, and replace them in Tasks 7 and 8.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/connectors/mail-server.connector.ts apps/api/test/mail-server.connector.spec.ts
git commit -m "feat(connectors): add the mail server connector's transport and health check"
```

---

### Task 7: `MailServerConnector.apply()` — eligibility and payload

**Files:**
- Modify: `apps/api/src/connectors/mail-server.connector.ts`
- Test: `apps/api/test/mail-server.connector.spec.ts`

**Interfaces:**
- Consumes: Task 5's `NotApplicableError`, Task 6's `request`, Tasks 2-4's `DesiredUser` fields (`userId`, `status`, `existingExternalId`).
- Produces: `apply(desired): Promise<{ externalId: string }>` returning `desired.userId`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/mail-server.connector.spec.ts`. Add a helper first:

```ts
function buildDesired(overrides: Partial<DesiredUser> = {}): DesiredUser {
  return {
    userId: '11111111-1111-1111-1111-111111111111',
    username: 'jdoe',
    email: 'jane@acme.com',
    firstName: 'Jane',
    lastName: 'Doe',
    enabled: true,
    status: 'active',
    attributes: { mail_enabled: ['true'] },
    groups: [],
    ...overrides,
  }
}

function okResponse() {
  return new Response(JSON.stringify({ external_id: 'x', status: 'active', aliases: [] }), { status: 200 })
}

describe('MailServerConnector.apply', () => {
  const ENV = { CONNECTOR_MAIL_SERVER_TOKEN: 'tok' }

  it('PUTs to the identity keyed by our own user id, and returns it', async () => {
    const fetchStub = vi.fn(async () => okResponse())
    const connector = new MailServerConnector(fetchStub).configure(CONFIG)

    const result = await connector.apply(buildDesired(), ENV)

    const [url, init] = fetchStub.mock.calls[0]
    expect(url).toBe('http://mail.internal/api/v1/provisioning/identities/11111111-1111-1111-1111-111111111111')
    expect(init.method).toBe('PUT')
    expect(result.externalId).toBe('11111111-1111-1111-1111-111111111111')
  })

  it('passes the full four-value status straight through', async () => {
    for (const status of ['pending', 'active', 'suspended', 'deactivated'] as const) {
      const fetchStub = vi.fn(async () => okResponse())
      const connector = new MailServerConnector(fetchStub).configure(CONFIG)
      await connector.apply(buildDesired({ status }), ENV)
      expect(JSON.parse(fetchStub.mock.calls[0][1].body).status).toBe(status)
    }
  })

  it('throws NotApplicable for a user with no mail and no existing identity', async () => {
    const fetchStub = vi.fn()
    const connector = new MailServerConnector(fetchStub).configure(CONFIG)

    await expect(
      connector.apply(buildDesired({ attributes: { mail_enabled: ['false'] } }), ENV),
    ).rejects.toBeInstanceOf(NotApplicableError)

    // The important half: it must not PUT, or the counterpart's upsert would
    // CREATE a mailbox for someone who should never have had one.
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('deactivates a user who had mail and no longer does — entitlement removal', async () => {
    const fetchStub = vi.fn(async () => okResponse())
    const connector = new MailServerConnector(fetchStub).configure(CONFIG)

    await connector.apply(
      buildDesired({
        status: 'active',
        attributes: { mail_enabled: ['false'] },
        existingExternalId: '11111111-1111-1111-1111-111111111111',
      }),
      ENV,
    )

    // Forced to deactivated even though the directory record is still active.
    expect(JSON.parse(fetchStub.mock.calls[0][1].body).status).toBe('deactivated')
  })

  it('omits absent optional fields rather than sending null', async () => {
    const fetchStub = vi.fn(async () => okResponse())
    const connector = new MailServerConnector(fetchStub).configure(CONFIG)

    await connector.apply(buildDesired({ attributes: { mail_enabled: ['true'] } }), ENV)

    const body = JSON.parse(fetchStub.mock.calls[0][1].body)
    // The counterpart rejects an explicit null for quota_mb and aliases, and
    // gives absent-vs-null different meanings for every scalar.
    expect('quota_mb' in body).toBe(false)
    expect('aliases' in body).toBe(false)
    expect(body.email).toBe('jane@acme.com')
  })

  it('maps quota, aliases and admin role from attributes', async () => {
    const fetchStub = vi.fn(async () => okResponse())
    const connector = new MailServerConnector(fetchStub).configure(CONFIG)

    await connector.apply(
      buildDesired({
        attributes: {
          mail_enabled: ['true'],
          mail_quota_mb: ['4096'],
          mail_aliases: ['j.doe@acme.com', 'jd@acme.com'],
          mail_admin_role: ['domain_admin'],
        },
      }),
      ENV,
    )

    const body = JSON.parse(fetchStub.mock.calls[0][1].body)
    expect(body.quota_mb).toBe(4096)
    expect(body.aliases).toEqual(['j.doe@acme.com', 'jd@acme.com'])
    // domain_admin's domain is derived from the user's own primary email.
    expect(body.admin).toEqual({ role: 'domain_admin', domains: ['acme.com'] })
  })

  it('never builds a payload containing a credential field', async () => {
    const fetchStub = vi.fn(async () => okResponse())
    const connector = new MailServerConnector(fetchStub).configure(CONFIG)

    await connector.apply(
      buildDesired({
        attributes: { mail_enabled: ['true'], password: ['hunter2'], password_hash: ['$2b$x'] },
      }),
      ENV,
    )

    const body = JSON.parse(fetchStub.mock.calls[0][1].body)
    expect(Object.keys(body).sort()).toEqual(['email', 'status', 'username'])
    expect(JSON.stringify(body)).not.toContain('hunter2')
  })

  it.each([
    [409, 'permanent'],
    [422, 'permanent'],
    [403, 'retriable'],
    [500, 'retriable'],
    [503, 'retriable'],
  ])('maps %i to a %s failure', async (status, kind) => {
    const fetchStub = vi.fn(async () => new Response('{"detail":"nope"}', { status }))
    const connector = new MailServerConnector(fetchStub).configure(CONFIG)

    const error = await connector.apply(buildDesired(), ENV).catch((e) => e)

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain(String(status))
    expect((error as { permanent?: boolean }).permanent ?? false).toBe(kind === 'permanent')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @idm/api exec vitest run test/mail-server.connector.spec.ts`
Expected: FAIL — `apply` throws `'not implemented'`.

- [ ] **Step 3: Implement `apply`**

Replace the `apply` stub in `apps/api/src/connectors/mail-server.connector.ts`:

```ts
  /**
   * Three eligibility outcomes, per the design's own table:
   *
   *  - not mail-enabled, no prior identity -> `NotApplicableError`. Nothing
   *    was ever created there, so there is nothing to do and nothing to
   *    correlate. Critically it must NOT `PUT`: the counterpart's upsert
   *    CREATES on first write, so pushing `deactivated` here would create a
   *    mailbox for someone who should never have had one, reserve their
   *    address against future collisions, and then deactivate it.
   *  - not mail-enabled, prior identity exists -> `PUT` forcing
   *    `deactivated`. This is ENTITLEMENT REMOVAL: mail access revoked while
   *    the person stays active in the directory, which is why the forced
   *    status deliberately disagrees with `desired.status`.
   *  - mail-enabled -> `PUT` the full desired state.
   *
   * Eligibility is decided HERE, at apply time, never at emission. If
   * `OutboxWriter` only emitted mail events for mail-enabled users, then
   * flipping `mail_enabled` to false would emit nothing at all and the
   * mailbox would live forever. The optimisation looks attractive every time
   * someone reads this fresh; it is a correctness bug.
   */
  async apply(
    desired: DesiredUser,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<{ externalId: string }> {
    const enabled = readBoolean(desired.attributes, 'mail_enabled')

    if (!enabled && desired.existingExternalId === undefined) {
      throw new NotApplicableError('mail_server', 'user is not mail-enabled and has no mailbox here')
    }

    const payload = enabled
      ? this.buildPayload(desired, desired.status ?? 'active')
      : this.buildPayload(desired, 'deactivated', { minimal: true })

    const { status, body } = await this.request(
      'PUT',
      `/provisioning/identities/${encodeURIComponent(desired.userId)}`,
      payload,
      env,
    )

    if (status !== 200) {
      throw new MailServerRequestError(status, body)
    }
    return { externalId: desired.userId }
  }

  /**
   * A CLOSED payload — every field is named here explicitly, so no attribute
   * can reach the counterpart just by existing. Default-deny holds
   * structurally rather than by a flag: there is nowhere in this object to
   * put an unrecognised key. That is a stronger property than the Keycloak
   * path, where `buildSyncedAttributes` must actively filter, and it is why
   * the counterpart has no free-form attribute bag either.
   *
   * Absent means ABSENT, never null. The counterpart gives absent and null
   * different meanings for every scalar, and rejects an explicit null for
   * `quota_mb` and `aliases` outright.
   */
  private buildPayload(
    desired: DesiredUser,
    status: string,
    options: { minimal?: boolean } = {},
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      username: desired.username,
      email: desired.email,
      status,
    }
    if (options.minimal === true) {
      return payload
    }

    const displayName = [desired.firstName, desired.lastName].filter((part) => part.length > 0).join(' ')
    if (displayName.length > 0) {
      payload.display_name = displayName
    }

    const quota = readNumber(desired.attributes, 'mail_quota_mb')
    if (quota !== undefined) {
      payload.quota_mb = quota
    }

    const aliases = desired.attributes.mail_aliases
    if (aliases !== undefined) {
      payload.aliases = [...aliases]
    }

    const role = desired.attributes.mail_admin_role?.[0]
    if (role === 'domain_admin' || role === 'superadmin') {
      // The administered domain is derived from the user's own address — a
      // settled simplification (design doc): it covers someone administering
      // the domain they are in, and avoids a list-valued attribute that is
      // awkward to edit in the console.
      const domain = desired.email.split('@').pop() ?? ''
      payload.admin = { role, domains: role === 'domain_admin' && domain.length > 0 ? [domain] : [] }
    }

    return payload
  }
```

Add these module-level helpers and the error class:

```ts
function readBoolean(attributes: Record<string, string[]>, key: string): boolean {
  return attributes[key]?.[0]?.toLowerCase() === 'true'
}

function readNumber(attributes: Record<string, string[]>, key: string): number | undefined {
  const raw = attributes[key]?.[0]
  if (raw === undefined) {
    return undefined
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * A non-200 from the provisioning API. `permanent` is what the counterpart's
 * own spec asks callers to distinguish: "409 and 422 are permanent failures
 * the connector should dead-letter rather than retry forever; 5xx is
 * retriable." A 403 is retriable on purpose — a revoked or expired service
 * token is an operator fix that should heal without replaying events, and
 * `health()` is what makes it legible meanwhile.
 */
export class MailServerRequestError extends Error {
  readonly permanent: boolean

  constructor(
    readonly status: number,
    readonly responseBody: unknown,
  ) {
    super(`mail server returned ${status}: ${JSON.stringify(responseBody)}`)
    this.name = 'MailServerRequestError'
    this.permanent = status === 409 || status === 422
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @idm/api exec vitest run test/mail-server.connector.spec.ts`
Expected: PASS — every `apply` test.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/connectors/mail-server.connector.ts apps/api/test/mail-server.connector.spec.ts
git commit -m "feat(connectors): converge mail identities from desired state"
```

---

### Task 8: `MailServerConnector.plan()` and `disable()`

**Files:**
- Modify: `apps/api/src/connectors/mail-server.connector.ts`
- Test: `apps/api/test/mail-server.connector.spec.ts`

**Interfaces:**
- Consumes: Task 7's `buildPayload` and `request`.
- Produces: the complete `DirectoryConnector` implementation — no stubs remain.

- [ ] **Step 1: Write the failing tests**

```ts
describe('MailServerConnector.plan', () => {
  const ENV = { CONNECTOR_MAIL_SERVER_TOKEN: 'tok' }

  it('describes the upsert without writing anything', async () => {
    const fetchStub = vi.fn()
    const connector = new MailServerConnector(fetchStub).configure(CONFIG)

    const ops = await connector.plan(buildDesired(), ENV)

    expect(ops).toHaveLength(1)
    expect(ops[0].description).toContain('jane@acme.com')
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('reports nothing for a user with no mail and no identity', async () => {
    const connector = new MailServerConnector(vi.fn()).configure(CONFIG)
    const ops = await connector.plan(buildDesired({ attributes: { mail_enabled: ['false'] } }), ENV)
    expect(ops).toEqual([])
  })
})

describe('MailServerConnector.disable', () => {
  const ENV = { CONNECTOR_MAIL_SERVER_TOKEN: 'tok' }
  const ID = '11111111-1111-1111-1111-111111111111'

  it('reads the current address, then deactivates', async () => {
    const fetchStub = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ external_id: ID, email: 'jane@acme.com', status: 'active', aliases: [] }), { status: 200 }),
      )
      .mockResolvedValueOnce(okResponse())

    await new MailServerConnector(fetchStub).configure(CONFIG).disable(ID, ENV)

    expect(fetchStub.mock.calls[0][1].method).toBe('GET')
    const [url, init] = fetchStub.mock.calls[1]
    expect(init.method).toBe('PUT')
    expect(url).toBe(`http://mail.internal/api/v1/provisioning/identities/${ID}`)
    expect(JSON.parse(init.body)).toEqual({ email: 'jane@acme.com', status: 'deactivated' })
  })

  it('is a no-op for an unknown identity', async () => {
    const fetchStub = vi.fn(async () => new Response('{"detail":"not found"}', { status: 404 }))
    await new MailServerConnector(fetchStub).configure(CONFIG).disable(ID, ENV)
    expect(fetchStub).toHaveBeenCalledTimes(1)
  })

  it('is a no-op for an identity with no mailbox to deactivate', async () => {
    const fetchStub = vi.fn(async () =>
      new Response(JSON.stringify({ external_id: ID, email: null, status: 'active', aliases: [] }), { status: 200 }),
    )
    await new MailServerConnector(fetchStub).configure(CONFIG).disable(ID, ENV)
    expect(fetchStub).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @idm/api exec vitest run test/mail-server.connector.spec.ts`
Expected: FAIL — both methods still throw `'not implemented'`.

- [ ] **Step 3: Implement both**

```ts
  async plan(
    desired: DesiredUser,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<ConnectorOperation[]> {
    const enabled = readBoolean(desired.attributes, 'mail_enabled')
    if (!enabled && desired.existingExternalId === undefined) {
      return []
    }
    // A plan writes NOTHING, including no read against the target — the
    // counterpart's own GET is cheap but not free, and every other
    // connector's plan() is answerable from desired state plus what the
    // caller already handed us.
    const status = enabled ? (desired.status ?? 'active') : 'deactivated'
    const kind = desired.existingExternalId === undefined ? 'create' : status === 'deactivated' ? 'disable' : 'update'
    return [
      {
        kind,
        description: `${kind} mail identity for ${desired.email} (status=${status})`,
      },
    ]
  }

  /**
   * The documented last-resort removal path. Currently UNREACHABLE — nothing
   * in this codebase calls `disable()` on any connector, and
   * `TargetReconciliationJob` documents that it deliberately never will,
   * because a principal whose desired state is "not enabled" is asserted
   * through `apply()` like every other desired-state assertion. Implemented
   * correctly anyway so the escape hatch is real rather than a trap for
   * whoever first wires it up.
   *
   * Needs the current address because the counterpart's upsert requires
   * `email` and `status` (every other field is optional), and this method
   * takes no user data by contract — so it reads the address back before
   * writing. A 404, or an identity with no mailbox, is a no-op: there is
   * nothing there to deactivate.
   */
  async disable(externalId: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const path = `/provisioning/identities/${encodeURIComponent(externalId)}`
    const current = await this.request('GET', path, undefined, env)

    if (current.status === 404) {
      return
    }
    if (current.status !== 200) {
      throw new MailServerRequestError(current.status, current.body)
    }

    const email = (current.body as { email?: string | null } | null)?.email
    if (typeof email !== 'string' || email.length === 0) {
      return
    }

    const { status, body } = await this.request('PUT', path, { email, status: 'deactivated' }, env)
    if (status !== 200) {
      throw new MailServerRequestError(status, body)
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @idm/api exec vitest run test/mail-server.connector.spec.ts`
Expected: PASS.

Run: `pnpm --filter @idm/api typecheck`
Expected: PASS — `MailServerConnector` now fully satisfies `DirectoryConnector` with no stubs.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/connectors/mail-server.connector.ts apps/api/test/mail-server.connector.spec.ts
git commit -m "feat(connectors): complete the mail connector with plan and disable"
```

---

### Task 9: Register the connector

**Files:**
- Modify: `apps/api/src/connectors/connector-registry.ts` (the `ImplementedConnectorTarget` union, the constructor, the `factories` literal)
- Modify: `apps/api/src/app.module.ts` (provider registration)
- Test: `apps/api/test/mail-server-sync.spec.ts`

**Interfaces:**
- Consumes: Task 8's complete `MailServerConnector`.
- Produces: `ConnectorRegistry.resolve('mail_server', tx)` returning a configured `MailServerConnector`.

- [ ] **Step 1: Write the failing test**

Append inside the top-level `describe` in `apps/api/test/mail-server-sync.spec.ts`, and add `import { MailServerConnector } from '../src/connectors/mail-server.connector'`:

```ts
  describe('ConnectorRegistry', () => {
    it('resolves mail_server to a configured MailServerConnector', async () => {
      await ctx.db
        .insert(connectorTargets)
        .values({
          target: 'mail_server',
          enabled: true,
          config: { baseUrl: 'http://mail.internal/api/v1', tokenSecretName: 'CONNECTOR_MAIL_SERVER_TOKEN' },
        })
        .onConflictDoUpdate({ target: connectorTargets.target, set: { enabled: true } })

      const registry = new ConnectorRegistry(unusedKeycloak())
      const connector = await registry.resolve('mail_server', ctx.db)

      expect(connector).toBeInstanceOf(MailServerConnector)
    })
  })
```

The `connector_targets` row is inserted by the test, not a migration — Postgres forbids using an enum value inside the transaction that added it, and the existing `active_directory` tests already seed their own rows this way for the same reason.

Before writing this, read `test/connector-registry.spec.ts` and confirm `resolve`'s exact signature and how its existing tests seed a target; if they differ from the above, mirror them rather than this sketch.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api exec vitest run test/mail-server-sync.spec.ts`
Expected: FAIL — resolve rejects, because `'mail_server'` is not in `ImplementedConnectorTarget`.

- [ ] **Step 3: Widen the registry**

In `apps/api/src/connectors/connector-registry.ts`:

```ts
type ImplementedConnectorTarget =
  | 'keycloak'
  | 'echo'
  | 'active_directory'
  | 'entra_id'
  | 'google_workspace'
  | 'mail_server'
```

Add the constructor parameter, following the identical `@Optional()`-with-JS-default shape every other connector already uses:

```ts
    // The SAME `@Optional()`-with-JS-default shape as the connectors above,
    // for the identical reason: a raw `new ConnectorRegistry(keycloak)` (every
    // earlier test in this file) keeps compiling and working via the TS
    // default, while real Nest DI hands every caller the ONE registered
    // instance instead.
    @Optional()
    @Inject(MailServerConnector)
    private readonly mailServerConnector: MailServerConnector = new MailServerConnector(),
```

Add the factory to the `factories` literal — the one that carries `satisfies Record<ImplementedConnectorTarget, ConnectorFactory>`, so a missing entry is a compile error rather than a runtime surprise:

```ts
      mail_server: (config) => this.mailServerConnector.configure(config),
```

- [ ] **Step 4: Register the provider**

In `apps/api/src/app.module.ts`, add `MailServerConnector` to the `providers` array alongside `EchoConnector`, `ActiveDirectoryConnector`, `EntraIdConnector` and `GoogleWorkspaceConnector`. Nest reflects every constructor parameter's type regardless of a JS default, so an unregistered class parameter fails DI resolution even with the default written at the call site.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @idm/api exec vitest run test/mail-server-sync.spec.ts`
Expected: PASS.

Run: `pnpm --filter @idm/api test`
Expected: PASS — including `app.module.spec.ts`'s DI-graph smoke test, which is what catches a missing provider registration.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/connectors/connector-registry.ts apps/api/src/app.module.ts apps/api/test/mail-server-sync.spec.ts
git commit -m "feat(connectors): register the mail server connector in the spine"
```

---

### Task 10: Seed the four attribute definitions

**Files:**
- Create: `apps/api/src/db/migrations/0018_<generated>.sql` (or a seed step — see Step 3)
- Test: `apps/api/test/mail-server-sync.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `attribute_definitions` rows keyed `mail_enabled`, `mail_quota_mb`, `mail_aliases`, `mail_admin_role`, all `applies_to = 'user'`. Task 7's `apply()` reads these keys off `desired.attributes`.

- [ ] **Step 1: Write the failing test**

Append inside the top-level `describe` in `apps/api/test/mail-server-sync.spec.ts`, adding `import { inArray } from 'drizzle-orm'` and `import { attributeDefinitions } from '../src/db/schema/attribute-definitions'`:

```ts
  describe('mail attribute definitions', () => {
    it('seeds the four keys the connector reads', async () => {
      const rows = await ctx.db
        .select()
        .from(attributeDefinitions)
        .where(
          inArray(attributeDefinitions.key, [
            'mail_enabled',
            'mail_quota_mb',
            'mail_aliases',
            'mail_admin_role',
          ]),
        )

      expect(rows).toHaveLength(4)
      expect(rows.find((r) => r.key === 'mail_enabled')?.dataType).toBe('boolean')
      expect(rows.find((r) => r.key === 'mail_quota_mb')?.dataType).toBe('number')
      // Default-deny for self-editing, like every other definition here.
      expect(rows.every((r) => r.selfEditable === false)).toBe(true)
    })
  })
```

`withTestDatabase()` runs migrations against a fresh container, so the seed migration written in Step 3 is what makes these rows exist.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api exec vitest run test/mail-server-sync.spec.ts`
Expected: FAIL — zero rows.

- [ ] **Step 3: Write the seed migration**

Create a hand-written migration file (drizzle-kit generates schema diffs, not data seeds, so this one is authored by hand). Name it with the next sequence number after Task 1's, and register it in the migrations journal the same way the generated ones are — check `apps/api/src/db/migrations/meta/_journal.json` and follow the existing entry shape exactly.

```sql
-- The four well-known attribute keys `MailServerConnector` reads. Seeded
-- rather than hardcoded so an admin can see and edit them in the console
-- like any other definition. `mail_aliases` is `string`: the multi-value
-- shape is carried by `user_attributes`' own storage, not by a distinct
-- data type. ON CONFLICT DO NOTHING so re-running against a database that
-- already has them is a no-op — the same idempotence every operator script
-- in this repo promises.
INSERT INTO "attribute_definitions" ("key", "label", "data_type", "applies_to", "self_editable", "sort_order")
VALUES
  ('mail_enabled',    'Mail enabled',      'boolean', 'user', false, 100),
  ('mail_quota_mb',   'Mailbox quota (MB)','number',  'user', false, 101),
  ('mail_aliases',    'Mail aliases',      'string',  'user', false, 102),
  ('mail_admin_role', 'Mail admin role',   'string',  'user', false, 103)
ON CONFLICT ("key", "applies_to") DO NOTHING;
```

Confirm the conflict target matches `attribute_definitions_key_scope_unique`'s actual columns (`key`, `applies_to`) — read `apps/api/src/db/schema/attribute-definitions.ts:58` and adjust if the index carries a third column.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @idm/api exec vitest run test/mail-server-sync.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/migrations/
git commit -m "feat(attributes): seed the four mail attribute definitions"
```

---

### Task 11: Transport — nginx server block and deployment runbook

**Files:**
- Create: `D:\mail-server\docker\nginx\templates\20-provisioning.conf.template`
- Create: `docs/11-operations.md`
- Modify: `.env.example` (document `CONNECTOR_MAIL_SERVER_TOKEN`)

**Interfaces:**
- Consumes: Task 6's config keys (`baseUrl`, `tokenSecretName`).
- Produces: a documented, reproducible path from this system to the counterpart's provisioning API across two hosts. No application code depends on it.

This task spans both repositories and finishes with a documented runbook rather than a test — provisioning the tunnel needs the actual hosts. Land the config and the doc; the operator runs the WireGuard steps.

- [ ] **Step 1: Write the nginx server block**

In the mail-server repo, create `docker/nginx/templates/20-provisioning.conf.template`:

```nginx
# IdM provisioning, reachable ONLY over the WireGuard tunnel.
#
# The public server block (10-https.conf.template) keeps its
# `location ^~ /api/v1/provisioning { return 404; }` untouched — this is a
# SECOND listener bound to the tunnel address, not a hole in the first one.
# That is what keeps the counterpart spec's own security argument literally
# true ("a leaked token is useless from outside") rather than replacing it
# with a different argument.
server {
    listen ${WIREGUARD_ADDRESS}:80;
    server_name _;

    # Required once provisioning is reachable from beyond the internal Docker
    # network — the counterpart spec flags that its own routes carry no
    # application-level limiter, and nginx's limiter never saw them before
    # because the public block returns 404 first.
    limit_req zone=provisioning burst=20 nodelay;

    location /api/v1/provisioning {
        proxy_pass http://backend:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        return 404;
    }
}
```

Add the matching `limit_req_zone` to the http-level config alongside the existing zones:

```nginx
limit_req_zone $binary_remote_addr zone=provisioning:1m rate=30r/s;
```

- [ ] **Step 2: Write the runbook**

Create `docs/11-operations.md` covering, in order: generating a WireGuard keypair on each host; the VPS as server (it holds the public IP) and this host as a peer dialing out with `PersistentKeepalive`; binding the nginx template above to the VPS's tunnel address; issuing a provisioning service token on the mail server (`POST /api/v1/idm/tokens`, superadmin JWT, raw token returned exactly once); putting that token in this repo's environment under `CONNECTOR_MAIL_SERVER_TOKEN`; and inserting the `connector_targets` row:

```sql
INSERT INTO connector_targets (target, enabled, config)
VALUES ('mail_server', true, '{"baseUrl":"http://10.8.0.2/api/v1","tokenSecretName":"CONNECTOR_MAIL_SERVER_TOKEN"}'::jsonb);
```

State explicitly that this row cannot be created by a migration: Postgres forbids using an enum value inside the transaction that added it, and all pending migrations run in one transaction on a fresh database.

- [ ] **Step 3: Document the secret**

In `.env.example`, alongside the other connector secrets:

```bash
# Service token for the mail server's provisioning API. Issued there via
# POST /api/v1/idm/tokens (superadmin), returned exactly once, stored only as
# a SHA-256 hash on that side. Referenced BY NAME from
# connector_targets.config.tokenSecretName — never stored in the database.
CONNECTOR_MAIL_SERVER_TOKEN=
```

- [ ] **Step 4: Write the contract smoke script**

This is the one check that catches **contract drift**, which no unit test can: a stub we write can be wrong in exactly the way the connector is wrong. Because the counterpart's schema is closed (`extra="forbid"`) and its own seven test files already prove its behaviour, a single real round trip covers essentially all of it.

Create `apps/api/scripts/smoke-mail.ts`, following `scripts/smoke-dev.ts`'s shape (read it first — it is the pattern this repo already uses for "prove it against the real thing"):

```ts
import { MailServerConnector } from '../src/connectors/mail-server.connector'
import type { DesiredUser } from '../src/connectors/connector'

/**
 * Proves the payload this connector BUILDS is one the mail server ACCEPTS.
 *
 * Unit tests assert what we send; the counterpart's own suite asserts what it
 * accepts. Neither can see a disagreement between the two. This makes exactly
 * one real round trip against a running mail server and asserts 200.
 *
 * Requires: a reachable mail server (tunnel up), CONNECTOR_MAIL_SERVER_TOKEN
 * set, MAIL_SERVER_BASE_URL set, and the target domain already hosted there —
 * the mail server never auto-creates domains.
 */
const baseUrl = process.env.MAIL_SERVER_BASE_URL
const smokeEmail = process.env.MAIL_SMOKE_EMAIL

if (baseUrl === undefined || smokeEmail === undefined) {
  console.error('[smoke:mail] set MAIL_SERVER_BASE_URL and MAIL_SMOKE_EMAIL (an address in a domain hosted there)')
  process.exit(1)
}

const connector = new MailServerConnector().configure({
  baseUrl,
  tokenSecretName: 'CONNECTOR_MAIL_SERVER_TOKEN',
})

const health = await connector.health()
if (!health.ok) {
  console.error(`[smoke:mail] health check failed: ${health.detail}`)
  process.exit(1)
}
console.log(`[smoke:mail] health ok — ${health.detail}`)

// A deliberately fixed uuid, so re-running converges the SAME identity rather
// than accumulating smoke-test mailboxes. The counterpart is declarative and
// idempotent by contract, so a second run must be a no-op.
const desired: DesiredUser = {
  userId: '00000000-0000-4000-8000-000000000001',
  username: 'idm-smoke',
  email: smokeEmail,
  firstName: 'IdM',
  lastName: 'Smoke',
  enabled: false,
  status: 'suspended',
  attributes: { mail_enabled: ['true'] },
  groups: [],
}

const { externalId } = await connector.apply(desired)
console.log(`[smoke:mail] upsert accepted — external id ${externalId}`)

// Idempotence is the property the counterpart's reconciliation depends on.
await connector.apply(desired)
console.log('[smoke:mail] re-push accepted — contract holds')
```

Register it in `apps/api/package.json` alongside `smoke:dev`:

```json
    "smoke:mail": "tsx --env-file-if-exists=../../.env scripts/smoke-mail.ts",
```

The identity is created **suspended**, never active — a smoke run must not produce a live, deliverable mailbox.

- [ ] **Step 5: Run both checks against the real stack**

Run: `pnpm --filter @idm/api target-reconcile -- --target mail_server --dry-run`
Expected: a plan, not a connection error. `MissingSecretError` means the env var is unset; a 403 means the service token is wrong or revoked.

Run: `pnpm --filter @idm/api smoke:mail`
Expected: three lines — health ok, upsert accepted, re-push accepted. A `422` naming a domain means `MAIL_SMOKE_EMAIL` is in a domain the mail server does not host.

- [ ] **Step 6: Commit**

```bash
git add docs/11-operations.md .env.example apps/api/scripts/smoke-mail.ts apps/api/package.json
git commit -m "feat(smoke): prove the mail provisioning contract against a real server"
```

Commit the nginx template separately, in the mail-server repo.

---

### Task 12 (optional): Dead-letter permanent failures immediately

Deferrable. Without it, a `409`/`422` still dead-letters — after 8 attempts and roughly 40 minutes, during which per-aggregate ordering stalls that one user's mail sync. Land it when that latency starts mattering.

**Files:**
- Modify: `apps/api/src/outbox/sync.worker.ts` (the `handleFailure` path around line 244)
- Test: `apps/api/test/mail-server-sync.spec.ts`

**Interfaces:**
- Consumes: Task 7's `MailServerRequestError.permanent`.
- Produces: an event whose error is permanent transitions straight to `failed`, skipping backoff.

- [ ] **Step 1: Write the failing test**

Append inside the top-level `describe` in `apps/api/test/mail-server-sync.spec.ts`. `runOnce()` takes no arguments and returns `'processed' | 'idle'` (`sync.worker.ts:211`), so the assertion reads the event row back rather than a return value:

```ts
  describe('permanent failures', () => {
    it('dead-letters on the first attempt instead of burning the backoff', async () => {
      await enableEcho()
      const user = await makeUser()
      await usersRepo().changeStatus(user.id, 'active')

      const echo = new EchoConnector()
      echo.apply = async () => {
        throw new MailServerRequestError(409, { detail: 'address already taken' })
      }
      const worker = makeWorker(new ConnectorRegistry(unusedKeycloak(), echo))

      expect(await worker.runOnce()).toBe('processed')

      const [event] = await ctx.db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, user.id))
        .orderBy(desc(outboxEvents.id))
        .limit(1)

      expect(event.status).toBe('failed')
      expect(event.attempts).toBe(1)
    })
  })
```

Add `import { desc } from 'drizzle-orm'`, `import { outboxEvents } from '../src/db/schema/outbox-events'`, and `import { MailServerRequestError } from '../src/connectors/mail-server.connector'`. Reuse the `enableEcho()` helper written in Task 5.

Read how `sync.worker.spec.ts` drives `runOnce()` and asserts on a dead-lettered row before writing this — mirror its exact approach to emitting the event that `runOnce` will claim.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api exec vitest run test/mail-server-sync.spec.ts`
Expected: FAIL — status is `pending` with a `next_attempt_at` in the future, not `failed`.

- [ ] **Step 3: Add the fast path**

In the failure-handling method around line 244, before the `attempts >= maxAttempts` check:

```ts
    // A permanent failure is one no amount of retrying can fix — an address
    // collision, an unhosted domain, a malformed payload. The counterpart's
    // own spec asks callers to distinguish these: "409 and 422 are permanent
    // failures the connector should dead-letter rather than retry forever."
    // Retrying them burns the full backoff schedule AND, because ordering is
    // per (aggregate, target), head-of-line blocks every later event for that
    // same principal on that same target for the duration.
    const permanent = error instanceof Error && (error as { permanent?: boolean }).permanent === true
    if (permanent || attempts >= this.config.maxAttempts) {
      await this.outboxRepository.markFailed(tx, id, { attempts, lastError })
      return
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @idm/api test`
Expected: PASS — no existing error carries `permanent`, so every current path is unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/outbox/sync.worker.ts apps/api/test/mail-server-sync.spec.ts
git commit -m "feat(outbox): dead-letter permanent failures without burning the backoff"
```

---

## Final verification

- [ ] Run the full gate: `pnpm verify`
- [ ] Confirm the mail server's own suite still passes: `cd D:\mail-server && pytest backend/tests -q`
- [ ] Smoke the contract against a running mail server, per Task 11 Step 4.
