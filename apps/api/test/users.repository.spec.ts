import { beforeEach, describe, expect, it } from 'vitest'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

describe('UsersRepository', () => {
  const ctx = withTestDatabase()
  let users: UsersRepository
  let orgUnitId: string

  beforeEach(async () => {
    await ctx.pool.query('TRUNCATE TABLE users, org_units CASCADE')
    users = new UsersRepository(ctx.db)
    const orgUnits = new OrgUnitsRepository(ctx.db)
    orgUnitId = (await orgUnits.createRoot('Acme Corp')).id
  })

  const input = (overrides = {}) => ({
    primaryEmail: 'ada@example.com',
    username: 'ada',
    firstName: 'Ada',
    lastName: 'Lovelace',
    orgUnitId,
    ...overrides,
  })

  it('creates a user in pending status with a derived display name', async () => {
    const user = await users.create(input())
    expect(user.status).toBe('pending')
    expect(user.displayName).toBe('Ada Lovelace')
    expect(user.deactivatedAt).toBeNull()
  })

  it('stores custom attributes as JSONB', async () => {
    const user = await users.create(
      input({ attributes: { cost_center: 'CC-1024', remote: true } }),
    )
    const found = await users.findById(user.id)
    expect(found?.attributes).toEqual({ cost_center: 'CC-1024', remote: true })
  })

  it('rejects a duplicate primary email', async () => {
    await users.create(input())
    await expect(users.create(input({ username: 'ada2' }))).rejects.toThrow()
  })

  it('finds by email case-insensitively', async () => {
    await users.create(input())
    expect((await users.findByEmail('ADA@EXAMPLE.COM'))?.username).toBe('ada')
  })

  it('allows pending to active to suspended to deactivated', async () => {
    const user = await users.create(input())
    expect((await users.changeStatus(user.id, 'active')).status).toBe('active')
    expect((await users.changeStatus(user.id, 'suspended')).status).toBe('suspended')

    const done = await users.changeStatus(user.id, 'deactivated')
    expect(done.status).toBe('deactivated')
    expect(done.deactivatedAt).toBeInstanceOf(Date)
  })

  it('treats deactivated as terminal', async () => {
    const user = await users.create(input())
    await users.changeStatus(user.id, 'active')
    await users.changeStatus(user.id, 'deactivated')

    await expect(users.changeStatus(user.id, 'active')).rejects.toThrow(
      /deactivated is terminal/,
    )
  })

  it('rejects a transition straight from pending to suspended', async () => {
    const user = await users.create(input())
    await expect(users.changeStatus(user.id, 'suspended')).rejects.toThrow(
      /cannot transition/,
    )
  })

  it('exposes no delete operation', () => {
    expect((users as unknown as Record<string, unknown>).delete).toBeUndefined()
  })
})
