# Identity Provider — Milestone 3a (RBAC Engine + Audit Log) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the scoped role-based permission engine, the privilege-escalation guards, and the append-only audit log — then enforce authorization on every existing read endpoint.

**Architecture:** Roles are a fixed catalog in code mapped to a `role_key` Postgres enum; `role_assignments` binds a user to a role at an optional org-unit scope, where a NULL scope means global. Permission checks reduce to an indexed `ltree` containment test against the target's current org unit, re-evaluated per request and never cached into a session. The audit log is append-only at the database level — a trigger raises on UPDATE and DELETE — and its writer takes a transaction handle so an audit row and the mutation it describes commit together or not at all.

**Tech Stack:** TypeScript, NestJS 10, Drizzle ORM, Postgres 16 (`ltree`, triggers, recursive CTEs), Zod, Vitest, Testcontainers.

**Source spec:** `docs/superpowers/specs/2026-08-04-identity-provider-core-design.md`
**Builds on:** Milestone 1 (`f00a61c`) and Milestone 2 (`a391570`), both merged to `master`.

## Global Constraints

- **The system never generates, transmits, or stores a credential.** No password column, no hashing, no login form. Keycloak owns credentials.
- **Attribute propagation is default-deny.** `sync_to_keycloak` and `self_editable` default to `false`.
- **There is no delete operation for users.** Users transition to `deactivated` (terminal). No `DELETE` against `users`.
- **Deactivated users are excluded from all default list and search views.**
- **Authorization is enforced in the API, never in the UI.**
- **Postgres and Keycloak are tested with Testcontainers, never mocks.**
- Single tenant. No `tenant_id` anywhere.
- TypeScript `strict: true`. No `any`, `as any`, `@ts-ignore`, or `@ts-expect-error`.
- Node 20+, pnpm 9+.
- Any task changing `package.json` commits `pnpm-lock.yaml` in the same commit.
- Any task changing a Drizzle schema runs `pnpm --filter @idm/api db:generate` and commits the generated migration and `meta/` files. Never hand-edit them.
- Controllers use explicit `@Inject(Token)` for every constructor dependency. Bare-class constructor typing depends on `design:paramtypes` metadata and has already produced one production-breaking defect in this project.

### Constraints specific to this milestone

- **Still READ-ONLY.** No `POST`/`PUT`/`PATCH`/`DELETE` route. Milestone 3b adds write endpoints once this engine exists. Role assignment in this milestone is seeded directly in tests and via the repository, not over HTTP.
- **Permission checks fail closed.** An authenticated principal that cannot be resolved to a local user, or that holds no applicable role, is denied. Never default to allow.
- **Scope is evaluated per request against the target's current org unit.** Never cache a resolved scope into a token, session, or module-level variable — moving a user between org units must take effect on the next request.

---

## File Structure

```
apps/api/src/
├── common/
│   ├── errors.ts                       # MODIFIED: add ForbiddenError
│   ├── domain-exception.filter.ts      # MODIFIED: map FORBIDDEN -> 403
│   └── http/
│       └── parse-id.ts                 # NEW: the uuid helper, de-triplicated
├── authz/
│   ├── actions.ts                      # NEW: Action union + ROLE_PERMISSIONS catalog
│   ├── role-assignments.repository.ts  # NEW: read/write role assignments
│   ├── permission.engine.ts            # NEW: can / assertCan / scopePathsFor / resolveActor
│   ├── privilege.guards.ts             # NEW: escalation guards
│   ├── require-permission.decorator.ts # NEW: @RequirePermission(action)
│   └── permission.guard.ts             # NEW: Nest guard wiring the engine to routes
├── audit/
│   ├── audit.writer.ts                 # NEW: transactional append-only writer
│   └── audit.repository.ts             # NEW: read side for the Auditor role
└── db/schema/
    ├── role-assignments.ts             # NEW
    └── audit-log.ts                    # NEW
```

`authz/` is its own directory because the permission engine is the project's security boundary and must be reviewable in one place. `audit/` sits beside it rather than inside it — audit records what happened regardless of whether authorization was involved.

---

### Task 1: De-triplicate the id helper and harden guard coverage

Carried cleanups from Milestone 2's final review. This lands first because every later task touches controllers, and doing it later means a merge conflict with itself.

**Files:**
- Create: `apps/api/src/common/http/parse-id.ts`
- Modify: `apps/api/src/users/users.controller.ts`, `apps/api/src/org-units/org-units.controller.ts`, `apps/api/src/groups/groups.controller.ts`
- Modify: `apps/api/test/guard-coverage.spec.ts`
- Test: `apps/api/test/parse-id.spec.ts`

**Interfaces:**
- Consumes: `ValidationError` from `src/common/errors.ts`
- Produces: `parseId(raw: unknown, field?: string): string` — returns the UUID, throws `ValidationError` naming the field otherwise

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/parse-id.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ValidationError } from '../src/common/errors'
import { parseId } from '../src/common/http/parse-id'

describe('parseId', () => {
  const valid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

  it('returns a valid uuid unchanged', () => {
    expect(parseId(valid)).toBe(valid)
  })

  it('rejects a non-uuid with ValidationError', () => {
    expect(() => parseId('not-a-uuid')).toThrow(ValidationError)
  })

  it('names the default field "id" in the issue', () => {
    try {
      parseId('nope')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as ValidationError).issues.join()).toContain('id')
    }
  })

  it('names a custom field when supplied', () => {
    try {
      parseId('nope', 'userId')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as ValidationError).issues.join()).toContain('userId')
    }
  })

  it('rejects non-string input rather than coercing it', () => {
    expect(() => parseId(42)).toThrow(ValidationError)
    expect(() => parseId(null)).toThrow(ValidationError)
    expect(() => parseId(undefined)).toThrow(ValidationError)
    expect(() => parseId(['a'])).toThrow(ValidationError)
  })
})
```

Replace the body of `apps/api/test/guard-coverage.spec.ts` with a version that walks Nest's module graph instead of reading only `AppModule`, so the check does not silently degrade when Milestone 3b splits controllers into feature modules:

```ts
import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { JwtGuard } from '../src/auth/jwt.guard'

/** Only the liveness probe may be reached without authentication. */
const OPEN_BY_DESIGN = new Set(['HealthController'])

type Ctor = new (...args: never[]) => unknown

/** Collect controllers from a module and every module it imports, transitively. */
function collectControllers(module: unknown, seen = new Set<unknown>()): Ctor[] {
  if (typeof module !== 'function' || seen.has(module)) {
    return []
  }
  seen.add(module)

  const own: Ctor[] = Reflect.getMetadata('controllers', module) ?? []
  const imports: unknown[] = Reflect.getMetadata('imports', module) ?? []

  return imports.reduce<Ctor[]>(
    (all, imported) => all.concat(collectControllers(imported, seen)),
    own,
  )
}

describe('guard coverage', () => {
  it('finds controllers through the whole module graph, not just AppModule', () => {
    const found = collectControllers(AppModule).map((c) => c.name).sort()
    // If a controller is added or renamed, update this list deliberately.
    expect(found).toEqual(
      [
        'GroupsController',
        'HealthController',
        'MeController',
        'OrgUnitsController',
        'UsersController',
      ].sort(),
    )
  })

  it('applies JwtGuard to every controller except the health endpoint', () => {
    const unguarded = collectControllers(AppModule)
      .filter((controller) => !OPEN_BY_DESIGN.has(controller.name))
      .filter((controller) => {
        const guards: unknown[] = Reflect.getMetadata('__guards__', controller) ?? []
        return !guards.includes(JwtGuard)
      })
      .map((controller) => controller.name)

    expect(unguarded).toEqual([])
  })
})
```

The explicit expected-name list is the point: a new controller fails the test until someone consciously adds it, which is exactly the review moment we want.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @idm/api test parse-id guard-coverage`
Expected: FAIL — cannot resolve `../src/common/http/parse-id`.

- [ ] **Step 3: Write the implementation**

`apps/api/src/common/http/parse-id.ts`:
```ts
import { z } from 'zod'
import { ValidationError } from '../errors'

const uuidSchema = z.string().uuid()

/**
 * Parses a path or query parameter as a UUID.
 * Rejects non-strings rather than coercing — a caller passing an array or a
 * number is a malformed request, not something to guess at.
 */
export function parseId(raw: unknown, field = 'id'): string {
  const parsed = uuidSchema.safeParse(raw)

  if (!parsed.success) {
    throw new ValidationError([`${field}: must be a UUID`])
  }

  return parsed.data
}
```

In each of the three controllers, delete the local `uuidSchema` const and the local `parseId` function, and import the shared one:
```ts
import { parseId } from '../common/http/parse-id'
```
Leave every call site unchanged — the signature is compatible. In `users.controller.ts`, the `orgUnitId` call site becomes `parseId(query.orgUnitId, 'orgUnitId')` so the error names the right field.

- [ ] **Step 4: Run the full suite**

Run:
```bash
pnpm --filter @idm/api test
pnpm --filter @idm/api build
```
Expected: all 147 existing tests still pass, plus 5 new `parse-id` tests and the reworked guard-coverage. Build exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "refactor: extract shared parseId helper and harden guard coverage"
```

---

### Task 2: Roles catalog, `role_assignments` schema and repository

**Files:**
- Create: `apps/api/src/authz/actions.ts`, `apps/api/src/db/schema/role-assignments.ts`, `apps/api/src/authz/role-assignments.repository.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Test: `apps/api/test/actions.spec.ts`, `apps/api/test/role-assignments.repository.spec.ts`

**Interfaces:**
- Consumes: `orgUnits`, `users` tables; `ConflictError`, `NotFoundError`; `DB_CLIENT`
- Produces:
  - `type RoleKey = 'super_admin' | 'user_admin' | 'help_desk' | 'auditor' | 'read_only'`
  - `type Action = 'user:read' | 'user:create' | 'user:update' | 'user:deactivate' | 'group:read' | 'group:create' | 'group:update' | 'group:manage_members' | 'org_unit:read' | 'org_unit:create' | 'role:assign' | 'audit:read'`
  - `const ROLE_PERMISSIONS: Record<RoleKey, readonly Action[]>`
  - `const ROLE_RANK: Record<RoleKey, number>`
  - `const ALL_ROLE_KEYS: readonly RoleKey[]`, `const ALL_ACTIONS: readonly Action[]`
  - `roleAssignments` table, `roleKey` pg enum
  - `interface RoleAssignment { id: string; userId: string; roleKey: RoleKey; scopeOrgUnitId: string | null; createdAt: Date }`
  - `class RoleAssignmentsRepository` with `assign(input: { userId: string; roleKey: RoleKey; scopeOrgUnitId?: string | null }): Promise<RoleAssignment>`, `revoke(id: string): Promise<void>`, `listForUser(userId: string): Promise<RoleAssignment[]>`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/actions.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  ALL_ACTIONS,
  ALL_ROLE_KEYS,
  ROLE_PERMISSIONS,
  ROLE_RANK,
} from '../src/authz/actions'

describe('role catalog', () => {
  it('defines permissions for every role', () => {
    for (const role of ALL_ROLE_KEYS) {
      expect(ROLE_PERMISSIONS[role]).toBeDefined()
    }
  })

  it('defines a rank for every role', () => {
    for (const role of ALL_ROLE_KEYS) {
      expect(typeof ROLE_RANK[role]).toBe('number')
    }
  })

  it('grants super_admin every action', () => {
    expect([...ROLE_PERMISSIONS.super_admin].sort()).toEqual([...ALL_ACTIONS].sort())
  })

  it('ranks super_admin above every other role', () => {
    for (const role of ALL_ROLE_KEYS.filter((r) => r !== 'super_admin')) {
      expect(ROLE_RANK.super_admin).toBeGreaterThan(ROLE_RANK[role])
    }
  })

  it('gives read_only no mutating action', () => {
    for (const action of ROLE_PERMISSIONS.read_only) {
      expect(action.endsWith(':read')).toBe(true)
    }
  })

  it('gives auditor read access to the audit log and nothing mutating', () => {
    expect(ROLE_PERMISSIONS.auditor).toContain('audit:read')
    for (const action of ROLE_PERMISSIONS.auditor) {
      expect(action.endsWith(':read')).toBe(true)
    }
  })

  it('reserves role:assign to super_admin alone', () => {
    for (const role of ALL_ROLE_KEYS.filter((r) => r !== 'super_admin')) {
      expect(ROLE_PERMISSIONS[role]).not.toContain('role:assign')
    }
  })

  it('references no action outside the declared union', () => {
    const known = new Set<string>(ALL_ACTIONS)
    for (const role of ALL_ROLE_KEYS) {
      for (const action of ROLE_PERMISSIONS[role]) {
        expect(known.has(action)).toBe(true)
      }
    }
  })
})
```

Create `apps/api/test/role-assignments.repository.spec.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { ConflictError, NotFoundError } from '../src/common/errors'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

const MISSING = '00000000-0000-0000-0000-000000000000'

describe('RoleAssignmentsRepository', () => {
  const ctx = withTestDatabase()
  let roles: RoleAssignmentsRepository
  let users: UsersRepository
  let rootId: string
  let salesId: string
  let userId: string

  beforeEach(async () => {
    await ctx.pool.query('TRUNCATE TABLE role_assignments, users, org_units CASCADE')
    roles = new RoleAssignmentsRepository(ctx.db)
    users = new UsersRepository(ctx.db)
    const orgUnits = new OrgUnitsRepository(ctx.db)
    const root = await orgUnits.createRoot('Acme Corp')
    rootId = root.id
    salesId = (await orgUnits.createChild(root.id, 'Sales')).id
    userId = (
      await users.create({
        primaryEmail: 'ada@example.com',
        username: 'ada',
        firstName: 'Ada',
        lastName: 'Lovelace',
        orgUnitId: rootId,
      })
    ).id
  })

  it('assigns a globally scoped role when no scope is given', async () => {
    const assignment = await roles.assign({ userId, roleKey: 'super_admin' })
    expect(assignment.roleKey).toBe('super_admin')
    expect(assignment.scopeOrgUnitId).toBeNull()
  })

  it('assigns a role scoped to an org unit', async () => {
    const assignment = await roles.assign({
      userId,
      roleKey: 'help_desk',
      scopeOrgUnitId: salesId,
    })
    expect(assignment.scopeOrgUnitId).toBe(salesId)
  })

  it('lists every assignment for a user', async () => {
    await roles.assign({ userId, roleKey: 'read_only' })
    await roles.assign({ userId, roleKey: 'help_desk', scopeOrgUnitId: salesId })
    expect(await roles.listForUser(userId)).toHaveLength(2)
  })

  it('returns an empty list for a user with no assignments', async () => {
    expect(await roles.listForUser(MISSING)).toEqual([])
  })

  it('rejects a duplicate role at the same scope with ConflictError', async () => {
    await roles.assign({ userId, roleKey: 'help_desk', scopeOrgUnitId: salesId })
    await expect(
      roles.assign({ userId, roleKey: 'help_desk', scopeOrgUnitId: salesId }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('allows the same role at two different scopes', async () => {
    await roles.assign({ userId, roleKey: 'help_desk', scopeOrgUnitId: salesId })
    await expect(
      roles.assign({ userId, roleKey: 'help_desk', scopeOrgUnitId: rootId }),
    ).resolves.toBeDefined()
  })

  it('treats a global assignment as distinct from a scoped one', async () => {
    await roles.assign({ userId, roleKey: 'help_desk' })
    await expect(
      roles.assign({ userId, roleKey: 'help_desk', scopeOrgUnitId: salesId }),
    ).resolves.toBeDefined()
  })

  it('rejects a duplicate global assignment with ConflictError', async () => {
    await roles.assign({ userId, roleKey: 'auditor' })
    await expect(roles.assign({ userId, roleKey: 'auditor' })).rejects.toBeInstanceOf(
      ConflictError,
    )
  })

  it('raises NotFoundError for a missing user', async () => {
    await expect(
      roles.assign({ userId: MISSING, roleKey: 'read_only' }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('raises NotFoundError for a missing scope org unit', async () => {
    await expect(
      roles.assign({ userId, roleKey: 'read_only', scopeOrgUnitId: MISSING }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('revokes an assignment', async () => {
    const assignment = await roles.assign({ userId, roleKey: 'read_only' })
    await roles.revoke(assignment.id)
    expect(await roles.listForUser(userId)).toEqual([])
  })
})
```

The "global is distinct from scoped" pair matters: a partial unique index over a nullable column does not treat NULLs as equal in Postgres, so the duplicate-global case needs its own guard.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @idm/api test actions role-assignments`
Expected: FAIL — cannot resolve `../src/authz/actions`.

- [ ] **Step 3: Write the implementation**

`apps/api/src/authz/actions.ts`:
```ts
export type RoleKey =
  | 'super_admin'
  | 'user_admin'
  | 'help_desk'
  | 'auditor'
  | 'read_only'

export type Action =
  | 'user:read'
  | 'user:create'
  | 'user:update'
  | 'user:deactivate'
  | 'group:read'
  | 'group:create'
  | 'group:update'
  | 'group:manage_members'
  | 'org_unit:read'
  | 'org_unit:create'
  | 'role:assign'
  | 'audit:read'

export const ALL_ROLE_KEYS: readonly RoleKey[] = [
  'super_admin',
  'user_admin',
  'help_desk',
  'auditor',
  'read_only',
]

export const ALL_ACTIONS: readonly Action[] = [
  'user:read',
  'user:create',
  'user:update',
  'user:deactivate',
  'group:read',
  'group:create',
  'group:update',
  'group:manage_members',
  'org_unit:read',
  'org_unit:create',
  'role:assign',
  'audit:read',
]

const READ_ONLY_ACTIONS: readonly Action[] = ['user:read', 'group:read', 'org_unit:read']

/**
 * The catalog is deliberately static code rather than database rows: a
 * permission table is itself a privilege-escalation surface, and these grants
 * should only change through code review.
 */
export const ROLE_PERMISSIONS: Record<RoleKey, readonly Action[]> = {
  super_admin: ALL_ACTIONS,
  user_admin: [
    'user:read',
    'user:create',
    'user:update',
    'user:deactivate',
    'group:read',
    'group:create',
    'group:update',
    'group:manage_members',
    'org_unit:read',
  ],
  help_desk: ['user:read', 'user:update', 'group:read', 'org_unit:read'],
  auditor: [...READ_ONLY_ACTIONS, 'audit:read'],
  read_only: READ_ONLY_ACTIONS,
}

/** Higher outranks lower. Used only by the privilege-escalation guards. */
export const ROLE_RANK: Record<RoleKey, number> = {
  super_admin: 40,
  user_admin: 30,
  help_desk: 20,
  auditor: 10,
  read_only: 0,
}
```

`apps/api/src/db/schema/role-assignments.ts`:
```ts
import { sql } from 'drizzle-orm'
import {
  index,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { orgUnits } from './org-units'
import { users } from './users'

export const roleKey = pgEnum('role_key', [
  'super_admin',
  'user_admin',
  'help_desk',
  'auditor',
  'read_only',
])

export const roleAssignments = pgTable(
  'role_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleKey: roleKey('role_key').notNull(),
    // NULL scope means the role applies across the whole directory.
    scopeOrgUnitId: uuid('scope_org_unit_id').references(() => orgUnits.id, {
      onDelete: 'cascade',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userIdx: index('role_assignments_user_idx').on(table.userId),
    // Two partial indexes: Postgres does not treat NULLs as equal, so a single
    // unique index over (user, role, scope) would permit unlimited duplicate
    // global assignments.
    scopedUnique: uniqueIndex('role_assignments_scoped_unique')
      .on(table.userId, table.roleKey, table.scopeOrgUnitId)
      .where(sql`${table.scopeOrgUnitId} IS NOT NULL`),
    globalUnique: uniqueIndex('role_assignments_global_unique')
      .on(table.userId, table.roleKey)
      .where(sql`${table.scopeOrgUnitId} IS NULL`),
  }),
)
```

Add `export * from './role-assignments'` to `apps/api/src/db/schema/index.ts`, keeping every existing export.

`apps/api/src/authz/role-assignments.repository.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import { ConflictError, NotFoundError } from '../common/errors'
import * as schema from '../db/schema/index'
import { orgUnits } from '../db/schema/org-units'
import { roleAssignments } from '../db/schema/role-assignments'
import { users } from '../db/schema/users'
import type { RoleKey } from './actions'

export interface RoleAssignment {
  id: string
  userId: string
  roleKey: RoleKey
  scopeOrgUnitId: string | null
  createdAt: Date
}

export interface AssignRoleInput {
  userId: string
  roleKey: RoleKey
  scopeOrgUnitId?: string | null
}

const UNIQUE_VIOLATION = '23505'

@Injectable()
export class RoleAssignmentsRepository {
  constructor(
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async assign(input: AssignRoleInput): Promise<RoleAssignment> {
    const [user] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)

    if (user === undefined) {
      throw new NotFoundError('user', input.userId)
    }

    const scopeOrgUnitId = input.scopeOrgUnitId ?? null

    if (scopeOrgUnitId !== null) {
      const [scope] = await this.db
        .select({ id: orgUnits.id })
        .from(orgUnits)
        .where(eq(orgUnits.id, scopeOrgUnitId))
        .limit(1)

      if (scope === undefined) {
        throw new NotFoundError('org unit', scopeOrgUnitId)
      }
    }

    try {
      const [row] = await this.db
        .insert(roleAssignments)
        .values({ userId: input.userId, roleKey: input.roleKey, scopeOrgUnitId })
        .returning()

      return row as RoleAssignment
    } catch (cause) {
      if ((cause as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new ConflictError(
          `user ${input.userId} already holds ${input.roleKey} at this scope`,
        )
      }
      throw cause
    }
  }

  async revoke(id: string): Promise<void> {
    await this.db.delete(roleAssignments).where(eq(roleAssignments.id, id))
  }

  async listForUser(userId: string): Promise<RoleAssignment[]> {
    const rows = await this.db
      .select()
      .from(roleAssignments)
      .where(eq(roleAssignments.userId, userId))

    return rows as RoleAssignment[]
  }
}
```

- [ ] **Step 4: Generate the migration and run the tests**

Run:
```bash
pnpm --filter @idm/api db:generate
pnpm --filter @idm/api test actions role-assignments
pnpm --filter @idm/api build
```
Expected: PASS — 8 catalog tests and 11 repository tests. Confirm the generated SQL contains BOTH partial unique indexes with their `WHERE` clauses; paste it into your report.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat: add role catalog and scoped role assignments"
```

---

### Task 3: Permission engine

**Files:**
- Create: `apps/api/src/authz/permission.engine.ts`
- Modify: `apps/api/src/common/errors.ts`, `apps/api/src/common/domain-exception.filter.ts`
- Test: `apps/api/test/permission.engine.spec.ts`

**Interfaces:**
- Consumes: `RoleAssignmentsRepository`, `ROLE_PERMISSIONS`, `OrgUnitsRepository.isWithinScope`, `UsersRepository`, `Principal`
- Produces:
  - `class ForbiddenError extends DomainError` — `code = 'FORBIDDEN'`, mapped to HTTP 403
  - `interface Actor { userId: string; orgUnitId: string; assignments: RoleAssignment[] }`
  - `class PermissionEngine` with:
    - `resolveActor(principal: Principal): Promise<Actor>` — throws `ForbiddenError` when the principal maps to no active local user
    - `can(actor: Actor, action: Action, targetOrgUnitId?: string): Promise<boolean>`
    - `assertCan(actor: Actor, action: Action, targetOrgUnitId?: string): Promise<void>` — throws `ForbiddenError`
    - `scopePathsFor(actor: Actor, action: Action): Promise<string[] | null>` — `null` means unrestricted

**How a Keycloak principal maps to a local user:** by `username`, case-insensitively, matching `Principal.preferred_username`. The sync design in the spec pushes our `username` to Keycloak, so the two are the same value by construction. This is an interim link — Milestone 4 introduces `external_identities`, which stores the Keycloak subject and becomes the authoritative mapping. Record that in a comment so it is replaced rather than forgotten.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/permission.engine.spec.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { ForbiddenError } from '../src/common/errors'
import { PermissionEngine } from '../src/authz/permission.engine'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

describe('PermissionEngine', () => {
  const ctx = withTestDatabase()
  let engine: PermissionEngine
  let roles: RoleAssignmentsRepository
  let users: UsersRepository
  let orgUnits: OrgUnitsRepository
  let rootId: string
  let salesId: string
  let emeaId: string
  let engId: string

  beforeEach(async () => {
    await ctx.pool.query('TRUNCATE TABLE role_assignments, users, org_units CASCADE')
    roles = new RoleAssignmentsRepository(ctx.db)
    users = new UsersRepository(ctx.db)
    orgUnits = new OrgUnitsRepository(ctx.db)
    engine = new PermissionEngine(ctx.db)

    const root = await orgUnits.createRoot('Acme Corp')
    rootId = root.id
    salesId = (await orgUnits.createChild(root.id, 'Sales')).id
    emeaId = (await orgUnits.createChild(salesId, 'EMEA')).id
    engId = (await orgUnits.createChild(root.id, 'Engineering')).id
  })

  const makeUser = (username: string, orgUnitId: string) =>
    users.create({
      primaryEmail: `${username}@example.com`,
      username,
      firstName: 'Test',
      lastName: 'User',
      orgUnitId,
    })

  it('resolves a principal to a local user by username, case-insensitively', async () => {
    const user = await makeUser('ada', rootId)
    const actor = await engine.resolveActor({
      subject: 'kc-1',
      username: 'ADA',
      email: 'ada@example.com',
    })
    expect(actor.userId).toBe(user.id)
  })

  it('denies a principal that maps to no local user', async () => {
    await expect(
      engine.resolveActor({ subject: 'kc-x', username: 'ghost', email: null }),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('denies a principal whose local user is deactivated', async () => {
    const user = await makeUser('ada', rootId)
    await users.changeStatus(user.id, 'active')
    await users.changeStatus(user.id, 'deactivated')

    await expect(
      engine.resolveActor({ subject: 'kc-1', username: 'ada', email: null }),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('denies every action to an actor with no roles', async () => {
    await makeUser('ada', rootId)
    const actor = await engine.resolveActor({ subject: 'k', username: 'ada', email: null })
    expect(await engine.can(actor, 'user:read')).toBe(false)
    expect(await engine.can(actor, 'user:read', salesId)).toBe(false)
  })

  it('grants a globally scoped role everywhere', async () => {
    const user = await makeUser('ada', rootId)
    await roles.assign({ userId: user.id, roleKey: 'user_admin' })
    const actor = await engine.resolveActor({ subject: 'k', username: 'ada', email: null })

    expect(await engine.can(actor, 'user:read', emeaId)).toBe(true)
    expect(await engine.can(actor, 'user:read', engId)).toBe(true)
    expect(await engine.scopePathsFor(actor, 'user:read')).toBeNull()
  })

  it('grants a scoped role only within its subtree', async () => {
    const user = await makeUser('ada', rootId)
    await roles.assign({ userId: user.id, roleKey: 'help_desk', scopeOrgUnitId: salesId })
    const actor = await engine.resolveActor({ subject: 'k', username: 'ada', email: null })

    expect(await engine.can(actor, 'user:read', salesId)).toBe(true)
    expect(await engine.can(actor, 'user:read', emeaId)).toBe(true)
    expect(await engine.can(actor, 'user:read', engId)).toBe(false)
    expect(await engine.can(actor, 'user:read', rootId)).toBe(false)
  })

  it('denies an action the role does not grant, even inside scope', async () => {
    const user = await makeUser('ada', rootId)
    await roles.assign({ userId: user.id, roleKey: 'help_desk', scopeOrgUnitId: salesId })
    const actor = await engine.resolveActor({ subject: 'k', username: 'ada', email: null })

    expect(await engine.can(actor, 'user:create', salesId)).toBe(false)
    expect(await engine.can(actor, 'audit:read', salesId)).toBe(false)
  })

  it('returns the scope paths a restricted actor may see', async () => {
    const user = await makeUser('ada', rootId)
    await roles.assign({ userId: user.id, roleKey: 'help_desk', scopeOrgUnitId: salesId })
    const actor = await engine.resolveActor({ subject: 'k', username: 'ada', email: null })

    expect(await engine.scopePathsFor(actor, 'user:read')).toEqual(['acme_corp.sales'])
    expect(await engine.scopePathsFor(actor, 'user:create')).toEqual([])
  })

  it('unions scopes when the actor holds the role at two places', async () => {
    const user = await makeUser('ada', rootId)
    await roles.assign({ userId: user.id, roleKey: 'help_desk', scopeOrgUnitId: salesId })
    await roles.assign({ userId: user.id, roleKey: 'help_desk', scopeOrgUnitId: engId })
    const actor = await engine.resolveActor({ subject: 'k', username: 'ada', email: null })

    const paths = await engine.scopePathsFor(actor, 'user:read')
    expect(paths?.sort()).toEqual(['acme_corp.engineering', 'acme_corp.sales'])
  })

  it('assertCan throws ForbiddenError when denied and is silent when allowed', async () => {
    const user = await makeUser('ada', rootId)
    await roles.assign({ userId: user.id, roleKey: 'help_desk', scopeOrgUnitId: salesId })
    const actor = await engine.resolveActor({ subject: 'k', username: 'ada', email: null })

    await expect(engine.assertCan(actor, 'user:read', engId)).rejects.toBeInstanceOf(
      ForbiddenError,
    )
    await expect(engine.assertCan(actor, 'user:read', salesId)).resolves.toBeUndefined()
  })

  it('re-evaluates scope against the org unit as it is now, not as it was', async () => {
    const user = await makeUser('ada', rootId)
    const target = await makeUser('bob', engId)
    await roles.assign({ userId: user.id, roleKey: 'help_desk', scopeOrgUnitId: salesId })
    const actor = await engine.resolveActor({ subject: 'k', username: 'ada', email: null })

    expect(await engine.can(actor, 'user:read', target.orgUnitId)).toBe(false)

    // Move the target into the actor's scope; the next check must reflect it.
    await ctx.pool.query('UPDATE users SET org_unit_id = $1 WHERE id = $2', [
      emeaId,
      target.id,
    ])
    const moved = await users.findById(target.id)
    expect(await engine.can(actor, 'user:read', moved?.orgUnitId)).toBe(true)
  })
})
```

The last test encodes the spec's "scope is evaluated per request, never cached" requirement as something executable.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api test permission.engine`
Expected: FAIL — cannot resolve `../src/authz/permission.engine`.

- [ ] **Step 3: Write the implementation**

Add to `apps/api/src/common/errors.ts`:
```ts
export class ForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN'
}
```

Add to the `STATUS_BY_CODE` table in `apps/api/src/common/domain-exception.filter.ts`:
```ts
  FORBIDDEN: HttpStatus.FORBIDDEN,
```

`apps/api/src/authz/permission.engine.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { Principal } from '../auth/jwt.guard'
import { DB_CLIENT } from '../common/db.token'
import { ForbiddenError } from '../common/errors'
import * as schema from '../db/schema/index'
import { orgUnits } from '../db/schema/org-units'
import { roleAssignments } from '../db/schema/role-assignments'
import { users } from '../db/schema/users'
import { ROLE_PERMISSIONS, type Action, type RoleKey } from './actions'

export interface ActorAssignment {
  roleKey: RoleKey
  scopeOrgUnitId: string | null
  scopePath: string | null
}

export interface Actor {
  userId: string
  username: string
  orgUnitId: string
  assignments: ActorAssignment[]
}

@Injectable()
export class PermissionEngine {
  constructor(
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Maps an authenticated Keycloak principal onto a local user by username.
   * The sync design pushes our `username` to Keycloak, so `preferred_username`
   * is the same value by construction.
   *
   * INTERIM: Milestone 4 introduces `external_identities`, which stores the
   * Keycloak subject and becomes the authoritative mapping. Replace this then.
   *
   * Fails closed: an unmatched or non-active principal is denied, never
   * treated as an anonymous or default actor.
   */
  async resolveActor(principal: Principal): Promise<Actor> {
    const [row] = await this.db
      .select({
        id: users.id,
        username: users.username,
        orgUnitId: users.orgUnitId,
        status: users.status,
      })
      .from(users)
      .where(sql`lower(${users.username}) = lower(${principal.username})`)
      .limit(1)

    if (row === undefined) {
      throw new ForbiddenError('principal does not map to a known user')
    }

    if (row.status === 'deactivated' || row.status === 'suspended') {
      throw new ForbiddenError('principal does not map to an active user')
    }

    const assignments = await this.db
      .select({
        roleKey: roleAssignments.roleKey,
        scopeOrgUnitId: roleAssignments.scopeOrgUnitId,
        scopePath: orgUnits.path,
      })
      .from(roleAssignments)
      .leftJoin(orgUnits, eq(roleAssignments.scopeOrgUnitId, orgUnits.id))
      .where(eq(roleAssignments.userId, row.id))

    return {
      userId: row.id,
      username: row.username,
      orgUnitId: row.orgUnitId,
      assignments: assignments as ActorAssignment[],
    }
  }

  private grantingAssignments(actor: Actor, action: Action): ActorAssignment[] {
    return actor.assignments.filter((assignment) =>
      ROLE_PERMISSIONS[assignment.roleKey].includes(action),
    )
  }

  async can(actor: Actor, action: Action, targetOrgUnitId?: string): Promise<boolean> {
    const granting = this.grantingAssignments(actor, action)

    if (granting.length === 0) {
      return false
    }

    // A global assignment (NULL scope) applies everywhere.
    if (granting.some((assignment) => assignment.scopeOrgUnitId === null)) {
      return true
    }

    if (targetOrgUnitId === undefined) {
      // No specific target: holding the action anywhere is enough to enter the
      // route. Result-level filtering is the caller's job via scopePathsFor.
      return true
    }

    const scopePaths = granting
      .map((assignment) => assignment.scopePath)
      .filter((path): path is string => path !== null)

    if (scopePaths.length === 0) {
      return false
    }

    const { rows } = await this.db.execute<{ contained: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
          FROM org_units
         WHERE id = ${targetOrgUnitId}::uuid
           AND path <@ ANY (${scopePaths}::ltree[])
      ) AS contained
    `)

    return rows[0]?.contained ?? false
  }

  async assertCan(
    actor: Actor,
    action: Action,
    targetOrgUnitId?: string,
  ): Promise<void> {
    if (!(await this.can(actor, action, targetOrgUnitId))) {
      throw new ForbiddenError(`not permitted: ${action}`)
    }
  }

  /**
   * The ltree paths within which this actor may perform `action`.
   * `null` means unrestricted (a global assignment); `[]` means nowhere.
   */
  async scopePathsFor(actor: Actor, action: Action): Promise<string[] | null> {
    const granting = this.grantingAssignments(actor, action)

    if (granting.some((assignment) => assignment.scopeOrgUnitId === null)) {
      return null
    }

    return granting
      .map((assignment) => assignment.scopePath)
      .filter((path): path is string => path !== null)
  }
}
```

- [ ] **Step 4: Run the tests**

Run:
```bash
pnpm --filter @idm/api test permission.engine
pnpm --filter @idm/api build
```
Expected: PASS — 12 tests. Build exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat: add scoped permission engine with fail-closed actor resolution"
```

---

### Task 4: Privilege-escalation guards

**Files:**
- Create: `apps/api/src/authz/privilege.guards.ts`
- Test: `apps/api/test/privilege.guards.spec.ts`

**Interfaces:**
- Consumes: `PermissionEngine`, `RoleAssignmentsRepository`, `ROLE_RANK`, `ForbiddenError`
- Produces:
  - `class PrivilegeGuards` with:
    - `assertCanAssignRole(actor: Actor, roleKey: RoleKey, scopeOrgUnitId: string | null): Promise<void>`
    - `assertCanModifyPrincipal(actor: Actor, targetUserId: string): Promise<void>`
    - `highestRank(assignments: ActorAssignment[]): number`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/privilege.guards.spec.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PrivilegeGuards } from '../src/authz/privilege.guards'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { ForbiddenError } from '../src/common/errors'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

describe('PrivilegeGuards', () => {
  const ctx = withTestDatabase()
  let guards: PrivilegeGuards
  let engine: PermissionEngine
  let roles: RoleAssignmentsRepository
  let users: UsersRepository
  let rootId: string
  let salesId: string
  let emeaId: string
  let engId: string

  beforeEach(async () => {
    await ctx.pool.query('TRUNCATE TABLE role_assignments, users, org_units CASCADE')
    roles = new RoleAssignmentsRepository(ctx.db)
    users = new UsersRepository(ctx.db)
    engine = new PermissionEngine(ctx.db)
    guards = new PrivilegeGuards(ctx.db)

    const orgUnits = new OrgUnitsRepository(ctx.db)
    const root = await orgUnits.createRoot('Acme Corp')
    rootId = root.id
    salesId = (await orgUnits.createChild(root.id, 'Sales')).id
    emeaId = (await orgUnits.createChild(salesId, 'EMEA')).id
    engId = (await orgUnits.createChild(root.id, 'Engineering')).id
  })

  const makeUser = (username: string, orgUnitId: string) =>
    users.create({
      primaryEmail: `${username}@example.com`,
      username,
      firstName: 'Test',
      lastName: 'User',
      orgUnitId,
    })

  const actorFor = (username: string) =>
    engine.resolveActor({ subject: 'k', username, email: null })

  it('lets a super_admin assign any role anywhere', async () => {
    const boss = await makeUser('boss', rootId)
    await roles.assign({ userId: boss.id, roleKey: 'super_admin' })
    const actor = await actorFor('boss')

    await expect(
      guards.assertCanAssignRole(actor, 'user_admin', salesId),
    ).resolves.toBeUndefined()
    await expect(
      guards.assertCanAssignRole(actor, 'super_admin', null),
    ).resolves.toBeUndefined()
  })

  it('refuses to let an actor grant a role they do not hold', async () => {
    const admin = await makeUser('admin', rootId)
    await roles.assign({ userId: admin.id, roleKey: 'help_desk', scopeOrgUnitId: salesId })
    const actor = await actorFor('admin')

    await expect(
      guards.assertCanAssignRole(actor, 'user_admin', salesId),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('refuses to let an actor grant a role beyond their own scope', async () => {
    const admin = await makeUser('admin', rootId)
    await roles.assign({ userId: admin.id, roleKey: 'help_desk', scopeOrgUnitId: salesId })
    const actor = await actorFor('admin')

    await expect(
      guards.assertCanAssignRole(actor, 'help_desk', engId),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('allows granting a held role at a narrower scope inside their own', async () => {
    const admin = await makeUser('admin', rootId)
    await roles.assign({ userId: admin.id, roleKey: 'help_desk', scopeOrgUnitId: salesId })
    const actor = await actorFor('admin')

    await expect(
      guards.assertCanAssignRole(actor, 'help_desk', emeaId),
    ).resolves.toBeUndefined()
  })

  it('refuses to let a scoped actor grant a global role', async () => {
    const admin = await makeUser('admin', rootId)
    await roles.assign({ userId: admin.id, roleKey: 'help_desk', scopeOrgUnitId: salesId })
    const actor = await actorFor('admin')

    await expect(
      guards.assertCanAssignRole(actor, 'help_desk', null),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('refuses to let an actor modify a principal who outranks them', async () => {
    const helper = await makeUser('helper', rootId)
    const boss = await makeUser('boss', rootId)
    await roles.assign({ userId: helper.id, roleKey: 'help_desk', scopeOrgUnitId: salesId })
    await roles.assign({ userId: boss.id, roleKey: 'super_admin' })
    const actor = await actorFor('helper')

    await expect(
      guards.assertCanModifyPrincipal(actor, boss.id),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('lets an actor modify a principal of equal rank', async () => {
    const a = await makeUser('a', rootId)
    const b = await makeUser('b', rootId)
    await roles.assign({ userId: a.id, roleKey: 'user_admin' })
    await roles.assign({ userId: b.id, roleKey: 'user_admin' })
    const actor = await actorFor('a')

    await expect(guards.assertCanModifyPrincipal(actor, b.id)).resolves.toBeUndefined()
  })

  it('lets an actor modify an unprivileged principal', async () => {
    const admin = await makeUser('admin', rootId)
    const plain = await makeUser('plain', rootId)
    await roles.assign({ userId: admin.id, roleKey: 'user_admin' })
    const actor = await actorFor('admin')

    await expect(guards.assertCanModifyPrincipal(actor, plain.id)).resolves.toBeUndefined()
  })

  it('refuses to let an unprivileged actor modify anyone with a role', async () => {
    const plain = await makeUser('plain', rootId)
    const admin = await makeUser('admin', rootId)
    await roles.assign({ userId: admin.id, roleKey: 'read_only' })
    const actor = await actorFor('plain')

    await expect(
      guards.assertCanModifyPrincipal(actor, admin.id),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('computes the highest rank across several assignments', () => {
    expect(
      guards.highestRank([
        { roleKey: 'read_only', scopeOrgUnitId: null, scopePath: null },
        { roleKey: 'user_admin', scopeOrgUnitId: null, scopePath: null },
        { roleKey: 'auditor', scopeOrgUnitId: null, scopePath: null },
      ]),
    ).toBe(30)
  })

  it('treats no assignments as the lowest rank', () => {
    expect(guards.highestRank([])).toBe(-1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api test privilege.guards`
Expected: FAIL — cannot resolve `../src/authz/privilege.guards`.

- [ ] **Step 3: Write the implementation**

`apps/api/src/authz/privilege.guards.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common'
import { eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import { ForbiddenError } from '../common/errors'
import * as schema from '../db/schema/index'
import { roleAssignments } from '../db/schema/role-assignments'
import { ROLE_RANK, type RoleKey } from './actions'
import type { Actor, ActorAssignment } from './permission.engine'

const NO_PRIVILEGE = -1

@Injectable()
export class PrivilegeGuards {
  constructor(
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  highestRank(assignments: ActorAssignment[]): number {
    return assignments.reduce(
      (highest, assignment) => Math.max(highest, ROLE_RANK[assignment.roleKey]),
      NO_PRIVILEGE,
    )
  }

  /**
   * An administrator may only grant a role they themselves hold, at a scope
   * their own holding covers. Without this, "help desk can reset passwords"
   * becomes "help desk can make themselves a super admin".
   */
  async assertCanAssignRole(
    actor: Actor,
    roleKey: RoleKey,
    scopeOrgUnitId: string | null,
  ): Promise<void> {
    const holdings = actor.assignments.filter(
      (assignment) =>
        assignment.roleKey === roleKey || assignment.roleKey === 'super_admin',
    )

    if (holdings.length === 0) {
      throw new ForbiddenError(`not permitted to grant ${roleKey}`)
    }

    // A global holding covers every scope, including a global grant.
    if (holdings.some((assignment) => assignment.scopeOrgUnitId === null)) {
      return
    }

    // Only a global holding may create a global grant.
    if (scopeOrgUnitId === null) {
      throw new ForbiddenError(`not permitted to grant ${roleKey} globally`)
    }

    const scopePaths = holdings
      .map((assignment) => assignment.scopePath)
      .filter((path): path is string => path !== null)

    const { rows } = await this.db.execute<{ contained: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
          FROM org_units
         WHERE id = ${scopeOrgUnitId}::uuid
           AND path <@ ANY (${scopePaths}::ltree[])
      ) AS contained
    `)

    if (rows[0]?.contained !== true) {
      throw new ForbiddenError(`not permitted to grant ${roleKey} at that scope`)
    }
  }

  /**
   * An administrator may not modify a principal whose privileges exceed their
   * own — otherwise a help-desk account becomes a path to any executive's.
   */
  async assertCanModifyPrincipal(actor: Actor, targetUserId: string): Promise<void> {
    const targetAssignments = await this.db
      .select({ roleKey: roleAssignments.roleKey })
      .from(roleAssignments)
      .where(eq(roleAssignments.userId, targetUserId))

    const targetRank = targetAssignments.reduce(
      (highest, row) => Math.max(highest, ROLE_RANK[row.roleKey as RoleKey]),
      NO_PRIVILEGE,
    )

    if (this.highestRank(actor.assignments) < targetRank) {
      throw new ForbiddenError('not permitted to modify a more privileged principal')
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run:
```bash
pnpm --filter @idm/api test privilege.guards
pnpm --filter @idm/api build
```
Expected: PASS — 11 tests. Build exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat: add privilege-escalation guards for role assignment and principal modification"
```

---

### Task 5: Append-only audit log

**Files:**
- Create: `apps/api/src/db/schema/audit-log.ts`, `apps/api/src/audit/audit.writer.ts`, `apps/api/src/audit/audit.repository.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Test: `apps/api/test/audit.spec.ts`

**Interfaces:**
- Consumes: `users` table, `DB_CLIENT`, `parsePageQuery`
- Produces:
  - `auditLog` table
  - `interface AuditEntry { actorUserId: string | null; action: string; resourceType: string; resourceId: string | null; before: unknown; after: unknown }`
  - `class AuditWriter` with `record(tx: DbHandle, entry: AuditEntry): Promise<void>` where `DbHandle` is the Drizzle database or transaction handle
  - `class AuditRepository` with `list(options: { limit: number; offset: number }): Promise<AuditRow[]>` and `count(): Promise<number>`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/audit.spec.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { AuditRepository } from '../src/audit/audit.repository'
import { AuditWriter } from '../src/audit/audit.writer'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

describe('audit log', () => {
  const ctx = withTestDatabase()
  let writer: AuditWriter
  let audit: AuditRepository
  let actorId: string

  beforeEach(async () => {
    await ctx.pool.query('TRUNCATE TABLE audit_log, users, org_units CASCADE')
    writer = new AuditWriter()
    audit = new AuditRepository(ctx.db)
    const orgUnits = new OrgUnitsRepository(ctx.db)
    const users = new UsersRepository(ctx.db)
    const root = await orgUnits.createRoot('Acme Corp')
    actorId = (
      await users.create({
        primaryEmail: 'ada@example.com',
        username: 'ada',
        firstName: 'Ada',
        lastName: 'Lovelace',
        orgUnitId: root.id,
      })
    ).id
  })

  it('records an entry with actor, action, resource and payloads', async () => {
    await writer.record(ctx.db, {
      actorUserId: actorId,
      action: 'user:update',
      resourceType: 'user',
      resourceId: actorId,
      before: { jobTitle: null },
      after: { jobTitle: 'Engineer' },
    })

    const rows = await audit.list({ limit: 10, offset: 0 })
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('user:update')
    expect(rows[0].resourceType).toBe('user')
    expect(rows[0].before).toEqual({ jobTitle: null })
    expect(rows[0].after).toEqual({ jobTitle: 'Engineer' })
  })

  it('allows a null actor for system-originated actions', async () => {
    await writer.record(ctx.db, {
      actorUserId: null,
      action: 'user:deactivate',
      resourceType: 'user',
      resourceId: actorId,
      before: { status: 'active' },
      after: { status: 'deactivated' },
    })

    const rows = await audit.list({ limit: 10, offset: 0 })
    expect(rows[0].actorUserId).toBeNull()
  })

  it('refuses UPDATE at the database level', async () => {
    await writer.record(ctx.db, {
      actorUserId: actorId,
      action: 'user:read',
      resourceType: 'user',
      resourceId: actorId,
      before: null,
      after: null,
    })

    await expect(
      ctx.pool.query(`UPDATE audit_log SET action = 'tampered'`),
    ).rejects.toThrow(/append-only/i)
  })

  it('refuses DELETE at the database level', async () => {
    await writer.record(ctx.db, {
      actorUserId: actorId,
      action: 'user:read',
      resourceType: 'user',
      resourceId: actorId,
      before: null,
      after: null,
    })

    await expect(ctx.pool.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/i)
  })

  it('rolls back the audit entry when its enclosing transaction fails', async () => {
    await expect(
      ctx.db.transaction(async (tx) => {
        await writer.record(tx, {
          actorUserId: actorId,
          action: 'user:update',
          resourceType: 'user',
          resourceId: actorId,
          before: null,
          after: { jobTitle: 'Engineer' },
        })
        throw new Error('mutation failed after the audit write')
      }),
    ).rejects.toThrow('mutation failed')

    expect(await audit.count()).toBe(0)
  })

  it('keeps the audit entry when its enclosing transaction commits', async () => {
    await ctx.db.transaction(async (tx) => {
      await writer.record(tx, {
        actorUserId: actorId,
        action: 'user:update',
        resourceType: 'user',
        resourceId: actorId,
        before: null,
        after: { jobTitle: 'Engineer' },
      })
    })

    expect(await audit.count()).toBe(1)
  })

  it('returns newest first and paginates', async () => {
    for (const action of ['a', 'b', 'c']) {
      await writer.record(ctx.db, {
        actorUserId: actorId,
        action,
        resourceType: 'user',
        resourceId: actorId,
        before: null,
        after: null,
      })
    }

    const page = await audit.list({ limit: 2, offset: 0 })
    expect(page.map((row) => row.action)).toEqual(['c', 'b'])
    expect(await audit.count()).toBe(3)
  })
})
```

The rollback pair is the point of the whole task: an audit row that survives a failed mutation is a lie, and one that vanishes on a successful one is a gap.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api test audit`
Expected: FAIL — cannot resolve `../src/audit/audit.writer`.

- [ ] **Step 3: Write the implementation**

`apps/api/src/db/schema/audit-log.ts`:
```ts
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
    actorUserId: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
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
```

Add `export * from './audit-log'` to `apps/api/src/db/schema/index.ts`, keeping every existing export.

The append-only guarantee is a trigger, which drizzle-kit will not generate. Add it to the extensions step in `apps/api/src/db/migrate.ts`, AFTER the drizzle migrations run so the table exists — replace the tail of `runMigrations` with:

```ts
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER })
  await enforceAuditAppendOnly(pool)
}

/**
 * The audit log's append-only property is enforced by the database, not by
 * application discipline. A compromised or buggy service must not be able to
 * rewrite history.
 */
async function enforceAuditAppendOnly(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'audit_log is append-only; % is not permitted', TG_OP;
    END;
    $$ LANGUAGE plpgsql;
  `)

  await pool.query(`DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log`)
  await pool.query(`
    CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
  `)

  await pool.query(`DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log`)
  await pool.query(`
    CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
  `)
}
```

`apps/api/src/audit/audit.writer.ts`:
```ts
import { Injectable } from '@nestjs/common'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { auditLog } from '../db/schema/audit-log'
import * as schema from '../db/schema/index'

/** Either the pooled database handle or a live transaction handle. */
export type DbHandle =
  | NodePgDatabase<typeof schema>
  | Parameters<Parameters<NodePgDatabase<typeof schema>['transaction']>[0]>[0]

export interface AuditEntry {
  actorUserId: string | null
  action: string
  resourceType: string
  resourceId: string | null
  before: unknown
  after: unknown
}

@Injectable()
export class AuditWriter {
  /**
   * Takes the caller's handle rather than opening its own, so the audit row
   * and the mutation it describes commit or roll back together. Never call
   * this with the pooled handle from inside a transaction.
   */
  async record(tx: DbHandle, entry: AuditEntry): Promise<void> {
    await tx.insert(auditLog).values({
      actorUserId: entry.actorUserId,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      before: entry.before ?? null,
      after: entry.after ?? null,
    })
  }
}
```

`apps/api/src/audit/audit.repository.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common'
import { desc, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import { auditLog } from '../db/schema/audit-log'
import * as schema from '../db/schema/index'

export interface AuditRow {
  id: number
  actorUserId: string | null
  action: string
  resourceType: string
  resourceId: string | null
  before: unknown
  after: unknown
  createdAt: Date
}

@Injectable()
export class AuditRepository {
  constructor(
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async list(options: { limit: number; offset: number }): Promise<AuditRow[]> {
    const rows = await this.db
      .select()
      .from(auditLog)
      .orderBy(desc(auditLog.id))
      .limit(options.limit)
      .offset(options.offset)

    return rows as AuditRow[]
  }

  async count(): Promise<number> {
    const [row] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(auditLog)

    return row?.value ?? 0
  }
}
```

- [ ] **Step 4: Generate the migration and run the tests**

Run:
```bash
pnpm --filter @idm/api db:generate
pnpm --filter @idm/api test audit
pnpm --filter @idm/api build
```
Expected: PASS — 7 tests. Build exits 0.

Then confirm the trigger survives a migration re-run: run `pnpm --filter @idm/api db:migrate` twice against the compose Postgres and confirm no error, then confirm `UPDATE audit_log SET action='x'` is still rejected. Paste the output into your report.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat: add database-enforced append-only audit log with transactional writer"
```

---

### Task 6: Enforce authorization on the read endpoints

**Files:**
- Create: `apps/api/src/authz/require-permission.decorator.ts`, `apps/api/src/authz/permission.guard.ts`
- Modify: `apps/api/src/users/users.controller.ts`, `apps/api/src/org-units/org-units.controller.ts`, `apps/api/src/groups/groups.controller.ts`, `apps/api/src/app.module.ts`
- Modify: `apps/api/test/guard-coverage.spec.ts`
- Test: `apps/api/test/permission.guard.spec.ts`

**Interfaces:**
- Consumes: `PermissionEngine`, `Action`, `AuthenticatedRequest`, `ForbiddenError`
- Produces:
  - `REQUIRED_PERMISSION` metadata key and `RequirePermission(action: Action): MethodDecorator`
  - `class PermissionGuard implements CanActivate` — resolves the actor, asserts the route's declared permission, and attaches `request.actor`
  - `interface AuthorizedRequest extends AuthenticatedRequest { actor: Actor }`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/permission.guard.spec.ts`:

```ts
import { Controller, Get, type INestApplication, UseGuards } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { Reflector } from '@nestjs/core'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard } from '../src/authz/permission.guard'
import { RequirePermission } from '../src/authz/require-permission.decorator'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { JwtGuard } from '../src/auth/jwt.guard'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

@Controller('probe')
@UseGuards(JwtGuard, PermissionGuard)
class ProbeController {
  @Get('readable')
  @RequirePermission('user:read')
  readable(): { ok: true } {
    return { ok: true }
  }

  @Get('auditable')
  @RequirePermission('audit:read')
  auditable(): { ok: true } {
    return { ok: true }
  }

  @Get('undeclared')
  undeclared(): { ok: true } {
    return { ok: true }
  }
}

describe('PermissionGuard', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let currentUsername = 'ada'

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        PermissionEngine,
        PermissionGuard,
        Reflector,
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue({
        canActivate: (context: { switchToHttp: () => { getRequest: () => Record<string, unknown> } }) => {
          context.switchToHttp().getRequest().principal = {
            subject: 'kc-1',
            username: currentUsername,
            email: null,
          }
          return true
        },
      })
      .compile()

    app = moduleRef.createNestApplication()
    app.useGlobalFilters(new DomainExceptionFilter())
    await app.init()
  })

  afterAll(async () => {
    await app?.close()
  })

  beforeEach(async () => {
    await ctx.pool.query('TRUNCATE TABLE role_assignments, users, org_units CASCADE')
    currentUsername = 'ada'
    const orgUnits = new OrgUnitsRepository(ctx.db)
    const users = new UsersRepository(ctx.db)
    const root = await orgUnits.createRoot('Acme Corp')
    await users.create({
      primaryEmail: 'ada@example.com',
      username: 'ada',
      firstName: 'Ada',
      lastName: 'Lovelace',
      orgUnitId: root.id,
    })
  })

  const grant = async (roleKey: 'read_only' | 'auditor') => {
    const users = new UsersRepository(ctx.db)
    const user = await users.findByEmail('ada@example.com')
    await new RoleAssignmentsRepository(ctx.db).assign({
      userId: user!.id,
      roleKey,
    })
  }

  it('denies a route when the actor lacks the permission', async () => {
    const res = await request(app.getHttpServer()).get('/probe/readable').expect(403)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  it('allows a route when the actor holds the permission', async () => {
    await grant('read_only')
    await request(app.getHttpServer()).get('/probe/readable').expect(200)
  })

  it('still denies a different permission the role does not grant', async () => {
    await grant('read_only')
    const res = await request(app.getHttpServer()).get('/probe/auditable').expect(403)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  it('allows the auditor role its own permission', async () => {
    await grant('auditor')
    await request(app.getHttpServer()).get('/probe/auditable').expect(200)
  })

  it('DENIES a route that declares no permission — fail closed', async () => {
    await grant('read_only')
    const res = await request(app.getHttpServer()).get('/probe/undeclared').expect(403)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  it('denies a principal that maps to no local user', async () => {
    currentUsername = 'ghost'
    const res = await request(app.getHttpServer()).get('/probe/readable').expect(403)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  it('reflects a revoked role on the very next request', async () => {
    await grant('read_only')
    await request(app.getHttpServer()).get('/probe/readable').expect(200)

    await ctx.pool.query('DELETE FROM role_assignments')
    await request(app.getHttpServer()).get('/probe/readable').expect(403)
  })
})
```

Two tests carry disproportionate weight. The undeclared-route test makes a missing `@RequirePermission` a denial rather than a silent bypass. The revoked-role test proves nothing is cached across requests.

Extend `apps/api/test/guard-coverage.spec.ts` with a third assertion: every route handler on a guarded controller declares a permission.

```ts
import { REQUIRED_PERMISSION } from '../src/authz/require-permission.decorator'

// ... inside describe('guard coverage'):

  it('declares a permission on every route of every guarded controller', () => {
    const missing: string[] = []

    for (const controller of collectControllers(AppModule)) {
      if (OPEN_BY_DESIGN.has(controller.name) || controller.name === 'MeController') {
        continue
      }

      const proto = controller.prototype as Record<string, unknown>
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (key === 'constructor') continue
        const handler = proto[key]
        if (typeof handler !== 'function') continue
        const isRoute = Reflect.hasMetadata('path', handler)
        if (!isRoute) continue
        if (Reflect.getMetadata(REQUIRED_PERMISSION, handler) === undefined) {
          missing.push(`${controller.name}.${key}`)
        }
      }
    }

    expect(missing).toEqual([])
  })
```

`MeController` is exempt because it returns only the caller's own principal — it needs authentication, not authorization.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @idm/api test permission.guard guard-coverage`
Expected: FAIL — cannot resolve `../src/authz/permission.guard`.

- [ ] **Step 3: Write the implementation**

`apps/api/src/authz/require-permission.decorator.ts`:
```ts
import { SetMetadata } from '@nestjs/common'
import type { Action } from './actions'

export const REQUIRED_PERMISSION = 'idm:required_permission'

/** Declares the permission a route requires. Routes without one are denied. */
export const RequirePermission = (action: Action): MethodDecorator =>
  SetMetadata(REQUIRED_PERMISSION, action)
```

`apps/api/src/authz/permission.guard.ts`:
```ts
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { AuthenticatedRequest } from '../auth/jwt.guard'
import { ForbiddenError } from '../common/errors'
import type { Action } from './actions'
import { PermissionEngine, type Actor } from './permission.engine'
import { REQUIRED_PERMISSION } from './require-permission.decorator'

export interface AuthorizedRequest extends AuthenticatedRequest {
  actor: Actor
}

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    @Inject(PermissionEngine) private readonly engine: PermissionEngine,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.get<Action | undefined>(
      REQUIRED_PERMISSION,
      context.getHandler(),
    )

    // Fail closed: a route that forgot to declare a permission is denied, not
    // waved through. Authorization is opt-out only by explicit exemption.
    if (required === undefined) {
      throw new ForbiddenError('route declares no permission')
    }

    const request = context.switchToHttp().getRequest<AuthorizedRequest>()
    const actor = await this.engine.resolveActor(request.principal)

    await this.engine.assertCan(actor, required)

    request.actor = actor
    return true
  }
}
```

Add `@RequirePermission(...)` to every route on the three controllers and add `PermissionGuard` to their `@UseGuards`:
- `UsersController`: class becomes `@UseGuards(JwtGuard, PermissionGuard)`; `list` and `findOne` get `@RequirePermission('user:read')`.
- `OrgUnitsController`: same guards; `list`, `findOne`, `subtree` get `@RequirePermission('org_unit:read')`.
- `GroupsController`: same guards; `list`, `findOne`, `members`, `effectiveMembers` get `@RequirePermission('group:read')`.

Register the new providers in `apps/api/src/app.module.ts` — add `PermissionEngine`, `PermissionGuard`, `PrivilegeGuards`, `RoleAssignmentsRepository`, `AuditWriter`, `AuditRepository` to `providers`. `Reflector` is provided by Nest core and needs no registration.

**YOU MUST ALSO UPDATE THE THREE EXISTING CONTROLLER SPECS**, or roughly thirty passing tests will start returning 403. `users.controller.spec.ts`, `org-units.controller.spec.ts`, and `groups.controller.spec.ts` currently override only `JwtGuard`. Adding `PermissionGuard` to the controllers means those tests now hit real authorization with no seeded actor.

Add a second override to each, alongside the existing `JwtGuard` one:
```ts
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: () => true })
```
This is correct rather than lazy: those specs test controller behaviour — pagination, filtering, status codes, response shapes — and authorization has its own dedicated spec in `permission.guard.spec.ts` plus the engine's own suite. Duplicating role seeding into every controller test would obscure what each is actually asserting. Do NOT weaken `permission.guard.spec.ts` in the same way.

- [ ] **Step 4: Run the full suite and verify the real app**

Run:
```bash
pnpm --filter @idm/api test
pnpm --filter @idm/api build
pnpm --filter @idm/api smoke:dev
```

`smoke:dev` WILL FAIL at this point, and that is correct — the seeded Keycloak user `admin@example.com` has no local user record or role, so it is now denied. Update `apps/api/scripts/smoke-dev.ts` to seed what it needs before asserting: create the org unit, a local user whose `username` matches the token's `preferred_username`, and a `super_admin` role assignment; then assert `GET /users` and `GET /groups` return 200. Clean up what it seeds. Re-run until green, and paste the output.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test apps/api/scripts
git commit -m "feat: enforce scoped permissions on every read endpoint, failing closed"
```

---

## Milestone 3a Definition of Done

- [ ] `ForbiddenError` maps to HTTP 403 through the global filter
- [ ] Roles are a static code catalog; `role:assign` belongs to `super_admin` alone
- [ ] `role_assignments` enforces uniqueness for both scoped and global assignments (two partial indexes)
- [ ] An authenticated principal that maps to no active local user is **denied**, never defaulted
- [ ] A scoped role grants only within its org-unit subtree, verified against `ltree` containment
- [ ] Scope is re-evaluated per request — moving a user or revoking a role takes effect on the next call
- [ ] An administrator cannot grant a role they do not hold, nor grant beyond their own scope, nor grant globally from a scoped holding
- [ ] An administrator cannot modify a principal who outranks them
- [ ] `audit_log` rejects `UPDATE` and `DELETE` **at the database level**, proven by raw SQL
- [ ] An audit row written inside a failed transaction does not survive
- [ ] Every route on every guarded controller declares a permission; a route without one is **denied**
- [ ] Still no `POST`/`PUT`/`PATCH`/`DELETE` route anywhere
- [ ] `pnpm --filter @idm/api test` and `build` green; `smoke:dev` green

## What Milestone 3b Builds On This

The write endpoints: `POST`/`PATCH` for users, groups, membership, and org units — each permission-checked through `PermissionGuard`, privilege-guarded where it touches roles or principals, and audited inside the same transaction as the mutation.

Carried forward and still open:
- The ReDoS gate on `new RegExp(rules.pattern)` in `attribute-validator.ts` must close in whichever milestone first exposes a write path for `attribute_definitions`.
- `GroupsRepository.create` should check the constraint name, not just SQLSTATE `23505`, once a second unique constraint is reachable.
- A bogus `orgUnitId` currently surfaces as an unmapped 500; map `23503` to `NotFoundError` when `POST /groups` lands.
- `smoke-dev.ts`'s port cleanup is Windows-only and must be fixed before it runs on Linux CI.
