import { beforeEach, describe, expect, it } from 'vitest'
import {
  bootstrapAdmin,
  DEFAULT_BOOTSTRAP_USERNAME,
  type BootstrapAdminDeps,
} from '../src/admin/bootstrap-admin'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

/**
 * Task 1 (task-1-brief.md): `pnpm run bootstrap:admin` is the anti-lockout
 * for a fresh install — no HTTP layer involved, so these tests exercise
 * `bootstrapAdmin` directly against a real Testcontainers Postgres, the same
 * way bootstrap-admin-cli.ts does, never through a mock. Idempotency is the
 * load-bearing property under test throughout: "running it twice must
 * succeed and not duplicate" is asserted with real row counts, not just "the
 * second call didn't throw".
 */
describe('bootstrapAdmin', () => {
  const ctx = withTestDatabase()
  let deps: BootstrapAdminDeps
  let users: UsersRepository
  let orgUnits: OrgUnitsRepository
  let roleAssignments: RoleAssignmentsRepository

  beforeEach(async () => {
    // DELETE, not TRUNCATE ... CASCADE — see role-assignments.repository.spec.ts's
    // own doc comment on this exact pattern. role_assignments cascades from
    // users (onDelete: 'cascade'), so deleting users alone is enough to clear
    // it too; audit_log is never touched because nothing in this file writes
    // to it (bootstrapAdmin calls repositories directly, never AuditWriter).
    await ctx.pool.query('DELETE FROM users')
    await ctx.pool.query('DELETE FROM org_units')

    users = new UsersRepository(ctx.db)
    orgUnits = new OrgUnitsRepository(ctx.db)
    roleAssignments = new RoleAssignmentsRepository(ctx.db)
    deps = { users, orgUnits, roleAssignments }
  })

  async function countRows(table: string): Promise<number> {
    const { rows } = await ctx.pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM ${table}`)
    return rows[0]?.c ?? 0
  }

  it('on a fresh database, creates an org unit, an active user, and a global super_admin grant', async () => {
    const result = await bootstrapAdmin(deps, 'new.admin@example.com')

    expect(result.steps.every((step) => step.changed)).toBe(true)

    const user = await users.findByUsername('new.admin@example.com')
    expect(user).not.toBeNull()
    expect(user?.status).toBe('active')
    expect(user?.id).toBe(result.userId)

    const orgUnit = await orgUnits.findById(result.orgUnitId)
    expect(orgUnit).not.toBeNull()
    expect(orgUnit?.parentId).toBeNull()

    const assignments = await roleAssignments.listForUser(result.userId)
    expect(assignments).toHaveLength(1)
    expect(assignments[0]).toMatchObject({ roleKey: 'super_admin', scopeOrgUnitId: null })
  })

  it('defaults to the seeded dev username when none is given', async () => {
    const result = await bootstrapAdmin(deps)
    expect(result.username).toBe(DEFAULT_BOOTSTRAP_USERNAME)
    expect(await users.findByUsername(DEFAULT_BOOTSTRAP_USERNAME)).not.toBeNull()
  })

  it('is idempotent: running it twice succeeds both times and creates nothing twice', async () => {
    const first = await bootstrapAdmin(deps, 'idempotent@example.com')
    expect(first.steps.every((step) => step.changed)).toBe(true)

    const second = await bootstrapAdmin(deps, 'idempotent@example.com')

    // The whole point: the second run must not throw, must not 409, and
    // must report that everything it looked at already existed.
    expect(second.steps.every((step) => step.changed === false)).toBe(true)
    expect(second.userId).toBe(first.userId)
    expect(second.orgUnitId).toBe(first.orgUnitId)

    expect(await countRows('users')).toBe(1)
    expect(await countRows('org_units')).toBe(1)
    expect(await countRows('role_assignments')).toBe(1)
  })

  it('running it three times in a row stays idempotent', async () => {
    await bootstrapAdmin(deps, 'thrice@example.com')
    await bootstrapAdmin(deps, 'thrice@example.com')
    await bootstrapAdmin(deps, 'thrice@example.com')

    expect(await countRows('users')).toBe(1)
    expect(await countRows('role_assignments')).toBe(1)
  })

  it('reuses an existing org unit instead of creating a second root', async () => {
    const existing = await orgUnits.createRoot('Acme Corp')

    const result = await bootstrapAdmin(deps, 'reuse-org-unit@example.com')

    expect(result.orgUnitId).toBe(existing.id)
    expect(await countRows('org_units')).toBe(1)
    const orgUnitStep = result.steps.find((step) => step.message.includes('org unit'))
    expect(orgUnitStep?.changed).toBe(false)
  })

  it('activates a pre-existing pending user rather than creating a new one', async () => {
    const root = await orgUnits.createRoot('Acme Corp')
    const pending = await users.create({
      primaryEmail: 'pending.user@example.com',
      username: 'pending.user@example.com',
      firstName: 'Pending',
      lastName: 'User',
      orgUnitId: root.id,
    })
    expect(pending.status).toBe('pending')

    const result = await bootstrapAdmin(deps, 'pending.user@example.com')

    expect(result.userId).toBe(pending.id)
    const activated = await users.findById(pending.id)
    expect(activated?.status).toBe('active')
    expect(await countRows('users')).toBe(1)

    const activationStep = result.steps.find((step) => step.message.includes('activated'))
    expect(activationStep?.changed).toBe(true)
    expect(activationStep?.message).toContain('was pending')
  })

  it('does not re-activate (or otherwise touch) a user who is already active', async () => {
    const root = await orgUnits.createRoot('Acme Corp')
    const created = await users.create({
      primaryEmail: 'already.active@example.com',
      username: 'already.active@example.com',
      firstName: 'Already',
      lastName: 'Active',
      orgUnitId: root.id,
    })
    await users.changeStatus(created.id, 'active')

    const result = await bootstrapAdmin(deps, 'already.active@example.com')

    const userStep = result.steps.find((step) => step.message.includes('local user'))
    const activationStep = result.steps.find((step) => step.message.includes('already active'))
    expect(userStep?.changed).toBe(false)
    expect(activationStep).toBeDefined()
    expect(activationStep?.changed).toBe(false)
  })

  it('grants the role only when missing, leaving an existing active user untouched', async () => {
    const root = await orgUnits.createRoot('Acme Corp')
    const created = await users.create({
      primaryEmail: 'no.role.yet@example.com',
      username: 'no.role.yet@example.com',
      firstName: 'No',
      lastName: 'Role',
      orgUnitId: root.id,
    })
    await users.changeStatus(created.id, 'active')

    const result = await bootstrapAdmin(deps, 'no.role.yet@example.com')

    const roleStep = result.steps.find((step) => step.message.includes('super_admin'))
    expect(roleStep?.changed).toBe(true)
    expect(await roleAssignments.listForUser(created.id)).toHaveLength(1)
  })

  it('does not duplicate the role grant when one is already held', async () => {
    const root = await orgUnits.createRoot('Acme Corp')
    const created = await users.create({
      primaryEmail: 'already.admin@example.com',
      username: 'already.admin@example.com',
      firstName: 'Already',
      lastName: 'Admin',
      orgUnitId: root.id,
    })
    await users.changeStatus(created.id, 'active')
    await roleAssignments.assign({ userId: created.id, roleKey: 'super_admin' })

    const result = await bootstrapAdmin(deps, 'already.admin@example.com')

    const roleStep = result.steps.find((step) => step.message.includes('super_admin'))
    expect(roleStep?.changed).toBe(false)
    expect(await roleAssignments.listForUser(created.id)).toHaveLength(1)
  })

  it('refuses to reactivate a deactivated user, failing with a clear error instead of a crash', async () => {
    const root = await orgUnits.createRoot('Acme Corp')
    const created = await users.create({
      primaryEmail: 'gone@example.com',
      username: 'gone@example.com',
      firstName: 'Gone',
      lastName: 'User',
      orgUnitId: root.id,
    })
    await users.changeStatus(created.id, 'active')
    await users.changeStatus(created.id, 'deactivated')

    await expect(bootstrapAdmin(deps, 'gone@example.com')).rejects.toThrow(/deactivated/i)

    // Confirm it really did nothing else on the way to failing — no role
    // grant snuck in ahead of the terminal-state check.
    expect(await roleAssignments.listForUser(created.id)).toHaveLength(0)
  })

  it('raises a clear, actionable error when the email is already taken by a different username', async () => {
    const root = await orgUnits.createRoot('Acme Corp')
    await users.create({
      primaryEmail: 'shared@example.com',
      username: 'someone.else',
      firstName: 'Someone',
      lastName: 'Else',
      orgUnitId: root.id,
    })

    await expect(bootstrapAdmin(deps, 'shared@example.com')).rejects.toThrow(
      /cannot bootstrap "shared@example\.com"/,
    )
  })

  it('synthesizes a placeholder email for a non-email username', async () => {
    const result = await bootstrapAdmin(deps, 'svc-account')
    const user = await users.findById(result.userId)
    expect(user?.primaryEmail).toBe('svc-account@local.invalid')
  })
})
