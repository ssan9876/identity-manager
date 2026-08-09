import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { JwtGuard } from '../src/auth/jwt.guard'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard, type AuthorizedRequest } from '../src/authz/permission.guard'
import { PrivilegeGuards } from '../src/authz/privilege.guards'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { GroupsRepository } from '../src/groups/groups.repository'
import { KEYCLOAK_ADMIN_CONFIG, KeycloakAdminClient } from '../src/keycloak/keycloak-admin.client'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { SyncDetailRepository } from '../src/outbox/sync-detail.repository'
import { SyncStateRepository } from '../src/outbox/sync-state.repository'
import { BusinessRolesRepository } from '../src/business-roles/business-roles.repository'
import { RoleReconciler } from '../src/business-roles/role-reconciler'
import { UsersController } from '../src/users/users.controller'
import { type User, UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

/**
 * `GET /users/:id/sync` — the per-user, per-target explanation behind a sync
 * badge (2026-08-08 sync-diagnostics spec).
 *
 * Its own file rather than another block inside users.controller.spec.ts:
 * that suite pins ONE unrestricted actor for every test, and the whole point
 * of this route is that what it returns DEPENDS on the caller's grants — the
 * raw connector error string is withheld from anyone lacking a GLOBAL
 * `audit:read`, preserving the decision OutboxController already made about
 * dead letters. Testing that needs a swappable actor, which would change the
 * shared fixture there for every other test in the file.
 *
 * Same unreachable-Keycloak fixture and stubbed-guard approach as
 * users.controller.spec.ts — see that file's own doc comments. No route here
 * touches Keycloak.
 */
const UNREACHABLE_KEYCLOAK_CONFIG = {
  issuer: 'http://127.0.0.1:1/realms/unreachable',
  clientId: 'irrelevant',
  clientSecret: 'irrelevant',
}

type Actor = AuthorizedRequest['actor']

/** Global `super_admin` — holds every action, including `audit:read`, with no org-unit scope. Sees raw error text. */
function superAdmin(orgUnitId: string): Actor {
  return {
    userId: '00000000-0000-0000-0000-0000000000a1',
    username: 'super-admin-test-actor',
    orgUnitId,
    assignments: [{ roleKey: 'super_admin', scopeOrgUnitId: null, scopePath: null }],
  }
}

/**
 * Global `help_desk` — holds `user:read` (so the route is reachable and
 * org-unit scoping passes) but NOT `audit:read` at all, so
 * `scopePathsFor(actor, 'audit:read')` returns `[]` rather than `null`. This
 * is the ordinary-admin case the redaction exists for.
 */
function helpDesk(orgUnitId: string): Actor {
  return {
    userId: '00000000-0000-0000-0000-0000000000a2',
    username: 'help-desk-test-actor',
    orgUnitId,
    assignments: [{ roleKey: 'help_desk', scopeOrgUnitId: null, scopePath: null }],
  }
}

/**
 * `auditor` SCOPED to one org unit — holds `audit:read`, but narrowly, so
 * `scopePathsFor` returns a non-empty array rather than `null`. Proves the
 * check is "global grant", not merely "holds the action at all"; a scoped
 * auditor must not read raw target error text either.
 */
function scopedAuditor(orgUnitId: string, scopePath: string): Actor {
  return {
    userId: '00000000-0000-0000-0000-0000000000a3',
    username: 'scoped-auditor-test-actor',
    orgUnitId,
    assignments: [{ roleKey: 'auditor', scopeOrgUnitId: orgUnitId, scopePath }],
  }
}

describe('GET /users/:id/sync', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let orgUnitId: string
  let orgUnitPath: string
  let otherOrgUnitId: string

  // Mutated per test, read by the stubbed guard below. Defaults to the
  // unrestricted case so a test that does not care need not set it.
  let activeActor: Actor

  const stubPermissionGuard: CanActivate = {
    canActivate(context: ExecutionContext): boolean {
      context.switchToHttp().getRequest<AuthorizedRequest>().actor = activeActor
      return true
    },
  }

  beforeAll(async () => {
    const orgUnits = new OrgUnitsRepository(ctx.db)
    const root = await orgUnits.createRoot(`Sync Detail Root ${Date.now()}`)
    orgUnitId = root.id
    orgUnitPath = root.path
    otherOrgUnitId = (await orgUnits.createRoot(`Sync Detail Other ${Date.now()}`)).id
    activeActor = superAdmin(orgUnitId)

    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        // Milestone 17, Task 9: UsersController now re-evaluates business roles
        // inside its own create/update transactions, and its RoleReconciler
        // parameter is deliberately NOT @Optional() (an absent reconciler would
        // mean every user write silently skips re-evaluation). Both providers are
        // therefore required to construct it, here exactly as in AppModule.
        BusinessRolesRepository,
        RoleReconciler,
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        UsersRepository,
        PermissionEngine,
        PrivilegeGuards,
        AuditWriter,
        OutboxWriter,
        { provide: KEYCLOAK_ADMIN_CONFIG, useValue: UNREACHABLE_KEYCLOAK_CONFIG },
        KeycloakAdminClient,
        GroupsRepository,
        SyncStateRepository,
        SyncDetailRepository,
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

  afterEach(async () => {
    activeActor = superAdmin(orgUnitId)
    await ctx.pool.query(`DELETE FROM connector_targets WHERE target = 'mail_server'`)
  })

  let seq = 0
  async function makeUser(inOrgUnit: string = orgUnitId): Promise<User> {
    seq += 1
    const username = `sync-detail-${seq}-${Date.now()}@example.com`.toLowerCase()
    return new UsersRepository(ctx.db).create({
      primaryEmail: username,
      username,
      firstName: 'Sync',
      lastName: `Detail${seq}`,
      orgUnitId: inOrgUnit,
    })
  }

  async function makeGroup(label: string) {
    seq += 1
    return new GroupsRepository(ctx.db).create({ name: `${label} ${seq} ${Date.now()}` })
  }

  async function enableTarget(target: 'mail_server' | 'echo'): Promise<void> {
    await ctx.pool.query(
      `INSERT INTO connector_targets (target, enabled) VALUES ($1, true)
       ON CONFLICT (target) DO UPDATE SET enabled = true`,
      [target],
    )
  }

  async function insertOutboxEvent(
    aggregateType: 'user' | 'group' | 'membership',
    aggregateId: string,
    status: 'pending' | 'processing' | 'done' | 'failed',
    eventType: 'created' | 'updated' | 'status_changed' | 'membership_changed' = 'updated',
    target: 'keycloak' | 'mail_server' | 'echo' = 'keycloak',
    extra: { attempts?: number; lastError?: string } = {},
  ): Promise<void> {
    await ctx.pool.query(
      `INSERT INTO outbox_events
         (aggregate_type, aggregate_id, event_type, payload, status, target, attempts, last_error)
       VALUES ($1, $2, $3, '{}'::jsonb, $4, $5, $6, $7)`,
      [aggregateType, aggregateId, eventType, status, target, extra.attempts ?? 0, extra.lastError ?? null],
    )
  }

  async function setExternalIdentity(userId: string, system: 'keycloak' | 'mail_server'): Promise<void> {
    await ctx.pool.query(
      `INSERT INTO external_identities (user_id, system, external_id, sync_state, last_synced_at)
       VALUES ($1, $2, $3, 'synced', now())
       ON CONFLICT (user_id, system) DO UPDATE SET sync_state = 'synced'`,
      [userId, system, `${system}-${userId}`],
    )
  }

  function get(userId: string) {
    return request(app.getHttpServer()).get(`/users/${userId}/sync`)
  }

  // The exact shape of the 2026-08-08 production incident: Keycloak synced
  // cleanly, mail_server dead-lettered on a missing secret, and the badge
  // stayed red with nothing anywhere to say why.
  async function seedMailFailure(user: User, lastError: string): Promise<void> {
    await insertOutboxEvent('user', user.id, 'done', 'created')
    await setExternalIdentity(user.id, 'keycloak')
    await enableTarget('mail_server')
    await insertOutboxEvent('user', user.id, 'failed', 'created', 'mail_server', { attempts: 8, lastError })
  }

  it('names the failing target and its attempt count', async () => {
    const user = await makeUser()
    await seedMailFailure(user, 'secret "CONNECTOR_MAIL_SERVER_TOKEN" is not set in the environment')

    const res = await get(user.id).expect(200)

    expect(res.body.syncState).toBe('failed')
    const mail = res.body.targets.find((t: { target: string }) => t.target === 'mail_server')
    const keycloak = res.body.targets.find((t: { target: string }) => t.target === 'keycloak')
    expect(mail.state).toBe('failed')
    expect(mail.latestEvent.attempts).toBe(8)
    // The whole point: Keycloak is separately, visibly healthy. Before this
    // route, the single aggregate badge could not say that.
    expect(keycloak.state).toBe('synced')
    expect(keycloak.externalId).not.toBeNull()
  })

  it('exposes raw error text to a GLOBAL audit:read holder', async () => {
    const user = await makeUser()
    await seedMailFailure(user, 'bind failed for CN=svc,DC=corp — credential rejected')

    const res = await get(user.id).expect(200)

    expect(res.body.errorDetailRedacted).toBe(false)
    const mail = res.body.targets.find((t: { target: string }) => t.target === 'mail_server')
    expect(mail.latestEvent.lastError).toContain('credential rejected')
  })

  it('redacts raw error text from a user:read holder without audit:read', async () => {
    const user = await makeUser()
    await seedMailFailure(user, 'bind failed for CN=svc,DC=corp — credential rejected')
    activeActor = helpDesk(orgUnitId)

    const res = await get(user.id).expect(200)

    expect(res.body.errorDetailRedacted).toBe(true)
    const mail = res.body.targets.find((t: { target: string }) => t.target === 'mail_server')
    expect(mail.latestEvent.lastError).toBeNull()
    // Structure survives redaction — that split is the design: an ordinary
    // admin still learns enough to diagnose and escalate without reading a
    // vendor string that may name internal hosts or directory paths.
    expect(mail.latestEvent.attempts).toBe(8)
    expect(mail.state).toBe('failed')
    expect(res.body.syncState).toBe('failed')
  })

  it('redacts from a SCOPED audit:read holder too — the check is a global grant, not the action alone', async () => {
    const user = await makeUser()
    await seedMailFailure(user, 'bind failed for CN=svc,DC=corp — credential rejected')
    activeActor = scopedAuditor(orgUnitId, orgUnitPath)

    const res = await get(user.id).expect(200)

    expect(res.body.errorDetailRedacted).toBe(true)
    const mail = res.body.targets.find((t: { target: string }) => t.target === 'mail_server')
    expect(mail.latestEvent.lastError).toBeNull()
  })

  it('reports a not-applicable target as settled, with no external id', async () => {
    // A done event and NO external_identities row is what the mail connector
    // leaves for a user with no mailbox (NotApplicableError). It must read as
    // settled, not as a permanently pending target.
    const user = await makeUser()
    await insertOutboxEvent('user', user.id, 'done', 'created')
    await setExternalIdentity(user.id, 'keycloak')
    await enableTarget('mail_server')
    await insertOutboxEvent('user', user.id, 'done', 'created', 'mail_server')

    const res = await get(user.id).expect(200)

    expect(res.body.syncState).toBe('synced')
    const mail = res.body.targets.find((t: { target: string }) => t.target === 'mail_server')
    expect(mail.state).toBe('synced')
    expect(mail.externalId).toBeNull()
  })

  it('names the group dragging a user down', async () => {
    const group = await makeGroup('Blocking Group')
    const user = await makeUser()
    await new GroupsRepository(ctx.db).addUser(group.id, user.id)
    await insertOutboxEvent('user', user.id, 'done', 'created')
    await setExternalIdentity(user.id, 'keycloak')
    await insertOutboxEvent('group', group.id, 'failed', 'updated', 'keycloak', { attempts: 8 })

    const res = await get(user.id).expect(200)

    expect(res.body.syncState).toBe('failed')
    expect(res.body.blockedByGroups).toHaveLength(1)
    expect(res.body.blockedByGroups[0].groupId).toBe(group.id)
    expect(res.body.blockedByGroups[0].groupName).toContain('Blocking Group')
    // The user's own targets are all healthy — without blockedByGroups the
    // panel would show a red badge and a table of green rows, explaining
    // nothing. This is the case SyncStateRepository exists to catch.
    for (const target of res.body.targets) {
      expect(target.state).toBe('synced')
    }
  })

  it('403s for a user outside the caller org-unit scope', async () => {
    const user = await makeUser(otherOrgUnitId)
    activeActor = scopedAuditor(orgUnitId, orgUnitPath)

    await get(user.id).expect(403)
  })

  it('404s for a user that does not exist, proving :id does not swallow :id/sync', async () => {
    await get('00000000-0000-0000-0000-000000000000').expect(404)
  })
})
