import { beforeEach, describe, expect, it } from 'vitest'
import { ForbiddenError } from '../src/common/errors'
import { PermissionEngine, type Actor } from '../src/authz/permission.engine'
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

  // Creates a user and activates it. resolveActor's status check is an
  // allowlist (`=== 'active'`) — `pending`, the default `UsersRepository
  // .create()` lands new users in, must be denied like any other non-active
  // status. Tests that specifically need a non-active user bypass this
  // helper and drive UsersRepository directly.
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

  it('denies a principal whose local user is pending (not yet active)', async () => {
    // Deliberately bypasses makeUser: UsersRepository.create() defaults new
    // users to `pending`, and that default must be denied, not granted.
    // This is the case Finding I-1 closed — the status check must be an
    // allowlist (`=== 'active'`), not a denylist of known-bad statuses,
    // because a denylist defaults every OTHER status (including `pending`,
    // and any future addition to the enum) to allowed.
    await users.create({
      primaryEmail: 'ada@example.com',
      username: 'ada',
      firstName: 'Test',
      lastName: 'User',
      orgUnitId: rootId,
    })

    await expect(
      engine.resolveActor({ subject: 'kc-1', username: 'ada', email: null }),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('denies a principal whose local user is suspended', async () => {
    const user = await makeUser('ada', rootId)
    await users.changeStatus(user.id, 'suspended')

    await expect(
      engine.resolveActor({ subject: 'kc-1', username: 'ada', email: null }),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('denies a principal whose local user is deactivated', async () => {
    const user = await makeUser('ada', rootId)
    await users.changeStatus(user.id, 'deactivated')

    await expect(
      engine.resolveActor({ subject: 'kc-1', username: 'ada', email: null }),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('denies every action to an actor with no roles', async () => {
    await makeUser('ada', rootId)
    const actor = await engine.resolveActor({ subject: 'k', username: 'ada', email: null })
    expect(engine.canAnywhere(actor, 'user:read')).toBe(false)
    expect(await engine.canIn(actor, 'user:read', salesId)).toBe(false)
  })

  it('grants a globally scoped role everywhere', async () => {
    const user = await makeUser('ada', rootId)
    await roles.assign({ userId: user.id, roleKey: 'user_admin' })
    const actor = await engine.resolveActor({ subject: 'k', username: 'ada', email: null })

    expect(await engine.canIn(actor, 'user:read', emeaId)).toBe(true)
    expect(await engine.canIn(actor, 'user:read', engId)).toBe(true)
    expect(await engine.scopePathsFor(actor, 'user:read')).toBeNull()
  })

  it('grants a scoped role only within its subtree', async () => {
    const user = await makeUser('ada', rootId)
    await roles.assign({ userId: user.id, roleKey: 'help_desk', scopeOrgUnitId: salesId })
    const actor = await engine.resolveActor({ subject: 'k', username: 'ada', email: null })

    expect(await engine.canIn(actor, 'user:read', salesId)).toBe(true)
    expect(await engine.canIn(actor, 'user:read', emeaId)).toBe(true)
    expect(await engine.canIn(actor, 'user:read', engId)).toBe(false)
    expect(await engine.canIn(actor, 'user:read', rootId)).toBe(false)
  })

  it('denies an action the role does not grant, even inside scope', async () => {
    const user = await makeUser('ada', rootId)
    await roles.assign({ userId: user.id, roleKey: 'help_desk', scopeOrgUnitId: salesId })
    const actor = await engine.resolveActor({ subject: 'k', username: 'ada', email: null })

    expect(await engine.canIn(actor, 'user:create', salesId)).toBe(false)
    expect(await engine.canIn(actor, 'audit:read', salesId)).toBe(false)
  })

  it('returns the scope paths a restricted actor may see', async () => {
    const user = await makeUser('ada', rootId)
    await roles.assign({ userId: user.id, roleKey: 'help_desk', scopeOrgUnitId: salesId })
    const actor = await engine.resolveActor({ subject: 'k', username: 'ada', email: null })

    expect(await engine.scopePathsFor(actor, 'user:read')).toEqual(['acme_corp.sales'])
    expect(await engine.scopePathsFor(actor, 'user:create')).toEqual([])
  })

  it('scopePathsFor: null (unrestricted) and [] (nowhere) must never be conflated by callers', async () => {
    const user = await makeUser('ada', rootId)
    await roles.assign({ userId: user.id, roleKey: 'user_admin' }) // global assignment
    const actor = await engine.resolveActor({ subject: 'k', username: 'ada', email: null })

    const unrestricted = await engine.scopePathsFor(actor, 'user:read')
    // user_admin does not grant role:assign (reserved to super_admin), so
    // this actor is entitled to it NOWHERE, not everywhere.
    const nowhere = await engine.scopePathsFor(actor, 'role:assign')

    expect(unrestricted).toBeNull()
    expect(nowhere).toEqual([])

    // The trap this pins (see the doc comment on scopePathsFor): `[]` is a
    // truthy value, so `if (paths)` correctly still runs the filter (which
    // then matches nothing, as it should for an actor entitled to nothing).
    expect(Boolean(nowhere)).toBe(true)
    // But `[].length` is falsy, so `if (paths?.length)` would WRONGLY skip
    // the filter entirely — which, combined with "no filter" meaning
    // unrestricted elsewhere in this same method's contract, would silently
    // grant this actor full visibility instead of none.
    expect(Boolean(nowhere?.length)).toBe(false)
  })

  it('unions scopes when the actor holds the role at two places', async () => {
    const user = await makeUser('ada', rootId)
    await roles.assign({ userId: user.id, roleKey: 'help_desk', scopeOrgUnitId: salesId })
    await roles.assign({ userId: user.id, roleKey: 'help_desk', scopeOrgUnitId: engId })
    const actor = await engine.resolveActor({ subject: 'k', username: 'ada', email: null })

    const paths = await engine.scopePathsFor(actor, 'user:read')
    expect(paths?.sort()).toEqual(['acme_corp.engineering', 'acme_corp.sales'])
  })

  it('canAnywhere: true for an action a scoped actor holds anywhere, false for one it does not', async () => {
    const user = await makeUser('ada', rootId)
    await roles.assign({ userId: user.id, roleKey: 'help_desk', scopeOrgUnitId: salesId })
    const actor = await engine.resolveActor({ subject: 'k', username: 'ada', email: null })

    // A scoped (non-global) actor: grantingAssignments is non-empty here, so
    // this exercises the real body of canAnywhere, not just its
    // `granting.length === 0` early return (already covered by "denies
    // every action to an actor with no roles" above).
    expect(engine.canAnywhere(actor, 'user:read')).toBe(true)
    expect(engine.canAnywhere(actor, 'user:create')).toBe(false)

    expect(() => engine.assertCanAnywhere(actor, 'user:read')).not.toThrow()
    expect(() => engine.assertCanAnywhere(actor, 'user:create')).toThrow(ForbiddenError)
  })

  // privilege.guards fix round 2, Critical: grantingAssignments does
  // `ROLE_PERMISSIONS[assignment.roleKey]?.includes(action) ?? false`.
  // Before ROLE_PERMISSIONS was made prototype-less (authz/actions.ts), a
  // colliding role_key like 'constructor' resolved to the inherited Object
  // function (truthy, not nullish), so `?.` did not short-circuit, and
  // `.includes` — looked up on that function — was `undefined`; calling
  // `undefined(action)` threw a TypeError. Not an escalation (it failed
  // closed via crash, never granted anything), but not the clean,
  // predictable denial this file's design implies either. This pins that
  // the catalog fix resolves this call site automatically, with no change
  // to permission.engine.ts itself.
  it('grantingAssignments (via canAnywhere) does not throw for a role_key colliding with an inherited Object.prototype property, and correctly denies', async () => {
    await ctx.pool.query(`ALTER TYPE role_key ADD VALUE IF NOT EXISTS 'constructor'`)
    const user = await makeUser('ada', rootId)
    await ctx.pool.query(
      'INSERT INTO role_assignments (user_id, role_key, scope_org_unit_id) VALUES ($1, $2::role_key, NULL)',
      [user.id, 'constructor'],
    )
    const actor = await engine.resolveActor({ subject: 'k', username: 'ada', email: null })

    expect(() => engine.canAnywhere(actor, 'user:read')).not.toThrow()
    expect(engine.canAnywhere(actor, 'user:read')).toBe(false)
  })

  it('assertCanIn throws ForbiddenError when denied and is silent when allowed', async () => {
    const user = await makeUser('ada', rootId)
    await roles.assign({ userId: user.id, roleKey: 'help_desk', scopeOrgUnitId: salesId })
    const actor = await engine.resolveActor({ subject: 'k', username: 'ada', email: null })

    await expect(engine.assertCanIn(actor, 'user:read', engId)).rejects.toBeInstanceOf(
      ForbiddenError,
    )
    await expect(engine.assertCanIn(actor, 'user:read', salesId)).resolves.toBeUndefined()
  })

  it('re-evaluates scope against the org unit as it is now, not as it was', async () => {
    const user = await makeUser('ada', rootId)
    const target = await makeUser('bob', engId)
    await roles.assign({ userId: user.id, roleKey: 'help_desk', scopeOrgUnitId: salesId })
    const actor = await engine.resolveActor({ subject: 'k', username: 'ada', email: null })

    expect(await engine.canIn(actor, 'user:read', target.orgUnitId)).toBe(false)

    // Move the target into the actor's scope; the next check must reflect it.
    await ctx.pool.query('UPDATE users SET org_unit_id = $1 WHERE id = $2', [
      emeaId,
      target.id,
    ])
    const moved = await users.findById(target.id)
    if (moved === null) {
      throw new Error('test setup failed: moved user disappeared')
    }
    // Note the explicit null check above rather than `moved?.orgUnitId`:
    // canIn's `orgUnitId` parameter is required (not optional) precisely so
    // a failed lookup cannot be passed straight through — see Finding I-2
    // and the type-only regression pin at the bottom of this file.
    expect(await engine.canIn(actor, 'user:read', moved.orgUnitId)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Type-only regression pin for Finding I-2. The function below is never
// called anywhere — it exists purely to be type-checked by `tsc` (the build
// step, which includes test/**/* per tsconfig.json). It is never executed:
// vitest's SWC transform strips types and transpiles the file, but an
// uncalled function's body never runs.
//
// The old bug: `can(actor, action, targetOrgUnitId?: string)` treated a
// missing target as "no target — list route, check elsewhere," which
// resolved to an allow. A failed lookup like `user?.orgUnitId` (typed
// `string | undefined`) fit that same optional parameter perfectly and
// compiled without complaint, silently reusing the list-route allow for
// what should have been a hard deny.
//
// canIn's `orgUnitId: string` closes this by making the parameter required.
// If it is ever loosened back to optional, the line below stops erroring,
// `@ts-expect-error` becomes an "Unused '@ts-expect-error' directive" error,
// and `tsc` fails the build — so the regression cannot land silently.
// ---------------------------------------------------------------------------
function _typeOnly_canInRejectsPossiblyUndefinedTarget(
  engine: PermissionEngine,
  actor: Actor,
  maybeOrgUnitId: string | undefined,
) {
  // @ts-expect-error orgUnitId must be `string`; `string | undefined` (e.g. from
  // `user?.orgUnitId` after a failed lookup) is rejected at compile time.
  return engine.canIn(actor, 'user:read', maybeOrgUnitId)
}
