import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { PermissionEngine, type Actor } from '../src/authz/permission.engine'
import { PrivilegeGuards } from '../src/authz/privilege.guards'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { ValidationError } from '../src/common/errors'
import { HrSourcesRepository } from '../src/hr/hr-sources.repository'
import { HrSyncService } from '../src/hr/hr-sync.service'
import { OrgUnitsRepository, type OrgUnit } from '../src/org-units/org-units.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { UsersRepository } from '../src/users/users.repository'
import { startHrFeedFake, type HrFeedFake } from './support/hr-feed-fake'
import { withTestDatabase } from './support/pg'

/**
 * HR inbound sync, end to end against real collaborators: a REAL local HTTP
 * fixture standing in for the HR system (test/support/hr-feed-fake.ts), a
 * real Testcontainers Postgres, and the REAL import pipeline — HrSyncService
 * constructs the actual ImportsController, so every assertion below about
 * creates/updates/batchIds is exercising resolveRow/commit themselves, not
 * a re-implementation.
 *
 * The source rows all carry an https:// URL (the only kind the schema and
 * fetchFeedCsv accept); the test seam routes the actual socket connection
 * to the local fixture WITHOUT weakening the https validation — see
 * HrSyncConfig.fetchImpl's own doc comment.
 */
describe('HR inbound sync (fetch -> preview -> commit)', () => {
  const ctx = withTestDatabase()

  const SECRET_NAME = 'CONNECTOR_HR_FEED_TOKEN'
  const SECRET_VALUE = `hr-sentinel-${Math.random().toString(36).slice(2)}`

  let fake: HrFeedFake
  let sources: HrSourcesRepository
  let service: HrSyncService
  let engine: PermissionEngine
  let actor: Actor
  let org: OrgUnit
  let organizationId: string

  let fixtureSeq = 0
  function nextTag(): string {
    fixtureSeq += 1
    return `hr${fixtureSeq}`
  }

  beforeAll(async () => {
    process.env[SECRET_NAME] = SECRET_VALUE
    fake = await startHrFeedFake()

    sources = new HrSourcesRepository(ctx.db)
    engine = new PermissionEngine(ctx.db)
    service = new HrSyncService(
      sources,
      new UsersRepository(ctx.db),
      new OrgUnitsRepository(ctx.db),
      engine,
      new PrivilegeGuards(ctx.db),
      new AuditWriter(),
      new OutboxWriter(),
      ctx.db,
      { maxRows: 1000 },
      {
        maxFetchBytes: 64 * 1024,
        // Routes the source's https URL to the local fixture — the REAL
        // fetch still runs, over a real socket, with the same headers.
        fetchImpl: (_input, init) => fetch(`${fake.baseUrl}/export.csv`, init),
      },
    )

    const orgUnits = new OrgUnitsRepository(ctx.db)
    org = await orgUnits.createRoot('HR Sync Root')

    const usersRepo = new UsersRepository(ctx.db)
    const admin = await usersRepo.create({
      primaryEmail: 'hr-sync-admin@example.com',
      username: 'hr-sync-admin',
      firstName: 'Sync',
      lastName: 'Admin',
      orgUnitId: org.id,
    })
    await usersRepo.changeStatus(admin.id, 'active')
    // GLOBAL super_admin — holds user:create/user:update everywhere, so
    // per-row scope checks pass and what these tests measure is the HR
    // layer's own behaviour, not a scope artifact.
    await new RoleAssignmentsRepository(ctx.db).assign({ userId: admin.id, roleKey: 'super_admin' })
    actor = await engine.resolveActor({ subject: 'test', username: 'hr-sync-admin', email: null })

    const { rows } = await ctx.pool.query<{ id: string }>('SELECT id FROM organizations WHERE is_master')
    organizationId = rows[0].id
  })

  afterAll(async () => {
    await fake.stop()
    delete process.env[SECRET_NAME]
  })

  async function makeSource(overrides: Partial<Parameters<HrSourcesRepository['create']>[1]> = {}) {
    return ctx.db.transaction(async (tx) =>
      sources.create(tx, {
        organizationId,
        name: `Feed ${nextTag()}`,
        kind: 'csv_url',
        url: 'https://hr.example.test/export.csv',
        authHeaderName: 'Authorization',
        authSecretName: SECRET_NAME,
        columnMapping: {
          EMP_ID: 'employeeId',
          WORK_EMAIL: 'primaryEmail',
          LOGIN: 'username',
          GIVEN: 'firstName',
          FAMILY: 'lastName',
          DEPT: 'orgUnitId',
          TITLE: 'jobTitle',
        },
        enabled: true,
        ...overrides,
      }),
    )
  }

  interface FeedRow {
    EMP_ID: string
    WORK_EMAIL: string
    LOGIN: string
    GIVEN?: string
    FAMILY?: string
    DEPT?: string
    TITLE?: string
    PAYROLL_BAND?: string
  }

  function feedCsv(rows: FeedRow[]): string {
    const headers = ['EMP_ID', 'WORK_EMAIL', 'LOGIN', 'GIVEN', 'FAMILY', 'DEPT', 'TITLE', 'PAYROLL_BAND']
    const lines = [headers.join(',')]
    for (const row of rows) {
      const record: Record<string, string> = {
        GIVEN: 'First',
        FAMILY: 'Last',
        DEPT: org.id,
        TITLE: '',
        PAYROLL_BAND: 'B9',
        ...row,
      }
      lines.push(headers.map((header) => record[header] ?? '').join(','))
    }
    return lines.join('\n')
  }

  function personRow(tag: string, overrides: Partial<FeedRow> = {}): FeedRow {
    return {
      EMP_ID: `E-${tag}`,
      WORK_EMAIL: `${tag}@example.com`,
      LOGIN: `user-${tag}`,
      ...overrides,
    }
  }

  async function userCountFor(employeeIds: string[]): Promise<number> {
    const { rows } = await ctx.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM users WHERE employee_id = ANY($1)',
      [employeeIds],
    )
    return rows[0].count
  }

  /**
   * The `rest_json` source kind end to end, through the SAME service, the
   * same fetch seam and the same import pipeline as a CSV feed. What this
   * proves is the property the kind dispatch exists for: once
   * `FEED_LOADERS` has produced its CSV, nothing downstream can tell the
   * two kinds apart — the preview, the guards, the commit and the audit
   * rows are the CSV path's, unmodified.
   */
  it('reads a rest_json source through the same pipeline as csv, dropping unmapped fields', async () => {
    const tag = nextTag()
    fake.body = JSON.stringify({
      data: {
        items: [
          {
            employee: { id: `E-${tag}`, login: `user-${tag}` },
            contact: { work: `${tag}@example.com` },
            name: { given: 'Ada', family: 'Lovelace' },
            unit: org.id,
            compensation: { band: 'B9' },
          },
        ],
      },
    })

    const source = await makeSource({
      kind: 'rest_json',
      url: 'https://hr.example.test/api/people',
      config: { recordsPath: 'data.items', pagination: { mode: 'none' } },
      columnMapping: {
        'employee.id': 'employeeId',
        'contact.work': 'primaryEmail',
        'employee.login': 'username',
        'name.given': 'firstName',
        'name.family': 'lastName',
        unit: 'orgUnitId',
      },
    })

    const report = await service.run(source, { commit: true, actor })

    expect(report.outcome).toBe('committed')
    expect(report.commit).toMatchObject({ created: 1, failed: 0 })
    expect(await userCountFor([`E-${tag}`])).toBe(1)

    // The unmapped compensation subtree never crossed the boundary.
    const { rows } = await ctx.pool.query<{ attributes: Record<string, unknown>; first_name: string }>(
      'SELECT attributes, first_name FROM users WHERE employee_id = $1',
      [`E-${tag}`],
    )
    expect(rows[0].first_name).toBe('Ada')
    expect(rows[0].attributes).toEqual({})
  })

  /** A mapping that does not fit the feed is `preview_failed` — the feed was fetched fine. Mislabelling it `fetch_failed` would send an operator hunting for a network fault that does not exist. */
  it('records a rest_json mapping that fits no record as preview_failed, not fetch_failed', async () => {
    fake.body = JSON.stringify([{ employee: { id: 'E-1' } }])
    const source = await makeSource({
      kind: 'rest_json',
      url: 'https://hr.example.test/api/people',
      config: { recordsPath: '', pagination: { mode: 'none' } },
      columnMapping: { 'employee.id': 'employeeId', 'nowhere.at.all': 'primaryEmail' },
    })

    await expect(service.run(source, { commit: false, actor })).rejects.toThrow(/absent from every record/)

    const after = await sources.findById(source.id)
    expect(after?.lastRunOutcome).toBe('preview_failed')
  })

  it('fetches, maps, previews and commits — one batchId across every audit row, auth header delivered, secret confined to it', async () => {
    const tagA = nextTag()
    const tagB = nextTag()
    fake.body = feedCsv([personRow(tagA), personRow(tagB, { TITLE: 'Engineer' })])
    const source = await makeSource()

    const report = await service.run(source, { commit: true, actor })

    expect(report.outcome).toBe('committed')
    expect(report.preview?.summary).toMatchObject({ toCreate: 2, toUpdate: 0, failed: 0 })
    expect(report.commit).toMatchObject({ created: 2, updated: 0, failed: 0 })
    expect(report.batchId).toBeTruthy()
    expect(await userCountFor([`E-${tagA}`, `E-${tagB}`])).toBe(2)

    // The unmapped PAYROLL_BAND column never crossed the boundary.
    const { rows: created } = await ctx.pool.query<{ attributes: Record<string, unknown> }>(
      'SELECT attributes FROM users WHERE employee_id = $1',
      [`E-${tagA}`],
    )
    expect(created[0].attributes).toEqual({})

    // One shared batchId: both user:create rows AND the hr_source:sync run row.
    const { rows: batchRows } = await ctx.pool.query<{ action: string }>(
      'SELECT action FROM audit_log WHERE batch_id = $1 ORDER BY id',
      [report.batchId],
    )
    expect(batchRows.map((row) => row.action).sort()).toEqual(['hr_source:sync', 'user:create', 'user:create'])

    // The configured header arrived with the RESOLVED secret value...
    const request = fake.requests.at(-1)
    expect(request?.headers.authorization).toBe(SECRET_VALUE)

    // ...and that value exists NOWHERE else: not in the report, not in the
    // source row's last_run metadata, not in any audit row.
    expect(JSON.stringify(report)).not.toContain(SECRET_VALUE)
    const after = await sources.findById(source.id)
    expect(JSON.stringify(after)).not.toContain(SECRET_VALUE)
    expect(after?.lastRunOutcome).toBe('committed')
    expect(after?.lastRunStartedAt).not.toBeNull()
    expect(after?.lastRunFinishedAt).not.toBeNull()
    expect((after?.lastRunCounts as { batchId?: string }).batchId).toBe(report.batchId)
    const { rows: leaked } = await ctx.pool.query(
      "SELECT id FROM audit_log WHERE before::text LIKE '%' || $1 || '%' OR after::text LIKE '%' || $1 || '%'",
      [SECRET_VALUE],
    )
    expect(leaked).toHaveLength(0)
  })

  it('re-running the identical feed is idempotent — unchanged rows, no duplicate people', async () => {
    const tag = nextTag()
    fake.body = feedCsv([personRow(tag)])
    const source = await makeSource()

    const first = await service.run(source, { commit: true, actor })
    expect(first.commit).toMatchObject({ created: 1 })

    const second = await service.run(source, { commit: true, actor })
    expect(second.outcome).toBe('committed')
    expect(second.commit).toMatchObject({ created: 0, updated: 0, unchanged: 1, failed: 0 })
    expect(await userCountFor([`E-${tag}`])).toBe(1)
  })

  it('a dry run (the default posture) previews and records the run but writes NOTHING about any user', async () => {
    const tag = nextTag()
    fake.body = feedCsv([personRow(tag)])
    const source = await makeSource()

    const report = await service.run(source, { commit: false, actor })

    expect(report.outcome).toBe('previewed')
    expect(report.preview?.summary.toCreate).toBe(1)
    expect(report.commit).toBeNull()
    expect(await userCountFor([`E-${tag}`])).toBe(0)
    const after = await sources.findById(source.id)
    expect(after?.lastRunOutcome).toBe('previewed')
  })

  it('a feed row failing validation aborts the commit by default — nothing committed, outcome recorded', async () => {
    const good = nextTag()
    const bad = nextTag()
    fake.body = feedCsv([personRow(good), personRow(bad, { WORK_EMAIL: 'not-an-email' })])
    const source = await makeSource()

    const report = await service.run(source, { commit: true, actor })

    expect(report.outcome).toBe('aborted_failures')
    expect(report.commit).toBeNull()
    expect(report.reasons[0]).toMatch(/1 of 2 row\(s\) failed the preview/)
    // The GOOD row was not committed either — refuse-and-report, never half-apply.
    expect(await userCountFor([`E-${good}`, `E-${bad}`])).toBe(0)
    const after = await sources.findById(source.id)
    expect(after?.lastRunOutcome).toBe('aborted_failures')

    // The explicit allow-partial override commits the rows that DID resolve.
    const partial = await service.run(source, { commit: true, allowPartial: true, actor })
    expect(partial.outcome).toBe('committed_partial')
    expect(partial.commit).toMatchObject({ created: 1, failed: 1 })
    expect(await userCountFor([`E-${good}`])).toBe(1)
    expect(await userCountFor([`E-${bad}`])).toBe(0)
  })

  it('an oversized body is rejected mid-stream and recorded as fetch_failed', async () => {
    const source = await makeSource()
    fake.body = 'X'.repeat(1024)
    fake.bodyRepeat = 100 // ~100 KiB against the service's 64 KiB cap
    fake.sendContentLength = false // forces the STREAMING cap, not the header short-circuit

    try {
      await expect(service.run(source, { commit: true, actor })).rejects.toThrow(ValidationError)
    } finally {
      fake.bodyRepeat = 1
      fake.sendContentLength = true
    }

    const after = await sources.findById(source.id)
    expect(after?.lastRunOutcome).toBe('fetch_failed')
    expect(JSON.stringify(after?.lastRunCounts)).toContain('too large')
  })

  it('the mass-change guard trips when the feed would update a large fraction of existing people — and force overrides it', async () => {
    // Seed a small population through the pipeline itself.
    const tags = Array.from({ length: 8 }, () => nextTag())
    fake.body = feedCsv(tags.map((tag) => personRow(tag)))
    const source = await makeSource({ blastRadiusThreshold: 20, blastRadiusFloor: 5 })
    const seed = await service.run(source, { commit: true, actor })
    expect(seed.outcome).toBe('committed')

    // The same 8 people back with a changed title: 8 updates, well over 20%
    // of this test database's population and over the floor of 5.
    fake.body = feedCsv(tags.map((tag) => personRow(tag, { TITLE: 'Retitled' })))
    const report = await service.run(source, { commit: true, actor })

    expect(report.outcome).toBe('aborted_blast_radius')
    expect(report.commit).toBeNull()
    expect(report.blastRadius?.tripped).toBe(true)
    expect(report.reasons[0]).toMatch(/blast-radius guard tripped/)
    const { rows: untouched } = await ctx.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM users WHERE employee_id = ANY($1) AND job_title = 'Retitled'",
      [tags.map((tag) => `E-${tag}`)],
    )
    expect(untouched[0].count).toBe(0)
    const after = await sources.findById(source.id)
    expect(after?.lastRunOutcome).toBe('aborted_blast_radius')

    // The explicit override applies it — and is visible in the run record.
    const forced = await service.run(source, { commit: true, force: true, actor })
    expect(forced.outcome).toBe('committed')
    expect(forced.commit?.updated).toBe(8)
    const { rows: retitled } = await ctx.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM users WHERE employee_id = ANY($1) AND job_title = 'Retitled'",
      [tags.map((tag) => `E-${tag}`)],
    )
    expect(retitled[0].count).toBe(8)
  })

  it('a disabled source may preview but refuses to commit', async () => {
    const tag = nextTag()
    fake.body = feedCsv([personRow(tag)])
    const source = await makeSource({ enabled: false })

    const preview = await service.run(source, { commit: false, actor })
    expect(preview.outcome).toBe('previewed')

    await expect(service.run(source, { commit: true, actor })).rejects.toThrow(/disabled/)
    expect(await userCountFor([`E-${tag}`])).toBe(0)
  })

  it('upstream failure statuses are recorded as fetch_failed and never crash the run record', async () => {
    const source = await makeSource()
    fake.status = 503
    try {
      await expect(service.run(source, { commit: false, actor })).rejects.toThrow(/upstream responded 503/)
    } finally {
      fake.status = 200
    }
    const after = await sources.findById(source.id)
    expect(after?.lastRunOutcome).toBe('fetch_failed')
  })
})
