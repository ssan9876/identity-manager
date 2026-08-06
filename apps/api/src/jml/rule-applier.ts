import { Inject, Injectable } from '@nestjs/common'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import { validateAttributes } from '../attributes/attribute-validator'
import { AuditWriter } from '../audit/audit.writer'
import { DB_CLIENT } from '../common/db.token'
import { InvalidTransitionError, ValidationError } from '../common/errors'
import * as schema from '../db/schema/index'
import { GroupsRepository } from '../groups/groups.repository'
import { KeycloakAdminClient } from '../keycloak/keycloak-admin.client'
import { revokeKeycloakAccessBestEffort } from '../keycloak/revoke-access'
import { OutboxWriter } from '../outbox/outbox.writer'
import { snapshotUser } from '../users/users.controller'
import { type User, UsersRepository } from '../users/users.repository'
import type { JmlActionType, MatchedRuleAction } from './rule-engine'

export interface ApplyResult {
  applied: boolean
  skippedReason?: string
}

const groupActionParamsSchema = z.object({ groupId: z.string().uuid() }).strict()
const setAttributeActionParamsSchema = z.object({ key: z.string().min(1), value: z.unknown() }).strict()

type ActionHandler = (
  rule: { id: string; name: string },
  userId: string,
  actionParams: Record<string, unknown>,
) => Promise<ApplyResult>

/**
 * Applies ONE matched rule action — Milestone 7, Task 6. Every handler below
 * goes through the SAME repository write paths every other mutation in this
 * system uses (`UsersRepository`, `GroupsRepository`), inside its own
 * `db.transaction`, writing an audit row and an outbox event together with
 * the mutation — identical shape to `UsersController`/`GroupsController`'s
 * own handlers, just with no HTTP request driving it.
 *
 * `actorUserId` is `null` on every audit row this class writes. There is
 * deliberately no attempt to thread a `PermissionEngine`/`Actor` check
 * through here the way an HTTP handler would: this is a TRUSTED, on-demand
 * system action (invoked only by `LifecycleJob`, itself only ever run
 * on-demand like `db:migrate`/`reconcile` — see that job's own doc comment),
 * not a request from an authenticated principal whose grants need checking.
 * `ReconciliationJob` (Milestone 4) already established this precedent: it
 * writes repair events directly, with no `PermissionEngine` involved either.
 * "No human did this" is the honest audit record for exactly this reason —
 * there is no human actor to check permissions FOR.
 */
@Injectable()
export class RuleApplier {
  constructor(
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(GroupsRepository) private readonly groups: GroupsRepository,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
    @Inject(OutboxWriter) private readonly outboxWriter: OutboxWriter,
    @Inject(KeycloakAdminClient) private readonly keycloak: KeycloakAdminClient,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * The dispatch table for `action`, built the same defensive way as
   * `rule-engine.ts`'s `CONDITION_FIELD_EXTRACTORS`/`OPERATOR_EVALUATORS` and
   * `src/authz/actions.ts`'s `ROLE_PERMISSIONS`/`ROLE_RANK`:
   * `Object.create(null)` plus an `Object.hasOwn` check before ever indexing
   * — see `apply` below. Each entry is a closure over `this` (rather than an
   * unbound method reference) so it can call the corresponding private
   * method with `this` correctly bound, with no separate `.call`/`.bind` at
   * the call site. By the time an action reaches this class,
   * `RuleEngine.matchRules`/`simulate` has ALREADY filtered out any
   * unrecognised action (see rule-engine.ts's `evaluateRule`), so in
   * practice this second check should never actually fire — it exists as
   * defense in depth, exactly like `UsersRepository.translateWriteError`
   * rethrowing anything it does not recognise rather than assuming its own
   * upstream validation is exhaustive.
   */
  private readonly handlers: Record<JmlActionType, ActionHandler> = Object.assign(
    Object.create(null) as Record<JmlActionType, ActionHandler>,
    {
      add_to_group: (rule, userId, actionParams) => this.applyAddToGroup(rule, userId, actionParams),
      remove_from_group: (rule, userId, actionParams) =>
        this.applyRemoveFromGroup(rule, userId, actionParams),
      set_attribute: (rule, userId, actionParams) => this.applySetAttribute(rule, userId, actionParams),
      deactivate: (rule, userId, actionParams) => this.applyDeactivate(rule, userId, actionParams),
    } satisfies Record<JmlActionType, ActionHandler>,
  )

  async apply(matched: MatchedRuleAction, userId: string): Promise<ApplyResult> {
    if (!Object.hasOwn(this.handlers, matched.action)) {
      console.warn(
        `[jml] rule ${matched.ruleId} ("${matched.ruleName}") has unknown action "${matched.action}" — skipped`,
      )
      return { applied: false, skippedReason: 'unknown_action' }
    }

    const handler = this.handlers[matched.action]
    return handler({ id: matched.ruleId, name: matched.ruleName }, userId, matched.actionParams)
  }

  /**
   * `resourceType`/`resourceId` on the audit row are the GROUP's, not the
   * user's — same anchor `GroupsController.addMember` already uses for a
   * human-driven add (see its own doc comment: membership is a fact about
   * the group's roster). `GroupsRepository.addUser` is itself idempotent
   * (`onConflictDoNothing`), so re-applying this action for a user already
   * in the group writes a fresh audit/outbox row but changes no membership
   * state — acceptable here because, like every JML action, this is only
   * ever reached via a trigger firing (see LifecycleJob), and a trigger only
   * fires once per idempotent script run (see that job's own doc comment on
   * why re-running it writes no new rows).
   */
  private async applyAddToGroup(
    rule: { id: string; name: string },
    userId: string,
    actionParams: Record<string, unknown>,
  ): Promise<ApplyResult> {
    const parsed = groupActionParamsSchema.safeParse(actionParams)
    if (!parsed.success) {
      console.warn(`[jml] rule ${rule.id} ("${rule.name}") add_to_group actionParams invalid — skipped`)
      return { applied: false, skippedReason: 'invalid_action_params' }
    }
    const { groupId } = parsed.data

    await this.db.transaction(async (tx) => {
      await this.groups.addUser(groupId, userId, tx)

      await this.auditWriter.record(tx, {
        actorUserId: null,
        action: 'jml:add_to_group',
        resourceType: 'group',
        resourceId: groupId,
        before: null,
        after: { groupId, userId, ruleId: rule.id, ruleName: rule.name },
      })

      await this.outboxWriter.record(tx, {
        aggregateType: 'membership',
        aggregateId: groupId,
        eventType: 'membership_changed',
        payload: { groupId, userId, action: 'jml:add_to_group', ruleId: rule.id },
      })
    })

    return { applied: true }
  }

  private async applyRemoveFromGroup(
    rule: { id: string; name: string },
    userId: string,
    actionParams: Record<string, unknown>,
  ): Promise<ApplyResult> {
    const parsed = groupActionParamsSchema.safeParse(actionParams)
    if (!parsed.success) {
      console.warn(`[jml] rule ${rule.id} ("${rule.name}") remove_from_group actionParams invalid — skipped`)
      return { applied: false, skippedReason: 'invalid_action_params' }
    }
    const { groupId } = parsed.data

    await this.db.transaction(async (tx) => {
      await this.groups.removeUser(groupId, userId, tx)

      await this.auditWriter.record(tx, {
        actorUserId: null,
        action: 'jml:remove_from_group',
        resourceType: 'group',
        resourceId: groupId,
        before: { groupId, userId, ruleId: rule.id, ruleName: rule.name },
        after: null,
      })

      await this.outboxWriter.record(tx, {
        aggregateType: 'membership',
        aggregateId: groupId,
        eventType: 'membership_changed',
        payload: { groupId, userId, action: 'jml:remove_from_group', ruleId: rule.id },
      })
    })

    return { applied: true }
  }

  /**
   * MERGES `{ [key]: value }` onto the user's existing attributes — same
   * merge contract `SelfServiceController.update` uses, and for the same
   * reason: writing this single key wholesale as the user's entire
   * `attributes` column would silently erase every OTHER attribute an admin
   * (or a previous rule) had already set. Validated through
   * `validateAttributes` against every ACTIVE definition (not filtered to
   * `self_editable`, unlike self-service — this is a system/admin-equivalent
   * actor, not the user editing their own profile), so a rule cannot set an
   * attribute key that is not a recognised, active definition — the same
   * default-deny attribute-propagation constraint every other write path in
   * this system already honours. An unrecognised/inactive key is a
   * misconfigured rule, not a crash: fail closed, log, and report
   * `skippedReason: 'invalid_attribute'`.
   */
  private async applySetAttribute(
    rule: { id: string; name: string },
    userId: string,
    actionParams: Record<string, unknown>,
  ): Promise<ApplyResult> {
    const parsed = setAttributeActionParamsSchema.safeParse(actionParams)
    if (!parsed.success) {
      console.warn(`[jml] rule ${rule.id} ("${rule.name}") set_attribute actionParams invalid — skipped`)
      return { applied: false, skippedReason: 'invalid_action_params' }
    }
    const { key, value } = parsed.data

    const definitions = await this.users.listActiveAttributeDefinitions()
    let validated: Record<string, unknown>
    try {
      validated = validateAttributes(definitions, { [key]: value })
    } catch (error) {
      if (error instanceof ValidationError) {
        console.warn(
          `[jml] rule ${rule.id} ("${rule.name}") set_attribute key "${key}" is not a recognised, active, user attribute — skipped`,
        )
        return { applied: false, skippedReason: 'invalid_attribute' }
      }
      throw error
    }

    let result: ApplyResult = { applied: false, skippedReason: 'user_not_found' }

    await this.db.transaction(async (tx) => {
      const current = await this.users.findById(userId, tx)
      if (current === null) {
        return
      }

      const updated = await this.users.update(
        userId,
        { attributes: { ...current.attributes, ...validated } },
        tx,
      )

      await this.auditWriter.record(tx, {
        actorUserId: null,
        action: 'jml:set_attribute',
        resourceType: 'user',
        resourceId: userId,
        before: snapshotUser(current),
        after: snapshotUser(updated),
      })

      await this.outboxWriter.record(tx, {
        aggregateType: 'user',
        aggregateId: userId,
        eventType: 'updated',
        payload: { ...snapshotUser(updated), action: 'jml:set_attribute', ruleId: rule.id },
      })

      result = { applied: true }
    })

    return result
  }

  /**
   * Goes through `UsersRepository.changeStatus` — the ONLY path to
   * `deactivated` (see that method's own doc comment) — so the same atomic
   * transition matrix every other deactivation in this system relies on
   * applies here too. `InvalidTransitionError` (e.g. the user is already
   * deactivated) is caught and treated as a benign, idempotent no-op rather
   * than propagated: a `deactivate` JML action firing twice for the same
   * user (once directly, once via a second rule, or via a re-run — see
   * LifecycleJob) must never crash the run over a target that is already in
   * the desired end state.
   *
   * Synchronous Keycloak revocation runs AFTER the local transaction
   * commits, exactly like `UsersController.deactivate` (see
   * `revokeKeycloakAccessBestEffort`'s own doc comment for the full
   * reasoning) — never before, and never gating this method's own success:
   * the outbox event written inside the transaction below is the durability
   * fallback regardless of whether the synchronous attempt lands.
   */
  private async applyDeactivate(
    rule: { id: string; name: string },
    userId: string,
    _actionParams: Record<string, unknown>,
  ): Promise<ApplyResult> {
    let outcome: { updated: User | null; alreadyTerminal: boolean } = {
      updated: null,
      alreadyTerminal: false,
    }

    await this.db.transaction(async (tx) => {
      const current = await this.users.findById(userId, tx)
      if (current === null) {
        return
      }

      try {
        const updated = await this.users.changeStatus(userId, 'deactivated', tx)

        await this.auditWriter.record(tx, {
          actorUserId: null,
          action: 'jml:deactivate',
          resourceType: 'user',
          resourceId: userId,
          before: snapshotUser(current),
          after: snapshotUser(updated),
        })

        await this.outboxWriter.record(tx, {
          aggregateType: 'user',
          aggregateId: userId,
          eventType: 'status_changed',
          payload: { ...snapshotUser(updated), action: 'jml:deactivate', ruleId: rule.id },
        })

        outcome = { updated, alreadyTerminal: false }
      } catch (error) {
        if (error instanceof InvalidTransitionError) {
          outcome = { updated: null, alreadyTerminal: true }
          return
        }
        throw error
      }
    })

    if (outcome.updated === null) {
      return {
        applied: false,
        skippedReason: outcome.alreadyTerminal ? 'already_deactivated' : 'user_not_found',
      }
    }

    await revokeKeycloakAccessBestEffort(this.keycloak, outcome.updated.username, '[jml:rule-applier]')

    return { applied: true }
  }
}
