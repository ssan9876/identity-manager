import { Inject, Injectable } from '@nestjs/common'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { AuditWriter } from '../audit/audit.writer'
import { DB_CLIENT } from '../common/db.token'
import { InvalidTransitionError, NotFoundError } from '../common/errors'
import * as schema from '../db/schema/index'
import { OutboxWriter } from '../outbox/outbox.writer'
import { sensitiveAttributeKeys, snapshotUser, snapshotUserForAudit } from './users.controller'
import { UsersRepository } from './users.repository'

/** One candidate the run selected but could not action, and why — never silently dropped (finding M5, docs/archive/audits/audit-integrity.md, which established that a silent skip is itself the defect). */
export interface BulkActivateSkip {
  userId: string
  reason: string
}

export interface BulkActivateReport {
  /** How many `pending` users the selector matched, before any were actioned. */
  candidates: number
  /** True when nothing was mutated — `apply` was not passed. */
  dryRun: boolean
  activatedUserIds: string[]
  skipped: BulkActivateSkip[]
}

export interface BulkActivateOptions {
  /**
   * An org-unit `path` (ltree), narrowing the run to that unit and its
   * descendants. Omitted means the WHOLE directory — see `run`'s doc
   * comment for why that is deliberately not the CLI's default.
   */
  scopePath?: string
  /** False (the default at every call site) performs no writes at all. */
  apply: boolean
}

/**
 * Activates `pending` users in bulk — the backfill counterpart to
 * `UsersController.activate`, which handles one person from the console.
 *
 * This exists because the single-user endpoint, on its own, does not scale
 * to the situation that motivated it: a directory where hundreds of people
 * were created without a `start_date` and are therefore unreachable by
 * `LifecycleJob` forever (see `UsersRepository.listPending`'s doc comment).
 * Clicking Activate several hundred times is not a migration path.
 *
 * Mirrors `LifecycleJob` deliberately, rather than inventing a second shape
 * for the same kind of work:
 *
 *   - ONE TRANSACTION PER USER (mutation + audit row + outbox event
 *     together), never one transaction for the whole run. A single
 *     long transaction over hundreds of rows would hold row locks for its
 *     entire duration and roll back every success on one late failure.
 *   - `InvalidTransitionError` is CAUGHT and recorded as a skip, not
 *     rethrown. A benign race — the row moved on between the SELECT and its
 *     transaction — must never take down processing for every other user in
 *     the same pass.
 *   - Skips are returned in the report, not just logged, so the caller
 *     (and a monitored cron wrapper) sees them without grepping output.
 *
 * Makes NO Keycloak call, for the same reason `UsersController.activate`
 * does not: propagation is the outbox's job, and `ReconciliationJob`
 * converges independently. A bulk run therefore enqueues one
 * `status_changed` event per activated user and returns immediately,
 * rather than blocking on hundreds of sequential REST calls.
 *
 * Audits as `user:bulk_activate`, distinct from the console's
 * `user:activate` and from `jml:lifecycle_activate`. All three land a user
 * on `active`; an auditor reading the log should be able to tell which one
 * did it — an operator's backfill, a named administrator's click, and the
 * scheduler are three materially different answers to "who let this person
 * in", and collapsing them would destroy that distinction permanently in an
 * append-only log.
 */
@Injectable()
export class BulkActivateJob {
  constructor(
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
    @Inject(OutboxWriter) private readonly outboxWriter: OutboxWriter,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * `apply: false` selects and counts but writes nothing — the caller can
   * see the blast radius before authorising it. The CLI defaults to it, the
   * same "applying anything at all is explicit" posture
   * `target-reconcile-cli.ts` already establishes for this codebase.
   */
  async run(options: BulkActivateOptions): Promise<BulkActivateReport> {
    const candidates = await this.users.listPending(options.scopePath)
    // Once per run, outside the per-candidate loop and its transactions —
    // finding C1 for the placement, SEC-M1 for why it is needed at all.
    const sensitiveKeys = sensitiveAttributeKeys(
      await this.users.listActiveAttributeDefinitions(),
    )

    if (!options.apply) {
      return {
        candidates: candidates.length,
        dryRun: true,
        activatedUserIds: [],
        skipped: [],
      }
    }

    const activatedUserIds: string[] = []
    const skipped: BulkActivateSkip[] = []

    for (const candidate of candidates) {
      try {
        await this.db.transaction(async (tx) => {
          // Re-read INSIDE the transaction rather than trusting the
          // selection snapshot — `before` in the audit row must be the row
          // this transaction actually acted on, not one read moments
          // earlier that may have changed since.
          const current = await this.users.findById(candidate.id, tx)
          if (current === null) {
            throw new NotFoundError('user', candidate.id)
          }

          const updated = await this.users.changeStatus(candidate.id, 'active', tx)

          await this.auditWriter.record(tx, {
            actorUserId: null,
            action: 'user:bulk_activate',
            resourceType: 'user',
            resourceId: candidate.id,
            before: snapshotUserForAudit(current, sensitiveKeys),
            after: snapshotUserForAudit(updated, sensitiveKeys),
          })

          await this.outboxWriter.record(tx, {
            aggregateType: 'user',
            aggregateId: candidate.id,
            eventType: 'status_changed',
            payload: { ...snapshotUser(updated), action: 'user:bulk_activate' },
          })
        })

        activatedUserIds.push(candidate.id)
      } catch (error) {
        // Only a transition refusal is survivable — that is the benign
        // race this loop exists to tolerate. Anything else (a connection
        // failure, a constraint violation) is a real fault and must abort
        // the run rather than be quietly counted as a skip.
        if (error instanceof InvalidTransitionError || error instanceof NotFoundError) {
          skipped.push({ userId: candidate.id, reason: error.message })
          continue
        }
        throw error
      }
    }

    return { candidates: candidates.length, dryRun: false, activatedUserIds, skipped }
  }
}
