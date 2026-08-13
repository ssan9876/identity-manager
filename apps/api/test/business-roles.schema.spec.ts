import { eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { describe, expect, it } from 'vitest'
import {
  businessRoleConditionOperator,
  businessRoleExceptionMode,
  businessRoleGrantKind,
  businessRoles,
} from '../src/db/schema/business-roles'
import { connectorTargets } from '../src/db/schema/connector-targets'
import { grantSource } from '../src/db/schema/grant-source'
import * as schema from '../src/db/schema/index'
import { organizations } from '../src/db/schema/organizations'
import { orgUnits } from '../src/db/schema/org-units'
import { provisioningMode, userTargetAccounts } from '../src/db/schema/user-target-accounts'
import { users } from '../src/db/schema/users'
import { withTestDatabase } from './support/pg'

const ctx = withTestDatabase()

let fixtureSeq = 0

// This suite inserts directly via `db.insert(...)`, bypassing
// OrgUnitsRepository/UsersRepository (and therefore their organization_id
// derivation) entirely — so, like every other raw-insert test fixture, it
// resolves master itself. There is only ever one organization in Phase 1.
async function masterOrganizationId(db: NodePgDatabase<typeof schema>): Promise<string> {
  const [master] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.isMaster, true))
  if (master === undefined) {
    throw new Error('no master organization exists')
  }
  return master.id
}

async function insertUser(
  db: NodePgDatabase<typeof schema>,
  overrides: { username?: string; jobTitle?: string | null; location?: string | null } = {},
): Promise<string> {
  fixtureSeq += 1
  const organizationId = await masterOrganizationId(db)
  const [unit] = await db
    .insert(orgUnits)
    .values({ name: `Unit ${fixtureSeq}`, path: `root${fixtureSeq}`, organizationId })
    .returning()

  const username = overrides.username ?? `fixture${fixtureSeq}`
  const [user] = await db
    .insert(users)
    .values({
      status: 'active',
      primaryEmail: `${username}@example.com`,
      username,
      firstName: 'Fixture',
      lastName: `User ${fixtureSeq}`,
      displayName: `Fixture User ${fixtureSeq}`,
      jobTitle: overrides.jobTitle ?? null,
      location: overrides.location ?? null,
      orgUnitId: unit.id,
      organizationId,
    })
    .returning()

  return user.id
}

describe('grant provenance (Milestone 15, Task 1)', () => {
  it('grant_source carries exactly two values', () => {
    expect([...grantSource.enumValues].sort()).toEqual(['business_role', 'manual'])
  })

  it('group_user_members.grant_source is NOT NULL and defaults to manual, so pre-existing rows backfill safely', async () => {
    const rows = await ctx.db.execute(sql`
      SELECT is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'group_user_members' AND column_name = 'grant_source'
    `)

    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]).toMatchObject({ is_nullable: 'NO' })
    expect(String(rows.rows[0].column_default)).toContain('manual')
  })

  it('granted_at is NOT NULL and granted_by is nullable', async () => {
    const rows = await ctx.db.execute(sql`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'group_user_members' AND column_name IN ('granted_by', 'granted_at')
      ORDER BY column_name
    `)

    expect(rows.rows).toEqual([
      { column_name: 'granted_at', is_nullable: 'NO' },
      { column_name: 'granted_by', is_nullable: 'YES' },
    ])
  })
})

describe('business role tables (Milestone 15, Task 2)', () => {
  it('declares the closed operator, grant-kind and exception-mode vocabularies', () => {
    expect([...businessRoleConditionOperator.enumValues].sort()).toEqual([
      'equals',
      'in',
      'in_org_subtree',
      'not_equals',
    ])
    expect([...businessRoleGrantKind.enumValues].sort()).toEqual(['group_membership', 'target_account'])
    expect([...businessRoleExceptionMode.enumValues].sort()).toEqual(['exclude', 'include'])
  })

  it('a new role is disabled, undrafted and unsimulated', async () => {
    const [role] = await ctx.db
      .insert(businessRoles)
      // organization_id is NOT NULL since Task 5 of the organizations
      // milestone, and this raw insert bypasses BusinessRolesRepository.create
      // (which derives master itself), so the fixture supplies it.
      .values({ name: 'Sales AE', organizationId: await masterOrganizationId(ctx.db) })
      .returning()

    expect(role.enabled).toBe(false)
    expect(role.draftDefinition).toBeNull()
    expect(role.simulatedAt).toBeNull()
    expect(role.simulatedDraftHash).toBeNull()
  })

  it('a grant must set exactly one of group_id / target, matching its kind', async () => {
    const [role] = await ctx.db
      .insert(businessRoles)
      // organization_id is NOT NULL since Task 5 of the organizations
      // milestone, and this raw insert bypasses BusinessRolesRepository.create
      // (which derives master itself), so the fixture supplies it.
      .values({ name: 'Check constraint', organizationId: await masterOrganizationId(ctx.db) })
      .returning()

    // group_membership with no group_id
    await expect(
      ctx.db.execute(sql`
        INSERT INTO business_role_grants (business_role_id, kind, group_id, target)
        VALUES (${role.id}, 'group_membership', NULL, NULL)
      `),
    ).rejects.toThrow(/business_role_grants_kind_matches_reference/)

    // group_membership carrying a target as well
    await expect(
      ctx.db.execute(sql`
        INSERT INTO business_role_grants (business_role_id, kind, group_id, target)
        VALUES (${role.id}, 'target_account', NULL, 'keycloak'), (${role.id}, 'group_membership', NULL, 'keycloak')
      `),
    ).rejects.toThrow(/business_role_grants_kind_matches_reference/)
  })

  it('an exception requires a reason', async () => {
    const [role] = await ctx.db
      .insert(businessRoles)
      // organization_id is NOT NULL since Task 5 of the organizations
      // milestone, and this raw insert bypasses BusinessRolesRepository.create
      // (which derives master itself), so the fixture supplies it.
      .values({ name: 'Reason required', organizationId: await masterOrganizationId(ctx.db) })
      .returning()

    await expect(
      ctx.db.execute(sql`
        INSERT INTO business_role_exceptions (business_role_id, user_id, mode, reason)
        VALUES (${role.id}, gen_random_uuid(), 'include', NULL)
      `),
    ).rejects.toThrow()
  })
})

describe('target-account entitlement (Milestone 15, Task 3)', () => {
  it('provisioning_mode carries exactly two values', () => {
    expect([...provisioningMode.enumValues].sort()).toEqual(['all_users', 'entitled_only'])
  })

  it('every existing connector target migrates to all_users, so behaviour is unchanged on the day this ships', async () => {
    const rows = await ctx.db.execute(sql`
      SELECT is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'connector_targets' AND column_name = 'provisioning_mode'
    `)

    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]).toMatchObject({ is_nullable: 'NO' })
    expect(String(rows.rows[0].column_default)).toContain('all_users')

    // And the seeded keycloak row really did land on all_users, not merely
    // that the column *could* default — the regression this guards is a
    // silent directory-wide provisioning stop.
    const seeded = await ctx.db.select().from(connectorTargets)
    for (const row of seeded) {
      expect(row.provisioningMode).toBe('all_users')
    }
  })

  it('a user has at most one account entitlement per target', async () => {
    const userId = await insertUser(ctx.db, { username: 'dupe-check' })

    await ctx.db.insert(userTargetAccounts).values({ userId, target: 'keycloak', grantSource: 'business_role' })

    await expect(
      ctx.db.insert(userTargetAccounts).values({ userId, target: 'keycloak', grantSource: 'manual' }),
    ).rejects.toThrow(/user_target_accounts_unique/)
  })
})
