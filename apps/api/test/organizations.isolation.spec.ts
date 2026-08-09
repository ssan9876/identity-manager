import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { ConflictError } from '../src/common/errors'
import { GroupsRepository } from '../src/groups/groups.repository'
import { UsersRepository } from '../src/users/users.repository'
import { groupGroupMembers, groupUserMembers } from '../src/db/schema/group-members'
import { groups } from '../src/db/schema/groups'
import { orgUnits } from '../src/db/schema/org-units'
import { organizations } from '../src/db/schema/organizations'
import { users } from '../src/db/schema/users'
import { withTestDatabase } from './support/pg'

const ctx = withTestDatabase()

/**
 * Milestone: organizations multi-tenancy, Task 4 (cross-tenant references
 * made impossible).
 *
 * Every insert below goes DIRECTLY through Drizzle, bypassing every
 * repository, guard and scope filter. That is the entire point: the claim
 * under test is that the DATABASE refuses a cross-tenant reference, not that
 * some application code path happened to catch it. Application checks are
 * bypassable by a CSV import, a connector write-back, a reconciler, a future
 * endpoint, or a plain bug; a composite foreign key is not.
 *
 * `withTestDatabase()` starts ONE container per test FILE and never
 * truncates between `it` blocks, so every fixture takes a per-call unique
 * discriminator.
 */
function unique(): string {
  return randomUUID().slice(0, 8)
}

async function createOrganizationRow(slug: string) {
  const [org] = await ctx.db
    .insert(organizations)
    .values({ slug, name: slug, realm: `${slug}-realm` })
    .returning()
  return org
}

async function insertOrgUnit(input: {
  organizationId: string
  path: string
  parentId?: string
}) {
  const [unit] = await ctx.db
    .insert(orgUnits)
    .values({
      name: input.path,
      path: sql`${input.path}::ltree`,
      organizationId: input.organizationId,
      parentId: input.parentId ?? null,
    })
    .returning()
  return unit
}

async function insertUser(input: {
  organizationId: string
  orgUnitId: string
  username: string
  managerId?: string
}) {
  const [user] = await ctx.db
    .insert(users)
    .values({
      organizationId: input.organizationId,
      orgUnitId: input.orgUnitId,
      username: input.username,
      primaryEmail: `${input.username}@example.test`,
      firstName: 'Test',
      lastName: 'User',
      displayName: input.username,
      managerId: input.managerId ?? null,
    })
    .returning()
  return user
}

async function insertGroup(input: {
  organizationId: string
  name: string
  orgUnitId?: string | null
}) {
  const [group] = await ctx.db
    .insert(groups)
    .values({
      organizationId: input.organizationId,
      name: input.name,
      orgUnitId: input.orgUnitId ?? null,
    })
    .returning()
  return group
}

describe('cross-tenant references are impossible', () => {
  it('rejects a user in one organization pointing at another organization org unit', async () => {
    const d = unique()
    const acme = await createOrganizationRow(`acme-ou-${d}`)
    const globex = await createOrganizationRow(`globex-ou-${d}`)
    const globexUnit = await insertOrgUnit({ organizationId: globex.id, path: `globex_ou_${d}` })

    await expect(
      insertUser({
        organizationId: acme.id,
        orgUnitId: globexUnit.id,
        username: `mallory${d}`,
      }),
    ).rejects.toThrow(/users_org_unit_organization_fk/)
  })

  it('rejects a manager in a different organization', async () => {
    const d = unique()
    const acme = await createOrganizationRow(`acme-mgr-${d}`)
    const globex = await createOrganizationRow(`globex-mgr-${d}`)
    const acmeUnit = await insertOrgUnit({ organizationId: acme.id, path: `acme_mgr_${d}` })
    const globexUnit = await insertOrgUnit({ organizationId: globex.id, path: `globex_mgr_${d}` })
    const boss = await insertUser({
      organizationId: globex.id,
      orgUnitId: globexUnit.id,
      username: `boss${d}`,
    })

    await expect(
      insertUser({
        organizationId: acme.id,
        orgUnitId: acmeUnit.id,
        username: `report${d}`,
        managerId: boss.id,
      }),
    ).rejects.toThrow(/users_manager_organization_fk/)
  })

  it('still permits a manager inside the same organization', async () => {
    const d = unique()
    const acme = await createOrganizationRow(`acme-same-${d}`)
    const acmeUnit = await insertOrgUnit({ organizationId: acme.id, path: `acme_same_${d}` })
    const boss = await insertUser({
      organizationId: acme.id,
      orgUnitId: acmeUnit.id,
      username: `boss${d}`,
    })

    await expect(
      insertUser({
        organizationId: acme.id,
        orgUnitId: acmeUnit.id,
        username: `report${d}`,
        managerId: boss.id,
      }),
    ).resolves.toBeDefined()
  })

  it('deleting a manager nulls only manager_id, never the not-null organization_id', async () => {
    // The composite FK's referential action is `ON DELETE SET NULL
    // (manager_id)` — a COLUMN LIST, available since Postgres 15. Without
    // it Postgres would try to null organization_id too, and every manager
    // delete would fail with a not-null violation instead of orphaning the
    // report, which is the behaviour users_manager_id_users_id_fk has
    // always had. Many spec files do a blanket `DELETE FROM users` between
    // tests, so getting this wrong would break them in a way that looks
    // nothing like a tenancy bug.
    const d = unique()
    const acme = await createOrganizationRow(`acme-del-${d}`)
    const acmeUnit = await insertOrgUnit({ organizationId: acme.id, path: `acme_del_${d}` })
    const boss = await insertUser({
      organizationId: acme.id,
      orgUnitId: acmeUnit.id,
      username: `delboss${d}`,
    })
    const report = await insertUser({
      organizationId: acme.id,
      orgUnitId: acmeUnit.id,
      username: `delreport${d}`,
      managerId: boss.id,
    })

    await ctx.db.execute(sql`DELETE FROM users WHERE id = ${boss.id}::uuid`)

    const { rows } = await ctx.db.execute<{ manager_id: string | null; organization_id: string }>(
      sql`SELECT manager_id, organization_id FROM users WHERE id = ${report.id}::uuid`,
    )
    expect(rows[0]?.manager_id).toBeNull()
    expect(rows[0]?.organization_id).toBe(acme.id)
  })

  it('rejects a group pointing at another organization org unit', async () => {
    const d = unique()
    const acme = await createOrganizationRow(`acme-grp-${d}`)
    const globex = await createOrganizationRow(`globex-grp-${d}`)
    const globexUnit = await insertOrgUnit({ organizationId: globex.id, path: `globex_grp_${d}` })

    await expect(
      insertGroup({ organizationId: acme.id, name: `poached-${d}`, orgUnitId: globexUnit.id }),
    ).rejects.toThrow(/groups_org_unit_organization_fk/)
  })

  it('still permits a global group, which has no org unit at all', async () => {
    const d = unique()
    const acme = await createOrganizationRow(`acme-global-${d}`)
    await expect(
      insertGroup({ organizationId: acme.id, name: `everyone-${d}`, orgUnitId: null }),
    ).resolves.toBeDefined()
  })

  it('rejects an org unit parented under another organization org unit', async () => {
    const d = unique()
    const acme = await createOrganizationRow(`acme-par-${d}`)
    const globex = await createOrganizationRow(`globex-par-${d}`)
    const globexUnit = await insertOrgUnit({ organizationId: globex.id, path: `globex_par_${d}` })

    await expect(
      insertOrgUnit({
        organizationId: acme.id,
        path: `acme_par_${d}`,
        parentId: globexUnit.id,
      }),
    ).rejects.toThrow(/org_units_parent_organization_fk/)
  })

  it('rejects a membership edge joining one organization group to another organization user', async () => {
    const d = unique()
    const acme = await createOrganizationRow(`acme-mem-${d}`)
    const globex = await createOrganizationRow(`globex-mem-${d}`)
    const globexUnit = await insertOrgUnit({ organizationId: globex.id, path: `globex_mem_${d}` })
    const acmeGroup = await insertGroup({ organizationId: acme.id, name: `insiders-${d}` })
    const outsider = await insertUser({
      organizationId: globex.id,
      orgUnitId: globexUnit.id,
      username: `outsider${d}`,
    })

    // The edge carries its own organization_id, so there is no way to write
    // this row at all: pinned to acme it fails the USER side, pinned to
    // globex it fails the GROUP side. Both directions are asserted, because
    // only asserting one would leave the other as an open door.
    await expect(
      ctx.db.insert(groupUserMembers).values({
        groupId: acmeGroup.id,
        userId: outsider.id,
        organizationId: acme.id,
      }),
    ).rejects.toThrow(/gum_user_organization_fk/)

    await expect(
      ctx.db.insert(groupUserMembers).values({
        groupId: acmeGroup.id,
        userId: outsider.id,
        organizationId: globex.id,
      }),
    ).rejects.toThrow(/gum_group_organization_fk/)
  })

  it('rejects nesting one organization group under another organization group', async () => {
    const d = unique()
    const acme = await createOrganizationRow(`acme-nest-${d}`)
    const globex = await createOrganizationRow(`globex-nest-${d}`)
    const acmeGroup = await insertGroup({ organizationId: acme.id, name: `acme-parent-${d}` })
    const globexGroup = await insertGroup({ organizationId: globex.id, name: `globex-child-${d}` })

    await expect(
      ctx.db.insert(groupGroupMembers).values({
        parentGroupId: acmeGroup.id,
        childGroupId: globexGroup.id,
        organizationId: acme.id,
      }),
    ).rejects.toThrow(/ggm_child_organization_fk/)

    await expect(
      ctx.db.insert(groupGroupMembers).values({
        parentGroupId: acmeGroup.id,
        childGroupId: globexGroup.id,
        organizationId: globex.id,
      }),
    ).rejects.toThrow(/ggm_parent_organization_fk/)
  })

  it('still permits membership and nesting inside one organization', async () => {
    const d = unique()
    const acme = await createOrganizationRow(`acme-ok-${d}`)
    const acmeUnit = await insertOrgUnit({ organizationId: acme.id, path: `acme_ok_${d}` })
    const parent = await insertGroup({ organizationId: acme.id, name: `ok-parent-${d}` })
    const child = await insertGroup({ organizationId: acme.id, name: `ok-child-${d}` })
    const member = await insertUser({
      organizationId: acme.id,
      orgUnitId: acmeUnit.id,
      username: `okuser${d}`,
    })

    await expect(
      ctx.db.insert(groupUserMembers).values({
        groupId: parent.id,
        userId: member.id,
        organizationId: acme.id,
      }),
    ).resolves.toBeDefined()
    await expect(
      ctx.db.insert(groupGroupMembers).values({
        parentGroupId: parent.id,
        childGroupId: child.id,
        organizationId: acme.id,
      }),
    ).resolves.toBeDefined()
  })
})

/**
 * Organizations milestone, Task 12 — the composite foreign keys asserted
 * above now have HTTP-shaped answers.
 *
 * Everything above deliberately bypasses the repositories to prove the
 * DATABASE refuses a cross-tenant reference. This block does the opposite,
 * and for the complementary reason: a refusal that reaches the caller as an
 * untranslated SQLSTATE 23503 becomes a bodyless 500, indistinguishable from
 * a crash, on a request that was refused for a perfectly comprehensible
 * reason. These two blocks together are the whole claim — the constraint
 * holds, AND the caller is told why.
 */
describe('a cross-tenant reference reaches the caller as a conflict', () => {
  it('translates a cross-tenant manager to a ConflictError, not a raw 23503', async () => {
    const d = unique()
    const acme = await createOrganizationRow(`acme-mgr-x-${d}`)
    const globex = await createOrganizationRow(`globex-mgr-x-${d}`)
    const acmeUnit = await insertOrgUnit({ organizationId: acme.id, path: `acme_mgr_x_${d}` })
    const globexUnit = await insertOrgUnit({ organizationId: globex.id, path: `globex_mgr_x_${d}` })
    const boss = await insertUser({
      organizationId: globex.id,
      orgUnitId: globexUnit.id,
      username: `boss-mgr-x-${d}`,
    })

    await expect(
      new UsersRepository(ctx.db).create({
        primaryEmail: `report-mgr-x-${d}@example.test`,
        username: `report-mgr-x-${d}`,
        firstName: 'Test',
        lastName: 'User',
        orgUnitId: acmeUnit.id,
        managerId: boss.id,
      }),
    ).rejects.toThrow(ConflictError)
  })

  it('still answers 404-shaped NotFound for a manager that simply does not exist', async () => {
    // The single-column FK must keep winning over the composite one: both
    // report SQLSTATE 23503 and differ only by constraint name.
    const d = unique()
    const acme = await createOrganizationRow(`acme-mgr-404-${d}`)
    const acmeUnit = await insertOrgUnit({ organizationId: acme.id, path: `acme_mgr_404_${d}` })

    await expect(
      new UsersRepository(ctx.db).create({
        primaryEmail: `report-mgr-404-${d}@example.test`,
        username: `report-mgr-404-${d}`,
        firstName: 'Test',
        lastName: 'User',
        orgUnitId: acmeUnit.id,
        managerId: randomUUID(),
      }),
    ).rejects.toThrow(/manager not found/)
  })

  it('translates a cross-tenant membership edge to a ConflictError', async () => {
    const d = unique()
    const acme = await createOrganizationRow(`acme-gum-x-${d}`)
    const globex = await createOrganizationRow(`globex-gum-x-${d}`)
    const globexUnit = await insertOrgUnit({ organizationId: globex.id, path: `globex_gum_x_${d}` })
    const group = await insertGroup({ organizationId: acme.id, name: `acme-gum-x-${d}` })
    const outsider = await insertUser({
      organizationId: globex.id,
      orgUnitId: globexUnit.id,
      username: `outsider-gum-x-${d}`,
    })

    await expect(new GroupsRepository(ctx.db).addUser(group.id, outsider.id)).rejects.toThrow(
      ConflictError,
    )
  })

  it('translates a cross-tenant nesting edge to a ConflictError', async () => {
    const d = unique()
    const acme = await createOrganizationRow(`acme-ggm-x-${d}`)
    const globex = await createOrganizationRow(`globex-ggm-x-${d}`)
    const parent = await insertGroup({ organizationId: acme.id, name: `acme-ggm-x-${d}` })
    const child = await insertGroup({ organizationId: globex.id, name: `globex-ggm-x-${d}` })

    await expect(
      new GroupsRepository(ctx.db).addChildGroup(parent.id, child.id),
    ).rejects.toThrow(ConflictError)
  })
})
