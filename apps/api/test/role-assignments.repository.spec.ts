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
