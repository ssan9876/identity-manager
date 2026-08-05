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
    // DELETE, not TRUNCATE ... CASCADE: TRUNCATE on `users` always
    // structurally cascades into audit_log via its actor_user_id foreign
    // key, and audit_log's append-only trigger unconditionally rejects that.
    // DELETE respects each table's own onDelete action instead:
    // role_assignments cascades from users/org_units, audit_log
    // ('restrict', unreferenced here) is never touched.
    await ctx.pool.query('DELETE FROM users')
    await ctx.pool.query('DELETE FROM org_units')
    currentUsername = 'ada'
    const orgUnits = new OrgUnitsRepository(ctx.db)
    const users = new UsersRepository(ctx.db)
    const root = await orgUnits.createRoot('Acme Corp')
    const ada = await users.create({
      primaryEmail: 'ada@example.com',
      username: 'ada',
      firstName: 'Ada',
      lastName: 'Lovelace',
      orgUnitId: root.id,
    })
    // resolveActor requires status === 'active'; UsersRepository.create()
    // defaults new users to 'pending'. Without this, every request would be
    // denied regardless of role — including the "allowed" cases below — for
    // the wrong reason (an inactive actor), masking what this suite actually
    // tests. See permission.engine.ts's resolveActor doc comment.
    await users.changeStatus(ada.id, 'active')
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
