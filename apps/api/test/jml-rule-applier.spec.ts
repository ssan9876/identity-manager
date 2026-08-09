import type { JmlActionType } from '../src/jml/rule-engine'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { attributeDefinitions } from '../src/db/schema/attribute-definitions'
import { GroupsRepository } from '../src/groups/groups.repository'
import { KeycloakAdminClient } from '../src/keycloak/keycloak-admin.client'
import type { MatchedRuleAction } from '../src/jml/rule-engine'
import { RuleApplier } from '../src/jml/rule-applier'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { type User, UsersRepository } from '../src/users/users.repository'
import { startKeycloak, type TestKeycloak } from './support/keycloak'
import { type TestDatabase, withTestDatabase } from './support/pg'

const SYNC_CLIENT_ID = 'idm-sync-service'
const SYNC_CLIENT_SECRET = 'idm_sync_dev_secret_change_me'

interface AuditLogRow {
  actor_user_id: string | null
  action: string
  resource_type: string
  resource_id: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}

interface OutboxRow {
  aggregate_type: string
  aggregate_id: string
  event_type: string
  payload: Record<string, unknown>
}

async function auditRowsFor(ctx: TestDatabase, resourceType: string, resourceId: string): Promise<AuditLogRow[]> {
  const { rows } = await ctx.pool.query<AuditLogRow>(
    'SELECT * FROM audit_log WHERE resource_type = $1 AND resource_id = $2 ORDER BY id ASC',
    [resourceType, resourceId],
  )
  return rows
}

async function outboxRowsFor(ctx: TestDatabase, aggregateType: string, aggregateId: string): Promise<OutboxRow[]> {
  const { rows } = await ctx.pool.query<OutboxRow>(
    'SELECT * FROM outbox_events WHERE aggregate_type = $1 AND aggregate_id = $2 ORDER BY id ASC',
    [aggregateType, aggregateId],
  )
  return rows
}

async function totalAuditCount(ctx: TestDatabase): Promise<number> {
  const { rows } = await ctx.pool.query<{ count: number }>('SELECT count(*)::int AS count FROM audit_log')
  return rows[0]?.count ?? 0
}

async function totalOutboxCount(ctx: TestDatabase): Promise<number> {
  const { rows } = await ctx.pool.query<{ count: number }>('SELECT count(*)::int AS count FROM outbox_events')
  return rows[0]?.count ?? 0
}

/**
 * MILESTONE 7, TASK 6: applying a matched rule action goes through the
 * existing write paths — permission-checked as the trusted system actor
 * (see RuleApplier's own doc comment for why that means NO PermissionEngine
 * call, mirroring ReconciliationJob's precedent), audited with a NULL actor,
 * and outboxed, exactly like every other mutation in this system.
 *
 * Uses a REAL Keycloak Testcontainer (not a mock) specifically to prove the
 * `deactivate` action's synchronous session revocation — the same standard
 * revocation.spec.ts already holds every OTHER deactivation path in this
 * system to.
 */
describe('RuleApplier (Milestone 7, Task 6)', () => {
  const ctx = withTestDatabase()
  let keycloak: TestKeycloak
  let client: KeycloakAdminClient
  let orgUnitId: string

  const usersRepo = () => new UsersRepository(ctx.db)
  const groupsRepo = () => new GroupsRepository(ctx.db)
  const applier = () =>
    new RuleApplier(usersRepo(), groupsRepo(), new AuditWriter(), new OutboxWriter(), client, ctx.db)

  beforeAll(async () => {
    keycloak = await startKeycloak()
    client = new KeycloakAdminClient({
      issuer: keycloak.issuer,
      clientId: SYNC_CLIENT_ID,
      clientSecret: SYNC_CLIENT_SECRET,
    })
    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot(`RuleApplier Root ${Date.now()}`)).id
  })

  afterAll(async () => {
    await keycloak?.stop()
  })

  let fixtureSeq = 0
  function nextTag(): string {
    fixtureSeq += 1
    return `ra${fixtureSeq}`
  }

  // username is email-SHAPED (not merely tagged) — required for the
  // `deactivate` tests below, which register a REAL Keycloak counterpart via
  // `createFixtureUserWithPassword`; the realm's User Profile rejects a
  // non-email-shaped `email` field, and `KeycloakAdminClient` locates a
  // user's Keycloak counterpart BY USERNAME (decision 1), so the two must
  // match. Same convention revocation.spec.ts's own `makeActiveUser` uses.
  async function makeActiveUser(): Promise<User> {
    const tag = nextTag()
    const username = `${tag}@example.com`.toLowerCase()
    const created = await usersRepo().create({
      primaryEmail: username,
      username,
      firstName: 'Rule',
      lastName: `Target${tag}`,
      orgUnitId,
    })
    return usersRepo().changeStatus(created.id, 'active')
  }

  function matched(overrides: Partial<MatchedRuleAction>): MatchedRuleAction {
    return {
      ruleId: '11111111-2222-3333-4444-555555555555',
      ruleName: 'Test Rule',
      action: 'deactivate',
      actionParams: {},
      ...overrides,
    }
  }

  /**
   * Milestone 19, Task 16. `add_to_group`/`remove_from_group` were removed —
   * business roles own desired group membership now, so a JML rule granting
   * one would be a second writer the reconciler would revoke on its next
   * pass. The two `describe` blocks that used to live here tested those
   * handlers; they are replaced by this, which asserts the removal is
   * ENFORCED rather than merely that the code is gone.
   *
   * The cast is the whole point: Postgres cannot `DROP VALUE`, so the
   * `jml_action` enum still has both labels and a stored row really can come
   * back carrying one. This reproduces that row shape exactly.
   */
  describe('the removed group actions', () => {
    for (const action of ['add_to_group', 'remove_from_group'] as const) {
      it(`refuses a stored "${action}" rule: skipped as unknown, writing nothing`, async () => {
        const group = await groupsRepo().create({ name: `RA Removed ${nextTag()}` })
        const user = await makeActiveUser()
        const auditBefore = await totalAuditCount(ctx)
        const outboxBefore = await totalOutboxCount(ctx)

        const result = await applier().apply(
          matched({
            action: action as unknown as JmlActionType,
            actionParams: { groupId: group.id },
          }),
          user.id,
        )

        expect(result.applied).toBe(false)
        expect(result.skippedReason).toBe('unknown_action')
        // Nothing granted, and no audit or outbox row invented for an action
        // this binary no longer implements.
        expect(await groupsRepo().listDirectUserMembers(group.id)).not.toContain(user.id)
        expect(await totalAuditCount(ctx)).toBe(auditBefore)
        expect(await totalOutboxCount(ctx)).toBe(outboxBefore)
      })
    }
  })

  describe('set_attribute', () => {
    it('merges the attribute onto the user, leaving other existing attributes untouched', async () => {
      const key = `costCenter-${nextTag()}`
      const otherKey = `nickname-${nextTag()}`
      await ctx.db.insert(attributeDefinitions).values([
        { key, label: 'Cost Center', dataType: 'string', required: false, appliesTo: 'user', isActive: true },
        { key: otherKey, label: 'Nickname', dataType: 'string', required: false, appliesTo: 'user', isActive: true },
      ])

      const user = await makeActiveUser()
      await usersRepo().update(user.id, { attributes: { [otherKey]: 'Keep Me' } })

      const result = await applier().apply(
        matched({ action: 'set_attribute', actionParams: { key, value: 'CC-42' } }),
        user.id,
      )

      expect(result.applied).toBe(true)
      const reloaded = await usersRepo().findById(user.id)
      expect(reloaded?.attributes[key]).toBe('CC-42')
      expect(reloaded?.attributes[otherKey]).toBe('Keep Me')

      const auditRows = await auditRowsFor(ctx, 'user', user.id)
      expect(auditRows).toHaveLength(1)
      expect(auditRows[0]!.action).toBe('jml:set_attribute')
      expect(auditRows[0]!.actor_user_id).toBeNull()

      const outboxRows = await outboxRowsFor(ctx, 'user', user.id)
      expect(outboxRows.some((row) => row.event_type === 'updated')).toBe(true)
    })

    it('an unrecognised attribute key fails closed — skipped, logged, no write', async () => {
      const user = await makeActiveUser()

      const result = await applier().apply(
        matched({ action: 'set_attribute', actionParams: { key: 'notARealAttribute', value: 'x' } }),
        user.id,
      )

      expect(result.applied).toBe(false)
      expect(result.skippedReason).toBe('invalid_attribute')
      expect(await auditRowsFor(ctx, 'user', user.id)).toEqual([])
    })

    // Finding H4 (docs/archive/audits/audit-integrity.md): "the same shape
    // exists in JML set_attribute" — this method reads current.attributes,
    // merges, and writes back exactly like SelfServiceController.update did
    // pre-fix. Two rules (or the same rule re-triggered, or a concurrent
    // human edit) touching the same user's attributes at once could lose
    // one to a stale-read merge. Uses `findByIdForUpdate` for the same
    // reason and the same fix — see this method's own doc comment.
    it(
      '20 concurrent set_attribute applications for the SAME user, each a DIFFERENT key, never lose one to a stale-read merge',
      async () => {
        const user = await makeActiveUser()
        const N = 20
        const keys = Array.from({ length: N }, () => `h4jml-${nextTag()}`)
        await ctx.db.insert(
          attributeDefinitions,
        ).values(
          keys.map((key) => ({
            key,
            label: key,
            dataType: 'string' as const,
            required: false,
            appliesTo: 'user' as const,
            isActive: true,
          })),
        )

        const results = await Promise.all(
          keys.map((key, i) =>
            applier().apply(
              matched({ action: 'set_attribute', actionParams: { key, value: `v${i}` } }),
              user.id,
            ),
          ),
        )
        expect(results.every((r) => r.applied)).toBe(true)

        const reloaded = await usersRepo().findById(user.id)
        for (let i = 0; i < N; i++) {
          expect(reloaded?.attributes[keys[i]]).toBe(`v${i}`)
        }
      },
      30_000,
    )
  })

  describe('deactivate', () => {
    it('deactivates the user, writes an audit row with a null actor, an outbox event, AND revokes their live Keycloak session', async () => {
      const user = await makeActiveUser()
      const password = 'fixture-password-never-sent-by-our-system'
      await keycloak.createFixtureUserWithPassword({ username: user.username, email: user.username, password })
      const { refreshToken } = await keycloak.tokenPairFor(user.username, password)

      const before = await keycloak.attemptRefresh(refreshToken)
      expect(before.ok).toBe(true)

      const result = await applier().apply(matched({ action: 'deactivate' }), user.id)

      expect(result.applied).toBe(true)
      const reloaded = await usersRepo().findById(user.id)
      expect(reloaded?.status).toBe('deactivated')

      const auditRows = await auditRowsFor(ctx, 'user', user.id)
      expect(auditRows.some((row) => row.action === 'jml:deactivate' && row.actor_user_id === null)).toBe(true)

      const outboxRows = await outboxRowsFor(ctx, 'user', user.id)
      expect(outboxRows.some((row) => row.event_type === 'status_changed')).toBe(true)

      // The session is genuinely dead — synchronous, not "eventually".
      const after = await keycloak.attemptRefresh(refreshToken)
      expect(after.ok).toBe(false)

      const kcUser = await client.findUserByUsername(user.username)
      expect(kcUser?.enabled).toBe(false)
    })

    it('an already-deactivated user is a benign no-op — no crash, no new audit row', async () => {
      const user = await makeActiveUser()
      await usersRepo().changeStatus(user.id, 'deactivated')
      const before = await auditRowsFor(ctx, 'user', user.id)

      const result = await applier().apply(matched({ action: 'deactivate' }), user.id)

      expect(result.applied).toBe(false)
      expect(result.skippedReason).toBe('already_deactivated')
      expect(await auditRowsFor(ctx, 'user', user.id)).toEqual(before)
    })
  })

  describe('unknown action', () => {
    it('is skipped and logged rather than applied or crashed on', async () => {
      const user = await makeActiveUser()

      const result = await applier().apply(
        matched({ action: 'run_shell_command' as MatchedRuleAction['action'] }),
        user.id,
      )

      expect(result.applied).toBe(false)
      expect(result.skippedReason).toBe('unknown_action')
      expect(await auditRowsFor(ctx, 'user', user.id)).toEqual([])
    })
  })
})
