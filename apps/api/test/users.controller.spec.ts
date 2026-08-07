import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { AuditWriter } from '../src/audit/audit.writer'
import { JwtGuard } from '../src/auth/jwt.guard'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard, type AuthorizedRequest } from '../src/authz/permission.guard'
import { PrivilegeGuards } from '../src/authz/privilege.guards'
import { DB_CLIENT } from '../src/common/db.token'
import { GroupsRepository } from '../src/groups/groups.repository'
import { KEYCLOAK_ADMIN_CONFIG, KeycloakAdminClient } from '../src/keycloak/keycloak-admin.client'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { SyncStateRepository } from '../src/outbox/sync-state.repository'
import { UsersController } from '../src/users/users.controller'
import { UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

// Milestone 4, Task 4: UsersController now depends on KeycloakAdminClient
// (synchronous revocation on deactivate) and SyncStateRepository (the
// `syncState` read shape) too. This suite never calls deactivate and never
// needs a REAL Keycloak — connecting to a closed local port fails FAST
// (ECONNREFUSED) rather than hanging, the same "unreachable" fixture
// sync.worker.spec.ts already relies on — so this config only needs to be
// well-formed, never actually reachable.
const UNREACHABLE_KEYCLOAK_CONFIG = {
  issuer: 'http://127.0.0.1:1/realms/unreachable',
  clientId: 'irrelevant',
  clientSecret: 'irrelevant',
}

// This suite tests UsersController in isolation from the real auth stack —
// PermissionGuard is stubbed out below, same as before Milestone 3b. The
// difference is that the controller now depends on `request.actor` (set by
// the real guard in production) to narrow its results, so the stub must set
// one too. It attaches a GLOBAL assignment (scopeOrgUnitId: null) so
// scopePathsFor/canIn resolve unrestricted, matching this suite's original
// "sees everything" behaviour — scoped-actor narrowing itself is covered by
// test/scope-narrowing.spec.ts, not here.
const UNRESTRICTED_ACTOR: AuthorizedRequest['actor'] = {
  userId: '00000000-0000-0000-0000-0000000000a1',
  username: 'unrestricted-test-actor',
  orgUnitId: '00000000-0000-0000-0000-0000000000a1',
  assignments: [{ roleKey: 'super_admin', scopeOrgUnitId: null, scopePath: null }],
}

const stubPermissionGuard: CanActivate = {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthorizedRequest>()
    request.actor = UNRESTRICTED_ACTOR
    return true
  },
}

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
        PermissionEngine,
        // Milestone 3b, Task 2: UsersController's write handlers now also
        // depend on PrivilegeGuards and AuditWriter (to pair assertCanIn
        // with assertCanModifyPrincipal and to audit each mutation inside
        // its transaction) — required here purely for DI resolution, since
        // this suite only exercises the (unchanged) read routes.
        PrivilegeGuards,
        AuditWriter,
        OutboxWriter,
        // Milestone 4, Task 4: required for DI resolution only — see the
        // UNREACHABLE_KEYCLOAK_CONFIG comment above. GroupsRepository is
        // SyncStateRepository's own dependency (effective-membership
        // lookups for the group/membership half of syncState derivation).
        { provide: KEYCLOAK_ADMIN_CONFIG, useValue: UNREACHABLE_KEYCLOAK_CONFIG },
        KeycloakAdminClient,
        GroupsRepository,
        SyncStateRepository,
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionGuard)
      .useValue(stubPermissionGuard)
      .compile()

    app = moduleRef.createNestApplication()
    app.useGlobalFilters(new DomainExceptionFilter())
    await app.init()
  })

  afterAll(async () => {
    await app?.close()
  })

  beforeEach(async () => {
    // DELETE, not TRUNCATE ... CASCADE: TRUNCATE on `users` always
    // structurally cascades into audit_log via its actor_user_id foreign
    // key, and audit_log's append-only trigger unconditionally rejects that.
    // DELETE respects each table's own onDelete action instead (audit_log is
    // 'restrict' and unreferenced here, so it's never touched).
    await ctx.pool.query('DELETE FROM users')
    await ctx.pool.query('DELETE FROM org_units')
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

  // Milestone 3b, Task 2 added POST /users and PATCH /users/:id — see
  // test/users.write.spec.ts for their full behavior (permission/scope/
  // privilege checks, transactional audit, error mapping). This pin
  // narrows to what remains permanently true: there is no DELETE route for
  // users, ever — removal is a transition to `deactivated`, which is
  // terminal (see UsersRepository.changeStatus's doc comment).
  it('exposes no delete route', async () => {
    await request(app.getHttpServer()).delete('/users/abc').expect(404)
  })

  // Carried finding from Task 5's review: parsePageQuery had no upper bound
  // on `offset`. A preposterous offset like this one used to sail through
  // validation and hit Postgres as a raw bigint error — an unmapped 500, not
  // a clean domain-level 400. Now that pagination is wired to a real
  // endpoint, this proves the fix end-to-end through the actual HTTP stack.
  it('rejects a preposterously large offset with 400 VALIDATION_FAILED rather than crashing on Postgres', async () => {
    const res = await request(app.getHttpServer()).get('/users?offset=1e21').expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  describe('default deactivated-user exclusion', () => {
    it('omits a deactivated user from the default list and total', async () => {
      const repo = new UsersRepository(ctx.db)
      const toDeactivate = await repo.create({
        primaryEmail: 'gone@example.com',
        username: 'gone',
        firstName: 'Gone',
        lastName: 'User',
        orgUnitId,
      })
      await repo.changeStatus(toDeactivate.id, 'active')
      await repo.changeStatus(toDeactivate.id, 'deactivated')

      const res = await request(app.getHttpServer()).get('/users').expect(200)
      expect(res.body.total).toBe(3)
      expect(
        res.body.items.map((u: { username: string }) => u.username),
      ).not.toContain('gone')
    })

    it('returns deactivated users when status=deactivated is requested explicitly', async () => {
      const repo = new UsersRepository(ctx.db)
      const toDeactivate = await repo.create({
        primaryEmail: 'gone2@example.com',
        username: 'gone2',
        firstName: 'Gone',
        lastName: 'User',
        orgUnitId,
      })
      await repo.changeStatus(toDeactivate.id, 'active')
      await repo.changeStatus(toDeactivate.id, 'deactivated')

      const res = await request(app.getHttpServer())
        .get('/users?status=deactivated')
        .expect(200)
      expect(res.body.total).toBe(1)
      expect(res.body.items.map((u: { username: string }) => u.username)).toEqual(['gone2'])
    })
  })

  // Milestone 8, Task 2: GET /users had no text search before this — only
  // status/orgUnitId, which cannot do PRODUCT.md's #1 job ("find a person
  // fast... search that survives hundreds of rows") on their own.
  describe('search', () => {
    it('matches by username substring, case-insensitively, and narrows total to match', async () => {
      const res = await request(app.getHttpServer()).get('/users?search=AD').expect(200)
      expect(res.body.total).toBe(1)
      expect(res.body.items.map((u: { username: string }) => u.username)).toEqual(['ada'])
    })

    it('matches by email substring', async () => {
      const res = await request(app.getHttpServer()).get('/users?search=grace%40example').expect(200)
      expect(res.body.items.map((u: { username: string }) => u.username)).toEqual(['grace'])
    })

    it('matches by display name substring', async () => {
      const repo = new UsersRepository(ctx.db)
      await repo.create({
        primaryEmail: 'hopper@example.com',
        username: 'ghopper',
        firstName: 'Grace',
        lastName: 'Hopper',
        orgUnitId,
      })

      const res = await request(app.getHttpServer()).get('/users?search=Hopper').expect(200)
      expect(res.body.items.map((u: { username: string }) => u.username)).toEqual(['ghopper'])
    })

    it('combines with other filters as AND, not OR', async () => {
      // 'ada' exists (from beforeEach) but every fixture user is 'pending',
      // never 'active' — so search+status together must match nobody, which
      // would only happen if the two filters were ANDed, not ORed (an OR
      // would still return 'ada' on the search half alone).
      const res = await request(app.getHttpServer()).get('/users?search=ada&status=active').expect(200)
      expect(res.body.total).toBe(0)
    })

    it('returns an empty page, not an error, for a search that matches nobody', async () => {
      const res = await request(app.getHttpServer()).get('/users?search=zzz-nobody-zzz').expect(200)
      expect(res.body.total).toBe(0)
      expect(res.body.items).toEqual([])
    })

    it('treats a whitespace-only search as no search at all, never a 400', async () => {
      const res = await request(app.getHttpServer()).get('/users?search=%20%20').expect(200)
      expect(res.body.total).toBe(3)
    })

    it('an absent search param behaves exactly as before (no filter)', async () => {
      const res = await request(app.getHttpServer()).get('/users').expect(200)
      expect(res.body.total).toBe(3)
    })

    it('escapes a literal "%" in the search term rather than treating it as an ILIKE wildcard', async () => {
      const repo = new UsersRepository(ctx.db)
      await repo.create({
        primaryEmail: 'literal-percent@example.com',
        username: 'has%percent',
        firstName: 'Literal',
        lastName: 'Percent',
        orgUnitId,
      })
      await repo.create({
        primaryEmail: 'wildcard-decoy@example.com',
        // Would ALSO match the unescaped pattern "%has%percent%" if '%'
        // were left as a live wildcard (any characters between "has" and
        // "percent") — asserting it is EXCLUDED below is what proves
        // escaping actually happened, not just that the literal match works.
        username: 'hasZZZpercent',
        firstName: 'Wildcard',
        lastName: 'Decoy',
        orgUnitId,
      })

      const res = await request(app.getHttpServer()).get('/users?search=has%25percent').expect(200)
      expect(res.body.items.map((u: { username: string }) => u.username)).toEqual(['has%percent'])
    })

    it('escapes a literal "_" in the search term rather than treating it as an ILIKE single-char wildcard', async () => {
      const repo = new UsersRepository(ctx.db)
      await repo.create({
        primaryEmail: 'literal-underscore@example.com',
        username: 'has_underscore',
        firstName: 'Literal',
        lastName: 'Underscore',
        orgUnitId,
      })
      await repo.create({
        primaryEmail: 'underscore-decoy@example.com',
        // Would ALSO match the unescaped pattern "%has_underscore%" if '_'
        // were left as a live single-character wildcard ('X' standing in
        // for the wildcard) — excluded below only if escaping worked.
        username: 'hasXunderscore',
        firstName: 'Underscore',
        lastName: 'Decoy',
        orgUnitId,
      })

      const res = await request(app.getHttpServer()).get('/users?search=has_underscore').expect(200)
      expect(res.body.items.map((u: { username: string }) => u.username)).toEqual(['has_underscore'])
    })

    it('rejects a NUL character in the search term with 400 VALIDATION_FAILED, never an unmapped 500', async () => {
      const res = await request(app.getHttpServer()).get('/users?search=x%00y').expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')
    })

    it('rejects a search term over 255 characters with 400', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users?search=${'a'.repeat(256)}`)
        .expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')
    })

    it('rejects a non-string search value (repeated query param) with 400 rather than 500', async () => {
      const res = await request(app.getHttpServer()).get('/users?search=a&search=b').expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')
    })
  })
})
