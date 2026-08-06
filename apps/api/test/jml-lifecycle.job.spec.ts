import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { GroupsRepository } from '../src/groups/groups.repository'
import { JmlRulesRepository } from '../src/jml/jml-rules.repository'
import { LifecycleJob } from '../src/jml/lifecycle.job'
import { RuleApplier } from '../src/jml/rule-applier'
import { KeycloakAdminClient } from '../src/keycloak/keycloak-admin.client'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { type User, UsersRepository } from '../src/users/users.repository'
import { startKeycloak, type TestKeycloak } from './support/keycloak'
import { type TestDatabase, withTestDatabase } from './support/pg'

const SYNC_CLIENT_ID = 'idm-sync-service'
const SYNC_CLIENT_SECRET = 'idm_sync_dev_secret_change_me'

const PAST_DATE = '2000-01-01'
const FUTURE_DATE = '2999-01-01'

async function totalAuditCount(ctx: TestDatabase): Promise<number> {
  const { rows } = await ctx.pool.query<{ count: number }>('SELECT count(*)::int AS count FROM audit_log')
  return rows[0]?.count ?? 0
}

interface AuditLogRow {
  actor_user_id: string | null
  action: string
}

async function auditRowsFor(ctx: TestDatabase, resourceId: string): Promise<AuditLogRow[]> {
  const { rows } = await ctx.pool.query<AuditLogRow>(
    "SELECT actor_user_id, action FROM audit_log WHERE resource_type = 'user' AND resource_id = $1 ORDER BY id ASC",
    [resourceId],
  )
  return rows
}

/**
 * MILESTONE 7, TASK 7: the date-driven lifecycle scheduler. Real Postgres AND
 * real Keycloak Testcontainers — the core claim ("a live session dies when a
 * leaver's end date passes") is meaningless against a mock, exactly like
 * revocation.spec.ts (Milestone 4).
 */
describe('LifecycleJob (Milestone 7, Task 7)', () => {
  const ctx = withTestDatabase()
  let keycloak: TestKeycloak
  let client: KeycloakAdminClient
  let orgUnitId: string

  const usersRepo = () => new UsersRepository(ctx.db)
  const groupsRepo = () => new GroupsRepository(ctx.db)
  const rulesRepo = () => new JmlRulesRepository(ctx.db)
  const makeJob = () =>
    new LifecycleJob(
      usersRepo(),
      rulesRepo(),
      new RuleApplier(usersRepo(), groupsRepo(), new AuditWriter(), new OutboxWriter(), client, ctx.db),
      new AuditWriter(),
      new OutboxWriter(),
      client,
      ctx.db,
    )

  beforeAll(async () => {
    keycloak = await startKeycloak()
    client = new KeycloakAdminClient({
      issuer: keycloak.issuer,
      clientId: SYNC_CLIENT_ID,
      clientSecret: SYNC_CLIENT_SECRET,
    })
    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot(`Lifecycle Root ${Date.now()}`)).id
  })

  afterAll(async () => {
    await keycloak?.stop()
  })

  let fixtureSeq = 0
  function nextTag(): string {
    fixtureSeq += 1
    return `lc${fixtureSeq}`
  }

  // username is email-SHAPED — required for the session-revocation test
  // below, which registers a REAL Keycloak counterpart; see
  // jml-rule-applier.spec.ts's identical `makeActiveUser` comment (and
  // revocation.spec.ts's own precedent) for why.
  async function makePendingUser(startDate: string | undefined): Promise<User> {
    const tag = nextTag()
    const username = `${tag}@example.com`.toLowerCase()
    return usersRepo().create({
      primaryEmail: username,
      username,
      firstName: 'Lifecycle',
      lastName: `Joiner${tag}`,
      orgUnitId,
      startDate,
    })
  }

  async function makeActiveUserWithEndDate(endDate: string | undefined): Promise<User> {
    const tag = nextTag()
    const username = `${tag}@example.com`.toLowerCase()
    const created = await usersRepo().create({
      primaryEmail: username,
      username,
      firstName: 'Lifecycle',
      lastName: `Leaver${tag}`,
      orgUnitId,
      endDate,
    })
    return usersRepo().changeStatus(created.id, 'active')
  }

  describe('joiners: start_date reached', () => {
    it('a pending user with a past start_date becomes active', async () => {
      const user = await makePendingUser(PAST_DATE)

      const report = await makeJob().run()

      expect(report.activatedUserIds).toContain(user.id)
      const reloaded = await usersRepo().findById(user.id)
      expect(reloaded?.status).toBe('active')
    })

    it('a pending user with a FUTURE start_date is left alone', async () => {
      const user = await makePendingUser(FUTURE_DATE)

      const report = await makeJob().run()

      expect(report.activatedUserIds).not.toContain(user.id)
      const reloaded = await usersRepo().findById(user.id)
      expect(reloaded?.status).toBe('pending')
    })

    it('a pending user with no start_date at all is left alone', async () => {
      const user = await makePendingUser(undefined)

      await makeJob().run()

      const reloaded = await usersRepo().findById(user.id)
      expect(reloaded?.status).toBe('pending')
    })
  })

  describe('leavers: end_date reached', () => {
    it('an active user with a past end_date becomes deactivated and their Keycloak session is revoked', async () => {
      const user = await makeActiveUserWithEndDate(PAST_DATE)
      const password = 'fixture-password-never-sent-by-our-system'
      await keycloak.createFixtureUserWithPassword({ username: user.username, email: user.username, password })
      const { refreshToken } = await keycloak.tokenPairFor(user.username, password)

      const before = await keycloak.attemptRefresh(refreshToken)
      expect(before.ok).toBe(true)

      const report = await makeJob().run()

      expect(report.deactivatedUserIds).toContain(user.id)
      const reloaded = await usersRepo().findById(user.id)
      expect(reloaded?.status).toBe('deactivated')

      // Synchronous — the session is dead as soon as run() has returned.
      const after = await keycloak.attemptRefresh(refreshToken)
      expect(after.ok).toBe(false)

      const kcUser = await client.findUserByUsername(user.username)
      expect(kcUser?.enabled).toBe(false)
    })

    it('an active user with a FUTURE end_date is left alone', async () => {
      const user = await makeActiveUserWithEndDate(FUTURE_DATE)

      const report = await makeJob().run()

      expect(report.deactivatedUserIds).not.toContain(user.id)
      const reloaded = await usersRepo().findById(user.id)
      expect(reloaded?.status).toBe('active')
    })
  })

  describe('firing start_date_reached / end_date_reached rules', () => {
    it('applies an enabled start_date_reached rule\'s action for a newly-activated joiner', async () => {
      const group = await groupsRepo().create({ name: `Onboarding Group ${nextTag()}` })
      const rule = await rulesRepo().create({
        name: `Auto-onboard ${nextTag()}`,
        trigger: 'start_date_reached',
        conditionField: 'status', // status is 'active' by the time the rule fires (post-transition)
        conditionOperator: 'equals',
        conditionValue: 'active',
        action: 'add_to_group',
        actionParams: { groupId: group.id },
      })
      await rulesRepo().markSimulated(rule.id)
      await rulesRepo().setEnabled(rule.id, true)

      const user = await makePendingUser(PAST_DATE)

      await makeJob().run()

      expect(await groupsRepo().listDirectUserMembers(group.id)).toContain(user.id)
    })

    it('applies an enabled end_date_reached rule\'s action for a newly-deactivated leaver', async () => {
      const group = await groupsRepo().create({ name: `Offboarding Group ${nextTag()}` })
      const rule = await rulesRepo().create({
        name: `Auto-offboard ${nextTag()}`,
        trigger: 'end_date_reached',
        conditionField: 'status',
        conditionOperator: 'equals',
        conditionValue: 'deactivated',
        action: 'add_to_group', // tags leavers into a review group; deliberately not 'deactivate' — that already happened via the direct end_date path, see LifecycleJob's own doc comment.
        actionParams: { groupId: group.id },
      })
      await rulesRepo().markSimulated(rule.id)
      await rulesRepo().setEnabled(rule.id, true)

      const user = await makeActiveUserWithEndDate(PAST_DATE)

      await makeJob().run()

      expect(await groupsRepo().listDirectUserMembers(group.id)).toContain(user.id)
    })

    it('a disabled rule never fires from the lifecycle job either', async () => {
      const group = await groupsRepo().create({ name: `Disabled Rule Group ${nextTag()}` })
      const rule = await rulesRepo().create({
        name: `Disabled ${nextTag()}`,
        trigger: 'start_date_reached',
        conditionField: 'status',
        conditionOperator: 'equals',
        conditionValue: 'active',
        action: 'add_to_group',
        actionParams: { groupId: group.id },
      })
      // Deliberately NOT simulated/enabled.

      const user = await makePendingUser(PAST_DATE)
      await makeJob().run()

      expect(rule.enabled).toBe(false)
      expect(await groupsRepo().listDirectUserMembers(group.id)).not.toContain(user.id)
    })
  })

  // =====================================================================
  // Idempotency: running it twice in a day must not double-apply or write
  // duplicate audit rows.
  // =====================================================================
  describe('idempotency — running the script twice', () => {
    it('a second run activates nobody new and writes no new audit rows for an already-activated joiner', async () => {
      const user = await makePendingUser(PAST_DATE)

      const first = await makeJob().run()
      expect(first.activatedUserIds).toContain(user.id)
      const afterFirstRun = await auditRowsFor(ctx, user.id)

      const totalBeforeSecond = await totalAuditCount(ctx)
      const second = await makeJob().run()
      const totalAfterSecond = await totalAuditCount(ctx)

      expect(second.activatedUserIds).not.toContain(user.id)
      expect(await auditRowsFor(ctx, user.id)).toEqual(afterFirstRun)
      expect(totalAfterSecond).toBe(totalBeforeSecond)

      const reloaded = await usersRepo().findById(user.id)
      expect(reloaded?.status).toBe('active')
    })

    it('a second run deactivates nobody new and writes no new audit rows for an already-deactivated leaver', async () => {
      const user = await makeActiveUserWithEndDate(PAST_DATE)

      const first = await makeJob().run()
      expect(first.deactivatedUserIds).toContain(user.id)
      const afterFirstRun = await auditRowsFor(ctx, user.id)

      const totalBeforeSecond = await totalAuditCount(ctx)
      const second = await makeJob().run()
      const totalAfterSecond = await totalAuditCount(ctx)

      expect(second.deactivatedUserIds).not.toContain(user.id)
      expect(await auditRowsFor(ctx, user.id)).toEqual(afterFirstRun)
      expect(totalAfterSecond).toBe(totalBeforeSecond)

      const reloaded = await usersRepo().findById(user.id)
      expect(reloaded?.status).toBe('deactivated')
    })

    it('a whole-run idempotency check across both joiners and leavers together', async () => {
      const joiner = await makePendingUser(PAST_DATE)
      const leaver = await makeActiveUserWithEndDate(PAST_DATE)

      await makeJob().run()
      const totalAfterFirst = await totalAuditCount(ctx)

      const second = await makeJob().run()
      const totalAfterSecond = await totalAuditCount(ctx)

      expect(second.activatedUserIds).toEqual([])
      expect(second.deactivatedUserIds).toEqual([])
      expect(second.ruleActionsApplied).toBe(0)
      expect(totalAfterSecond).toBe(totalAfterFirst)

      expect((await usersRepo().findById(joiner.id))?.status).toBe('active')
      expect((await usersRepo().findById(leaver.id))?.status).toBe('deactivated')
    })
  })
})
