import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { ConnectorTarget } from '../src/connectors/connector'
import { orgUnits } from '../src/db/schema/org-units'
import { userTargetAccounts } from '../src/db/schema/user-target-accounts'
import { users } from '../src/db/schema/users'
import { groups } from '../src/db/schema/groups'
import { OrganizationsRepository } from '../src/organizations/organizations.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { type TestDatabase, withTestDatabase } from './support/pg'

/**
 * MILESTONE 18 — the sync half of business roles: what an ENTITLEMENT
 * actually causes to happen in a target.
 *
 * Task 13 (fan-out), Task 14 (losing an entitlement disables) and Task 15
 * (target reconciliation respects the mode) are three views of one property:
 * a target in `entitled_only` mode provisions exactly the people some
 * business role granted it to, and actively DISABLES everyone else it has an
 * account for — never silently drops them, which is how orphaned accounts
 * are made.
 *
 * The safety property this whole file exists around: `all_users` is the
 * DEFAULT mode and reproduces the pre-business-roles behaviour exactly.
 * test/outbox-emission.spec.ts is the pre-existing regression net for that
 * claim and passes UNMODIFIED alongside this file.
 */

const ctx = withTestDatabase()

function writer(): OutboxWriter {
  return new OutboxWriter()
}

/**
 * The `master` organization the organizations backfill migration creates.
 * `organization_id` is NOT NULL on org_units/users/groups and the fixtures
 * below seed through raw inserts rather than the repositories that resolve it
 * themselves, so they have to supply it — same note as business-roles.spec.ts's
 * own `masterOrgId`.
 */
async function masterOrgId(ctx: TestDatabase): Promise<string> {
  const master = await new OrganizationsRepository(ctx.db).findMaster()
  return master.id
}

/**
 * `withTestDatabase()` starts ONE container per test FILE and never truncates
 * between `it` blocks, so every fixture below carries a per-call `seq`
 * discriminator. Without one, a user seeded by an earlier test satisfies a
 * later test's role condition (or vice versa) and the counts silently stop
 * meaning what they say — the same trap business-roles.spec.ts's own fixtures
 * document at length.
 */
let seq = 0

async function insertUser(options: { jobTitle?: string; status?: 'active' | 'deactivated' } = {}): Promise<string> {
  seq += 1
  const n = seq
  const organizationId = await masterOrgId(ctx)
  const [unit] = await ctx.db
    .insert(orgUnits)
    .values({ name: `BR Sync Unit ${n}`, path: `br_sync_root_${n}`, organizationId })
    .returning()
  const [user] = await ctx.db
    .insert(users)
    .values({
      status: options.status ?? 'active',
      organizationId,
      primaryEmail: `br-sync-${n}@example.com`,
      username: `br-sync-${n}`,
      firstName: 'Sync',
      lastName: `User ${n}`,
      displayName: `Sync User ${n}`,
      jobTitle: options.jobTitle ?? null,
      orgUnitId: unit!.id,
    })
    .returning()
  return user!.id
}

async function insertGroup(): Promise<string> {
  seq += 1
  const organizationId = await masterOrgId(ctx)
  const [group] = await ctx.db.insert(groups).values({ name: `BR Sync Group ${seq}`, organizationId }).returning()
  return group!.id
}

type ProvisioningMode = 'all_users' | 'entitled_only'

/**
 * `connector_targets` is a GLOBAL, single-row-per-target catalog that the
 * migrations seed (`keycloak`, enabled, `all_users`) and that nothing
 * truncates between `it` blocks. So every test declares the WHOLE catalog it
 * wants rather than only the row it cares about: everything is disabled
 * first, then exactly the listed targets are enabled in the listed mode. A
 * test that only enabled its own target would still see whatever the
 * previous test left behind.
 */
async function configureTargets(spec: Partial<Record<ConnectorTarget, ProvisioningMode>>): Promise<void> {
  await ctx.pool.query('UPDATE connector_targets SET enabled = false')
  for (const [target, mode] of Object.entries(spec)) {
    await ctx.pool.query(
      `INSERT INTO connector_targets (target, enabled, provisioning_mode, config)
         VALUES ($1, true, $2, $3::jsonb)
       ON CONFLICT (target) DO UPDATE
         SET enabled = true, provisioning_mode = EXCLUDED.provisioning_mode, config = EXCLUDED.config`,
      [target, mode, JSON.stringify(target === 'echo' ? { credentialSecretName: 'ECHO_TEST_SECRET' } : {})],
    )
  }
}

/** Every target an outbox row was written for, for this aggregate, in insertion order. */
async function outboxTargetsForAggregate(aggregateId: string): Promise<string[]> {
  const { rows } = await ctx.pool.query<{ target: string }>(
    'SELECT target FROM outbox_events WHERE aggregate_id = $1 ORDER BY id',
    [aggregateId],
  )
  return rows.map((row) => row.target)
}

const outboxTargetsFor = outboxTargetsForAggregate

async function outboxEventsFor(aggregateId: string): Promise<{ eventType: string; target: string }[]> {
  const { rows } = await ctx.pool.query<{ event_type: string; target: string }>(
    'SELECT event_type, target FROM outbox_events WHERE aggregate_id = $1 ORDER BY id',
    [aggregateId],
  )
  return rows.map((row) => ({ eventType: row.event_type, target: row.target }))
}

// ---------------------------------------------------------------------------
// Task 13 — fan out by entitlement, per target, opt-in
// ---------------------------------------------------------------------------

describe('entitlement-driven fan-out (Milestone 18, Task 13)', () => {
  const userEvent = (userId: string) =>
    ({ aggregateType: 'user', aggregateId: userId, eventType: 'updated', payload: {} }) as const

  it('an all_users target still receives a row for every user — behaviour is unchanged by default', async () => {
    const userId = await insertUser()
    await configureTargets({ keycloak: 'all_users' })

    await ctx.db.transaction((tx) => writer().record(tx, userEvent(userId)))

    expect(await outboxTargetsFor(userId)).toEqual(['keycloak'])
  })

  it('an entitled_only target receives NOTHING for a user with no account entitlement', async () => {
    const userId = await insertUser()
    await configureTargets({ keycloak: 'entitled_only' })

    await ctx.db.transaction((tx) => writer().record(tx, userEvent(userId)))

    expect(await outboxTargetsFor(userId)).toEqual([])
  })

  it('an entitled_only target receives a row once the user holds the entitlement', async () => {
    const userId = await insertUser()
    await configureTargets({ keycloak: 'entitled_only' })
    await ctx.db.insert(userTargetAccounts).values({ userId, target: 'keycloak', grantSource: 'business_role' })

    await ctx.db.transaction((tx) => writer().record(tx, userEvent(userId)))

    expect(await outboxTargetsFor(userId)).toEqual(['keycloak'])
  })

  it('mixes modes correctly across targets in one write', async () => {
    const userId = await insertUser()
    await configureTargets({ keycloak: 'all_users', echo: 'entitled_only' })

    await ctx.db.transaction((tx) => writer().record(tx, userEvent(userId)))

    // `echo` is enabled and would have received a row before this task; it is
    // dropped purely because this user holds no entitlement for it, while the
    // `all_users` target beside it is untouched by the filter.
    expect(await outboxTargetsFor(userId)).toEqual(['keycloak'])
  })

  it('an entitlement for one target does not leak to another entitled_only target', async () => {
    const userId = await insertUser()
    await configureTargets({ keycloak: 'entitled_only', echo: 'entitled_only' })
    await ctx.db.insert(userTargetAccounts).values({ userId, target: 'echo', grantSource: 'business_role' })

    await ctx.db.transaction((tx) => writer().record(tx, userEvent(userId)))

    expect(await outboxTargetsFor(userId)).toEqual(['echo'])
  })

  it('a non-user aggregate is unaffected by entitlement state', async () => {
    // Group events have no user to look up; an entitled_only target must not
    // silently stop receiving group syncs just because a group can never hold
    // a `user_target_accounts` row.
    const groupId = await insertGroup()
    await configureTargets({ keycloak: 'entitled_only' })

    await ctx.db.transaction((tx) =>
      writer().record(tx, {
        aggregateType: 'group',
        aggregateId: groupId,
        eventType: 'updated',
        payload: {},
      }),
    )

    expect(await outboxTargetsForAggregate(groupId)).toEqual(['keycloak'])
  })
})
