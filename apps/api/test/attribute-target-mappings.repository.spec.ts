import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AttributeTargetMappingsRepository } from '../src/attributes/attribute-target-mappings.repository'
import { attributeDefinitions } from '../src/db/schema/attribute-definitions'
import { connectorTargets } from '../src/db/schema/connector-targets'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

/**
 * `countExportImpact` — the number an admin has to acknowledge before
 * enabling a propagation mapping (security finding 5).
 *
 * The rule lives in the repository ALONE, so the count the console shows and
 * the count the API enforces cannot drift apart. These tests are what pin the
 * two parts of it that are easy to get wrong: what counts as holding a value,
 * and which organizations are in scope.
 *
 * `withTestDatabase()` starts ONE container per FILE with no truncation
 * between `it` blocks, so every fixture below takes a per-call unique key and
 * every count is filtered to the users this test created.
 */
describe('AttributeTargetMappingsRepository.countExportImpact', () => {
  const ctx = withTestDatabase()

  function repo(): AttributeTargetMappingsRepository {
    return new AttributeTargetMappingsRepository(ctx.db)
  }

  function usersRepo(): UsersRepository {
    return new UsersRepository(ctx.db)
  }

  /** Legal under attributes/attribute-key.ts: a letter first, then letters, digits or underscores. */
  function uniqueKey(prefix: string): string {
    return `${prefix}_${randomUUID().replace(/-/g, '_')}`.slice(0, 64)
  }

  async function seedDefinition(
    over: Partial<typeof attributeDefinitions.$inferInsert> = {},
  ): Promise<{ id: string; key: string }> {
    const key = typeof over.key === 'string' ? over.key : uniqueKey('exp')
    const [row] = await ctx.db
      .insert(attributeDefinitions)
      .values({ key, label: 'Export impact', dataType: 'string', appliesTo: 'user', ...over })
      .returning()
    return { id: row.id, key: row.key }
  }

  /**
   * Enables a target for the MASTER organization, which is the organization
   * every user seeded here lands in. `connector_targets.organization_id`
   * defaults to `master_organization_id()`, so the row needs no explicit id.
   */
  async function enableTarget(target: 'active_directory' | 'entra_id'): Promise<void> {
    await ctx.db
      .insert(connectorTargets)
      .values({ target, enabled: true, config: {} })
      .onConflictDoUpdate({
        target: [connectorTargets.organizationId, connectorTargets.target],
        set: { enabled: true },
      })
  }

  async function disableTarget(target: 'active_directory' | 'entra_id'): Promise<void> {
    await ctx.db
      .insert(connectorTargets)
      .values({ target, enabled: false, config: {} })
      .onConflictDoUpdate({
        target: [connectorTargets.organizationId, connectorTargets.target],
        set: { enabled: false },
      })
  }

  let rootOrgUnitId: string | null = null
  async function orgUnitId(): Promise<string> {
    if (rootOrgUnitId === null) {
      rootOrgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot(`Export Impact ${Date.now()}`)).id
    }
    return rootOrgUnitId
  }

  async function seedUser(over: { jobTitle?: string; attributes?: Record<string, unknown> } = {}) {
    const tag = randomUUID().slice(0, 8)
    return usersRepo().create({
      primaryEmail: `exp-${tag}@example.com`,
      username: `exp-${tag}`,
      firstName: 'Export',
      lastName: 'Impact',
      orgUnitId: await orgUnitId(),
      ...over,
    })
  }

  // ==========================================================================
  // What counts as holding a value
  // ==========================================================================

  it('counts only users holding a non-null value for the custom attribute', async () => {
    const definition = await seedDefinition()
    await enableTarget('active_directory')

    await seedUser({ attributes: { [definition.key]: 'yes' } })
    // Holds the KEY, but its value is null — there is nothing to export.
    await seedUser({ attributes: { [definition.key]: null } })
    // Does not hold the key at all.
    await seedUser({ attributes: {} })

    await expect(
      repo().countExportImpact({
        target: 'active_directory',
        attributeDefinitionId: definition.id,
      }),
    ).resolves.toMatchObject({ holderCount: 1 })
  })

  /**
   * THE ASSERTION THAT MAKES THE NUMBER MEAN ANYTHING.
   *
   * `connector_targets` is keyed `(organization_id, target)`, so a tenant
   * with no enabled row exports nothing no matter how many of its users hold
   * a value. A directory-wide count would over-state this on every
   * deployment where one tenant of twenty is configured — and an alarming
   * number that is also wrong is one people learn to click past.
   */
  it('excludes holders when the organization does not have that target enabled', async () => {
    const definition = await seedDefinition()
    await disableTarget('entra_id')
    await seedUser({ attributes: { [definition.key]: 'yes' } })

    await expect(
      repo().countExportImpact({ target: 'entra_id', attributeDefinitionId: definition.id }),
    ).resolves.toMatchObject({ holderCount: 0 })
  })

  it('reports the definition sensitive flag, so no caller re-derives it', async () => {
    const definition = await seedDefinition({ sensitive: true })
    await enableTarget('active_directory')

    await expect(
      repo().countExportImpact({
        target: 'active_directory',
        attributeDefinitionId: definition.id,
      }),
    ).resolves.toMatchObject({ sensitive: true })
  })

  // ==========================================================================
  // Core fields
  // ==========================================================================

  it('counts a core title only where a job title is actually set', async () => {
    await enableTarget('active_directory')
    const before = await repo().countExportImpact({
      target: 'active_directory',
      coreField: 'title',
    })

    await seedUser({ jobTitle: 'Engineer' })
    await seedUser()

    const after = await repo().countExportImpact({ target: 'active_directory', coreField: 'title' })
    expect(after.holderCount - before.holderCount).toBe(1)
  })

  it('reports a core field as never sensitive — there is no definition to carry the flag', async () => {
    await enableTarget('active_directory')

    await expect(
      repo().countExportImpact({ target: 'active_directory', coreField: 'given_name' }),
    ).resolves.toMatchObject({ sensitive: false })
  })

  /**
   * `first_name` is NOT NULL, so every in-scope user holds it. The count
   * approaching the whole population is correct rather than alarmist: it is
   * exactly the sentence an admin should read before exporting every name in
   * the directory to a third party.
   */
  it('counts every in-scope user for a core field that cannot be null', async () => {
    await enableTarget('active_directory')
    const before = await repo().countExportImpact({
      target: 'active_directory',
      coreField: 'given_name',
    })

    await seedUser()
    await seedUser()

    const after = await repo().countExportImpact({
      target: 'active_directory',
      coreField: 'given_name',
    })
    expect(after.holderCount - before.holderCount).toBe(2)
  })
})
