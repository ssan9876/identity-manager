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

  // Creates a user and activates it before returning. PermissionEngine
  // .resolveActor's status check is an allowlist (`=== 'active'`, closed by
  // Task 3's fix round — see task-3-report.md Finding I-1): it denies
  // anything that isn't active, and UsersRepository.create() defaults new
  // users to `pending`. Every actor this suite resolves via actorFor(...)
  // below must be active first, or resolveActor throws ForbiddenError before
  // any guard logic under test even runs. The brief's original helper did
  // not activate; fixed here rather than relaxing the engine's status check,
  // which is a security property covered by its own tests.
  const makeUser = async (username: string, orgUnitId: string) => {
    const user = await users.create({
      primaryEmail: `${username}@example.com`,
      username,
      firstName: 'Test',
      lastName: 'User',
      orgUnitId,
    })
    return users.changeStatus(user.id, 'active')
  }

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
