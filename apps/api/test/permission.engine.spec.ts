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
