import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  businessRoleConditionOperator,
  businessRoleExceptionMode,
  businessRoleGrantKind,
  businessRoles,
} from '../src/db/schema/business-roles'
import { grantSource } from '../src/db/schema/grant-source'
import { withTestDatabase } from './support/pg'

const ctx = withTestDatabase()

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
    const [role] = await ctx.db.insert(businessRoles).values({ name: 'Sales AE' }).returning()

    expect(role.enabled).toBe(false)
    expect(role.draftDefinition).toBeNull()
    expect(role.simulatedAt).toBeNull()
    expect(role.simulatedDraftHash).toBeNull()
  })

  it('a grant must set exactly one of group_id / target, matching its kind', async () => {
    const [role] = await ctx.db.insert(businessRoles).values({ name: 'Check constraint' }).returning()

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
    const [role] = await ctx.db.insert(businessRoles).values({ name: 'Reason required' }).returning()

    await expect(
      ctx.db.execute(sql`
        INSERT INTO business_role_exceptions (business_role_id, user_id, mode, reason)
        VALUES (${role.id}, gen_random_uuid(), 'include', NULL)
      `),
    ).rejects.toThrow()
  })
})
