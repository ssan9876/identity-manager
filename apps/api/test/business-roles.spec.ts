import { describe, expect, it } from 'vitest'
import { BusinessRolesRepository } from '../src/business-roles/business-roles.repository'
import { hashDefinition, parseDefinition } from '../src/business-roles/draft'
import { withTestDatabase } from './support/pg'

const ctx = withTestDatabase()

function repo(): BusinessRolesRepository {
  return new BusinessRolesRepository(ctx.db)
}

const DEFINITION = {
  conditions: [{ field: 'jobTitle', operator: 'equals', value: 'Account Executive' }],
  grants: [{ kind: 'target_account', groupId: null, target: 'keycloak' }],
}

describe('draft canonicalisation (Milestone 17, Task 7)', () => {
  it('hashes equal definitions equally regardless of key or member order', () => {
    const a = parseDefinition({
      conditions: [
        { field: 'jobTitle', operator: 'equals', value: 'AE' },
        { field: 'location', operator: 'equals', value: 'London' },
      ],
      grants: [],
    })
    const b = parseDefinition({
      conditions: [
        { operator: 'equals', value: 'London', field: 'location' },
        { value: 'AE', field: 'jobTitle', operator: 'equals' },
      ],
      grants: [],
    })

    expect(hashDefinition(a)).toBe(hashDefinition(b))
  })

  it('hashes different definitions differently', () => {
    const a = parseDefinition({ conditions: [{ field: 'jobTitle', operator: 'equals', value: 'AE' }], grants: [] })
    const b = parseDefinition({ conditions: [{ field: 'jobTitle', operator: 'equals', value: 'SDR' }], grants: [] })

    expect(hashDefinition(a)).not.toBe(hashDefinition(b))
  })

  it('rejects an operator outside the closed set', () => {
    expect(() =>
      parseDefinition({ conditions: [{ field: 'jobTitle', operator: 'matches', value: 'x' }], grants: [] }),
    ).toThrow()
  })

  it('rejects a grant whose kind does not match its reference', () => {
    expect(() =>
      parseDefinition({ conditions: [], grants: [{ kind: 'group_membership', groupId: null, target: 'keycloak' }] }),
    ).toThrow()
  })
})

describe('the publish gate (Milestone 17, Task 7)', () => {
  it('a saved draft changes nothing about the published definition', async () => {
    const role = await repo().create({ name: 'Draft only', description: null })

    await repo().saveDraft(role.id, DEFINITION)

    const published = await repo().findById(role.id)
    expect(published?.conditions).toEqual([])
    expect(published?.grants).toEqual([])
    expect(published?.draftDefinition).not.toBeNull()
  })

  it('publish refuses when the draft was never simulated', async () => {
    const role = await repo().create({ name: 'Never simulated', description: null })
    await repo().saveDraft(role.id, DEFINITION)

    await expect(repo().publish(role.id)).rejects.toThrow(/simulat/i)
  })

  it('publish refuses when the draft changed after simulation', async () => {
    const role = await repo().create({ name: 'Edited after simulation', description: null })
    await repo().saveDraft(role.id, DEFINITION)
    await repo().recordSimulation(role.id, hashDefinition(parseDefinition(DEFINITION)))

    // Simulate something harmless, then try to ship something sweeping.
    await repo().saveDraft(role.id, {
      conditions: [{ field: 'status', operator: 'equals', value: 'active' }],
      grants: [{ kind: 'target_account', groupId: null, target: 'keycloak' }],
    })

    await expect(repo().publish(role.id)).rejects.toThrow(/simulat/i)
  })

  it('publish copies the draft down and clears it', async () => {
    const role = await repo().create({ name: 'Publishable', description: null })
    await repo().saveDraft(role.id, DEFINITION)
    await repo().recordSimulation(role.id, hashDefinition(parseDefinition(DEFINITION)))

    await repo().publish(role.id)

    const published = await repo().findById(role.id)
    expect(published?.conditions).toEqual([
      expect.objectContaining({ field: 'jobTitle', operator: 'equals', value: 'Account Executive' }),
    ])
    expect(published?.grants).toEqual([expect.objectContaining({ kind: 'target_account', target: 'keycloak' })])
    expect(published?.draftDefinition).toBeNull()
    expect(published?.simulatedDraftHash).toBeNull()
  })

  it('listEnabledForEvaluation returns only enabled roles, with their published definitions', async () => {
    const on = await repo().create({ name: 'Enabled role', description: null })
    await repo().saveDraft(on.id, DEFINITION)
    await repo().recordSimulation(on.id, hashDefinition(parseDefinition(DEFINITION)))
    await repo().publish(on.id)
    await repo().setEnabled(on.id, true)

    const off = await repo().create({ name: 'Disabled role', description: null })
    await repo().saveDraft(off.id, DEFINITION)
    await repo().recordSimulation(off.id, hashDefinition(parseDefinition(DEFINITION)))
    await repo().publish(off.id)

    const roles = await repo().listEnabledForEvaluation()

    expect(roles.map((r) => r.id)).toEqual([on.id])
    expect(roles[0].grants).toEqual([expect.objectContaining({ target: 'keycloak' })])
  })
})
