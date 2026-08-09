import { beforeEach, describe, expect, it } from 'vitest'
import { ConflictError, CycleError, NotFoundError } from '../src/common/errors'
import { GroupsRepository } from '../src/groups/groups.repository'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

const MISSING = '00000000-0000-0000-0000-000000000000'

describe('group membership', () => {
  const ctx = withTestDatabase()
  let groups: GroupsRepository
  let users: UsersRepository
  let orgUnitId: string

  beforeEach(async () => {
    // DELETE, not TRUNCATE ... CASCADE: TRUNCATE on `users` always
    // structurally cascades into audit_log via its actor_user_id foreign
    // key, and audit_log's append-only trigger unconditionally rejects that.
    // DELETE respects each table's own onDelete action instead:
    // group_user_members/group_group_members cascade from groups/users,
    // audit_log ('restrict', unreferenced here) is never touched.
    await ctx.pool.query('DELETE FROM groups')
    await ctx.pool.query('DELETE FROM users')
    await ctx.pool.query('DELETE FROM org_units')
    groups = new GroupsRepository(ctx.db)
    users = new UsersRepository(ctx.db)
    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot('Acme Corp')).id
  })

  const makeUser = (username: string) =>
    users.create({
      primaryEmail: `${username}@example.com`,
      username,
      firstName: 'Test',
      lastName: 'User',
      orgUnitId,
    })

  it('adds and lists a direct user member', async () => {
    const group = await groups.create({ name: 'Engineering' })
    const user = await makeUser('ada')
    await groups.addUser(group.id, user.id)
    expect(await groups.listDirectUserMembers(group.id)).toEqual([user.id])
  })

  it('is idempotent when the same user is added twice', async () => {
    const group = await groups.create({ name: 'Engineering' })
    const user = await makeUser('ada')
    await groups.addUser(group.id, user.id)
    await groups.addUser(group.id, user.id)
    expect(await groups.listDirectUserMembers(group.id)).toEqual([user.id])
  })

  it('removes a user member', async () => {
    const group = await groups.create({ name: 'Engineering' })
    const user = await makeUser('ada')
    await groups.addUser(group.id, user.id)
    await groups.removeUser(group.id, user.id)
    expect(await groups.listDirectUserMembers(group.id)).toEqual([])
  })

  // listDirectGroupsForUser (Milestone 6, Task 3): the mirror-image query of
  // listDirectUserMembers above — user -> their direct group ids, rather
  // than group -> its direct user ids. Added for SelfServiceController.
  it("lists a user's direct group memberships only, not a group unrelated to them", async () => {
    const group = await groups.create({ name: 'Engineering' })
    const other = await groups.create({ name: 'Sales' })
    const user = await makeUser('ada')
    await groups.addUser(group.id, user.id)
    expect(await groups.listDirectGroupsForUser(user.id)).toEqual([group.id])
    expect(await groups.listDirectGroupsForUser(user.id)).not.toContain(other.id)
  })

  it('does not climb into ancestor groups — that is listEffectiveGroupsForUser\'s job, not this one\'s', async () => {
    const parent = await groups.create({ name: 'All Staff' })
    const child = await groups.create({ name: 'Engineering' })
    await groups.addChildGroup(parent.id, child.id)
    const user = await makeUser('ada')
    await groups.addUser(child.id, user.id)

    expect(await groups.listDirectGroupsForUser(user.id)).toEqual([child.id])
    const effective = await groups.listEffectiveGroupsForUser(user.id)
    expect(effective.sort()).toEqual([parent.id, child.id].sort())
  })

  it('returns an empty list for a user in no groups', async () => {
    const user = await makeUser('ada')
    expect(await groups.listDirectGroupsForUser(user.id)).toEqual([])
  })

  it('raises NotFoundError for a missing group or user', async () => {
    const group = await groups.create({ name: 'Engineering' })
    const user = await makeUser('ada')
    await expect(groups.addUser(MISSING, user.id)).rejects.toBeInstanceOf(NotFoundError)
    await expect(groups.addUser(group.id, MISSING)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('nests a child group', async () => {
    const parent = await groups.create({ name: 'All Staff' })
    const child = await groups.create({ name: 'Engineering' })
    await groups.addChildGroup(parent.id, child.id)
    expect(await groups.listDirectChildGroups(parent.id)).toEqual([child.id])
  })

  it('rejects a self-edge as a CycleError', async () => {
    const group = await groups.create({ name: 'Engineering' })
    await expect(groups.addChildGroup(group.id, group.id)).rejects.toBeInstanceOf(
      CycleError,
    )
  })

  it('rejects a direct two-node cycle', async () => {
    const a = await groups.create({ name: 'A' })
    const b = await groups.create({ name: 'B' })
    await groups.addChildGroup(a.id, b.id)
    await expect(groups.addChildGroup(b.id, a.id)).rejects.toBeInstanceOf(CycleError)
  })

  it('rejects a transitive cycle three levels deep', async () => {
    const a = await groups.create({ name: 'A' })
    const b = await groups.create({ name: 'B' })
    const c = await groups.create({ name: 'C' })
    await groups.addChildGroup(a.id, b.id)
    await groups.addChildGroup(b.id, c.id)
    await expect(groups.addChildGroup(c.id, a.id)).rejects.toBeInstanceOf(CycleError)
  })

  it('allows a diamond, which is not a cycle', async () => {
    const top = await groups.create({ name: 'Top' })
    const left = await groups.create({ name: 'Left' })
    const right = await groups.create({ name: 'Right' })
    const bottom = await groups.create({ name: 'Bottom' })
    await groups.addChildGroup(top.id, left.id)
    await groups.addChildGroup(top.id, right.id)
    await groups.addChildGroup(left.id, bottom.id)
    await expect(groups.addChildGroup(right.id, bottom.id)).resolves.toBeUndefined()
  })

  it('is idempotent when the same edge is added twice', async () => {
    const parent = await groups.create({ name: 'All Staff' })
    const child = await groups.create({ name: 'Engineering' })
    await groups.addChildGroup(parent.id, child.id)
    await groups.addChildGroup(parent.id, child.id)
    expect(await groups.listDirectChildGroups(parent.id)).toEqual([child.id])
  })

  it('never lets concurrent edge insertions form a cycle', async () => {
    // A -> B and B -> A raced 20 times. Without serialization both checks pass
    // and a cycle is committed, which makes effective-membership expansion
    // depend on UNION dedup rather than on the graph actually being a DAG.
    for (let i = 0; i < 20; i++) {
      // finding H1 (docs/archive/audits/audit-integrity.md): TRUNCATE is not
      // among the runtime role's grants on ANY table (only SELECT/INSERT/
      // UPDATE/DELETE — see db/roles.ts), so this between-iteration reset
      // runs on the OWNER pool. Everything under test below — addChildGroup,
      // the cycle race itself — still runs as the runtime role via `groups`
      // (constructed on `ctx.db`).
      await ctx.ownerPool.query('TRUNCATE TABLE group_group_members CASCADE')
      const a = await groups.findByName('A') ?? (await groups.create({ name: 'A' }))
      const b = await groups.findByName('B') ?? (await groups.create({ name: 'B' }))

      const results = await Promise.allSettled([
        groups.addChildGroup(a.id, b.id),
        groups.addChildGroup(b.id, a.id),
      ])

      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      expect(fulfilled).toHaveLength(1)

      const { rows } = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM group_group_members')
      expect(rows[0].n).toBe(1)
    }
  })

  it('raises NotFoundError when nesting a group that does not exist', async () => {
    const group = await groups.create({ name: 'Engineering' })
    await expect(groups.addChildGroup(group.id, MISSING)).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })
})
