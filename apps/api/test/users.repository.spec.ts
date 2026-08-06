import { beforeEach, describe, expect, it } from 'vitest'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

describe('UsersRepository', () => {
  const ctx = withTestDatabase()
  let users: UsersRepository
  let orgUnitId: string

  beforeEach(async () => {
    // DELETE, not TRUNCATE ... CASCADE: TRUNCATE on `users` always
    // structurally cascades into audit_log via its actor_user_id foreign
    // key, and audit_log's append-only trigger unconditionally rejects that.
    // DELETE respects each table's own onDelete action instead (audit_log is
    // 'restrict' and unreferenced here, so it's never touched).
    await ctx.pool.query('DELETE FROM users')
    await ctx.pool.query('DELETE FROM org_units')
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

  // LOW finding (docs/superpowers/audit-injection.md): unnormalised Unicode
  // usernames were stored verbatim, so an NFD-typed username and its NFC
  // (pre-composed) equivalent — visually IDENTICAL to a human, byte-distinct
  // to Postgres's lower()-based unique index — could both exist as separate
  // accounts. Not a resolution-ambiguity bug (lower() already agrees with
  // PermissionEngine.resolveActor exactly), but a display-layer
  // impersonation risk this closes by normalising on write.
  it('normalises a username to NFC on write, so an NFD-typed username collides with its NFC equivalent instead of creating a second, visually-identical account', async () => {
    const combiningAcute = String.fromCharCode(0x301)
    const nfd = `cafe${combiningAcute}user` // "e" + combining acute — NOT pre-composed
    const nfc = nfd.normalize('NFC') // pre-composed "é" — what a human would normally type

    // Sanity: these really are two different byte sequences that really do
    // represent the same visual identity — otherwise this test proves nothing.
    expect(nfd).not.toBe(nfc)
    expect(nfd.normalize('NFC')).toBe(nfc)

    const created = await users.create(input({ username: nfd, primaryEmail: 'nfd@example.com' }))
    // Stored form is NFC, not the raw NFD bytes the caller sent.
    expect(created.username).toBe(nfc)
    expect(created.username).not.toBe(nfd)

    // A second signup using the pre-composed NFC form of the SAME visual
    // username must now collide, not create a second, visually-identical
    // account.
    await expect(
      users.create(input({ username: nfc, primaryEmail: 'nfc@example.com' })),
    ).rejects.toThrow()
  })

  it('finds by email case-insensitively', async () => {
    await users.create(input())
    expect((await users.findByEmail('ADA@EXAMPLE.COM'))?.username).toBe('ada')
  })

  it('finds by username case-insensitively', async () => {
    await users.create(input())
    expect((await users.findByUsername('ADA'))?.primaryEmail).toBe('ada@example.com')
  })

  it('findByUsername matches on username, not email', async () => {
    await users.create(input())
    // 'ada@example.com' is this user's email, not their username ('ada') --
    // pins that findByUsername compares against the username column, not
    // primaryEmail. A caller that needs "the user PermissionEngine.
    // resolveActor would resolve for this principal" must get null here,
    // not a false-positive match on the email column.
    expect(await users.findByUsername('ada@example.com')).toBeNull()
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

  describe('list/count default status filtering', () => {
    it('excludes a deactivated user from the default list and count, while including pending/active/suspended', async () => {
      const pending = await users.create(
        input({ username: 'status-pending', primaryEmail: 'status-pending@example.com' }),
      )
      const active = await users.create(
        input({ username: 'status-active', primaryEmail: 'status-active@example.com' }),
      )
      await users.changeStatus(active.id, 'active')
      const suspended = await users.create(
        input({ username: 'status-suspended', primaryEmail: 'status-suspended@example.com' }),
      )
      await users.changeStatus(suspended.id, 'active')
      await users.changeStatus(suspended.id, 'suspended')
      const deactivated = await users.create(
        input({
          username: 'status-deactivated',
          primaryEmail: 'status-deactivated@example.com',
        }),
      )
      await users.changeStatus(deactivated.id, 'active')
      await users.changeStatus(deactivated.id, 'deactivated')

      const list = await users.list({ limit: 50, offset: 0 })
      const ids = list.map((u) => u.id)
      expect(ids).toEqual(expect.arrayContaining([pending.id, active.id, suspended.id]))
      expect(ids).not.toContain(deactivated.id)

      const count = await users.count()
      expect(count).toBe(3)
      expect(count).toBe(list.length)
    })

    it('returns exactly the deactivated users when status: "deactivated" is requested explicitly', async () => {
      const active = await users.create(
        input({ username: 'status-active-2', primaryEmail: 'status-active-2@example.com' }),
      )
      await users.changeStatus(active.id, 'active')
      const deactivated = await users.create(
        input({
          username: 'status-deactivated-2',
          primaryEmail: 'status-deactivated-2@example.com',
        }),
      )
      await users.changeStatus(deactivated.id, 'active')
      await users.changeStatus(deactivated.id, 'deactivated')

      const list = await users.list({ limit: 50, offset: 0, status: 'deactivated' })
      expect(list.map((u) => u.id)).toEqual([deactivated.id])
      expect(list.map((u) => u.id)).not.toContain(active.id)

      const count = await users.count({ status: 'deactivated' })
      expect(count).toBe(1)
      expect(count).toBe(list.length)
    })
  })
})
