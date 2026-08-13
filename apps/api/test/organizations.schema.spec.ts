import { describe, expect, it } from 'vitest'
import { organizationStatus, organizations } from '../src/db/schema/organizations'
import { withTestDatabase } from './support/pg'

const ctx = withTestDatabase()

describe('organizations schema', () => {
  it('declares the organization_status vocabulary', () => {
    expect([...organizationStatus.enumValues].sort()).toEqual(['active', 'suspended'])
  })

  it('a valid organization can be inserted', async () => {
    const [org] = await ctx.db.insert(organizations).values({
      slug: 'test-org',
      name: 'Test Organization',
      realm: 'test-realm',
      status: 'active',
    }).returning()

    expect(org.id).toBeDefined()
    expect(org.slug).toBe('test-org')
    expect(org.name).toBe('Test Organization')
    expect(org.realm).toBe('test-realm')
    expect(org.status).toBe('active')
    expect(org.isMaster).toBe(false)
  })

  it('a malformed slug rejects with organizations_slug_format', async () => {
    await expect(
      ctx.db.insert(organizations).values({
        slug: 'INVALID_SLUG!',
        name: 'Bad Slug',
        realm: 'bad-realm',
      }),
    ).rejects.toThrow(/organizations_slug_format/)
  })

  it('a second master organization rejects with organizations_master_unique', async () => {
    // The organizations backfill migration (Task 2) already seeded exactly
    // one master row before this test runs, so a second `isMaster: true`
    // insert collides with THAT existing row — there is no "insert the
    // first one ourselves" step left to do.
    await expect(
      ctx.db.insert(organizations).values({
        slug: 'master-2',
        name: 'Second Master',
        realm: 'realm-2',
        isMaster: true,
      }),
    ).rejects.toThrow(/organizations_master_unique/)
  })

  it('a non-master organization with null realm rejects with organizations_realm_present', async () => {
    await expect(
      ctx.db.insert(organizations).values({
        slug: 'no-realm',
        name: 'No Realm Org',
        realm: null,
        isMaster: false,
      }),
    ).rejects.toThrow(/organizations_realm_present/)
  })

  it('multiple non-master organizations are permitted (proves master index is partial)', async () => {
    const [org1] = await ctx.db.insert(organizations).values({
      slug: 'org-a',
      name: 'Organization A',
      realm: 'realm-a',
      isMaster: false,
    }).returning()

    const [org2] = await ctx.db.insert(organizations).values({
      slug: 'org-b',
      name: 'Organization B',
      realm: 'realm-b',
      isMaster: false,
    }).returning()

    expect(org1.id).toBeDefined()
    expect(org2.id).toBeDefined()
    expect(org1.id).not.toEqual(org2.id)
  })

  it('duplicate slug rejects with organizations_slug_unique', async () => {
    await ctx.db.insert(organizations).values({
      slug: 'duplicate-test',
      name: 'First Duplicate',
      realm: 'realm-dup-1',
    })

    // Try to insert same slug again
    await expect(
      ctx.db.insert(organizations).values({
        slug: 'duplicate-test',
        name: 'Second Duplicate',
        realm: 'realm-dup-2',
      }),
    ).rejects.toThrow(/organizations_slug_unique/)
  })
})
