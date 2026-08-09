import { describe, expect, it } from 'vitest'
import { ValidationError } from '../src/common/errors'
import { type CreateJmlRuleInput, JmlRulesRepository } from '../src/jml/jml-rules.repository'
import { simulate } from '../src/jml/rule-engine'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { UsersRepository } from '../src/users/users.repository'
import { type TestDatabase, withTestDatabase } from './support/pg'

async function totalCount(ctx: TestDatabase, table: string): Promise<number> {
  const { rows } = await ctx.pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`)
  return rows[0]?.count ?? 0
}

/**
 * MILESTONE 7, TASK 5/6: `jml_rules` storage and the mandatory-simulate gate.
 * Rules are seeded/managed exclusively through this repository this
 * milestone — no HTTP CRUD (see the milestone plan) — so every test below
 * drives `JmlRulesRepository` directly.
 */
describe('JmlRulesRepository (Milestone 7, Tasks 5 & 6)', () => {
  const ctx = withTestDatabase()
  const repo = () => new JmlRulesRepository(ctx.db)

  let orgUnitId: string
  async function ensureOrgUnit(): Promise<string> {
    if (orgUnitId) return orgUnitId
    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot(`JML Rules Root ${Date.now()}`)).id
    return orgUnitId
  }

  let fixtureSeq = 0
  function nextTag(): string {
    fixtureSeq += 1
    return `jmlr${fixtureSeq}`
  }

  function ruleInput(overrides: Partial<CreateJmlRuleInput> = {}): CreateJmlRuleInput {
    return {
      name: `Rule ${nextTag()}`,
      trigger: 'user_attribute_changed',
      conditionField: 'jobTitle',
      conditionOperator: 'equals',
      conditionValue: 'Engineer',
      action: 'deactivate',
      ...overrides,
    }
  }

  /** jobTitle defaults to 'Engineer' — matching every ruleInput() fixture's default conditionValue above, so a plain makeActiveUser() call is a real match unless a test overrides it. */
  async function makeActiveUser(jobTitle = 'Engineer'): Promise<{ id: string; username: string }> {
    const org = await ensureOrgUnit()
    const tag = nextTag()
    const created = await new UsersRepository(ctx.db).create({
      primaryEmail: `${tag}@example.com`,
      username: tag,
      firstName: 'Test',
      lastName: 'User',
      orgUnitId: org,
      jobTitle,
    })
    return new UsersRepository(ctx.db).changeStatus(created.id, 'active')
  }

  describe('create', () => {
    it('defaults enabled to false and simulatedAt to null, regardless of what is passed', async () => {
      const rule = await repo().create(ruleInput())
      expect(rule.enabled).toBe(false)
      expect(rule.simulatedAt).toBeNull()
      expect(rule.id).toEqual(expect.any(String))
      expect(rule.actionParams).toEqual({})
    })

    it('stores conditionValue and actionParams as given', async () => {
      const rule = await repo().create(
        ruleInput({
          conditionOperator: 'in',
          conditionValue: ['Engineer', 'Manager'],
          action: 'set_attribute',
          actionParams: { key: 'costCenter', value: 'CC-42' },
        }),
      )
      expect(rule.conditionValue).toEqual(['Engineer', 'Manager'])
      expect(rule.actionParams).toEqual({ key: 'costCenter', value: 'CC-42' })
    })
  })

  describe('findById / list', () => {
    it('returns null for a rule that does not exist', async () => {
      expect(await repo().findById('00000000-0000-0000-0000-000000000000')).toBeNull()
    })

    it('lists every created rule', async () => {
      const rule = await repo().create(ruleInput())
      const all = await repo().list()
      expect(all.map((r) => r.id)).toContain(rule.id)
    })
  })

  describe('the enable gate — a rule cannot be enabled until it has been simulated', () => {
    it('enabling a never-simulated rule is rejected with a ValidationError, and the row stays disabled', async () => {
      const rule = await repo().create(ruleInput())

      await expect(repo().setEnabled(rule.id, true)).rejects.toThrow(ValidationError)

      const reloaded = await repo().findById(rule.id)
      expect(reloaded?.enabled).toBe(false)
    })

    it('markSimulated then setEnabled(true) succeeds', async () => {
      const rule = await repo().create(ruleInput())

      await repo().markSimulated(rule.id)
      const enabled = await repo().setEnabled(rule.id, true)

      expect(enabled.enabled).toBe(true)
      expect(enabled.simulatedAt).not.toBeNull()
    })

    it('disabling (enabled: false) is always allowed, even for a never-simulated rule', async () => {
      const rule = await repo().create(ruleInput())
      const result = await repo().setEnabled(rule.id, false)
      expect(result.enabled).toBe(false)
    })

    it('setEnabled on a nonexistent rule 404s', async () => {
      await expect(
        repo().setEnabled('00000000-0000-0000-0000-000000000000', false),
      ).rejects.toThrow(/not found/)
    })

    it('markSimulated is idempotent — simulating twice just refreshes the timestamp', async () => {
      const rule = await repo().create(ruleInput())
      const first = await repo().markSimulated(rule.id)
      const second = await repo().markSimulated(rule.id)
      expect(first.simulatedAt).not.toBeNull()
      expect(second.simulatedAt).not.toBeNull()
    })
  })

  describe('listEnabledByTrigger', () => {
    it('returns only enabled rules matching the exact trigger', async () => {
      const target = await repo().create(ruleInput({ trigger: 'start_date_reached' }))
      await repo().markSimulated(target.id)
      await repo().setEnabled(target.id, true)

      const wrongTrigger = await repo().create(ruleInput({ trigger: 'end_date_reached' }))
      await repo().markSimulated(wrongTrigger.id)
      await repo().setEnabled(wrongTrigger.id, true)

      const stillDisabled = await repo().create(ruleInput({ trigger: 'start_date_reached' }))

      const results = await repo().listEnabledByTrigger('start_date_reached')
      const ids = results.map((r) => r.id)

      expect(ids).toContain(target.id)
      expect(ids).not.toContain(wrongTrigger.id)
      expect(ids).not.toContain(stillDisabled.id)
    })
  })

  // =====================================================================
  // THE FOUR THINGS THAT MATTER MOST, #3: simulate writes NOTHING.
  // =====================================================================
  describe('simulate() writes nothing', () => {
    it('leaves user, audit_log and outbox_events row counts completely unchanged', async () => {
      const rule = await repo().create(ruleInput({ conditionField: 'jobTitle', conditionOperator: 'equals', conditionValue: 'Engineer' }))
      const user = await makeActiveUser()
      const fullUser = await new UsersRepository(ctx.db).findById(user.id)

      const usersBefore = await totalCount(ctx, 'users')
      const auditBefore = await totalCount(ctx, 'audit_log')
      const outboxBefore = await totalCount(ctx, 'outbox_events')

      const effects = simulate(rule, [fullUser!])
      expect(effects).toHaveLength(1)

      expect(await totalCount(ctx, 'users')).toBe(usersBefore)
      expect(await totalCount(ctx, 'audit_log')).toBe(auditBefore)
      expect(await totalCount(ctx, 'outbox_events')).toBe(outboxBefore)
    })

    it('previews a rule that is not yet enabled — enabled state never gates a preview', async () => {
      const rule = await repo().create(ruleInput({ conditionField: 'jobTitle', conditionOperator: 'equals', conditionValue: 'Engineer' }))
      expect(rule.enabled).toBe(false)

      const user = await makeActiveUser()
      const fullUser = await new UsersRepository(ctx.db).findById(user.id)

      const [effect] = simulate(rule, [fullUser!])
      expect(effect?.wouldApply).toBe(true)
    })
  })
})
