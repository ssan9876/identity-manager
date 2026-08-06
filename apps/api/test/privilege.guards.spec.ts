import { beforeEach, describe, expect, it } from 'vitest'
import type { RoleKey } from '../src/authz/actions'
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
  let supportId: string

  beforeEach(async () => {
    // DELETE, not TRUNCATE ... CASCADE: TRUNCATE on `users` always
    // structurally cascades into audit_log via its actor_user_id foreign
    // key, and audit_log's append-only trigger unconditionally rejects that.
    // DELETE respects each table's own onDelete action instead:
    // role_assignments cascades from users/org_units, audit_log
    // ('restrict', unreferenced here) is never touched.
    await ctx.pool.query('DELETE FROM users')
    await ctx.pool.query('DELETE FROM org_units')
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
    // Third sibling, disjoint from both salesId and engId's subtrees — used
    // by the multi-element sql.param test below (a "third unrelated scope").
    supportId = (await orgUnits.createChild(root.id, 'Support')).id
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

  // Finding I-2: every test above reaches `holdings` through the literal
  // `assignment.roleKey === roleKey` disjunct (all use help_desk). The
  // `|| assignment.roleKey === 'super_admin'` disjunct — the spec's
  // headline escalation path, a scoped super_admin — was previously
  // exercised ONLY by the first test's globally-scoped super_admin, where
  // every assertion expects allow, so a plausible-but-wrong refactor that
  // treats ANY super_admin membership as an unconditional bypass (instead
  // of folding it into the same scope-restricted holdings list as every
  // other role) left the original 11 tests green. A SCOPED super_admin must
  // be denied outside its own subtree exactly like a scoped help_desk is.
  describe('a scoped super_admin (the headline escalation path)', () => {
    it('is denied granting super_admin globally', async () => {
      const admin = await makeUser('admin', rootId)
      await roles.assign({ userId: admin.id, roleKey: 'super_admin', scopeOrgUnitId: salesId })
      const actor = await actorFor('admin')

      await expect(
        guards.assertCanAssignRole(actor, 'super_admin', null),
      ).rejects.toBeInstanceOf(ForbiddenError)
    })

    it('is denied granting user_admin globally', async () => {
      const admin = await makeUser('admin', rootId)
      await roles.assign({ userId: admin.id, roleKey: 'super_admin', scopeOrgUnitId: salesId })
      const actor = await actorFor('admin')

      await expect(
        guards.assertCanAssignRole(actor, 'user_admin', null),
      ).rejects.toBeInstanceOf(ForbiddenError)
    })

    it('is denied granting outside its own subtree', async () => {
      const admin = await makeUser('admin', rootId)
      await roles.assign({ userId: admin.id, roleKey: 'super_admin', scopeOrgUnitId: salesId })
      const actor = await actorFor('admin')

      await expect(
        guards.assertCanAssignRole(actor, 'user_admin', engId),
      ).rejects.toBeInstanceOf(ForbiddenError)
    })

    it('is denied granting at the root, above its own scope', async () => {
      const admin = await makeUser('admin', rootId)
      await roles.assign({ userId: admin.id, roleKey: 'super_admin', scopeOrgUnitId: salesId })
      const actor = await actorFor('admin')

      await expect(
        guards.assertCanAssignRole(actor, 'user_admin', rootId),
      ).rejects.toBeInstanceOf(ForbiddenError)
    })

    it('is allowed granting inside its own subtree — intended delegation', async () => {
      const admin = await makeUser('admin', rootId)
      await roles.assign({ userId: admin.id, roleKey: 'super_admin', scopeOrgUnitId: salesId })
      const actor = await actorFor('admin')

      await expect(
        guards.assertCanAssignRole(actor, 'user_admin', emeaId),
      ).resolves.toBeUndefined()
    })
  })

  // Minor finding: every test above gives the actor exactly ONE holding, so
  // sql.param(scopePaths) is only ever exercised with a 1-element array.
  // Task 3 documented that Drizzle's sql tag renders 1-element and
  // >=2-element arrays differently (see the sql.param comment above). This
  // exercises the real >=2-element case: two disjoint held scopes, granted
  // at each, denied at a third (supportId) the actor holds nothing in.
  it('grants at either of two disjoint held scopes and denies an unrelated third', async () => {
    const admin = await makeUser('admin', rootId)
    await roles.assign({ userId: admin.id, roleKey: 'help_desk', scopeOrgUnitId: salesId })
    await roles.assign({ userId: admin.id, roleKey: 'help_desk', scopeOrgUnitId: engId })
    const actor = await actorFor('admin')

    await expect(
      guards.assertCanAssignRole(actor, 'help_desk', salesId),
    ).resolves.toBeUndefined()
    await expect(
      guards.assertCanAssignRole(actor, 'help_desk', engId),
    ).resolves.toBeUndefined()
    await expect(
      guards.assertCanAssignRole(actor, 'help_desk', supportId),
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

  // Finding I-1: role_assignments.role_key is a Postgres enum that can grow
  // independently of this code's static ROLE_RANK catalog (e.g. a migration
  // lands ahead of a deploy). `ROLE_RANK[unknownKey]` is `undefined`, and
  // `Math.max(n, undefined)` is `NaN`, which poisons the whole reduce and
  // fails every later `<`/`>` comparison — a silent fail-open, not the
  // fail-closed 403/500 either side of this check needs. These simulate
  // that drift for real, by widening a real Postgres enum, the same way
  // the review demonstrated it live (`ALTER TYPE role_key ADD VALUE
  // 'ghost_role'`), so the regression is pinned against genuine Postgres
  // behaviour, not a hand-typed fixture.
  // The ALTER TYPE calls below run on ctx.ownerPool, not ctx.pool: finding
  // H1 (docs/superpowers/audit-integrity.md) — widening an enum requires
  // owning the type, which the RUNTIME role deliberately does not. Every
  // subsequent step in each test (the INSERT using the new value, and every
  // method under test) still runs as the runtime role.
  describe('role_key catalog drift (Finding I-1)', () => {
    it('does not let an unrecognized role on the ACTOR inflate their rank past a real denial', async () => {
      await ctx.ownerPool.query(`ALTER TYPE role_key ADD VALUE IF NOT EXISTS 'ghost_role'`)

      const ghost = await makeUser('ghost', rootId)
      const boss = await makeUser('boss', rootId)
      await ctx.pool.query(
        'INSERT INTO role_assignments (user_id, role_key, scope_org_unit_id) VALUES ($1, $2::role_key, NULL)',
        [ghost.id, 'ghost_role'],
      )
      await roles.assign({ userId: boss.id, roleKey: 'super_admin' })
      const actor = await actorFor('ghost')

      // Pre-fix: highestRank([ghost_role]) was NaN, and NaN < 40 is false —
      // never throws, so an actor holding nothing recognizable could modify
      // a super_admin. Fixed: the unknown role contributes NO_PRIVILEGE, so
      // this actor's rank is -1, correctly denied against a real 40.
      await expect(
        guards.assertCanModifyPrincipal(actor, boss.id),
      ).rejects.toBeInstanceOf(ForbiddenError)
    })

    it('fails loud (throws), not open, when the TARGET holds an unrecognized role', async () => {
      await ctx.ownerPool.query(`ALTER TYPE role_key ADD VALUE IF NOT EXISTS 'ghost_role'`)

      const plain = await makeUser('plain', rootId)
      const ghost = await makeUser('ghost', rootId)
      await ctx.pool.query(
        'INSERT INTO role_assignments (user_id, role_key, scope_org_unit_id) VALUES ($1, $2::role_key, NULL)',
        [ghost.id, 'ghost_role'],
      )
      const actor = await actorFor('plain')

      // Pre-fix: targetRank was NaN, and actorRank(-1) < NaN is false —
      // never throws, so a completely unprivileged actor could modify this
      // target. Fixed: an unrecognized role_key on the TARGET must never
      // read as "unprivileged, go ahead" — it throws a data-integrity
      // fault (a plain Error, not ForbiddenError) instead, so it must
      // reject, and must not be mistaken for an ordinary 403 denial.
      await expect(guards.assertCanModifyPrincipal(actor, ghost.id)).rejects.toThrow()
      await expect(
        guards.assertCanModifyPrincipal(actor, ghost.id),
      ).rejects.not.toBeInstanceOf(ForbiddenError)
    })
  })

  // Finding I-1, round 2 (CRITICAL): the round-1 fix guarded against a
  // roleKey being ABSENT (`in` / `?? NO_PRIVILEGE`), not against it
  // resolving to something INHERITED. `'constructor' in ROLE_RANK` and
  // `'toString' in ROLE_RANK` are both true on an ordinary object (walks
  // the prototype chain), and `ROLE_RANK['constructor']` is a real,
  // truthy, non-nullish value (the inherited Object function) that `??`
  // does not catch — Math.max then coerces it to NaN, reopening the exact
  // fail-open Finding I-1 was meant to close, via a different door.
  // role_key is a Postgres enum, so `ALTER TYPE role_key ADD VALUE
  // 'constructor'` is ordinary, valid SQL — these use the actual colliding
  // names, not a generic placeholder, and go through the real methods
  // end-to-end against a real Postgres, exactly as the review reproduced it.
  describe('role_key values colliding with an inherited Object.prototype property (Finding I-1, fix round 2)', () => {
    it('denies (never resolves) when the TARGET holds only "constructor"', async () => {
      await ctx.ownerPool.query(`ALTER TYPE role_key ADD VALUE IF NOT EXISTS 'constructor'`)

      const plain = await makeUser('plain', rootId)
      const colliding = await makeUser('colliding', rootId)
      await ctx.pool.query(
        'INSERT INTO role_assignments (user_id, role_key, scope_org_unit_id) VALUES ($1, $2::role_key, NULL)',
        [colliding.id, 'constructor'],
      )
      const actor = await actorFor('plain')

      await expect(guards.assertCanModifyPrincipal(actor, colliding.id)).rejects.toThrow()
      await expect(
        guards.assertCanModifyPrincipal(actor, colliding.id),
      ).rejects.not.toBeInstanceOf(ForbiddenError)
    })

    it('denies (never resolves) when the TARGET holds only "toString"', async () => {
      await ctx.ownerPool.query(`ALTER TYPE role_key ADD VALUE IF NOT EXISTS 'toString'`)

      const plain = await makeUser('plain', rootId)
      const colliding = await makeUser('colliding', rootId)
      await ctx.pool.query(
        'INSERT INTO role_assignments (user_id, role_key, scope_org_unit_id) VALUES ($1, $2::role_key, NULL)',
        [colliding.id, 'toString'],
      )
      const actor = await actorFor('plain')

      await expect(guards.assertCanModifyPrincipal(actor, colliding.id)).rejects.toThrow()
      await expect(
        guards.assertCanModifyPrincipal(actor, colliding.id),
      ).rejects.not.toBeInstanceOf(ForbiddenError)
    })

    it('does not let an ACTOR holding only "constructor" modify a real super_admin', async () => {
      await ctx.ownerPool.query(`ALTER TYPE role_key ADD VALUE IF NOT EXISTS 'constructor'`)

      const colliding = await makeUser('colliding', rootId)
      const boss = await makeUser('boss', rootId)
      await ctx.pool.query(
        'INSERT INTO role_assignments (user_id, role_key, scope_org_unit_id) VALUES ($1, $2::role_key, NULL)',
        [colliding.id, 'constructor'],
      )
      await roles.assign({ userId: boss.id, roleKey: 'super_admin' })
      const actor = await actorFor('colliding')

      // Pre-fix: ROLE_RANK['constructor'] ?? NO_PRIVILEGE never fires
      // (inherited Object function is truthy, not nullish); Math.max
      // coerces it to NaN, and NaN < 40 is false -> resolved.
      expect(guards.highestRank(actor.assignments)).not.toBeNaN()
      await expect(
        guards.assertCanModifyPrincipal(actor, boss.id),
      ).rejects.toBeInstanceOf(ForbiddenError)
    })

    it('ranks an actor holding "constructor" plus a real role by the real role alone', async () => {
      await ctx.ownerPool.query(`ALTER TYPE role_key ADD VALUE IF NOT EXISTS 'constructor'`)

      const mixed = await makeUser('mixed', rootId)
      await ctx.pool.query(
        'INSERT INTO role_assignments (user_id, role_key, scope_org_unit_id) VALUES ($1, $2::role_key, NULL)',
        [mixed.id, 'constructor'],
      )
      await roles.assign({ userId: mixed.id, roleKey: 'user_admin' })
      const actor = await actorFor('mixed')

      expect(guards.highestRank(actor.assignments)).toBe(30)
    })
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

  it('highestRank ignores an assignment whose roleKey is outside the catalog, rather than corrupting the result via NaN', () => {
    // Direct, DB-free pin on highestRank's own contract (Finding I-1,
    // actor side): even mixed with a real, high-ranked assignment, an
    // unrecognized roleKey must not win via NaN contamination or otherwise
    // change the answer.
    expect(
      guards.highestRank([
        { roleKey: 'super_admin', scopeOrgUnitId: null, scopePath: null },
        { roleKey: 'ghost_role' as RoleKey, scopeOrgUnitId: null, scopePath: null },
      ]),
    ).toBe(40)
  })

  // Finding I-1, round 2: the full named colliding set from the review,
  // exercised directly and cheaply (no DB) against highestRank itself. Every
  // one of these is an inherited property/accessor on Object.prototype, so
  // each is a DISTINCT way the round-1 `?? NO_PRIVILEGE`-only fix could have
  // resolved to a truthy, non-nullish value and been coerced to NaN.
  const COLLIDING_ROLE_KEYS = [
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
    '__proto__',
  ] as const

  it('highestRank never returns NaN, for any single role_key that collides with an inherited Object.prototype property', () => {
    for (const collidingKey of COLLIDING_ROLE_KEYS) {
      const rank = guards.highestRank([
        { roleKey: collidingKey as RoleKey, scopeOrgUnitId: null, scopePath: null },
      ])
      expect(rank, `roleKey "${collidingKey}"`).not.toBeNaN()
      expect(rank, `roleKey "${collidingKey}"`).toBe(-1)
    }
  })

  it('highestRank ignores every colliding role_key even mixed with a real, high-ranked assignment', () => {
    for (const collidingKey of COLLIDING_ROLE_KEYS) {
      const rank = guards.highestRank([
        { roleKey: 'super_admin', scopeOrgUnitId: null, scopePath: null },
        { roleKey: collidingKey as RoleKey, scopeOrgUnitId: null, scopePath: null },
      ])
      expect(rank, `roleKey "${collidingKey}"`).toBe(40)
    }
  })
})
