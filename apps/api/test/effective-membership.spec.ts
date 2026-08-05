import { beforeEach, describe, expect, it } from 'vitest'
import { GroupsRepository } from '../src/groups/groups.repository'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

describe('effective membership', () => {
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

  it('includes direct members', async () => {
    const group = await groups.create({ name: 'Engineering' })
    const ada = await makeUser('ada')
    await groups.addUser(group.id, ada.id)
    expect(await groups.listEffectiveUserMembers(group.id)).toEqual([ada.id])
  })

  it('includes members of nested groups, transitively', async () => {
    const all = await groups.create({ name: 'All Staff' })
    const eng = await groups.create({ name: 'Engineering' })
    const backend = await groups.create({ name: 'Backend' })
    await groups.addChildGroup(all.id, eng.id)
    await groups.addChildGroup(eng.id, backend.id)

    const ada = await makeUser('ada')
    const grace = await makeUser('grace')
    await groups.addUser(backend.id, ada.id)
    await groups.addUser(eng.id, grace.id)

    const effective = await groups.listEffectiveUserMembers(all.id)
    expect(effective.sort()).toEqual([ada.id, grace.id].sort())
  })

  it('de-duplicates a user reachable by two paths', async () => {
    const top = await groups.create({ name: 'Top' })
    const left = await groups.create({ name: 'Left' })
    const right = await groups.create({ name: 'Right' })
    const bottom = await groups.create({ name: 'Bottom' })
    await groups.addChildGroup(top.id, left.id)
    await groups.addChildGroup(top.id, right.id)
    await groups.addChildGroup(left.id, bottom.id)
    await groups.addChildGroup(right.id, bottom.id)

    const ada = await makeUser('ada')
    await groups.addUser(bottom.id, ada.id)

    expect(await groups.listEffectiveUserMembers(top.id)).toEqual([ada.id])
  })

  it('does not leak members upward from a parent to its child', async () => {
    const parent = await groups.create({ name: 'Parent' })
    const child = await groups.create({ name: 'Child' })
    await groups.addChildGroup(parent.id, child.id)

    const ada = await makeUser('ada')
    await groups.addUser(parent.id, ada.id)

    expect(await groups.listEffectiveUserMembers(child.id)).toEqual([])
  })

  it('returns an empty list for a group with no members', async () => {
    const group = await groups.create({ name: 'Empty' })
    expect(await groups.listEffectiveUserMembers(group.id)).toEqual([])
  })

  it('resolves every group a user effectively belongs to', async () => {
    const all = await groups.create({ name: 'All Staff' })
    const eng = await groups.create({ name: 'Engineering' })
    const backend = await groups.create({ name: 'Backend' })
    const unrelated = await groups.create({ name: 'Unrelated' })
    await groups.addChildGroup(all.id, eng.id)
    await groups.addChildGroup(eng.id, backend.id)

    const ada = await makeUser('ada')
    await groups.addUser(backend.id, ada.id)

    const effective = await groups.listEffectiveGroupsForUser(ada.id)
    expect(effective.sort()).toEqual([all.id, eng.id, backend.id].sort())
    expect(effective).not.toContain(unrelated.id)
  })

  it('terminates even if a cycle exists in the stored graph', async () => {
    // The repository prevents cycles, so plant one directly to prove the
    // expansion itself is safe rather than relying on the guard upstream.
    const a = await groups.create({ name: 'A' })
    const b = await groups.create({ name: 'B' })
    await ctx.pool.query(
      'INSERT INTO group_group_members (parent_group_id, child_group_id) VALUES ($1,$2),($2,$1)',
      [a.id, b.id],
    )
    const ada = await makeUser('ada')
    await groups.addUser(b.id, ada.id)

    expect(await groups.listEffectiveUserMembers(a.id)).toEqual([ada.id])
  })
})
