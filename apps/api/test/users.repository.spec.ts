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

  it('resolves concurrent identical transition requests atomically, with no double success', async () => {
    const ITERATIONS = 20

    for (let i = 0; i < ITERATIONS; i++) {
      const user = await users.create(
        input({
          primaryEmail: `race-same-${i}@example.com`,
          username: `race-same-${i}`,
        }),
      )
      await users.changeStatus(user.id, 'active')
      await users.changeStatus(user.id, 'suspended')

      // Two identical concurrent requests to deactivate the same user. A
      // read-then-write implementation has no guard against this: both reads
      // see 'suspended', both validate, both blindly write "success". The
      // atomic conditional UPDATE re-checks the row's live status at write
      // time, so only the request that actually lands first can win.
      const results = await Promise.allSettled([
        users.changeStatus(user.id, 'deactivated'),
        users.changeStatus(user.id, 'deactivated'),
      ])

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)

      for (const result of results) {
        if (result.status === 'rejected') {
          expect(String((result.reason as Error)?.message)).toMatch(
            /deactivated is terminal/,
          )
        }
      }

      const final = await users.findById(user.id)
      expect(final?.status).toBe('deactivated')
      expect(final?.deactivatedAt).toBeInstanceOf(Date)
    }
  })

  it('never lets a concurrent competing transition silently undo a concurrent deactivation', async () => {
    const ITERATIONS = 20

    for (let i = 0; i < ITERATIONS; i++) {
      const user = await users.create(
        input({
          primaryEmail: `race-mixed-${i}@example.com`,
          username: `race-mixed-${i}`,
        }),
      )
      await users.changeStatus(user.id, 'active')
      await users.changeStatus(user.id, 'suspended')

      // The exact shape the reviewer reproduced: a suspended user with a
      // concurrent reactivation racing a concurrent deactivation. Whichever
      // one physically lands first, 'deactivated' must win in the end --
      // either it lands directly, or 'active' lands first and the concurrent
      // deactivate request legally follows it ('active' -> 'deactivated' is
      // itself allowed). There is no valid interleaving of this specific
      // pair that should leave the row 'active'. The old read-then-write
      // code allowed exactly that ~40% of the time: the deactivate call
      // reported success while the row was silently reverted to active with
      // a null deactivatedAt.
      const [activeResult, deactivatedResult] = await Promise.allSettled([
        users.changeStatus(user.id, 'active'),
        users.changeStatus(user.id, 'deactivated'),
      ])

      expect(deactivatedResult.status).toBe('fulfilled')

      const final = await users.findById(user.id)
      expect(final?.status).toBe('deactivated')
      expect(final?.deactivatedAt).toBeInstanceOf(Date)

      // If the concurrent reactivation lost the race, it must fail loudly
      // with the terminal message -- never succeed silently against a stale
      // read.
      if (activeResult.status === 'rejected') {
        expect(String((activeResult.reason as Error)?.message)).toMatch(
          /deactivated is terminal/,
        )
      }
    }
  })

  it('never lets a concurrent suspend silently undo a concurrent deactivation of an active user', async () => {
    const ITERATIONS = 20

    for (let i = 0; i < ITERATIONS; i++) {
      const user = await users.create(
        input({
          primaryEmail: `race-active-${i}@example.com`,
          username: `race-active-${i}`,
        }),
      )
      await users.changeStatus(user.id, 'active')

      // The exact shape that produced the Critical bug: an ACTIVE user hit
      // with a concurrent suspend racing a concurrent deactivate (8/25
      // failures against the old non-atomic code). Whichever physically
      // lands first, 'deactivated' must win in the end -- either it lands
      // directly, or 'suspended' lands first and the concurrent deactivate
      // request legally follows it ('suspended' -> 'deactivated' is itself
      // allowed). There is no valid interleaving of this pair that should
      // leave the row anywhere but 'deactivated'. The old read-then-write
      // code let the deactivate call report success while a later, stale
      // 'suspended' write silently clobbered it back to
      // status='suspended', deactivated_at=null.
      const [suspendedResult, deactivatedResult] = await Promise.allSettled([
        users.changeStatus(user.id, 'suspended'),
        users.changeStatus(user.id, 'deactivated'),
      ])

      expect(deactivatedResult.status).toBe('fulfilled')

      const final = await users.findById(user.id)
      expect(final?.status).toBe('deactivated')
      expect(final?.deactivatedAt).toBeInstanceOf(Date)

      // If the concurrent suspend lost the race, it must fail loudly with
      // the terminal message -- never succeed silently against a stale read
      // that would have clobbered the deactivation.
      if (suspendedResult.status === 'rejected') {
        expect(String((suspendedResult.reason as Error)?.message)).toMatch(
          /deactivated is terminal/,
        )
      }
    }
  })

  it('exposes no delete operation', () => {
    expect((users as unknown as Record<string, unknown>).delete).toBeUndefined()
  })
})
