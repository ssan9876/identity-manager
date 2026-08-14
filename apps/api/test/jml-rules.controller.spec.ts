import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { JwtGuard } from '../src/auth/jwt.guard'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard } from '../src/authz/permission.guard'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { JmlRulesController } from '../src/jml/jml-rules.controller'
import { JmlRulesRepository } from '../src/jml/jml-rules.repository'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { UsersRepository, type User } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

function stubJwtGuard(getUsername: () => string): CanActivate {
  return {
    canActivate(context: ExecutionContext): boolean {
      context.switchToHttp().getRequest<{ principal?: unknown }>().principal = {
        subject: 'jml-rules-controller-test',
        username: getUsername(),
        email: null,
      }
      return true
    },
  }
}

/**
 * The HTTP surface for joiner/mover/leaver rules.
 *
 * Before this controller there was none: rules lived behind `lifecycle-cli.ts`
 * alone, so the one actor in this system that deactivates real accounts with
 * no human in the loop was invisible in the console and editable only by
 * whoever had a shell on the API host — with no audit row naming them.
 *
 * The behaviour worth pinning here is not "CRUD works". It is that the
 * simulation gate survives being made reachable over HTTP: a rule cannot be
 * born enabled, cannot be enabled without a recorded simulation, and cannot
 * be touched at all by a scoped grant.
 */
describe('JmlRulesController', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let currentUsername = ''
  let orgUnitId: string

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [JmlRulesController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        JmlRulesRepository,
        UsersRepository,
        AuditWriter,
        PermissionEngine,
        PermissionGuard,
        RoleAssignmentsRepository,
        Reflector,
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue(stubJwtGuard(() => currentUsername))
      .compile()

    app = moduleRef.createNestApplication()
    app.useGlobalFilters(new DomainExceptionFilter())
    await app.init()

    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot(`JML Rules Root ${Date.now()}`)).id
  })

  afterAll(async () => {
    await app?.close()
  })

  let fixtureSeq = 0
  function nextTag(): string {
    fixtureSeq += 1
    return `jml${fixtureSeq}`
  }

  const usersRepo = () => new UsersRepository(ctx.db)
  const rolesRepo = () => new RoleAssignmentsRepository(ctx.db)

  async function makeActiveUser(role: string): Promise<User> {
    const tag = nextTag()
    const created = await usersRepo().create({
      primaryEmail: `${role}-${tag}@example.com`,
      username: `${role}-${tag}`,
      firstName: 'Test',
      lastName: 'User',
      orgUnitId,
    })
    return usersRepo().changeStatus(created.id, 'active')
  }

  /** An active caller holding `roleKey` GLOBALLY (no scope org unit). */
  async function actAs(roleKey: 'super_admin' | 'auditor' | 'user_admin'): Promise<User> {
    const user = await makeActiveUser(roleKey)
    await rolesRepo().assign({ userId: user.id, roleKey, scopeOrgUnitId: null })
    currentUsername = user.username
    return user
  }

  const deactivateRule = (name: string) => ({
    name,
    trigger: 'end_date_reached',
    conditionField: 'status',
    conditionOperator: 'equals',
    conditionValue: 'active',
    action: 'deactivate',
  })

  async function createRule(body: Record<string, unknown>): Promise<{ id: string }> {
    const res = await request(app.getHttpServer()).post('/jml-rules').send(body).expect(201)
    return res.body as { id: string }
  }

  // =========================================================================
  // Creation
  // =========================================================================

  it('creates a rule DISABLED and never simulated, whatever the caller sends', async () => {
    await actAs('super_admin')

    const res = await request(app.getHttpServer())
      .post('/jml-rules')
      // `enabled` is not a field of the create DTO. `.strict()` refuses it
      // outright rather than ignoring it, so a caller who believes they
      // created a live rule is told otherwise.
      .send({ ...deactivateRule(`born-disabled ${nextTag()}`), enabled: true })
      .expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')

    const rule = await createRule(deactivateRule(`born-disabled ok ${nextTag()}`))
    const fetched = await request(app.getHttpServer()).get(`/jml-rules/${rule.id}`).expect(200)
    expect(fetched.body).toMatchObject({ enabled: false, simulatedAt: null })
  })

  /**
   * `RuleApplier.applySetAttribute` runs this exact schema at APPLY time,
   * where a rule missing its `key` produces a `console.warn` and a silent
   * skip — a rule that looks live in every listing and does nothing, forever.
   * Refusing it at create time is the difference between a typo and a
   * three-month gap in an automated process nobody is watching.
   */
  it('refuses a set_attribute rule whose actionParams the applier would reject', async () => {
    await actAs('super_admin')

    for (const actionParams of [undefined, {}, { value: 'x' }, { key: '', value: 'x' }, { key: 'a', value: 1, extra: 2 }]) {
      const res = await request(app.getHttpServer())
        .post('/jml-rules')
        .send({
          name: `bad-params ${nextTag()}`,
          trigger: 'user_created',
          conditionField: 'status',
          conditionOperator: 'equals',
          conditionValue: 'active',
          action: 'set_attribute',
          ...(actionParams === undefined ? {} : { actionParams }),
        })
        .expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')
    }

    await createRule({
      name: `good-params ${nextTag()}`,
      trigger: 'user_created',
      conditionField: 'status',
      conditionOperator: 'equals',
      conditionValue: 'active',
      action: 'set_attribute',
      actionParams: { key: 'costCentre', value: '4100' },
    })
  })

  it("refuses 'in' without an array, and an array without 'in'", async () => {
    await actAs('super_admin')

    await request(app.getHttpServer())
      .post('/jml-rules')
      .send({ ...deactivateRule(`in-scalar ${nextTag()}`), conditionOperator: 'in', conditionValue: 'active' })
      .expect(400)

    await request(app.getHttpServer())
      .post('/jml-rules')
      .send({ ...deactivateRule(`equals-array ${nextTag()}`), conditionValue: ['active'] })
      .expect(400)

    await createRule({
      ...deactivateRule(`in-array ${nextTag()}`),
      conditionOperator: 'in',
      conditionValue: ['active', 'suspended'],
    })
  })

  /**
   * DERIVED from `KNOWN_TRIGGERS`, so this cannot drift from what
   * `matchRules` will actually dispatch on. A trigger the API accepts but the
   * engine refuses is the `simulate`/`matchRules` disagreement finding
   * INJ-INFO already closed once, arriving through a new door.
   */
  it('refuses a trigger the rule engine could never dispatch on', async () => {
    await actAs('super_admin')
    await request(app.getHttpServer())
      .post('/jml-rules')
      .send({ ...deactivateRule(`bad-trigger ${nextTag()}`), trigger: 'user_deleted' })
      .expect(400)
  })

  // =========================================================================
  // The simulation gate
  // =========================================================================

  it('refuses to enable a rule that has never been simulated', async () => {
    await actAs('super_admin')
    const rule = await createRule(deactivateRule(`ungated ${nextTag()}`))

    const res = await request(app.getHttpServer()).post(`/jml-rules/${rule.id}/enable`).expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
    expect(String(res.body.message ?? res.body.details)).toMatch(/simulat/i)

    const fetched = await request(app.getHttpServer()).get(`/jml-rules/${rule.id}`).expect(200)
    expect(fetched.body.enabled).toBe(false)
  })

  /**
   * Simulating is NOT acknowledging. Collapsing the two would mean merely
   * requesting a preview unlocks `enable` with nobody having read the output
   * — the gate would still be there and would have stopped meaning anything.
   */
  it('previewing does not by itself unlock enable', async () => {
    await actAs('super_admin')
    const rule = await createRule(deactivateRule(`preview-only ${nextTag()}`))

    const preview = await request(app.getHttpServer())
      .post(`/jml-rules/${rule.id}/simulate`)
      .expect(200)
    expect(preview.body).toMatchObject({ ruleId: rule.id })
    expect(preview.body.wouldApplyCount).toBeGreaterThan(0)

    await request(app.getHttpServer()).post(`/jml-rules/${rule.id}/enable`).expect(400)

    await request(app.getHttpServer())
      .post(`/jml-rules/${rule.id}/acknowledge-simulation`)
      .send({ wouldApplyCount: preview.body.wouldApplyCount })
      .expect(200)

    const enabled = await request(app.getHttpServer()).post(`/jml-rules/${rule.id}/enable`).expect(200)
    expect(enabled.body.enabled).toBe(true)
  })

  /** `simulate` takes no database handle at all — this asserts the route kept it that way. */
  it('a preview writes nothing: no rule change, no user change, no outbox event', async () => {
    await actAs('super_admin')
    const rule = await createRule(deactivateRule(`inert ${nextTag()}`))

    const before = await snapshotCounts()
    await request(app.getHttpServer()).post(`/jml-rules/${rule.id}/simulate`).expect(200)
    await request(app.getHttpServer()).post(`/jml-rules/${rule.id}/simulate`).expect(200)
    expect(await snapshotCounts()).toEqual(before)

    const fetched = await request(app.getHttpServer()).get(`/jml-rules/${rule.id}`).expect(200)
    expect(fetched.body).toMatchObject({ enabled: false, simulatedAt: null })
  })

  it('disabling is always allowed, simulation history or not', async () => {
    await actAs('super_admin')
    const rule = await createRule(deactivateRule(`disable-free ${nextTag()}`))

    const res = await request(app.getHttpServer()).post(`/jml-rules/${rule.id}/disable`).expect(200)
    expect(res.body.enabled).toBe(false)
  })

  // =========================================================================
  // The record
  // =========================================================================

  it('writes down who acknowledged a preview, and the number they were shown', async () => {
    const admin = await actAs('super_admin')
    const rule = await createRule(deactivateRule(`audited ${nextTag()}`))

    await request(app.getHttpServer())
      .post(`/jml-rules/${rule.id}/acknowledge-simulation`)
      .send({ wouldApplyCount: 42 })
      .expect(200)

    const { rows } = await ctx.pool.query<{ action: string; actor_user_id: string; after: Record<string, unknown> }>(
      `SELECT action, actor_user_id, after FROM audit_log
       WHERE resource_id = $1 AND action = 'jml_rule:acknowledge_simulation'
       ORDER BY created_at DESC LIMIT 1`,
      [rule.id],
    )
    expect(rows[0]?.actor_user_id).toBe(admin.id)
    // The caller's own claim about the preview they read, carried into the
    // record so "they enabled it having been told it would touch 42 people"
    // is answerable afterwards.
    expect(rows[0]?.after).toMatchObject({ reviewedWouldApplyCount: 42 })
  })

  it('records a creation with the whole rule, every field of which decides behaviour', async () => {
    const admin = await actAs('super_admin')
    const rule = await createRule(deactivateRule(`audited-create ${nextTag()}`))

    const { rows } = await ctx.pool.query<{ actor_user_id: string; before: unknown; after: Record<string, unknown> }>(
      `SELECT actor_user_id, before, after FROM audit_log
       WHERE resource_id = $1 AND action = 'jml_rule:create' LIMIT 1`,
      [rule.id],
    )
    expect(rows[0]?.actor_user_id).toBe(admin.id)
    expect(rows[0]?.before).toBeNull()
    expect(rows[0]?.after).toMatchObject({
      enabled: false,
      trigger: 'end_date_reached',
      conditionField: 'status',
      action: 'deactivate',
    })
  })

  // =========================================================================
  // Authorization
  // =========================================================================

  /**
   * A rule names no org unit and `matchRules` runs it against every user the
   * lifecycle pass walks, so there is nothing for a scoped grant to narrow
   * to. Same posture as business roles, recertification campaigns, SSO
   * applications, the audit log and dead letters.
   */
  it('refuses a SCOPED super_admin — managing a rule needs a global grant', async () => {
    const scoped = await makeActiveUser('scoped_admin')
    await rolesRepo().assign({ userId: scoped.id, roleKey: 'super_admin', scopeOrgUnitId: orgUnitId })
    currentUsername = scoped.username

    const res = await request(app.getHttpServer())
      .post('/jml-rules')
      .send(deactivateRule(`scoped ${nextTag()}`))
      .expect(403)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  /**
   * An auditor who cannot read the rules cannot explain a change they are
   * looking at — a JML rule is the only actor here that alters accounts with
   * no human in the loop. Reading is theirs; acting is not.
   */
  it('lets an auditor READ rules and refuses every write', async () => {
    await actAs('super_admin')
    const rule = await createRule(deactivateRule(`auditor-visible ${nextTag()}`))

    await actAs('auditor')
    await request(app.getHttpServer()).get('/jml-rules').expect(200)
    await request(app.getHttpServer()).get(`/jml-rules/${rule.id}`).expect(200)

    await request(app.getHttpServer()).post('/jml-rules').send(deactivateRule('nope')).expect(403)
    await request(app.getHttpServer()).post(`/jml-rules/${rule.id}/simulate`).expect(403)
    await request(app.getHttpServer()).post(`/jml-rules/${rule.id}/enable`).expect(403)
    await request(app.getHttpServer()).post(`/jml-rules/${rule.id}/disable`).expect(403)
    await request(app.getHttpServer())
      .post(`/jml-rules/${rule.id}/acknowledge-simulation`)
      .send({ wouldApplyCount: 0 })
      .expect(403)
  })

  it('404s for a rule that does not exist, and 400s for an id that is not one', async () => {
    await actAs('super_admin')
    await request(app.getHttpServer())
      .get('/jml-rules/00000000-0000-0000-0000-000000000000')
      .expect(404)
    await request(app.getHttpServer()).get('/jml-rules/not-a-uuid').expect(400)
  })

  async function snapshotCounts(): Promise<Record<string, number>> {
    const { rows } = await ctx.pool.query<Record<string, string>>(
      `SELECT
         (SELECT count(*) FROM jml_rules)     AS rules,
         (SELECT count(*) FROM outbox_events) AS outbox,
         (SELECT count(*) FROM users WHERE status <> 'active') AS inactive_users,
         (SELECT count(*) FROM jml_rules WHERE simulated_at IS NOT NULL) AS simulated`,
    )
    return Object.fromEntries(Object.entries(rows[0]!).map(([k, v]) => [k, Number(v)]))
  }
})
