# Identity Provider — Milestone 2 (Core CRUD) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add groups with nested membership and effective-membership expansion, establish a domain-error taxonomy, and expose a read-only authenticated HTTP layer over users, org units, and groups.

**Architecture:** A `DomainError` hierarchy replaces bare `Error` throughout the repositories, and one Nest exception filter maps those to HTTP status codes — this lands *before* any controller exists, so no repository error can ever surface as a 500. Groups use two membership tables (users-in-groups, groups-in-groups) rather than a polymorphic table, preserving foreign-key integrity. Nested membership is a DAG guarded by a recursive-CTE cycle check serialized under a Postgres advisory lock. Effective membership expands via recursive CTE with `UNION` (not `UNION ALL`), so it terminates even if a cycle somehow existed.

**Tech Stack:** TypeScript, NestJS 10, Drizzle ORM, Postgres 16 (`ltree`, recursive CTEs, advisory locks), Zod, Vitest, Testcontainers.

**Source spec:** `docs/superpowers/specs/2026-08-04-identity-provider-core-design.md`
**Builds on:** Milestone 1 (merged at `f00a61c`)

## Global Constraints

These bind every task, and carry forward from Milestone 1.

- **The system never generates, transmits, or stores a credential.** No password column, no hashing, no login form. Keycloak owns credentials.
- **Attribute propagation is default-deny.** `sync_to_keycloak` and `self_editable` default to `false`.
- **There is no delete operation for users.** Users transition to `deactivated` (terminal). No `DELETE` against `users`.
- **Authorization is enforced in the API, never in the UI.**
- **Postgres and Keycloak are tested with Testcontainers, never mocks.**
- **Single tenant.** No `tenant_id` anywhere.
- TypeScript `strict: true`. No `any`, `as any`, `@ts-ignore`, or `@ts-expect-error`.
- Node 20+, pnpm 9+.

### Constraints specific to this milestone

- **This milestone's HTTP surface is READ-ONLY.** No `POST`, `PUT`, `PATCH`, or `DELETE` routes. Write endpoints wait for Milestone 3, which lands the RBAC engine and audit log. A write route added here would be unauthorized and unaudited.
- **Every controller must be guarded by `JwtGuard`.** Endpoints are authenticated-only; there is no per-user authorization until Milestone 3. **This build must not be deployed to a real network before Milestone 3 lands** — any authenticated user can currently read the whole directory. Task 5 adds a test that fails if any controller is left unguarded.
- **Every task that changes `apps/api/package.json` must commit `pnpm-lock.yaml` in the same commit.** Milestone 1 shipped a broken commit by omitting it.
- **Every task that changes a Drizzle schema must run `pnpm --filter @idm/api db:generate` and commit the generated migration and `meta/` files.** Never hand-edit generated SQL or the journal.

---

## File Structure

```
apps/api/src/
├── common/
│   ├── errors.ts                     # DomainError hierarchy — the taxonomy
│   ├── domain-exception.filter.ts    # DomainError -> HTTP status mapping
│   └── pagination.ts                 # shared limit/offset parsing + caps
├── db/schema/
│   ├── groups.ts                     # groups table
│   └── group-members.ts              # group_user_members + group_group_members
├── groups/
│   ├── groups.repository.ts          # group CRUD + membership edges + cycle guard
│   └── groups.controller.ts          # read-only HTTP
├── users/
│   ├── users.repository.ts           # MODIFIED: typed errors + list()
│   └── users.controller.ts           # read-only HTTP
├── org-units/
│   ├── org-units.repository.ts       # MODIFIED: typed errors + list()
│   └── org-units.controller.ts       # read-only HTTP
└── app.module.ts                     # MODIFIED: wire filter, providers, controllers
```

Membership lives beside groups because the two always change together. The error taxonomy sits in `common/` because every layer depends on it and nothing depends on a layer above it.

---

### Task 1: Domain error taxonomy and HTTP exception filter

This lands first and alone. Milestone 1's final review flagged that three modules throw three unrelated error types, and that the moment controllers exist every repository error becomes a 500. Fixing that after the controllers exist means touching every handler.

**Files:**
- Create: `apps/api/src/common/errors.ts`
- Create: `apps/api/src/common/domain-exception.filter.ts`
- Modify: `apps/api/src/users/users.repository.ts` (throw sites only)
- Modify: `apps/api/src/org-units/org-units.repository.ts` (throw site only)
- Modify: `apps/api/src/attributes/attribute-validator.ts` (`AttributeValidationError` base class only)
- Test: `apps/api/test/errors.spec.ts`, `apps/api/test/domain-exception.filter.spec.ts`

**Interfaces:**
- Consumes: nothing new
- Produces:
  - `abstract class DomainError extends Error { readonly code: string }`
  - `class NotFoundError extends DomainError` — `code = 'NOT_FOUND'`, ctor `(resource: string, id: string)`
  - `class ConflictError extends DomainError` — `code = 'CONFLICT'`, ctor `(message: string)`
  - `class InvalidTransitionError extends DomainError` — `code = 'INVALID_TRANSITION'`, ctor `(message: string)`
  - `class CycleError extends DomainError` — `code = 'CYCLE_DETECTED'`, ctor `(message: string)`
  - `class ValidationError extends DomainError { readonly issues: string[] }` — `code = 'VALIDATION_FAILED'`, ctor `(issues: string[])`
  - `DomainExceptionFilter` — a Nest `ExceptionFilter` catching `DomainError`
  - `AttributeValidationError` now extends `ValidationError` (keeps its existing `issues` property and message format)

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/errors.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  ConflictError,
  CycleError,
  DomainError,
  InvalidTransitionError,
  NotFoundError,
  ValidationError,
} from '../src/common/errors'
import { AttributeValidationError } from '../src/attributes/attribute-validator'

describe('domain error taxonomy', () => {
  it('gives every error a stable machine-readable code', () => {
    expect(new NotFoundError('user', 'abc').code).toBe('NOT_FOUND')
    expect(new ConflictError('duplicate').code).toBe('CONFLICT')
    expect(new InvalidTransitionError('bad').code).toBe('INVALID_TRANSITION')
    expect(new CycleError('loop').code).toBe('CYCLE_DETECTED')
    expect(new ValidationError(['a']).code).toBe('VALIDATION_FAILED')
  })

  it('makes every domain error an instanceof DomainError and Error', () => {
    for (const error of [
      new NotFoundError('user', 'abc'),
      new ConflictError('duplicate'),
      new InvalidTransitionError('bad'),
      new CycleError('loop'),
      new ValidationError(['a']),
    ]) {
      expect(error).toBeInstanceOf(DomainError)
      expect(error).toBeInstanceOf(Error)
    }
  })

  it('sets name to the concrete subclass, not "Error"', () => {
    expect(new NotFoundError('user', 'abc').name).toBe('NotFoundError')
    expect(new CycleError('loop').name).toBe('CycleError')
  })

  it('formats NotFoundError with resource and id', () => {
    expect(new NotFoundError('org unit', 'xyz').message).toBe('org unit not found: xyz')
  })

  it('carries issues on ValidationError', () => {
    expect(new ValidationError(['a: bad', 'b: worse']).issues).toEqual([
      'a: bad',
      'b: worse',
    ])
  })

  it('keeps AttributeValidationError in the taxonomy without changing its shape', () => {
    const error = new AttributeValidationError(['cost_center: Required'])
    expect(error).toBeInstanceOf(ValidationError)
    expect(error).toBeInstanceOf(DomainError)
    expect(error.issues).toEqual(['cost_center: Required'])
    expect(error.message).toBe('attribute validation failed: cost_center: Required')
    expect(error.name).toBe('AttributeValidationError')
  })
})
```

Create `apps/api/test/domain-exception.filter.spec.ts`:

```ts
import { Controller, Get, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import {
  ConflictError,
  CycleError,
  InvalidTransitionError,
  NotFoundError,
  ValidationError,
} from '../src/common/errors'

@Controller('boom')
class BoomController {
  @Get('not-found')
  notFound(): never {
    throw new NotFoundError('user', 'u-1')
  }
  @Get('conflict')
  conflict(): never {
    throw new ConflictError('username already taken')
  }
  @Get('transition')
  transition(): never {
    throw new InvalidTransitionError('cannot transition from pending to suspended')
  }
  @Get('cycle')
  cycle(): never {
    throw new CycleError('adding this edge would create a cycle')
  }
  @Get('validation')
  validation(): never {
    throw new ValidationError(['name: Required'])
  }
  @Get('unmapped')
  unmapped(): never {
    throw new Error('some internal detail that must not leak')
  }
}

describe('DomainExceptionFilter', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BoomController],
    }).compile()
    app = moduleRef.createNestApplication()
    app.useGlobalFilters(new DomainExceptionFilter())
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it('maps NotFoundError to 404', async () => {
    const res = await request(app.getHttpServer()).get('/boom/not-found').expect(404)
    expect(res.body).toEqual({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'user not found: u-1',
    })
  })

  it('maps ConflictError to 409', async () => {
    const res = await request(app.getHttpServer()).get('/boom/conflict').expect(409)
    expect(res.body.code).toBe('CONFLICT')
  })

  it('maps InvalidTransitionError to 409', async () => {
    const res = await request(app.getHttpServer()).get('/boom/transition').expect(409)
    expect(res.body.code).toBe('INVALID_TRANSITION')
  })

  it('maps CycleError to 409', async () => {
    const res = await request(app.getHttpServer()).get('/boom/cycle').expect(409)
    expect(res.body.code).toBe('CYCLE_DETECTED')
  })

  it('maps ValidationError to 400 and includes its issues', async () => {
    const res = await request(app.getHttpServer()).get('/boom/validation').expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
    expect(res.body.issues).toEqual(['name: Required'])
  })

  it('does not catch non-domain errors, and never leaks their message', async () => {
    const res = await request(app.getHttpServer()).get('/boom/unmapped').expect(500)
    expect(JSON.stringify(res.body)).not.toContain('some internal detail')
  })
})
```

The last test is the important one: a filter that accidentally caught everything would turn genuine bugs into polite 400s and leak internals.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @idm/api test errors domain-exception`
Expected: FAIL — cannot resolve `../src/common/errors`.

- [ ] **Step 3: Write the implementation**

`apps/api/src/common/errors.ts`:
```ts
/**
 * Every error the domain raises deliberately extends DomainError, so the HTTP
 * layer can map it to a status code. Anything that is NOT a DomainError is a
 * genuine bug and must surface as a 500 — never rewrite one into a 4xx.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string

  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND'

  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`)
  }
}

export class ConflictError extends DomainError {
  readonly code = 'CONFLICT'
}

export class InvalidTransitionError extends DomainError {
  readonly code = 'INVALID_TRANSITION'
}

export class CycleError extends DomainError {
  readonly code = 'CYCLE_DETECTED'
}

export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_FAILED'

  constructor(
    public readonly issues: string[],
    message = `validation failed: ${issues.join('; ')}`,
  ) {
    super(message)
  }
}
```

`apps/api/src/common/domain-exception.filter.ts`:
```ts
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
} from '@nestjs/common'
import type { Response } from 'express'
import { DomainError, ValidationError } from './errors'

const STATUS_BY_CODE: Record<string, HttpStatus> = {
  NOT_FOUND: HttpStatus.NOT_FOUND,
  CONFLICT: HttpStatus.CONFLICT,
  INVALID_TRANSITION: HttpStatus.CONFLICT,
  CYCLE_DETECTED: HttpStatus.CONFLICT,
  VALIDATION_FAILED: HttpStatus.BAD_REQUEST,
}

/**
 * Catches DomainError ONLY. Unmapped throwables fall through to Nest's default
 * handler and become a 500 with no body detail — a bug must look like a bug.
 */
@Catch(DomainError)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(error: DomainError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>()
    const statusCode =
      STATUS_BY_CODE[error.code] ?? HttpStatus.INTERNAL_SERVER_ERROR

    const body: Record<string, unknown> = {
      statusCode,
      code: error.code,
      message: error.message,
    }

    if (error instanceof ValidationError) {
      body.issues = error.issues
    }

    response.status(statusCode).json(body)
  }
}
```

In `apps/api/src/attributes/attribute-validator.ts`, change `AttributeValidationError` to extend `ValidationError`, preserving its message format exactly:
```ts
import { ValidationError } from '../common/errors'

export class AttributeValidationError extends ValidationError {
  constructor(issues: string[]) {
    super(issues, `attribute validation failed: ${issues.join('; ')}`)
    this.name = 'AttributeValidationError'
  }
}
```

In `apps/api/src/users/users.repository.ts`, replace the three bare throws — **keep the message text byte-identical**, because existing tests assert on it:
```ts
// import { InvalidTransitionError, NotFoundError } from '../common/errors'

// was: throw new Error(`user not found: ${id}`)
throw new NotFoundError('user', id)

// was: throw new Error('deactivated is terminal; the user cannot be reactivated')
throw new InvalidTransitionError(
  'deactivated is terminal; the user cannot be reactivated',
)

// was: throw new Error(`cannot transition from ${current.status} to ${next}`)
throw new InvalidTransitionError(
  `cannot transition from ${current.status} to ${next}`,
)
```

In `apps/api/src/org-units/org-units.repository.ts`:
```ts
// import { NotFoundError } from '../common/errors'

// was: throw new Error(`parent org unit not found: ${parentId}`)
throw new NotFoundError('parent org unit', parentId)
```

`NotFoundError('user', id)` renders `user not found: <id>` and `NotFoundError('parent org unit', parentId)` renders `parent org unit not found: <id>` — byte-identical to the previous strings, so the Milestone 1 tests asserting `/user not found/` and `/parent org unit not found/` keep passing unchanged.

- [ ] **Step 4: Run the full suite to verify nothing regressed**

Run:
```bash
pnpm --filter @idm/api test
pnpm --filter @idm/api build
```
Expected: all previously passing tests still pass (68 before this task), plus the new ones. Build exits 0.

If any Milestone 1 test fails on an error message, you changed a message — revert that change; the messages are contractual.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/common apps/api/src/users apps/api/src/org-units apps/api/src/attributes apps/api/test
git commit -m "feat: add domain error taxonomy and HTTP exception filter"
```

---

### Task 2: `groups` schema and repository

**Files:**
- Create: `apps/api/src/db/schema/groups.ts`, `apps/api/src/groups/groups.repository.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Test: `apps/api/test/groups.repository.spec.ts`

**Interfaces:**
- Consumes: `withTestDatabase()` from `test/support/pg.ts`; `NotFoundError`, `ConflictError` (Task 1); `orgUnits` table
- Produces:
  - `groups` table export
  - `interface Group { id: string; name: string; description: string | null; orgUnitId: string | null; attributes: Record<string, unknown>; createdAt: Date; updatedAt: Date }`
  - `interface CreateGroupInput { name: string; description?: string; orgUnitId?: string; attributes?: Record<string, unknown> }`
  - `class GroupsRepository` with `create(input): Promise<Group>`, `findById(id): Promise<Group | null>`, `findByName(name): Promise<Group | null>`, `list(options: { limit: number; offset: number }): Promise<Group[]>`, `count(): Promise<number>`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/groups.repository.spec.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { ConflictError } from '../src/common/errors'
import { GroupsRepository } from '../src/groups/groups.repository'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { withTestDatabase } from './support/pg'

describe('GroupsRepository', () => {
  const ctx = withTestDatabase()
  let groups: GroupsRepository
  let orgUnitId: string

  beforeEach(async () => {
    await ctx.pool.query('TRUNCATE TABLE groups, users, org_units CASCADE')
    groups = new GroupsRepository(ctx.db)
    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot('Acme Corp')).id
  })

  it('creates a group with defaults', async () => {
    const group = await groups.create({ name: 'Engineering' })
    expect(group.name).toBe('Engineering')
    expect(group.description).toBeNull()
    expect(group.orgUnitId).toBeNull()
    expect(group.attributes).toEqual({})
  })

  it('creates a group scoped to an org unit with attributes', async () => {
    const group = await groups.create({
      name: 'Sales EMEA',
      description: 'Regional sales',
      orgUnitId,
      attributes: { cost_center: 'CC-1' },
    })
    expect(group.orgUnitId).toBe(orgUnitId)
    expect(group.attributes).toEqual({ cost_center: 'CC-1' })
  })

  it('rejects a duplicate name case-insensitively with a ConflictError', async () => {
    await groups.create({ name: 'Engineering' })
    await expect(groups.create({ name: 'ENGINEERING' })).rejects.toBeInstanceOf(
      ConflictError,
    )
  })

  it('finds by name case-insensitively', async () => {
    await groups.create({ name: 'Engineering' })
    expect((await groups.findByName('engineering'))?.name).toBe('Engineering')
  })

  it('returns null for a missing group rather than throwing', async () => {
    expect(await groups.findById('00000000-0000-0000-0000-000000000000')).toBeNull()
  })

  it('lists groups with limit and offset, ordered by name', async () => {
    for (const name of ['Charlie', 'Alpha', 'Bravo']) {
      await groups.create({ name })
    }
    expect((await groups.list({ limit: 2, offset: 0 })).map((g) => g.name)).toEqual([
      'Alpha',
      'Bravo',
    ])
    expect((await groups.list({ limit: 2, offset: 2 })).map((g) => g.name)).toEqual([
      'Charlie',
    ])
    expect(await groups.count()).toBe(3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api test groups.repository`
Expected: FAIL — cannot resolve `../src/groups/groups.repository`.

- [ ] **Step 3: Write the implementation**

`apps/api/src/db/schema/groups.ts`:
```ts
import { sql } from 'drizzle-orm'
import {
  index,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { orgUnits } from './org-units'

export const groups = pgTable(
  'groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    description: varchar('description', { length: 1024 }),
    orgUnitId: uuid('org_unit_id').references(() => orgUnits.id, {
      onDelete: 'restrict',
    }),
    attributes: jsonb('attributes')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    nameUnique: uniqueIndex('groups_name_unique').on(sql`lower(${table.name})`),
    orgUnitIdx: index('groups_org_unit_idx').on(table.orgUnitId),
  }),
)
```

Update `apps/api/src/db/schema/index.ts` — add `export * from './groups'` alongside the existing three exports; do not drop any.

`apps/api/src/groups/groups.repository.ts`:
```ts
import { asc, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { ConflictError } from '../common/errors'
import * as schema from '../db/schema/index'
import { groups } from '../db/schema/groups'

export interface Group {
  id: string
  name: string
  description: string | null
  orgUnitId: string | null
  attributes: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export interface CreateGroupInput {
  name: string
  description?: string
  orgUnitId?: string
  attributes?: Record<string, unknown>
}

const UNIQUE_VIOLATION = '23505'

export class GroupsRepository {
  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async create(input: CreateGroupInput): Promise<Group> {
    try {
      const [row] = await this.db
        .insert(groups)
        .values({
          name: input.name,
          description: input.description ?? null,
          orgUnitId: input.orgUnitId ?? null,
          attributes: input.attributes ?? {},
        })
        .returning()

      return row as Group
    } catch (cause) {
      if ((cause as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new ConflictError(`a group named "${input.name}" already exists`)
      }
      throw cause
    }
  }

  async findById(id: string): Promise<Group | null> {
    const [row] = await this.db.select().from(groups).where(eq(groups.id, id)).limit(1)
    return (row as Group | undefined) ?? null
  }

  async findByName(name: string): Promise<Group | null> {
    const [row] = await this.db
      .select()
      .from(groups)
      .where(sql`lower(${groups.name}) = lower(${name})`)
      .limit(1)

    return (row as Group | undefined) ?? null
  }

  async list(options: { limit: number; offset: number }): Promise<Group[]> {
    const rows = await this.db
      .select()
      .from(groups)
      .orderBy(asc(groups.name))
      .limit(options.limit)
      .offset(options.offset)

    return rows as Group[]
  }

  async count(): Promise<number> {
    const [row] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(groups)

    return row?.value ?? 0
  }
}
```

Translating the Postgres unique-violation code into a `ConflictError` is what keeps a duplicate name a 409 rather than a 500 once controllers exist.

- [ ] **Step 4: Generate the migration and run the tests**

Run:
```bash
pnpm --filter @idm/api db:generate
pnpm --filter @idm/api test groups.repository
pnpm --filter @idm/api build
```
Expected: PASS — 6 tests. Build exits 0. Confirm the generated SQL emits a `lower(name)` expression unique index; paste it into your report.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat: add groups schema and repository"
```

---

### Task 3: Group membership edges with cycle prevention

**Files:**
- Create: `apps/api/src/db/schema/group-members.ts`
- Modify: `apps/api/src/db/schema/index.ts`, `apps/api/src/groups/groups.repository.ts`
- Test: `apps/api/test/group-membership.spec.ts`

**Interfaces:**
- Consumes: `groups` (Task 2), `users` table, `CycleError`, `NotFoundError`, `ConflictError` (Task 1)
- Produces, added to `GroupsRepository`:
  - `addUser(groupId: string, userId: string): Promise<void>`
  - `removeUser(groupId: string, userId: string): Promise<void>`
  - `addChildGroup(parentGroupId: string, childGroupId: string): Promise<void>`
  - `removeChildGroup(parentGroupId: string, childGroupId: string): Promise<void>`
  - `listDirectUserMembers(groupId: string): Promise<string[]>` — user ids
  - `listDirectChildGroups(groupId: string): Promise<string[]>` — group ids

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/group-membership.spec.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { ConflictError, CycleError, NotFoundError } from '../src/common/errors'
import { GroupsRepository } from '../src/groups/groups.repository'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

const MISSING = '00000000-0000-0000-0000-000000000000'

describe('group membership', () => {
  const ctx = withTestDatabase()
  let groups: GroupsRepository
  let users: UsersRepository
  let orgUnitId: string

  beforeEach(async () => {
    await ctx.pool.query(
      'TRUNCATE TABLE group_user_members, group_group_members, groups, users, org_units CASCADE',
    )
    groups = new GroupsRepository(ctx.db)
    users = new UsersRepository(ctx.db)
    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot('Acme Corp')).id
  })

  const makeUser = (username: string) =>
    users.create({
      primaryEmail: `${username}@example.com`,
      username,
      firstName: 'Test',
      lastName: 'User',
      orgUnitId,
    })

  it('adds and lists a direct user member', async () => {
    const group = await groups.create({ name: 'Engineering' })
    const user = await makeUser('ada')
    await groups.addUser(group.id, user.id)
    expect(await groups.listDirectUserMembers(group.id)).toEqual([user.id])
  })

  it('is idempotent when the same user is added twice', async () => {
    const group = await groups.create({ name: 'Engineering' })
    const user = await makeUser('ada')
    await groups.addUser(group.id, user.id)
    await groups.addUser(group.id, user.id)
    expect(await groups.listDirectUserMembers(group.id)).toEqual([user.id])
  })

  it('removes a user member', async () => {
    const group = await groups.create({ name: 'Engineering' })
    const user = await makeUser('ada')
    await groups.addUser(group.id, user.id)
    await groups.removeUser(group.id, user.id)
    expect(await groups.listDirectUserMembers(group.id)).toEqual([])
  })

  it('raises NotFoundError for a missing group or user', async () => {
    const group = await groups.create({ name: 'Engineering' })
    const user = await makeUser('ada')
    await expect(groups.addUser(MISSING, user.id)).rejects.toBeInstanceOf(NotFoundError)
    await expect(groups.addUser(group.id, MISSING)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('nests a child group', async () => {
    const parent = await groups.create({ name: 'All Staff' })
    const child = await groups.create({ name: 'Engineering' })
    await groups.addChildGroup(parent.id, child.id)
    expect(await groups.listDirectChildGroups(parent.id)).toEqual([child.id])
  })

  it('rejects a self-edge as a CycleError', async () => {
    const group = await groups.create({ name: 'Engineering' })
    await expect(groups.addChildGroup(group.id, group.id)).rejects.toBeInstanceOf(
      CycleError,
    )
  })

  it('rejects a direct two-node cycle', async () => {
    const a = await groups.create({ name: 'A' })
    const b = await groups.create({ name: 'B' })
    await groups.addChildGroup(a.id, b.id)
    await expect(groups.addChildGroup(b.id, a.id)).rejects.toBeInstanceOf(CycleError)
  })

  it('rejects a transitive cycle three levels deep', async () => {
    const a = await groups.create({ name: 'A' })
    const b = await groups.create({ name: 'B' })
    const c = await groups.create({ name: 'C' })
    await groups.addChildGroup(a.id, b.id)
    await groups.addChildGroup(b.id, c.id)
    await expect(groups.addChildGroup(c.id, a.id)).rejects.toBeInstanceOf(CycleError)
  })

  it('allows a diamond, which is not a cycle', async () => {
    const top = await groups.create({ name: 'Top' })
    const left = await groups.create({ name: 'Left' })
    const right = await groups.create({ name: 'Right' })
    const bottom = await groups.create({ name: 'Bottom' })
    await groups.addChildGroup(top.id, left.id)
    await groups.addChildGroup(top.id, right.id)
    await groups.addChildGroup(left.id, bottom.id)
    await expect(groups.addChildGroup(right.id, bottom.id)).resolves.toBeUndefined()
  })

  it('is idempotent when the same edge is added twice', async () => {
    const parent = await groups.create({ name: 'All Staff' })
    const child = await groups.create({ name: 'Engineering' })
    await groups.addChildGroup(parent.id, child.id)
    await groups.addChildGroup(parent.id, child.id)
    expect(await groups.listDirectChildGroups(parent.id)).toEqual([child.id])
  })

  it('never lets concurrent edge insertions form a cycle', async () => {
    // A -> B and B -> A raced 20 times. Without serialization both checks pass
    // and a cycle is committed, which makes effective-membership expansion
    // depend on UNION dedup rather than on the graph actually being a DAG.
    for (let i = 0; i < 20; i++) {
      await ctx.pool.query('TRUNCATE TABLE group_group_members CASCADE')
      const a = await groups.findByName('A') ?? (await groups.create({ name: 'A' }))
      const b = await groups.findByName('B') ?? (await groups.create({ name: 'B' }))

      const results = await Promise.allSettled([
        groups.addChildGroup(a.id, b.id),
        groups.addChildGroup(b.id, a.id),
      ])

      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      expect(fulfilled).toHaveLength(1)

      const { rows } = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM group_group_members')
      expect(rows[0].n).toBe(1)
    }
  })

  it('raises NotFoundError when nesting a group that does not exist', async () => {
    const group = await groups.create({ name: 'Engineering' })
    await expect(groups.addChildGroup(group.id, MISSING)).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api test group-membership`
Expected: FAIL — `groups.addUser is not a function`.

- [ ] **Step 3: Write the implementation**

`apps/api/src/db/schema/group-members.ts`:
```ts
import { sql } from 'drizzle-orm'
import { check, index, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core'
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
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.groupId, table.userId] }),
    userIdx: index('group_user_members_user_idx').on(table.userId),
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
```

Update `apps/api/src/db/schema/index.ts` — add `export * from './group-members'`, keeping the existing exports.

Append to `apps/api/src/groups/groups.repository.ts` (and add the imports it needs):
```ts
import { and, eq } from 'drizzle-orm'
import { CycleError, NotFoundError } from '../common/errors'
import { groupGroupMembers, groupUserMembers } from '../db/schema/group-members'
import { users } from '../db/schema/users'

/**
 * A single lock id shared by every nested-group mutation. Edge insertion is a
 * check-then-write, so two concurrent transactions could each observe no cycle
 * and together commit one. Nested-group edits are rare admin operations, so
 * serializing all of them is cheaper than reasoning about partial orders.
 */
const GROUP_GRAPH_LOCK_ID = 0x1d3a_0001

// ... inside class GroupsRepository:

  private async requireGroup(id: string): Promise<void> {
    if ((await this.findById(id)) === null) {
      throw new NotFoundError('group', id)
    }
  }

  async addUser(groupId: string, userId: string): Promise<void> {
    await this.requireGroup(groupId)

    const [user] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)

    if (user === undefined) {
      throw new NotFoundError('user', userId)
    }

    await this.db
      .insert(groupUserMembers)
      .values({ groupId, userId })
      .onConflictDoNothing()
  }

  async removeUser(groupId: string, userId: string): Promise<void> {
    await this.db
      .delete(groupUserMembers)
      .where(
        and(
          eq(groupUserMembers.groupId, groupId),
          eq(groupUserMembers.userId, userId),
        ),
      )
  }

  async listDirectUserMembers(groupId: string): Promise<string[]> {
    const rows = await this.db
      .select({ userId: groupUserMembers.userId })
      .from(groupUserMembers)
      .where(eq(groupUserMembers.groupId, groupId))

    return rows.map((row) => row.userId)
  }

  async addChildGroup(parentGroupId: string, childGroupId: string): Promise<void> {
    if (parentGroupId === childGroupId) {
      throw new CycleError('a group cannot contain itself')
    }

    await this.requireGroup(parentGroupId)
    await this.requireGroup(childGroupId)

    await this.db.transaction(async (tx) => {
      // Serialize every graph mutation; see GROUP_GRAPH_LOCK_ID.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${GROUP_GRAPH_LOCK_ID})`)

      // Would the new edge close a loop? It does exactly when the proposed
      // parent is already reachable downward from the proposed child.
      const { rows } = await tx.execute<{ reachable: boolean }>(sql`
        WITH RECURSIVE descendants AS (
          SELECT child_group_id AS id
            FROM group_group_members
           WHERE parent_group_id = ${childGroupId}::uuid
          UNION
          SELECT ggm.child_group_id
            FROM group_group_members ggm
            JOIN descendants d ON ggm.parent_group_id = d.id
        )
        SELECT EXISTS (
          SELECT 1 FROM descendants WHERE id = ${parentGroupId}::uuid
        ) AS reachable
      `)

      if (rows[0]?.reachable === true) {
        throw new CycleError(
          `nesting group ${childGroupId} under ${parentGroupId} would create a cycle`,
        )
      }

      await tx
        .insert(groupGroupMembers)
        .values({ parentGroupId, childGroupId })
        .onConflictDoNothing()
    })
  }

  async removeChildGroup(parentGroupId: string, childGroupId: string): Promise<void> {
    await this.db
      .delete(groupGroupMembers)
      .where(
        and(
          eq(groupGroupMembers.parentGroupId, parentGroupId),
          eq(groupGroupMembers.childGroupId, childGroupId),
        ),
      )
  }

  async listDirectChildGroups(groupId: string): Promise<string[]> {
    const rows = await this.db
      .select({ childGroupId: groupGroupMembers.childGroupId })
      .from(groupGroupMembers)
      .where(eq(groupGroupMembers.parentGroupId, groupId))

    return rows.map((row) => row.childGroupId)
  }
```

- [ ] **Step 4: Generate the migration and run the tests**

Run:
```bash
pnpm --filter @idm/api db:generate
pnpm --filter @idm/api test group-membership
pnpm --filter @idm/api build
```
Expected: PASS — 13 tests. Confirm the generated SQL contains the `group_group_members_no_self_edge` CHECK constraint; paste it into your report.

Then prove the concurrency test is load-bearing: temporarily remove the `pg_advisory_xact_lock` line, re-run, and confirm the concurrency test FAILS (two edges committed). Restore it and confirm it passes. Include both outputs in your report.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat: add group membership edges with advisory-locked cycle prevention"
```

---

### Task 4: Effective membership expansion

**Files:**
- Modify: `apps/api/src/groups/groups.repository.ts`
- Test: `apps/api/test/effective-membership.spec.ts`

**Interfaces:**
- Consumes: everything from Task 3
- Produces, added to `GroupsRepository`:
  - `listEffectiveUserMembers(groupId: string): Promise<string[]>` — user ids from this group and every descendant group, de-duplicated
  - `listEffectiveGroupsForUser(userId: string): Promise<string[]>` — group ids the user belongs to directly or transitively (walking upward)

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/effective-membership.spec.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { GroupsRepository } from '../src/groups/groups.repository'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

describe('effective membership', () => {
  const ctx = withTestDatabase()
  let groups: GroupsRepository
  let users: UsersRepository
  let orgUnitId: string

  beforeEach(async () => {
    await ctx.pool.query(
      'TRUNCATE TABLE group_user_members, group_group_members, groups, users, org_units CASCADE',
    )
    groups = new GroupsRepository(ctx.db)
    users = new UsersRepository(ctx.db)
    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot('Acme Corp')).id
  })

  const makeUser = (username: string) =>
    users.create({
      primaryEmail: `${username}@example.com`,
      username,
      firstName: 'Test',
      lastName: 'User',
      orgUnitId,
    })

  it('includes direct members', async () => {
    const group = await groups.create({ name: 'Engineering' })
    const ada = await makeUser('ada')
    await groups.addUser(group.id, ada.id)
    expect(await groups.listEffectiveUserMembers(group.id)).toEqual([ada.id])
  })

  it('includes members of nested groups, transitively', async () => {
    const all = await groups.create({ name: 'All Staff' })
    const eng = await groups.create({ name: 'Engineering' })
    const backend = await groups.create({ name: 'Backend' })
    await groups.addChildGroup(all.id, eng.id)
    await groups.addChildGroup(eng.id, backend.id)

    const ada = await makeUser('ada')
    const grace = await makeUser('grace')
    await groups.addUser(backend.id, ada.id)
    await groups.addUser(eng.id, grace.id)

    const effective = await groups.listEffectiveUserMembers(all.id)
    expect(effective.sort()).toEqual([ada.id, grace.id].sort())
  })

  it('de-duplicates a user reachable by two paths', async () => {
    const top = await groups.create({ name: 'Top' })
    const left = await groups.create({ name: 'Left' })
    const right = await groups.create({ name: 'Right' })
    const bottom = await groups.create({ name: 'Bottom' })
    await groups.addChildGroup(top.id, left.id)
    await groups.addChildGroup(top.id, right.id)
    await groups.addChildGroup(left.id, bottom.id)
    await groups.addChildGroup(right.id, bottom.id)

    const ada = await makeUser('ada')
    await groups.addUser(bottom.id, ada.id)

    expect(await groups.listEffectiveUserMembers(top.id)).toEqual([ada.id])
  })

  it('does not leak members upward from a parent to its child', async () => {
    const parent = await groups.create({ name: 'Parent' })
    const child = await groups.create({ name: 'Child' })
    await groups.addChildGroup(parent.id, child.id)

    const ada = await makeUser('ada')
    await groups.addUser(parent.id, ada.id)

    expect(await groups.listEffectiveUserMembers(child.id)).toEqual([])
  })

  it('returns an empty list for a group with no members', async () => {
    const group = await groups.create({ name: 'Empty' })
    expect(await groups.listEffectiveUserMembers(group.id)).toEqual([])
  })

  it('resolves every group a user effectively belongs to', async () => {
    const all = await groups.create({ name: 'All Staff' })
    const eng = await groups.create({ name: 'Engineering' })
    const backend = await groups.create({ name: 'Backend' })
    const unrelated = await groups.create({ name: 'Unrelated' })
    await groups.addChildGroup(all.id, eng.id)
    await groups.addChildGroup(eng.id, backend.id)

    const ada = await makeUser('ada')
    await groups.addUser(backend.id, ada.id)

    const effective = await groups.listEffectiveGroupsForUser(ada.id)
    expect(effective.sort()).toEqual([all.id, eng.id, backend.id].sort())
    expect(effective).not.toContain(unrelated.id)
  })

  it('terminates even if a cycle exists in the stored graph', async () => {
    // The repository prevents cycles, so plant one directly to prove the
    // expansion itself is safe rather than relying on the guard upstream.
    const a = await groups.create({ name: 'A' })
    const b = await groups.create({ name: 'B' })
    await ctx.pool.query(
      'INSERT INTO group_group_members (parent_group_id, child_group_id) VALUES ($1,$2),($2,$1)',
      [a.id, b.id],
    )
    const ada = await makeUser('ada')
    await groups.addUser(b.id, ada.id)

    expect(await groups.listEffectiveUserMembers(a.id)).toEqual([ada.id])
  })
})
```

The last test is the one worth writing carefully: `UNION ALL` would hang here, and the failure mode is a wedged test run rather than a clear assertion error.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api test effective-membership`
Expected: FAIL — `groups.listEffectiveUserMembers is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `apps/api/src/groups/groups.repository.ts`:
```ts
  /**
   * Every user in this group or any descendant group.
   * UNION (not UNION ALL) is load-bearing: it de-duplicates the frontier, so
   * the recursion terminates even against a graph that somehow contains a cycle.
   */
  async listEffectiveUserMembers(groupId: string): Promise<string[]> {
    const { rows } = await this.db.execute<{ user_id: string }>(sql`
      WITH RECURSIVE reachable AS (
        SELECT ${groupId}::uuid AS id
        UNION
        SELECT ggm.child_group_id
          FROM group_group_members ggm
          JOIN reachable r ON ggm.parent_group_id = r.id
      )
      SELECT DISTINCT gum.user_id
        FROM group_user_members gum
        JOIN reachable r ON gum.group_id = r.id
    `)

    return rows.map((row) => row.user_id)
  }

  /** Every group this user belongs to directly, plus all of their ancestors. */
  async listEffectiveGroupsForUser(userId: string): Promise<string[]> {
    const { rows } = await this.db.execute<{ group_id: string }>(sql`
      WITH RECURSIVE ancestors AS (
        SELECT gum.group_id AS id
          FROM group_user_members gum
         WHERE gum.user_id = ${userId}::uuid
        UNION
        SELECT ggm.parent_group_id
          FROM group_group_members ggm
          JOIN ancestors a ON ggm.child_group_id = a.id
      )
      SELECT DISTINCT id AS group_id FROM ancestors
    `)

    return rows.map((row) => row.group_id)
  }
```

- [ ] **Step 4: Run the tests**

Run:
```bash
pnpm --filter @idm/api test effective-membership
pnpm --filter @idm/api build
```
Expected: PASS — 7 tests. Build exits 0.

Then prove the cycle-safety test is load-bearing: temporarily change both `UNION` keywords to `UNION ALL`, re-run **only** the cycle test with a short timeout, and confirm it hangs or errors rather than passing. Restore `UNION` and confirm green. Report what you observed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat: add effective group membership expansion"
```

---

### Task 5: HTTP foundation — pagination, Zod query validation, guard coverage

**Files:**
- Create: `apps/api/src/common/pagination.ts`
- Modify: `apps/api/src/users/users.repository.ts` (add `list`/`count`), `apps/api/src/org-units/org-units.repository.ts` (add `list`/`count`)
- Test: `apps/api/test/pagination.spec.ts`, `apps/api/test/guard-coverage.spec.ts`

**Interfaces:**
- Consumes: `ValidationError` (Task 1)
- Produces:
  - `interface PageQuery { limit: number; offset: number }`
  - `parsePageQuery(raw: unknown): PageQuery` — defaults `limit=50`, `offset=0`; caps `limit` at `100`; throws `ValidationError` on invalid input
  - `interface Page<T> { items: T[]; total: number; limit: number; offset: number }`
  - `UsersRepository.list(options: PageQuery & { status?: UserStatus; orgUnitId?: string }): Promise<User[]>` and `UsersRepository.count(filter?: { status?: UserStatus; orgUnitId?: string }): Promise<number>`
  - `OrgUnitsRepository.list(options: PageQuery): Promise<OrgUnit[]>` and `OrgUnitsRepository.count(): Promise<number>`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/pagination.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ValidationError } from '../src/common/errors'
import { parsePageQuery } from '../src/common/pagination'

describe('parsePageQuery', () => {
  it('applies defaults when nothing is supplied', () => {
    expect(parsePageQuery({})).toEqual({ limit: 50, offset: 0 })
  })

  it('accepts numeric strings from the query string', () => {
    expect(parsePageQuery({ limit: '10', offset: '20' })).toEqual({
      limit: 10,
      offset: 20,
    })
  })

  it('caps limit at 100 rather than rejecting it', () => {
    expect(parsePageQuery({ limit: '5000' }).limit).toBe(100)
  })

  it('rejects a negative offset', () => {
    expect(() => parsePageQuery({ offset: '-1' })).toThrow(ValidationError)
  })

  it('rejects a zero or negative limit', () => {
    expect(() => parsePageQuery({ limit: '0' })).toThrow(ValidationError)
  })

  it('rejects a non-numeric limit', () => {
    expect(() => parsePageQuery({ limit: 'lots' })).toThrow(ValidationError)
  })

  it('rejects a fractional limit', () => {
    expect(() => parsePageQuery({ limit: '2.5' })).toThrow(ValidationError)
  })

  it('names the offending field in the issues list', () => {
    try {
      parsePageQuery({ limit: 'lots' })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as ValidationError).issues.join()).toContain('limit')
    }
  })
})
```

Create `apps/api/test/guard-coverage.spec.ts`:

```ts
import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { JwtGuard } from '../src/auth/jwt.guard'

/** Only the liveness probe may be reached without authentication. */
const OPEN_BY_DESIGN = new Set(['HealthController'])

describe('guard coverage', () => {
  it('applies JwtGuard to every controller except the health endpoint', () => {
    // Pure metadata reflection — no DI container, no env, no database.
    // `@Module({controllers})` stores under 'controllers'; `@UseGuards` under '__guards__'.
    const registered: Array<new (...args: never[]) => unknown> =
      Reflect.getMetadata('controllers', AppModule) ?? []

    expect(registered.length).toBeGreaterThan(0)

    const unguarded = registered
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

This test is what stops a future controller from shipping unauthenticated. It must fail loudly if someone adds one without `@UseGuards(JwtGuard)`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @idm/api test pagination guard-coverage`
Expected: FAIL — cannot resolve `../src/common/pagination`.

- [ ] **Step 3: Write the implementation**

`apps/api/src/common/pagination.ts`:
```ts
import { z } from 'zod'
import { ValidationError } from './errors'

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 100

export interface PageQuery {
  limit: number
  offset: number
}

export interface Page<T> {
  items: T[]
  total: number
  limit: number
  offset: number
}

const pageSchema = z.object({
  limit: z.coerce.number().int().positive().default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
})

/**
 * An oversized limit is clamped rather than rejected — a caller asking for
 * "everything" gets a page, not a 400. Malformed input is still an error.
 */
export function parsePageQuery(raw: unknown): PageQuery {
  const parsed = pageSchema.safeParse(raw ?? {})

  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || 'query'}: ${issue.message}`,
      ),
    )
  }

  return {
    limit: Math.min(parsed.data.limit, MAX_LIMIT),
    offset: parsed.data.offset,
  }
}
```

Append to `apps/api/src/users/users.repository.ts` (its drizzle import must gain `and` and `asc` alongside the existing `eq`/`sql`):
```ts
  async list(
    options: { limit: number; offset: number; status?: UserStatus; orgUnitId?: string },
  ): Promise<User[]> {
    const filters = []
    if (options.status !== undefined) filters.push(eq(users.status, options.status))
    if (options.orgUnitId !== undefined) filters.push(eq(users.orgUnitId, options.orgUnitId))

    const rows = await this.db
      .select()
      .from(users)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(asc(users.username))
      .limit(options.limit)
      .offset(options.offset)

    return rows as User[]
  }

  async count(filter: { status?: UserStatus; orgUnitId?: string } = {}): Promise<number> {
    const filters = []
    if (filter.status !== undefined) filters.push(eq(users.status, filter.status))
    if (filter.orgUnitId !== undefined) filters.push(eq(users.orgUnitId, filter.orgUnitId))

    const [row] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(users)
      .where(filters.length > 0 ? and(...filters) : undefined)

    return row?.value ?? 0
  }
```

Append to `apps/api/src/org-units/org-units.repository.ts`:
```ts
  async list(options: { limit: number; offset: number }): Promise<OrgUnit[]> {
    const rows = await this.db
      .select()
      .from(orgUnits)
      .orderBy(asc(orgUnits.path))
      .limit(options.limit)
      .offset(options.offset)

    return rows as OrgUnit[]
  }

  async count(): Promise<number> {
    const [row] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(orgUnits)

    return row?.value ?? 0
  }
```

- [ ] **Step 4: Run the tests**

Run:
```bash
pnpm --filter @idm/api test pagination guard-coverage
pnpm --filter @idm/api build
```
Expected: PASS — 9 tests. Build exits 0. `guard-coverage` currently passes trivially because only `HealthController` and `MeController` exist; Task 6 makes it meaningful.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat: add pagination parsing, repository list methods, and guard-coverage test"
```

---

### Task 6: Read-only users and org-units controllers

**Files:**
- Create: `apps/api/src/common/db.token.ts`, `apps/api/src/users/users.controller.ts`, `apps/api/src/org-units/org-units.controller.ts`
- Modify: `apps/api/src/app.module.ts`, `apps/api/src/main.ts`, `apps/api/src/users/users.repository.ts` (make injectable), `apps/api/src/org-units/org-units.repository.ts` (make injectable)
- Test: `apps/api/test/users.controller.spec.ts`, `apps/api/test/org-units.controller.spec.ts`

**Interfaces:**
- Consumes: `UsersRepository`, `OrgUnitsRepository`, `parsePageQuery`, `Page<T>`, `JwtGuard`, `DomainExceptionFilter`, `createDbClient`
- Produces:
  - `DB_CLIENT` injection token (a `Symbol`) providing `NodePgDatabase<typeof schema>`
  - `GET /users` → `Page<User>`; `GET /users/:id` → `User` or 404
  - `GET /org-units` → `Page<OrgUnit>`; `GET /org-units/:id` → `OrgUnit` or 404; `GET /org-units/:id/subtree` → `OrgUnit[]`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/users.controller.spec.ts`:

```ts
import { type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { JwtGuard } from '../src/auth/jwt.guard'
import { DB_CLIENT } from '../src/common/db.token'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { UsersController } from '../src/users/users.controller'
import { UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

describe('GET /users', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let orgUnitId: string

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        UsersRepository,
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue({ canActivate: () => true })
      .compile()

    app = moduleRef.createNestApplication()
    app.useGlobalFilters(new DomainExceptionFilter())
    await app.init()
  })

  afterAll(async () => {
    await app?.close()
  })

  beforeEach(async () => {
    await ctx.pool.query('TRUNCATE TABLE users, org_units CASCADE')
    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot('Acme Corp')).id
    const users = new UsersRepository(ctx.db)
    for (const username of ['ada', 'grace', 'alan']) {
      await users.create({
        primaryEmail: `${username}@example.com`,
        username,
        firstName: 'Test',
        lastName: 'User',
        orgUnitId,
      })
    }
  })

  it('returns a page with total, limit and offset', async () => {
    const res = await request(app.getHttpServer()).get('/users').expect(200)
    expect(res.body.total).toBe(3)
    expect(res.body.limit).toBe(50)
    expect(res.body.offset).toBe(0)
    expect(res.body.items).toHaveLength(3)
  })

  it('orders by username and honours limit/offset', async () => {
    const res = await request(app.getHttpServer())
      .get('/users?limit=2&offset=1')
      .expect(200)
    expect(res.body.items.map((u: { username: string }) => u.username)).toEqual([
      'alan',
      'grace',
    ])
  })

  it('filters by status', async () => {
    const res = await request(app.getHttpServer())
      .get('/users?status=pending')
      .expect(200)
    expect(res.body.total).toBe(3)
  })

  it('rejects an unknown status with 400 VALIDATION_FAILED', async () => {
    const res = await request(app.getHttpServer())
      .get('/users?status=nonsense')
      .expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('rejects a malformed limit with 400 rather than 500', async () => {
    const res = await request(app.getHttpServer()).get('/users?limit=lots').expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('never exposes a credential-shaped field', async () => {
    const res = await request(app.getHttpServer()).get('/users').expect(200)
    const serialized = JSON.stringify(res.body).toLowerCase()
    for (const forbidden of ['password', 'passwd', 'secret', 'hash', 'salt', 'token']) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('returns a single user by id', async () => {
    const list = await request(app.getHttpServer()).get('/users').expect(200)
    const id = list.body.items[0].id
    const res = await request(app.getHttpServer()).get(`/users/${id}`).expect(200)
    expect(res.body.id).toBe(id)
  })

  it('returns 404 NOT_FOUND for a missing user', async () => {
    const res = await request(app.getHttpServer())
      .get('/users/00000000-0000-0000-0000-000000000000')
      .expect(404)
    expect(res.body.code).toBe('NOT_FOUND')
  })

  it('returns 400 for a non-uuid id rather than 500', async () => {
    const res = await request(app.getHttpServer()).get('/users/not-a-uuid').expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('exposes no write routes', async () => {
    await request(app.getHttpServer()).post('/users').send({ username: 'x' }).expect(404)
    await request(app.getHttpServer()).patch('/users/abc').send({}).expect(404)
    await request(app.getHttpServer()).delete('/users/abc').expect(404)
  })
})
```

Create `apps/api/test/org-units.controller.spec.ts`:

```ts
import { type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { JwtGuard } from '../src/auth/jwt.guard'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { OrgUnitsController } from '../src/org-units/org-units.controller'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { withTestDatabase } from './support/pg'

describe('GET /org-units', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let rootId: string
  let salesId: string

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OrgUnitsController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        OrgUnitsRepository,
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue({ canActivate: () => true })
      .compile()

    app = moduleRef.createNestApplication()
    app.useGlobalFilters(new DomainExceptionFilter())
    await app.init()
  })

  afterAll(async () => {
    await app?.close()
  })

  beforeEach(async () => {
    await ctx.pool.query('TRUNCATE TABLE users, org_units CASCADE')
    const repo = new OrgUnitsRepository(ctx.db)
    const root = await repo.createRoot('Acme Corp')
    rootId = root.id
    salesId = (await repo.createChild(root.id, 'Sales')).id
    await repo.createChild(salesId, 'EMEA')
  })

  it('lists org units as a page ordered by path', async () => {
    const res = await request(app.getHttpServer()).get('/org-units').expect(200)
    expect(res.body.total).toBe(3)
    expect(res.body.items.map((u: { path: string }) => u.path)).toEqual([
      'acme_corp',
      'acme_corp.sales',
      'acme_corp.sales.emea',
    ])
  })

  it('returns one org unit by id', async () => {
    const res = await request(app.getHttpServer()).get(`/org-units/${salesId}`).expect(200)
    expect(res.body.path).toBe('acme_corp.sales')
  })

  it('returns the subtree including its root', async () => {
    const res = await request(app.getHttpServer())
      .get(`/org-units/${salesId}/subtree`)
      .expect(200)
    expect(res.body.map((u: { path: string }) => u.path).sort()).toEqual([
      'acme_corp.sales',
      'acme_corp.sales.emea',
    ])
  })

  it('returns 404 for a missing org unit', async () => {
    const res = await request(app.getHttpServer())
      .get('/org-units/00000000-0000-0000-0000-000000000000')
      .expect(404)
    expect(res.body.code).toBe('NOT_FOUND')
  })

  it('exposes no write routes', async () => {
    await request(app.getHttpServer()).post('/org-units').send({ name: 'x' }).expect(404)
    await request(app.getHttpServer()).delete(`/org-units/${rootId}`).expect(404)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @idm/api test users.controller org-units.controller`
Expected: FAIL — cannot resolve `../src/common/db.token`.

- [ ] **Step 3: Write the implementation**

`apps/api/src/common/db.token.ts`:
```ts
/** DI token for the Drizzle database handle. */
export const DB_CLIENT = Symbol('DB_CLIENT')
```

`apps/api/src/users/users.controller.ts`:
```ts
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common'
import { z } from 'zod'
import { JwtGuard } from '../auth/jwt.guard'
import { NotFoundError, ValidationError } from '../common/errors'
import { type Page, parsePageQuery } from '../common/pagination'
import { UsersRepository, type User, type UserStatus } from './users.repository'

const uuidSchema = z.string().uuid()
const statusSchema = z
  .enum(['pending', 'active', 'suspended', 'deactivated'])
  .optional()

function parseId(raw: string): string {
  const parsed = uuidSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ValidationError([`id: must be a UUID`])
  }
  return parsed.data
}

@Controller('users')
@UseGuards(JwtGuard)
export class UsersController {
  constructor(private readonly users: UsersRepository) {}

  @Get()
  async list(@Query() query: Record<string, unknown>): Promise<Page<User>> {
    const page = parsePageQuery(query)

    const status = statusSchema.safeParse(query.status)
    if (!status.success) {
      throw new ValidationError(['status: must be one of pending, active, suspended, deactivated'])
    }

    const orgUnitId =
      query.orgUnitId === undefined ? undefined : parseId(String(query.orgUnitId))

    const filter = { status: status.data as UserStatus | undefined, orgUnitId }

    const [items, total] = await Promise.all([
      this.users.list({ ...page, ...filter }),
      this.users.count(filter),
    ])

    return { items, total, limit: page.limit, offset: page.offset }
  }

  @Get(':id')
  async findOne(@Param('id') rawId: string): Promise<User> {
    const id = parseId(rawId)
    const user = await this.users.findById(id)
    if (user === null) {
      throw new NotFoundError('user', id)
    }
    return user
  }
}
```

`apps/api/src/org-units/org-units.controller.ts`:
```ts
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common'
import { z } from 'zod'
import { JwtGuard } from '../auth/jwt.guard'
import { NotFoundError, ValidationError } from '../common/errors'
import { type Page, parsePageQuery } from '../common/pagination'
import { OrgUnitsRepository, type OrgUnit } from './org-units.repository'

const uuidSchema = z.string().uuid()

function parseId(raw: string): string {
  const parsed = uuidSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ValidationError([`id: must be a UUID`])
  }
  return parsed.data
}

@Controller('org-units')
@UseGuards(JwtGuard)
export class OrgUnitsController {
  constructor(private readonly orgUnits: OrgUnitsRepository) {}

  @Get()
  async list(@Query() query: Record<string, unknown>): Promise<Page<OrgUnit>> {
    const page = parsePageQuery(query)
    const [items, total] = await Promise.all([
      this.orgUnits.list(page),
      this.orgUnits.count(),
    ])
    return { items, total, limit: page.limit, offset: page.offset }
  }

  @Get(':id')
  async findOne(@Param('id') rawId: string): Promise<OrgUnit> {
    const id = parseId(rawId)
    const unit = await this.orgUnits.findById(id)
    if (unit === null) {
      throw new NotFoundError('org unit', id)
    }
    return unit
  }

  @Get(':id/subtree')
  async subtree(@Param('id') rawId: string): Promise<OrgUnit[]> {
    const id = parseId(rawId)
    const unit = await this.orgUnits.findById(id)
    if (unit === null) {
      throw new NotFoundError('org unit', id)
    }
    return this.orgUnits.findSubtree(id)
  }
}
```

Both repositories must become injectable. Add `@Injectable()` and an `@Inject(DB_CLIENT)` constructor parameter to `UsersRepository` and `OrgUnitsRepository`:
```ts
import { Inject, Injectable } from '@nestjs/common'
import { DB_CLIENT } from '../common/db.token'

@Injectable()
export class UsersRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>) {}
  // ...
}
```
Milestone 1 proved that a class resolved through Nest DI must declare its own injection token — a `useFactory` registration alone is not consulted. Direct construction (`new UsersRepository(ctx.db)`) still works for the existing repository tests, so they keep passing unchanged.

Wire everything in `apps/api/src/app.module.ts`:
```ts
import { Module } from '@nestjs/common'
import { JWT_GUARD_OPTIONS, JwtGuard, type JwtGuardOptions } from './auth/jwt.guard'
import { MeController } from './auth/me.controller'
import { DB_CLIENT } from './common/db.token'
import { loadEnv } from './config/env'
import { createDbClient } from './db/client'
import { HealthController } from './health/health.controller'
import { OrgUnitsController } from './org-units/org-units.controller'
import { OrgUnitsRepository } from './org-units/org-units.repository'
import { UsersController } from './users/users.controller'
import { UsersRepository } from './users/users.repository'

@Module({
  controllers: [HealthController, MeController, UsersController, OrgUnitsController],
  providers: [
    {
      provide: JWT_GUARD_OPTIONS,
      useFactory: (): JwtGuardOptions => {
        const env = loadEnv(process.env)
        return { issuer: env.keycloakIssuer, audience: env.keycloakAudience }
      },
    },
    {
      provide: DB_CLIENT,
      useFactory: () => createDbClient(loadEnv(process.env).databaseUrl).db,
    },
    JwtGuard,
    UsersRepository,
    OrgUnitsRepository,
  ],
})
export class AppModule {}
```

Register the filter globally in `apps/api/src/main.ts`, after `NestFactory.create`:
```ts
import { DomainExceptionFilter } from './common/domain-exception.filter'
// ...
app.useGlobalFilters(new DomainExceptionFilter())
```

- [ ] **Step 4: Run the tests**

Run:
```bash
pnpm --filter @idm/api test
pnpm --filter @idm/api build
```
Expected: all tests pass, including `guard-coverage`, which is now meaningful — it sees `UsersController` and `OrgUnitsController`.

Prove `guard-coverage` is load-bearing: temporarily remove `@UseGuards(JwtGuard)` from `UsersController`, re-run it, confirm it FAILS naming `UsersController`, restore, confirm green. Include both outputs in your report.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat: add read-only users and org-units HTTP endpoints"
```

---

### Task 7: Read-only groups controller

**Files:**
- Create: `apps/api/src/groups/groups.controller.ts`
- Modify: `apps/api/src/app.module.ts`, `apps/api/src/groups/groups.repository.ts` (make injectable)
- Test: `apps/api/test/groups.controller.spec.ts`

**Interfaces:**
- Consumes: `GroupsRepository` (Tasks 2-4), `parsePageQuery`, `JwtGuard`, `DB_CLIENT`
- Produces:
  - `GET /groups` → `Page<Group>`
  - `GET /groups/:id` → `Group` or 404
  - `GET /groups/:id/members` → `{ users: string[]; groups: string[] }` (direct only)
  - `GET /groups/:id/effective-members` → `string[]` (user ids, expanded)
  - `GET /users/:id/groups` is intentionally NOT added here — it would require a second route on `UsersController`; instead `GET /groups?userId=` filters by effective membership

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/groups.controller.spec.ts`:

```ts
import { type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { JwtGuard } from '../src/auth/jwt.guard'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { GroupsController } from '../src/groups/groups.controller'
import { GroupsRepository } from '../src/groups/groups.repository'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

describe('GET /groups', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let allId: string
  let engId: string
  let adaId: string

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [GroupsController],
      providers: [{ provide: DB_CLIENT, useFactory: () => ctx.db }, GroupsRepository],
    })
      .overrideGuard(JwtGuard)
      .useValue({ canActivate: () => true })
      .compile()

    app = moduleRef.createNestApplication()
    app.useGlobalFilters(new DomainExceptionFilter())
    await app.init()
  })

  afterAll(async () => {
    await app?.close()
  })

  beforeEach(async () => {
    await ctx.pool.query(
      'TRUNCATE TABLE group_user_members, group_group_members, groups, users, org_units CASCADE',
    )
    const orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot('Acme Corp')).id
    const groups = new GroupsRepository(ctx.db)
    const users = new UsersRepository(ctx.db)

    allId = (await groups.create({ name: 'All Staff' })).id
    engId = (await groups.create({ name: 'Engineering' })).id
    await groups.addChildGroup(allId, engId)

    adaId = (
      await users.create({
        primaryEmail: 'ada@example.com',
        username: 'ada',
        firstName: 'Ada',
        lastName: 'Lovelace',
        orgUnitId,
      })
    ).id
    await groups.addUser(engId, adaId)
  })

  it('lists groups as a page ordered by name', async () => {
    const res = await request(app.getHttpServer()).get('/groups').expect(200)
    expect(res.body.total).toBe(2)
    expect(res.body.items.map((g: { name: string }) => g.name)).toEqual([
      'All Staff',
      'Engineering',
    ])
  })

  it('returns one group by id', async () => {
    const res = await request(app.getHttpServer()).get(`/groups/${engId}`).expect(200)
    expect(res.body.name).toBe('Engineering')
  })

  it('returns 404 for a missing group', async () => {
    const res = await request(app.getHttpServer())
      .get('/groups/00000000-0000-0000-0000-000000000000')
      .expect(404)
    expect(res.body.code).toBe('NOT_FOUND')
  })

  it('returns direct members only', async () => {
    const res = await request(app.getHttpServer())
      .get(`/groups/${allId}/members`)
      .expect(200)
    expect(res.body.users).toEqual([])
    expect(res.body.groups).toEqual([engId])
  })

  it('returns effective members expanded through nesting', async () => {
    const res = await request(app.getHttpServer())
      .get(`/groups/${allId}/effective-members`)
      .expect(200)
    expect(res.body).toEqual([adaId])
  })

  it('distinguishes direct from effective membership', async () => {
    const direct = await request(app.getHttpServer())
      .get(`/groups/${allId}/members`)
      .expect(200)
    const effective = await request(app.getHttpServer())
      .get(`/groups/${allId}/effective-members`)
      .expect(200)
    expect(direct.body.users).toEqual([])
    expect(effective.body).toEqual([adaId])
  })

  it('exposes no write routes', async () => {
    await request(app.getHttpServer()).post('/groups').send({ name: 'x' }).expect(404)
    await request(app.getHttpServer()).delete(`/groups/${engId}`).expect(404)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api test groups.controller`
Expected: FAIL — cannot resolve `../src/groups/groups.controller`.

- [ ] **Step 3: Write the implementation**

Make `GroupsRepository` injectable exactly as the other two:
```ts
import { Inject, Injectable } from '@nestjs/common'
import { DB_CLIENT } from '../common/db.token'

@Injectable()
export class GroupsRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>) {}
  // ...
}
```

`apps/api/src/groups/groups.controller.ts`:
```ts
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common'
import { z } from 'zod'
import { JwtGuard } from '../auth/jwt.guard'
import { NotFoundError, ValidationError } from '../common/errors'
import { type Page, parsePageQuery } from '../common/pagination'
import { GroupsRepository, type Group } from './groups.repository'

const uuidSchema = z.string().uuid()

function parseId(raw: string): string {
  const parsed = uuidSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ValidationError(['id: must be a UUID'])
  }
  return parsed.data
}

@Controller('groups')
@UseGuards(JwtGuard)
export class GroupsController {
  constructor(private readonly groups: GroupsRepository) {}

  @Get()
  async list(@Query() query: Record<string, unknown>): Promise<Page<Group>> {
    const page = parsePageQuery(query)
    const [items, total] = await Promise.all([
      this.groups.list(page),
      this.groups.count(),
    ])
    return { items, total, limit: page.limit, offset: page.offset }
  }

  @Get(':id')
  async findOne(@Param('id') rawId: string): Promise<Group> {
    return this.requireGroup(parseId(rawId))
  }

  @Get(':id/members')
  async members(
    @Param('id') rawId: string,
  ): Promise<{ users: string[]; groups: string[] }> {
    const id = parseId(rawId)
    await this.requireGroup(id)

    const [users, groups] = await Promise.all([
      this.groups.listDirectUserMembers(id),
      this.groups.listDirectChildGroups(id),
    ])

    return { users, groups }
  }

  @Get(':id/effective-members')
  async effectiveMembers(@Param('id') rawId: string): Promise<string[]> {
    const id = parseId(rawId)
    await this.requireGroup(id)
    return this.groups.listEffectiveUserMembers(id)
  }

  private async requireGroup(id: string): Promise<Group> {
    const group = await this.groups.findById(id)
    if (group === null) {
      throw new NotFoundError('group', id)
    }
    return group
  }
}
```

Add `GroupsController` to `controllers` and `GroupsRepository` to `providers` in `apps/api/src/app.module.ts`.

- [ ] **Step 4: Run the full suite**

Run:
```bash
pnpm --filter @idm/api test
pnpm --filter @idm/api build
pnpm --filter @idm/api db:migrate
```
Expected: every test passes; build exits 0; migrations apply cleanly to the running compose Postgres.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat: add read-only groups HTTP endpoints with membership expansion"
```

---

## Milestone 2 Definition of Done

- [ ] Every repository throws a `DomainError` subclass; no bare `Error` remains in `src/users`, `src/org-units`, `src/groups`
- [ ] `DomainExceptionFilter` is registered globally in `main.ts` and maps codes to 404/409/400
- [ ] A non-`DomainError` still produces a 500 with no internal detail in the body
- [ ] Groups support nested membership as a DAG; self-edges, direct cycles, and transitive cycles are all rejected
- [ ] Concurrent cycle-forming edge insertions cannot both commit (advisory lock, proven by a test that fails without it)
- [ ] Effective membership expands transitively, de-duplicates diamonds, and terminates against a planted cycle
- [ ] Every controller carries `@UseGuards(JwtGuard)`; `guard-coverage.spec.ts` fails if one does not
- [ ] **No `POST`/`PUT`/`PATCH`/`DELETE` route exists anywhere** — asserted per controller
- [ ] No response body contains a credential-shaped field
- [ ] `pnpm --filter @idm/api test` and `build` both green; migrations apply to a fresh database

## What Milestone 3 Builds On This

The RBAC engine and audit log. It consumes `isWithinScope` (Milestone 1) for scope checks, `DomainError` for a new `ForbiddenError`, and the read controllers as the first surface to enforce permissions on. **Milestone 3 is the gate for write endpoints** — no `POST`/`PATCH` route may be added until permission checks and audit writes are in place.

Carried forward, unchanged: the ReDoS gate on `new RegExp(rules.pattern)` in `attribute-validator.ts` must be closed by whichever milestone first exposes a write path for `attribute_definitions`.
