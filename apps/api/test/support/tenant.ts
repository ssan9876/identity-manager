import { randomUUID } from 'node:crypto'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../src/db/schema/index'
import { organizations } from '../../src/db/schema/organizations'
import { OrgUnitsRepository } from '../../src/org-units/org-units.repository'
import { UsersRepository } from '../../src/users/users.repository'

export interface TenantFixture {
  organizationId: string
  orgUnitId: string
  userId: string
  username: string
}

/**
 * A second, NON-master organization with its own root org unit and its own
 * ACTIVE user — the fixture every "does this lookup stay inside one tenant"
 * assertion needs.
 *
 * `users_username_unique` is `(organization_id, lower(username))` (see
 * db/schema/users.ts, migration 0028), so the SAME username may legitimately
 * exist here and in master at once. That is the whole point: a lookup
 * matching on `lower(username)` alone has two candidate rows and no stated
 * preference between them.
 *
 * The `organizations` row is inserted DIRECTLY rather than through
 * `OrganizationsRepository.create` only because that method requires a live
 * `DbHandle` (an open transaction, deliberately not the pooled handle). The
 * org unit and the user go through their real repositories, so
 * `organization_id` is derived exactly the way production derives it
 * (`OrgUnitsRepository.createRoot`'s explicit organization argument, then
 * `UsersRepository.create`'s derivation from the org unit) rather than being
 * asserted into place by the fixture.
 *
 * The user is ACTIVE on purpose: a non-active tenant row would make
 * `PermissionEngine.resolveActor` reject for the WRONG reason (its status
 * allowlist) and hide whether the organization predicate does anything.
 *
 * Every name is per-call unique — `organizations_slug_unique` and
 * `org_units_path_unique` are global, and no spec truncates `organizations`
 * between tests, so a fixed slug would collide with itself.
 */
export async function seedTenant(
  db: NodePgDatabase<typeof schema>,
  input: { username: string },
): Promise<TenantFixture> {
  const discriminator = randomUUID().slice(0, 8)
  const slug = `tenant-${discriminator}`

  const [organization] = await db
    .insert(organizations)
    .values({ slug, name: `Tenant ${discriminator}`, realm: `${slug}-realm` })
    .returning()

  const orgUnits = new OrgUnitsRepository(db)
  const users = new UsersRepository(db)

  // `createRoot`'s third parameter is the only way to build a root outside
  // master; omitting it falls back to master (see its doc comment).
  const orgUnit = await orgUnits.createRoot(`Tenant_${discriminator}`, db, organization.id)

  const created = await users.create({
    // Usernames in this system are often themselves email addresses, so the
    // local part is taken rather than the whole thing — otherwise a username
    // of `admin@example.com` would produce `admin@example.com@…`.
    primaryEmail: `${input.username.split('@')[0]}@${slug}.example`,
    username: input.username,
    firstName: 'Tenant',
    lastName: 'Person',
    orgUnitId: orgUnit.id,
  })
  const user = await users.changeStatus(created.id, 'active')

  return {
    organizationId: organization.id,
    orgUnitId: orgUnit.id,
    userId: user.id,
    username: user.username,
  }
}
