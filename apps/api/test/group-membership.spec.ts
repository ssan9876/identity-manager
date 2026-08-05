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
    await ctx.pool.query(
      'TRUNCATE TABLE group_user_members, group_group_members, groups, users, org_units CASCADE',
    )
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
      await ctx.pool.query('TRUNCATE TABLE group_group_members CASCADE')
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
