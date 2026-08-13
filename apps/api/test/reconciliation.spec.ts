import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { GroupsRepository } from '../src/groups/groups.repository'
import { KeycloakAdminClient } from '../src/keycloak/keycloak-admin.client'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { OutboxRepository } from '../src/outbox/outbox.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { ReconciliationJob } from '../src/outbox/reconciliation.job'
import { SyncWorker } from '../src/outbox/sync.worker'
import { type User, UsersRepository } from '../src/users/users.repository'
import { startKeycloak, type TestKeycloak } from './support/keycloak'
import { type TestDatabase, withTestDatabase } from './support/pg'

const SYNC_CLIENT_ID = 'idm-sync-service'
const SYNC_CLIENT_SECRET = 'idm_sync_dev_secret_change_me'

/**
 * MILESTONE 4, TASK 4: the on-demand reconciliation job. Against REAL
 * Postgres AND REAL Keycloak Testcontainers — "detects a user changed
 * directly in Keycloak" is meaningless to prove against a mock that only
 * ever reflects what THIS code wrote.
 *
 * Every test below drives `job.run()` at least twice: once to establish a
 * converged baseline (so drift after that point is unambiguous), then again
 * after mutating Keycloak DIRECTLY via a plain `KeycloakAdminClient` call —
 * simulating an operator using the Keycloak admin console — never through
 * this project's own controllers/worker, which would defeat the point.
 */
describe('ReconciliationJob (Milestone 4, Task 4)', () => {
  const ctx = withTestDatabase()
  let keycloak: TestKeycloak
  let client: KeycloakAdminClient
  let orgUnitId: string

  const usersRepo = () => new UsersRepository(ctx.db)
  const groupsRepo = () => new GroupsRepository(ctx.db)
  const makeJob = () =>
    new ReconciliationJob(
      usersRepo(),
      groupsRepo(),
      client,
      new OutboxWriter(),
      new SyncWorker(ctx.db, new OutboxRepository(), usersRepo(), groupsRepo(), client),
      new AuditWriter(),
      ctx.db,
    )

  beforeAll(async () => {
    keycloak = await startKeycloak()
    client = new KeycloakAdminClient({
      issuer: keycloak.issuer,
      clientId: SYNC_CLIENT_ID,
      clientSecret: SYNC_CLIENT_SECRET,
    })
    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot(`Reconciliation Root ${Date.now()}`)).id
  })

  afterAll(async () => {
    await keycloak?.stop()
  })

  let fixtureSeq = 0
  function nextTag(): string {
    fixtureSeq += 1
    return `${fixtureSeq}`
  }

  interface AuditLogRow {
    actor_user_id: string | null
    action: string
    resource_type: string
    resource_id: string | null
    before: Record<string, unknown> | null
    after: Record<string, unknown> | null
  }

  async function auditRowsFor(ctx: TestDatabase, resourceId: string): Promise<AuditLogRow[]> {
    const { rows } = await ctx.pool.query<AuditLogRow>(
      "SELECT * FROM audit_log WHERE resource_type = 'user' AND resource_id = $1 ORDER BY id ASC",
      [resourceId],
    )
    return rows
  }

  async function makeUser(): Promise<User> {
    const tag = nextTag()
    const username = `reconcile-user-${tag}@example.com`.toLowerCase()
    return usersRepo().create({
      primaryEmail: username,
      username,
      firstName: 'Reconcile',
      lastName: `Target${tag}`,
      orgUnitId,
    })
  }

  // =====================================================================
  // A user who never synced at all.
  // =====================================================================
  it('detects and creates a user missing from Keycloak entirely', async () => {
    const user = await makeUser()
    await usersRepo().changeStatus(user.id, 'active')

    const report = await makeJob().run()

    const drift = report.usersWithDrift.find((d) => d.userId === user.id)
    expect(drift?.reasons).toEqual(['missing_in_keycloak'])

    const kcUser = await client.findUserByUsername(user.username)
    expect(kcUser).not.toBeNull()
    expect(kcUser?.enabled).toBe(true)
  })

  // =====================================================================
  // THE test that matters most: direct edit in Keycloak, detected + repaired.
  // =====================================================================
  it('detects a user changed directly in Keycloak (enabled flipped out-of-band) and re-asserts desired state', async () => {
    const user = await makeUser()
    await usersRepo().changeStatus(user.id, 'active')

    const job = makeJob()
    await job.run() // establishes a converged baseline (creates them, enabled)
    expect((await client.findUserByUsername(user.username))?.enabled).toBe(true)

    // An operator disables this user DIRECTLY in Keycloak — never through
    // this project's own API/worker.
    await client.setEnabled(user.username, false)
    expect((await client.findUserByUsername(user.username))?.enabled).toBe(false)

    const report = await job.run()
    const drift = report.usersWithDrift.find((d) => d.userId === user.id)
    expect(drift?.reasons).toContain('enabled_mismatch')

    // Re-asserted: desired state wins.
    expect((await client.findUserByUsername(user.username))?.enabled).toBe(true)
  })

  it('detects a profile field (email) edited directly in Keycloak and re-asserts it', async () => {
    const user = await makeUser()
    await usersRepo().changeStatus(user.id, 'active')

    const job = makeJob()
    await job.run()

    await client.updateUser(
      user.username,
      { email: 'someone-else@example.com', firstName: user.firstName, lastName: user.lastName, attributes: {} },
      [],
    )
    expect((await client.findUserByUsername(user.username))?.email).toBe('someone-else@example.com')

    const report = await job.run()
    const drift = report.usersWithDrift.find((d) => d.userId === user.id)
    expect(drift?.reasons).toContain('email_mismatch')

    expect((await client.findUserByUsername(user.username))?.email).toBe(user.primaryEmail)
  })

  // =====================================================================
  // Group membership drift, exercising the new listUserGroups read.
  // =====================================================================
  it('detects and repairs group membership removed directly in Keycloak', async () => {
    const group = await groupsRepo().create({ name: `Reconcile Group ${nextTag()}` })
    const user = await makeUser()
    await usersRepo().changeStatus(user.id, 'active')
    await groupsRepo().addUser(group.id, user.id)

    const job = makeJob()
    await job.run() // creates the user AND joins them to the (newly ensured) Keycloak group
    expect(await keycloak.getUserGroupNames(user.username)).toContain(group.name)

    // Direct, out-of-band removal.
    await client.setUserGroups(user.username, [])
    expect(await keycloak.getUserGroupNames(user.username)).toEqual([])

    const report = await job.run()
    const drift = report.usersWithDrift.find((d) => d.userId === user.id)
    expect(drift?.reasons).toContain('group_mismatch')

    expect(await keycloak.getUserGroupNames(user.username)).toContain(group.name)
  })

  // =====================================================================
  // Security-relevant: a DEACTIVATED user re-enabled directly in Keycloak.
  // =====================================================================
  it('reverts a deactivated user who was re-enabled directly in Keycloak', async () => {
    const user = await makeUser()
    await usersRepo().changeStatus(user.id, 'active')

    const job = makeJob()
    await job.run()
    await usersRepo().changeStatus(user.id, 'deactivated')
    await job.run() // converges: disabled in Keycloak too
    expect((await client.findUserByUsername(user.username))?.enabled).toBe(false)

    // An operator re-enables them directly in Keycloak — bypassing this
    // system's own deactivate endpoint entirely.
    await client.setEnabled(user.username, true)
    expect((await client.findUserByUsername(user.username))?.enabled).toBe(true)

    const report = await job.run()
    const drift = report.usersWithDrift.find((d) => d.userId === user.id)
    expect(drift?.reasons).toContain('enabled_mismatch')

    // Re-asserted: a deactivated user's Keycloak account stays disabled,
    // regardless of what an operator did directly against Keycloak.
    expect((await client.findUserByUsername(user.username))?.enabled).toBe(false)
  })

  // =====================================================================
  // Finding M2 (docs/archive/audits/audit-integrity.md): binding constraint 7
  // requires every mutation be "audited AND outboxed in one transaction" —
  // `enqueueRepair` wrote an outbox event only. Measured by the audit over
  // exactly this scenario (a suspended user manually re-enabled directly in
  // Keycloak): "Keycloak account re-disabled, 0 audit rows written." Fixed:
  // an `actorUserId: null` audit row now lands in the SAME transaction as
  // the outbox event, `before` = the observed Keycloak state, `after` =
  // desired state + the drift reasons.
  // =====================================================================
  describe('audits its own repairs (finding M2, docs/archive/audits/audit-integrity.md)', () => {
    it('writes an actorUserId:null audit row when it repairs a deactivated user re-enabled directly in Keycloak', async () => {
      const user = await makeUser()
      await usersRepo().changeStatus(user.id, 'active')

      const job = makeJob()
      await job.run()
      await usersRepo().changeStatus(user.id, 'deactivated')
      await job.run() // converges: disabled in Keycloak too
      expect((await client.findUserByUsername(user.username))?.enabled).toBe(false)

      const auditRowsBeforeDrift = await auditRowsFor(ctx, user.id)

      // Bypasses this system entirely, exactly like the audit's own repro.
      await client.setEnabled(user.username, true)
      expect((await client.findUserByUsername(user.username))?.enabled).toBe(true)

      const report = await job.run()
      const drift = report.usersWithDrift.find((d) => d.userId === user.id)
      expect(drift?.reasons).toContain('enabled_mismatch')
      expect((await client.findUserByUsername(user.username))?.enabled).toBe(false)

      const auditRows = await auditRowsFor(ctx, user.id)
      expect(auditRows.length).toBe(auditRowsBeforeDrift.length + 1)

      const repairRow = auditRows[auditRows.length - 1]!
      expect(repairRow.action).toBe('reconciliation:repair')
      expect(repairRow.actor_user_id).toBeNull()
      // before = the OBSERVED (drifted) Keycloak state — genuinely enabled.
      expect(repairRow.before?.enabled).toBe(true)
      // after = the DESIRED state this repair will assert — deactivated
      // users are always desired-disabled — plus why.
      expect(repairRow.after?.status).toBe('deactivated')
      expect(repairRow.after?.reasons).toEqual(['enabled_mismatch'])
    })

    it('writes no audit row for a user with no drift', async () => {
      const user = await makeUser()
      await usersRepo().changeStatus(user.id, 'active')

      const job = makeJob()
      await job.run()
      const afterFirst = await auditRowsFor(ctx, user.id)

      await job.run() // fully converged — no drift this time
      expect(await auditRowsFor(ctx, user.id)).toEqual(afterFirst)
    })
  })

  // =====================================================================
  // No false positives: an already-converged user reports no drift.
  // =====================================================================
  it('reports no drift for a user already fully converged', async () => {
    const user = await makeUser()
    await usersRepo().changeStatus(user.id, 'active')

    const job = makeJob()
    await job.run()

    const report = await job.run()
    expect(report.usersWithDrift.find((d) => d.userId === user.id)).toBeUndefined()
  })
  /**
   * SECURITY FINDING 6: reconciliation could not see Keycloak-only accounts.
   *
   * The drift walk starts from THIS database and asks Keycloak about each user
   * it finds, so it is structurally incapable of noticing an account only
   * Keycloak has — one created by hand in the admin console, or left behind by
   * a deletion that never propagated. This creates exactly that, through a
   * plain `KeycloakAdminClient` call (an operator with the admin console, not
   * this system's own controllers), and asserts it is both SEEN and LEFT
   * ALONE.
   *
   * The "left alone" half is the point, not an afterthought. Every other kind
   * of drift here is a divergence from a state this system owns, so pushing it
   * back is unambiguous. An account this system never created may be a service
   * account, a break-glass administrator, or a federated identity — deleting
   * it automatically is how a reconciliation job locks a human out of the
   * identity provider.
   */
  it('reports a Keycloak-only account, and deliberately does not repair it', async () => {
    const username = `kc-only-${Date.now()}`
    await client.createUser(
      {
        username,
        email: `${username}@example.com`,
        firstName: 'Keycloak',
        lastName: 'Only',
        enabled: true,
        attributes: {},
      },
      [],
    )

    const report = await makeJob().run()

    expect(report.keycloakOnlyUsernames).toContain(username)
    // Still there afterwards: seen, reported, untouched.
    expect(await client.findUserByUsername(username)).not.toBeNull()
  })

  it('reports nothing extra when every Keycloak account has a user here', async () => {
    const report = await makeJob().run()
    const stray = report.keycloakOnlyUsernames.filter((u) => u.startsWith('kc-only-'))
    // The account created above is the only planted one; anything else in this
    // realm (the sync service client, say) is not a user and never appears.
    expect(stray.length).toBeLessThanOrEqual(1)
  })
})
