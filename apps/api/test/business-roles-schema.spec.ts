import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
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
