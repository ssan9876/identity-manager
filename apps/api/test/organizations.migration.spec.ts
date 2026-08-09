import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { startMigrationHarness } from './support/migration-harness'

describe('organizations backfill migration', () => {
  it('adopts every pre-existing root, user and group into master', async () => {
    const { db, migrateTo } = await startMigrationHarness()

    await migrateTo('0021') // the last pre-organizations migration
    await db.execute(sql`
      INSERT INTO org_units (name, parent_id, path) VALUES
        ('Acme', NULL, 'acme'), ('Globex', NULL, 'globex'), ('Sales', NULL, 'acme.sales')
    `)

    const before = await db.execute(sql`SELECT path FROM org_units ORDER BY path`)

    await migrateTo('latest')

    const master = await db.execute(
      sql`SELECT id, slug, realm, is_master FROM organizations WHERE is_master`,
    )
    expect(master.rows).toHaveLength(1)
    expect(master.rows[0]).toMatchObject({ slug: 'master', realm: null, is_master: true })

    const after = await db.execute(sql`SELECT path FROM org_units ORDER BY path`)
    expect(after.rows).toEqual(before.rows) // no ltree path was rewritten

    const orphans = await db.execute(sql`SELECT count(*)::int AS n FROM org_units WHERE organization_id IS NULL`)
    expect(orphans.rows[0]).toEqual({ n: 0 })

    const adopted = await db.execute(
      sql`SELECT ou.name FROM org_units ou JOIN organizations o ON o.id = ou.organization_id WHERE o.is_master ORDER BY ou.name`,
    )
    expect(adopted.rows).toEqual([{ name: 'Acme' }, { name: 'Globex' }, { name: 'Sales' }])
  })

  it('rejects an org unit with no organization, naming the FK it violates', async () => {
    const { db, migrateTo } = await startMigrationHarness()

    await migrateTo('latest')

    await expect(
      db.execute(sql`
        INSERT INTO org_units (name, parent_id, path, organization_id)
        VALUES ('Orphan', NULL, 'orphan', NULL)
      `),
    ).rejects.toThrow(/null value in column "organization_id"/)

    const master = await db.execute(sql`SELECT id FROM organizations WHERE is_master`)
    await expect(
      db.execute(sql`
        INSERT INTO org_units (name, parent_id, path, organization_id)
        VALUES ('Not Orphan', NULL, 'not_orphan', ${master.rows[0]!.id})
      `),
    ).resolves.toBeDefined()

    await expect(
      db.execute(sql`
        INSERT INTO org_units (name, parent_id, path, organization_id)
        VALUES ('Bad Fk', NULL, 'bad_fk', '00000000-0000-0000-0000-000000000000')
      `),
    ).rejects.toThrow(/org_units_organization_id_organizations_id_fk/)
  })
})
