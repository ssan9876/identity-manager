import { beforeEach, describe, expect, it } from 'vitest'
import { ConflictError } from '../src/common/errors'
import { GroupsRepository } from '../src/groups/groups.repository'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { withTestDatabase } from './support/pg'

describe('GroupsRepository', () => {
  const ctx = withTestDatabase()
  let groups: GroupsRepository
  let orgUnitId: string

  beforeEach(async () => {
    await ctx.pool.query('TRUNCATE TABLE groups, users, org_units CASCADE')
    groups = new GroupsRepository(ctx.db)
    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot('Acme Corp')).id
  })

  it('creates a group with defaults', async () => {
    const group = await groups.create({ name: 'Engineering' })
    expect(group.name).toBe('Engineering')
    expect(group.description).toBeNull()
    expect(group.orgUnitId).toBeNull()
    expect(group.attributes).toEqual({})
  })

  it('creates a group scoped to an org unit with attributes', async () => {
    const group = await groups.create({
      name: 'Sales EMEA',
      description: 'Regional sales',
      orgUnitId,
      attributes: { cost_center: 'CC-1' },
    })
    expect(group.orgUnitId).toBe(orgUnitId)
    expect(group.attributes).toEqual({ cost_center: 'CC-1' })
  })

  it('rejects a duplicate name case-insensitively with a ConflictError', async () => {
    await groups.create({ name: 'Engineering' })
    await expect(groups.create({ name: 'ENGINEERING' })).rejects.toBeInstanceOf(
      ConflictError,
    )
  })

  it('finds by name case-insensitively', async () => {
    await groups.create({ name: 'Engineering' })
    expect((await groups.findByName('engineering'))?.name).toBe('Engineering')
  })

  it('returns null for a missing group rather than throwing', async () => {
    expect(await groups.findById('00000000-0000-0000-0000-000000000000')).toBeNull()
  })

  it('lists groups with limit and offset, ordered by name', async () => {
    for (const name of ['Charlie', 'Alpha', 'Bravo']) {
      await groups.create({ name })
    }
    expect((await groups.list({ limit: 2, offset: 0 })).map((g) => g.name)).toEqual([
      'Alpha',
      'Bravo',
    ])
    expect((await groups.list({ limit: 2, offset: 2 })).map((g) => g.name)).toEqual([
      'Charlie',
    ])
    expect(await groups.count()).toBe(3)
  })
})
