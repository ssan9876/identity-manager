import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Controller, Get, HttpException, HttpStatus, Inject } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import { MIGRATIONS_FOLDER } from '../db/migrate'
import type * as schema from '../db/schema/index'

/**
 * What `database` can report. Two values, both coarse on purpose — see the
 * controller's doc comment on why this vocabulary is closed.
 */
export type DatabaseCheck = 'ok' | 'unreachable'

/**
 * What `migrations` can report. `pending` means the ledger is provably
 * BEHIND the journal this build ships; `unknown` means the question could
 * not be answered at all (ledger unreadable, journal missing). Both are
 * not-ready — they differ only in what an operator should go look at.
 */
export type MigrationsCheck = 'ok' | 'pending' | 'unknown'

export interface ReadinessBody {
  status: 'ready' | 'not_ready'
  checks: {
    database: DatabaseCheck
    migrations: MigrationsCheck
  }
}

interface JournalEntry {
  idx: number
  when: number
  tag: string
}

interface Journal {
  entries: JournalEntry[]
}

/**
 * Where drizzle records what it has applied. Schema and table are drizzle's
 * own defaults, which `runMigrations` (db/migrate.ts) accepts by passing
 * only `migrationsFolder` — spelled out here because this controller READS
 * that ledger and would silently answer `unknown` forever if a future
 * migrate call started overriding them.
 */
const LEDGER = 'drizzle.__drizzle_migrations'

/**
 * Readiness — deliberately a DIFFERENT question from liveness.
 *
 * `GET /health` answers "is this process alive": it is dependency-free and
 * returns 200 as soon as Nest is serving. That is the right answer for a
 * restart supervisor and the wrong answer for a load balancer, and the gap
 * between the two caused a real incident: `systemctl is-active` reports a
 * `Type=simple` unit active the instant the process forks, seconds before
 * Nest binds the port, so the deploy script had to poll `/health` in a retry
 * loop to discover something no endpoint actually stated. `/health/ready`
 * states it.
 *
 * WHAT IT CHECKS
 *
 * 1. The database answers a trivial query. Not "the DSN parses" or "a pool
 *    object exists" — a round trip, as the runtime role, through the same
 *    pool request handlers use. Nothing this service does is meaningful
 *    without it.
 * 2. The applied-migration ledger is not behind the migration journal this
 *    build ships. An instance running new code against an old schema is up,
 *    is connected, and must not serve: it will 500 on the columns it expects
 *    and, worse, may write rows the old schema constrains differently. This
 *    is precisely the window a rolling deploy opens — new code starts, then
 *    `db:migrate` runs — and the only readiness signal that closes it.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK
 *
 * - Outbound connectors: Keycloak, the mail server, SCIM/Entra/Google/AD
 *   targets. A readiness probe that fails when Keycloak is down converts
 *   somebody else's partial outage into a total outage of THIS service:
 *   every instance drops out of rotation simultaneously, and the console,
 *   the audit log, the approval queues and every read path — none of which
 *   touch Keycloak — become unreachable for no reason. It also misattributes
 *   the fault, pointing an on-call engineer at this app when the problem is
 *   next door. The outbox exists exactly so that target outages are absorbed
 *   asynchronously and retried; readiness must not undo that design.
 * - Outbox depth / sync-worker progress. A backlog is a metric to alert on,
 *   not a reason to refuse HTTP traffic — and refusing traffic cannot drain
 *   it. See this endpoint's sibling discussion of metrics.
 * - Anything O(n): no row counts, no scans, no locks. This is polled every
 *   few seconds, forever, by every probe in the deployment.
 *
 * WHAT IT RETURNS, AND WHY THAT SHAPE
 *
 * 200 `{status:'ready', checks:{...}}`; 503 `{status:'not_ready',
 * checks:{...}}`. 503 (not 500) because "not ready" is a correct, expected
 * answer about deployment state rather than a bug — the same reading
 * `NOT_CONFIGURED` already gets in `DomainExceptionFilter`, and the status
 * every load balancer and `kubelet` already interprets as "take me out of
 * rotation".
 *
 * The body is a CLOSED vocabulary of literal strings and nothing else. This
 * route is unauthenticated — it must be, since the probes that call it (a
 * shell script with curl, a systemd unit, a kubelet) hold no token, and
 * `guard-coverage.spec.ts` records that exemption by controller name. So the
 * failure body is readable by anyone who can reach the port, and the one
 * thing it must never do is stringify the caught error: pg's messages carry
 * hosts, ports, role names and occasionally the connection string. Naming
 * two coarse subsystems tells an operator where to look while telling an
 * attacker nothing that `docs/` does not already say out loud. The full
 * error goes to the process log instead, where it is already privileged.
 *
 * WHY A SEPARATE CONTROLLER, AND WHY `/health/ready`
 *
 * Separate class: `guard-coverage.spec.ts` enumerates every controller by
 * name and lists the ones allowed to be unauthenticated. Hanging a second
 * open route off `HealthController` would have widened the unauthenticated
 * surface with no test noticing; a new controller cannot be added to the
 * graph without that spec failing until someone approves the exemption in
 * writing. Keeping liveness dependency-free is the other half of it — the
 * class that answers "am I alive" should not acquire a database handle.
 *
 * Under `/health` rather than a top-level `/ready`: the probe surface stays
 * one prefix, so a reverse proxy or firewall can expose (or block) all of it
 * with a single `location /health` rule instead of tracking each new probe
 * as it is added.
 */
@Controller('health')
export class ReadinessController {
  /**
   * Last failure signature written to the log, so a probe polling a broken
   * instance every two seconds does not write the same line 43,000 times a
   * day. Reset on recovery, so a fault that returns is reported again.
   */
  private lastLogged: string | null = null

  constructor(
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  @Get('ready')
  async ready(): Promise<ReadinessBody> {
    const checks = await this.probe()

    if (checks.database === 'ok' && checks.migrations === 'ok') {
      this.lastLogged = null
      return { status: 'ready', checks }
    }

    throw new HttpException(
      { status: 'not_ready', checks } satisfies ReadinessBody,
      HttpStatus.SERVICE_UNAVAILABLE,
    )
  }

  private async probe(): Promise<ReadinessBody['checks']> {
    try {
      await this.db.execute(sql`SELECT 1`)
    } catch (error) {
      // The migration check needs the same connection, so there is nothing
      // left to say about it — `unknown`, not `pending`: we did not find the
      // schema to be behind, we failed to ask.
      this.log('database', error)
      return { database: 'unreachable', migrations: 'unknown' }
    }

    return { database: 'ok', migrations: await this.checkMigrations() }
  }

  /**
   * Compares the newest journal entry this build ships against the newest
   * row in the ledger, which is drizzle's OWN criterion for what is
   * outstanding: `migrate()` applies every entry whose `when` exceeds
   * `MAX(created_at)`. Using the same rule means "ready" is exactly
   * "`db:migrate` would do nothing", rather than a second, subtly different
   * definition of up-to-date that could disagree with the migrator.
   *
   * The journal is read from disk on every call rather than cached at
   * import: this app is deployed and run from source (`start:e2e` runs
   * `src/main.ts` with `apps/api` as the working directory, the same
   * assumption `MIGRATIONS_FOLDER` already encodes), so the file on disk is
   * the build's real answer even after an in-place update, and a ~4 KB read
   * is far cheaper than the database round trip beside it.
   */
  private async checkMigrations(): Promise<MigrationsCheck> {
    let expected: number
    try {
      const raw = await readFile(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')
      const journal = JSON.parse(raw) as Journal
      const entries = journal.entries ?? []
      if (entries.length === 0) {
        // No migrations exist in this build at all (the pre-first-generate
        // state `runMigrations` also handles). Nothing to be behind.
        return 'ok'
      }
      expected = Math.max(...entries.map((entry) => entry.when))
    } catch (error) {
      // Fail CLOSED. An instance that cannot establish which schema version
      // it was built for cannot promise it is safe to serve, and a probe
      // that answers "ready" when it does not know is worse than one that
      // answers "no".
      this.log('journal', error)
      return 'unknown'
    }

    try {
      const result = await this.db.execute<{ applied: string | null }>(
        sql.raw(`SELECT max(created_at)::text AS applied FROM ${LEDGER}`),
      )
      const applied = result.rows[0]?.applied
      if (applied === undefined || applied === null) {
        // Ledger present but empty: migrations have never run here.
        return 'pending'
      }
      return Number(applied) >= expected ? 'ok' : 'pending'
    } catch (error) {
      // Ledger missing, or unreadable by the runtime role (it holds only the
      // grants `provisionRuntimeRole` hands out — including, since this
      // endpoint exists, SELECT on the ledger). Either way the question is
      // unanswered, not answered "yes".
      this.log('ledger', error)
      return 'unknown'
    }
  }

  private log(subject: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    const signature = `${subject}: ${message}`
    if (this.lastLogged === signature) return
    this.lastLogged = signature
    console.warn(`[readiness] not ready — ${signature}`)
  }
}
