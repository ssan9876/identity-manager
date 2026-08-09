import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { groups } from '../src/db/schema/groups'
import { orgUnits } from '../src/db/schema/org-units'
import { organizations } from '../src/db/schema/organizations'
import { users } from '../src/db/schema/users'
import { withTestDatabase } from './support/pg'

const ctx = withTestDatabase()

/**
 * Milestone: organizations multi-tenancy, Task 3 (per-organization
 * uniqueness).
 *
 * Everything here inserts DIRECTLY with Drizzle, bypassing every repository
 * on purpose: the assertion under test is about the unique INDEXES, not
 * about any application-level pre-check. A repository that happened to
 * reject the duplicate itself would make a passing test prove nothing about
 * what a second API instance, a CSV import, or a connector write would do.
 * (The plan's standing constraint after Task 1: Tasks 2-5 and 10 require
 * real-database assertions, not typecheck-only ones.)
 *
 * `withTestDatabase()` starts ONE container per test FILE and never
 * truncates between `it` blocks, so every fixture below takes a per-call
 * unique discriminator — otherwise the second test would collide with the
 * first test's rows and pass or fail for the wrong reason.
 */
function unique(): string {
  return randomUUID().slice(0, 8)
}

/**
 * A real, non-master organization. `realm` is mandatory for non-master rows
 * (`organizations_realm_present`, Task 1) and `slug` must be lowercase
 * (`organizations_slug_format`), so both are derived from the discriminator.
 */
async function createOrganizationRow(slug: string) {
  const [org] = await ctx.db
    .insert(organizations)
    .values({ slug, name: slug, realm: `${slug}-realm` })
    .returning()
  return org
}

/** Users are NOT NULL on `org_unit_id`, so every user fixture needs one of these. */
async function insertOrgUnit(input: { organizationId: string; path: string }) {
  const [unit] = await ctx.db
    .insert(orgUnits)
    .values({
      name: input.path,
      path: sql`${input.path}::ltree`,
      organizationId: input.organizationId,
    })
    .returning()
  return unit
}

async function insertUser(input: {
  organizationId: string
  orgUnitId: string
  username: string
  primaryEmail?: string
  employeeId?: string
}) {
  const [user] = await ctx.db
    .insert(users)
    .values({
      organizationId: input.organizationId,
      orgUnitId: input.orgUnitId,
      username: input.username,
      primaryEmail: input.primaryEmail ?? `${input.username}-${unique()}@example.test`,
      firstName: 'Test',
      lastName: 'User',
      displayName: input.username,
      employeeId: input.employeeId ?? null,
    })
    .returning()
  return user
}

async function insertGroup(input: { organizationId: string; name: string }) {
  const [group] = await ctx.db
    .insert(groups)
    .values({ organizationId: input.organizationId, name: input.name, orgUnitId: null })
    .returning()
  return group
}

describe('per-organization uniqueness', () => {
  it('permits the same username in two organizations and forbids it twice in one', async () => {
    const d = unique()
    const acme = await createOrganizationRow(`acme-${d}`)
    const globex = await createOrganizationRow(`globex-${d}`)
    const acmeUnit = await insertOrgUnit({ organizationId: acme.id, path: `acme_${d}` })
    const globexUnit = await insertOrgUnit({ organizationId: globex.id, path: `globex_${d}` })

    await expect(
      insertUser({ organizationId: acme.id, orgUnitId: acmeUnit.id, username: `jsmith${d}` }),
    ).resolves.toBeDefined()
    await expect(
      insertUser({ organizationId: globex.id, orgUnitId: globexUnit.id, username: `jsmith${d}` }),
    ).resolves.toBeDefined()
    // Case-insensitivity must still hold WITHIN an organization: the index is
    // (organization_id, lower(username)), not (organization_id, username).
    await expect(
      insertUser({ organizationId: acme.id, orgUnitId: acmeUnit.id, username: `JSmith${d}` }),
    ).rejects.toThrow(/users_username_unique/)
  })

  it('permits the same primary email in two organizations and forbids it twice in one', async () => {
    const d = unique()
    const acme = await createOrganizationRow(`acme-mail-${d}`)
    const globex = await createOrganizationRow(`globex-mail-${d}`)
    const acmeUnit = await insertOrgUnit({ organizationId: acme.id, path: `acme_mail_${d}` })
    const globexUnit = await insertOrgUnit({ organizationId: globex.id, path: `globex_mail_${d}` })
    const email = `shared-${d}@example.test`

    await expect(
      insertUser({
        organizationId: acme.id,
        orgUnitId: acmeUnit.id,
        username: `a1${d}`,
        primaryEmail: email,
      }),
    ).resolves.toBeDefined()
    await expect(
      insertUser({
        organizationId: globex.id,
        orgUnitId: globexUnit.id,
        username: `g1${d}`,
        primaryEmail: email,
      }),
    ).resolves.toBeDefined()
    await expect(
      insertUser({
        organizationId: acme.id,
        orgUnitId: acmeUnit.id,
        username: `a2${d}`,
        primaryEmail: email.toUpperCase(),
      }),
    ).rejects.toThrow(/users_primary_email_unique/)
  })

  it('permits the same employee id in two organizations and forbids it twice in one', async () => {
    const d = unique()
    const acme = await createOrganizationRow(`acme-emp-${d}`)
    const globex = await createOrganizationRow(`globex-emp-${d}`)
    const acmeUnit = await insertOrgUnit({ organizationId: acme.id, path: `acme_emp_${d}` })
    const globexUnit = await insertOrgUnit({ organizationId: globex.id, path: `globex_emp_${d}` })
    const employeeId = `E-${d}`

    await expect(
      insertUser({ organizationId: acme.id, orgUnitId: acmeUnit.id, username: `ae1${d}`, employeeId }),
    ).resolves.toBeDefined()
    await expect(
      insertUser({ organizationId: globex.id, orgUnitId: globexUnit.id, username: `ge1${d}`, employeeId }),
    ).resolves.toBeDefined()
    await expect(
      insertUser({ organizationId: acme.id, orgUnitId: acmeUnit.id, username: `ae2${d}`, employeeId }),
    ).rejects.toThrow(/users_employee_id_unique/)
  })

  it('keeps employee_id uniqueness partial — many NULLs per organization', async () => {
    const d = unique()
    const acme = await createOrganizationRow(`acme-null-${d}`)
    const acmeUnit = await insertOrgUnit({ organizationId: acme.id, path: `acme_null_${d}` })

    await expect(
      insertUser({ organizationId: acme.id, orgUnitId: acmeUnit.id, username: `n1${d}` }),
    ).resolves.toBeDefined()
    await expect(
      insertUser({ organizationId: acme.id, orgUnitId: acmeUnit.id, username: `n2${d}` }),
    ).resolves.toBeDefined()
  })

  it('permits the same group name in two organizations and forbids it twice in one', async () => {
    const d = unique()
    const acme = await createOrganizationRow(`acme-grp-${d}`)
    const globex = await createOrganizationRow(`globex-grp-${d}`)

    await expect(insertGroup({ organizationId: acme.id, name: `engineers-${d}` })).resolves.toBeDefined()
    await expect(insertGroup({ organizationId: globex.id, name: `engineers-${d}` })).resolves.toBeDefined()
    await expect(
      insertGroup({ organizationId: acme.id, name: `Engineers-${d}` }),
    ).rejects.toThrow(/groups_name_unique/)
  })
})
