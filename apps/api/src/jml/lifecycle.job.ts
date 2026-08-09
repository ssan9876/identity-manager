import { Inject, Injectable } from '@nestjs/common'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { AuditWriter } from '../audit/audit.writer'
import { DB_CLIENT } from '../common/db.token'
import { InvalidTransitionError, NotFoundError } from '../common/errors'
import * as schema from '../db/schema/index'
import { KeycloakAdminClient } from '../keycloak/keycloak-admin.client'
import { revokeKeycloakAccessBestEffort } from '../keycloak/revoke-access'
import { OutboxWriter } from '../outbox/outbox.writer'
import { snapshotUser } from '../users/users.controller'
import { type User, UsersRepository } from '../users/users.repository'
import { JmlRulesRepository } from './jml-rules.repository'
import { RuleApplier } from './rule-applier'
import { matchRules } from './rule-engine'

/**
 * One due user this run could NOT action, and why — finding M5
 * (docs/archive/audits/audit-integrity.md): before the `pending -> deactivated`
 * transition fix (UsersRepository.ALLOWED_TRANSITIONS), a never-onboarded
 * leaver was skipped this way on EVERY run, forever, with the only trace a
 * `console.warn` nobody watching the process's stdout would ever see. That
 * specific cause is now closed, but the catch-and-skip machinery itself
 * stays — a genuine race (the row changed between the SELECT and this
 * transaction) is still possible and still must not abort the whole run —
 * so the report, not a log line, is now the record of anything left
 * unactioned, for `lifecycle-cli.ts` (or any other caller) to surface
 * instead of silently moving on.
 */
export interface LifecycleSkip {
  userId: string
  phase: 'activate' | 'deactivate'
  reason: string
}

export interface LifecycleReport {
  activatedUserIds: string[]
  deactivatedUserIds: string[]
  ruleActionsApplied: number
  /** Every due user this run selected but could not transition. Empty on a clean run — never silently dropped. */
  skipped: LifecycleSkip[]
}

/** Today's date as an ISO `YYYY-MM-DD` string, in UTC — `Date#toISOString` always renders UTC regardless of the host process's local timezone, so this is stable across environments. */
function isoToday(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * The date-driven join/leave half of joiner/mover/leaver automation —
 * Milestone 7, Task 7. An on-demand script, in the same style as
 * `db:migrate` (db/migrate-cli.ts) and the reconciliation job
 * (outbox/reconcile-cli.ts) — see `lifecycle-cli.ts`, the runtime entrypoint
 * that actually invokes `run()` against a real database/Keycloak.
 *
 * ALSO SCHEDULED since 2026-08-08 (sync-diagnostics spec):
 * `deploy/systemd/idm-lifecycle.timer` runs it daily at 02:00. Until that
 * timer existed, nothing on any host invoked this job at all — no cron
 * entry, no unit — so a joiner with a `start_date` was never activated, and
 * because every connector derives `desiredEnabled` from
 * `status === 'active'` (sync.worker.ts), they were asserted into Keycloak
 * and every other target as a DISABLED account and stayed that way. Still
 * no in-process timer and no scheduler inside the API: the unit invokes
 * `lifecycle-cli.ts` exactly as an operator would, so there is one code path
 * whether a human or systemd starts it.
 *
 * IDEMPOTENCY is structural, not a separate tracked flag: `run()` re-derives
 * "who is due" from `UsersRepository`'s two lifecycle queries EVERY time it
 * runs, and each query's own WHERE clause (`status = 'pending'` /
 * `status <> 'deactivated'`) excludes exactly the users a PRIOR run already
 * transitioned — see those methods' own doc comments. A second run the same
 * day therefore selects zero rows for anyone already handled, so it performs
 * zero further mutations, writes zero further audit rows, and fires zero
 * further trigger rules for them. This is also why rule-firing is done
 * INLINE with each query's own loop (`fireTriggerRules`, below) rather than
 * as a separate pass: a user only ever appears in that loop on the ONE run
 * that actually transitions them, so `start_date_reached`/`end_date_reached`
 * rules fire exactly once per user, ever, with no extra bookkeeping.
 *
 * Like `RuleApplier` (see its own doc comment), this writes `actorUserId:
 * null` on every audit row — a trusted, on-demand system script, not a
 * request from an authenticated principal, so there is no `PermissionEngine`
 * check to perform.
 */
@Injectable()
export class LifecycleJob {
  constructor(
    @Inject(UsersRepository) private readonly usersRepository: UsersRepository,
    @Inject(JmlRulesRepository) private readonly rulesRepository: JmlRulesRepository,
    @Inject(RuleApplier) private readonly applier: RuleApplier,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
    @Inject(OutboxWriter) private readonly outboxWriter: OutboxWriter,
    @Inject(KeycloakAdminClient) private readonly keycloak: KeycloakAdminClient,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async run(today: string = isoToday()): Promise<LifecycleReport> {
    const { transitioned: activated, skipped: activateSkipped } = await this.activateDueUsers(today)
    const { transitioned: deactivated, skipped: deactivateSkipped } = await this.deactivateDueUsers(today)

    let ruleActionsApplied = 0
    for (const user of activated) {
      ruleActionsApplied += await this.fireTriggerRules('start_date_reached', user)
    }
    for (const user of deactivated) {
      ruleActionsApplied += await this.fireTriggerRules('end_date_reached', user)
    }

    return {
      activatedUserIds: activated.map((user) => user.id),
      deactivatedUserIds: deactivated.map((user) => user.id),
      ruleActionsApplied,
      skipped: [...activateSkipped, ...deactivateSkipped],
    }
  }

  /**
   * Transitions every `pending` user whose `start_date` has arrived to
   * `active`, one user per transaction (mutation + audit row + outbox event
   * together — the same shape `UsersController`'s own write handlers use).
   * `InvalidTransitionError` is caught and skipped rather than aborting the
   * whole run: a benign race (the row moved on between the SELECT above and
   * this transaction) must never take down processing for every OTHER due
   * user in the same pass. Finding M5 (docs/archive/audits/audit-integrity.md):
   * a skip is still recorded into the returned report, not just logged —
   * see `LifecycleSkip`'s own doc comment for why silent skipping was itself
   * part of the finding, independent of the specific `pending ->
   * deactivated` cause that made this branch fire on EVERY run.
   */
  private async activateDueUsers(
    today: string,
  ): Promise<{ transitioned: User[]; skipped: LifecycleSkip[] }> {
    const due = await this.usersRepository.listPendingWithStartDateOnOrBefore(today)
    const activated: User[] = []
    const skipped: LifecycleSkip[] = []

    for (const candidate of due) {
      try {
        const updated = await this.db.transaction(async (tx) => {
          const current = await this.usersRepository.findById(candidate.id, tx)
          if (current === null) {
            throw new NotFoundError('user', candidate.id)
          }

          const updated = await this.usersRepository.changeStatus(candidate.id, 'active', tx)

          await this.auditWriter.record(tx, {
            actorUserId: null,
            action: 'jml:lifecycle_activate',
            resourceType: 'user',
            resourceId: candidate.id,
            before: snapshotUser(current),
            after: snapshotUser(updated),
          })

          await this.outboxWriter.record(tx, {
            aggregateType: 'user',
            aggregateId: candidate.id,
            eventType: 'status_changed',
            payload: { ...snapshotUser(updated), action: 'jml:lifecycle_activate' },
          })

          return updated
        })

        activated.push(updated)
      } catch (error) {
        if (error instanceof InvalidTransitionError) {
          console.warn(`[jml:lifecycle] skipped activation for ${candidate.id} — ${error.message}`)
          skipped.push({ userId: candidate.id, phase: 'activate', reason: error.message })
          continue
        }
        throw error
      }
    }

    return { transitioned: activated, skipped }
  }

  /**
   * Transitions every not-yet-`deactivated` user whose `end_date` has passed
   * to `deactivated`, then performs SYNCHRONOUS Keycloak revocation
   * (`setEnabled(false)` + `revokeSessions`) immediately after that user's
   * own transaction commits — never before, and never gating it — so a
   * session dies before this method moves on to the next candidate, exactly
   * matching `UsersController.deactivate`'s synchronous-revocation contract
   * (Milestone 4, Task 4) for a human-driven deactivation. The outbox event
   * written inside the transaction is the durability fallback either way —
   * see `revokeKeycloakAccessBestEffort`'s doc comment.
   */
  private async deactivateDueUsers(
    today: string,
  ): Promise<{ transitioned: User[]; skipped: LifecycleSkip[] }> {
    const due = await this.usersRepository.listNonDeactivatedWithEndDateOnOrBefore(today)
    const deactivated: User[] = []
    const skipped: LifecycleSkip[] = []

    for (const candidate of due) {
      try {
        const updated = await this.db.transaction(async (tx) => {
          const current = await this.usersRepository.findById(candidate.id, tx)
          if (current === null) {
            throw new NotFoundError('user', candidate.id)
          }

          const updated = await this.usersRepository.changeStatus(candidate.id, 'deactivated', tx)

          await this.auditWriter.record(tx, {
            actorUserId: null,
            action: 'jml:lifecycle_deactivate',
            resourceType: 'user',
            resourceId: candidate.id,
            before: snapshotUser(current),
            after: snapshotUser(updated),
          })

          await this.outboxWriter.record(tx, {
            aggregateType: 'user',
            aggregateId: candidate.id,
            eventType: 'status_changed',
            payload: { ...snapshotUser(updated), action: 'jml:lifecycle_deactivate' },
          })

          return updated
        })

        await revokeKeycloakAccessBestEffort(this.keycloak, updated.username, '[jml:lifecycle]')
        deactivated.push(updated)
      } catch (error) {
        if (error instanceof InvalidTransitionError) {
          console.warn(`[jml:lifecycle] skipped deactivation for ${candidate.id} — ${error.message}`)
          skipped.push({ userId: candidate.id, phase: 'deactivate', reason: error.message })
          continue
        }
        throw error
      }
    }

    return { transitioned: deactivated, skipped }
  }

  /** Evaluates and applies every enabled rule for `trigger` against `user`; returns how many actions were applied. */
  private async fireTriggerRules(
    trigger: 'start_date_reached' | 'end_date_reached',
    user: User,
  ): Promise<number> {
    const rules = await this.rulesRepository.listEnabledByTrigger(trigger)
    const matches = matchRules(rules, user, trigger)

    let applied = 0
    for (const match of matches) {
      const result = await this.applier.apply(match, user.id)
      if (result.applied) {
        applied += 1
      }
    }
    return applied
  }
}
