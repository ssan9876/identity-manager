import { Inject, Injectable, type OnApplicationShutdown, Optional } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import * as schema from '../db/schema/index'
import { externalIdentities } from '../db/schema/external-identities'
import { GroupsRepository } from '../groups/groups.repository'
import { KeycloakAdminClient } from '../keycloak/keycloak-admin.client'
import { UsersRepository } from '../users/users.repository'
import { type ClaimedOutboxEvent, OutboxRepository } from './outbox.repository'
import type { DbHandle } from './outbox.writer'

export const SYNC_WORKER_CONFIG = Symbol('SYNC_WORKER_CONFIG')

export interface SyncWorkerConfig {
  /** Attempts (including the first) after which an event is dead-lettered. */
  maxAttempts: number
  /** Base of the exponential backoff, before jitter. */
  baseDelayMs: number
  /** Hard ceiling on the backoff delay, before jitter. */
  maxDelayMs: number
  /** Idle time between drain passes once `start()` finds nothing to do. */
  pollIntervalMs: number
}

const DEFAULT_CONFIG: SyncWorkerConfig = {
  maxAttempts: 8,
  baseDelayMs: 2_000,
  maxDelayMs: 10 * 60_000,
  pollIntervalMs: 5_000,
}

/**
 * Exponential backoff with EQUAL jitter (delay is always in
 * `[exponential/2, exponential]`, never a near-zero retry and never
 * perfectly synchronized across many failing events — the classic
 * thundering-herd risk of naive exponential backoff with no jitter at all).
 * `attempts` is 1-based (the count AFTER the failure that just happened, as
 * written to the row) so the very first retry already backs off by roughly
 * `baseDelayMs`, not 0. `random` is injectable so callers can pin it in a
 * test; defaults to `Math.random`.
 *
 * A pure function, exported and unit-tested directly with no database or
 * network involved — the same reasoning `buildSyncedAttributes`
 * (keycloak-admin.client.ts) is a standalone export rather than inlined.
 */
export function computeBackoffDelayMs(
  attempts: number,
  config: Pick<SyncWorkerConfig, 'baseDelayMs' | 'maxDelayMs'>,
  random: () => number = Math.random,
): number {
  const exponential = config.baseDelayMs * 2 ** Math.max(0, attempts - 1)
  const capped = Math.min(exponential, config.maxDelayMs)
  const half = capped / 2
  return Math.round(half + random() * half)
}

/**
 * Drains `outbox_events` into Keycloak — the heart of Milestone 4.
 *
 * THE central design rule, everywhere below: reconcile to DESIRED STATE,
 * read fresh from Postgres, every single time. `event.payload` is consulted
 * in exactly one place (`reconcileMembership`, to know WHOM a membership
 * edge change might affect) and even there it is used only as a pointer to
 * re-read from — never as a value written anywhere. This is what makes
 * every retry, and every re-application of an already-`done` event, safe:
 * applying the same event twice re-derives and re-asserts the same state,
 * producing no different outcome the second time. See `reconcileUser`.
 *
 * Registered in AppModule (Milestone 4, Task 4) as an ordinary provider, but
 * `start()` is never called by DI/Nest lifecycle hooks — only `main.ts`'s
 * `bootstrap()` calls it, gated by `env.syncWorkerEnabled`. That is what
 * keeps it from running during tests: `vitest run` never executes
 * `main.ts` (every spec file builds its own `Test.createTestingModule`, or
 * — for `app.module.spec.ts` — compiles the real `AppModule` but only ever
 * calls `app.init()`, never `bootstrap()`), so a `SyncWorker` instance may
 * be freely CONSTRUCTED by DI in any test without ever being STARTED.
 * `onApplicationShutdown` below (Nest's standard shutdown hook, wired via
 * `app.enableShutdownHooks()` in main.ts) calls `stop()` unconditionally —
 * safe even when `start()` was never called (see `stop()`'s own doc
 * comment) — so a test that constructs the app and calls `app.close()`
 * (e.g. app.module.spec.ts) exercises that path harmlessly too.
 */
@Injectable()
export class SyncWorker implements OnApplicationShutdown {
  private readonly config: SyncWorkerConfig
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private currentRun: Promise<void> = Promise.resolve()

  constructor(
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
    @Inject(OutboxRepository) private readonly outboxRepository: OutboxRepository,
    @Inject(UsersRepository) private readonly usersRepository: UsersRepository,
    @Inject(GroupsRepository) private readonly groupsRepository: GroupsRepository,
    @Inject(KeycloakAdminClient) private readonly keycloak: KeycloakAdminClient,
    @Optional() @Inject(SYNC_WORKER_CONFIG) config?: Partial<SyncWorkerConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  // -------------------------------------------------------------------
  // One event, start to finish
  // -------------------------------------------------------------------

  /**
   * Claims and processes AT MOST one event. Returns `'idle'` when there was
   * nothing claimable (the caller should back off before polling again).
   *
   * The claim, the Keycloak reconciliation, and the final status write all
   * happen inside ONE transaction — see `OutboxRepository.claimNext`'s doc
   * comment for why that is exactly what makes a crashed worker's claim
   * releasable. `applyEvent` itself runs in a NESTED transaction
   * (`tx.transaction`, a savepoint — see GroupsRepository.addChildGroup's
   * doc comment for confirmation this is how Drizzle's node-postgres driver
   * implements nesting): if it throws, only ITS writes roll back; the outer
   * transaction is left healthy so the retry/dead-letter bookkeeping below
   * can still commit. Without this nesting, a genuine Postgres-level error
   * partway through a multi-user membership fan-out would poison the whole
   * transaction and the `catch` block's own bookkeeping writes would fail
   * too, silently losing the attempt/error record this method exists to
   * guarantee.
   */
  async runOnce(): Promise<'processed' | 'idle'> {
    let didWork = false

    await this.db.transaction(async (tx) => {
      const claimed = await this.outboxRepository.claimNext(tx)
      if (claimed === null) {
        return
      }
      didWork = true

      try {
        await tx.transaction(async (nested) => {
          await this.applyEvent(nested, claimed)
        })
        await this.outboxRepository.markDone(tx, claimed.id)
      } catch (error) {
        await this.recordFailure(tx, claimed, error)
      }
    })

    return didWork ? 'processed' : 'idle'
  }

  /**
   * Backoff + dead-letter bookkeeping for one failed attempt. Never
   * rethrows: this always ends in a normal (non-throwing) return so
   * `runOnce`'s outer transaction commits the bookkeeping instead of rolling
   * it back — a failed Keycloak call must be RECORDED, not lost.
   */
  private async recordFailure(tx: DbHandle, claimed: ClaimedOutboxEvent, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    const attempts = claimed.attempts + 1

    if (attempts >= this.config.maxAttempts) {
      await this.outboxRepository.markFailed(tx, claimed.id, { attempts, lastError: message })
      if (claimed.aggregateType === 'user') {
        await this.markUserSyncFailed(tx, claimed.aggregateId)
      }
      return
    }

    const nextAttemptAt = new Date(Date.now() + computeBackoffDelayMs(attempts, this.config))
    await this.outboxRepository.markForRetry(tx, claimed.id, { attempts, nextAttemptAt, lastError: message })
  }

  /**
   * Regresses an ALREADY-synced user's `external_identities` row to
   * `'failed'` once their event is dead-lettered — see that column's own
   * doc comment (db/schema/external-identities.ts) for why this is a
   * regression of an existing row, not a fresh insert: with no prior
   * successful sync there is no Keycloak id to store (the column is
   * `NOT NULL`), and the dead-lettered `outbox_events` row itself already
   * makes the failure visible/queryable regardless. A no-op UPDATE
   * (0 rows) when no row exists yet is the correct outcome for that case,
   * not an error.
   *
   * Deliberately only called for a DIRECT `user`-aggregate event — a
   * dead-lettered `membership`/`group` event can fan out across several
   * users (see `reconcileMembership`/`reconcileGroup`) and, because it
   * failed partway through, does not cleanly identify which of them are
   * actually out of sync. That gap is closed by Task 4's on-demand
   * reconciliation job, not by this worker.
   */
  private async markUserSyncFailed(tx: DbHandle, userId: string): Promise<void> {
    await tx
      .update(externalIdentities)
      .set({ syncState: 'failed', updatedAt: new Date() })
      .where(and(eq(externalIdentities.userId, userId), eq(externalIdentities.system, 'keycloak')))
  }

  // -------------------------------------------------------------------
  // Reconciliation — one branch per aggregate type
  // -------------------------------------------------------------------

  private async applyEvent(tx: DbHandle, event: ClaimedOutboxEvent): Promise<void> {
    switch (event.aggregateType) {
      case 'user':
        await this.reconcileUser(tx, event.aggregateId)
        return
      case 'group':
        await this.reconcileGroup(tx, event.aggregateId)
        return
      case 'membership':
        await this.reconcileMembership(tx, event)
        return
      case 'org_unit':
        // Org units have no Keycloak-side representation in this milestone
        // — KeycloakAdminClient has no concept of one, and no user
        // attribute is derived from org-unit fields — so there is nothing
        // to reconcile. The event still exists and is drained (marked
        // `done`) so it does not sit `pending` forever.
        return
    }
  }

  /**
   * Reconciles ONE user's full desired Keycloak state: profile fields,
   * `enabled`, default-deny-filtered attributes, and flattened effective
   * group membership — then records the result in `external_identities`.
   * Called directly for a `user`-aggregate event, and indirectly (fanned
   * out) from `reconcileGroup`/`reconcileMembership` — every caller ends up
   * here because this is the ONE place a user's sync actually completes.
   *
   * Reads `users` fresh via `tx` and reasserts the WHOLE desired state on
   * every call, never a delta — calling this twice in a row for the same
   * user is a no-op the second time (proven by the idempotence test).
   */
  private async reconcileUser(tx: DbHandle, userId: string): Promise<void> {
    const user = await this.usersRepository.findById(userId, tx)
    if (user === null) {
      // There is no delete for users (terminal status is `deactivated`) —
      // see UsersRepository.changeStatus's doc comment. A missing row here
      // means `userId` never named a real user, which should not happen
      // from any real mutation path; surface it as a genuine, visible
      // failure (retried, then dead-lettered) rather than silently
      // skipping it.
      throw new Error(`sync worker: no user found for id ${userId}`)
    }

    const definitions = await this.usersRepository.listActiveAttributeDefinitions(tx)

    // Only an 'active' user is treated as a live principal anywhere else in
    // this system (PermissionEngine.resolveActor requires it). Mirroring
    // that here keeps a pending/suspended/deactivated user's Keycloak
    // account disabled — blocking login — until they are genuinely active.
    // Suspend/deactivate additionally get a SYNCHRONOUS setEnabled(false)
    // call on the request path (Task 4); this eventual-consistency pass is
    // what converges everything else, including re-enabling on
    // reactivation, and is the only path that ever flips it back to true.
    const desiredEnabled = user.status === 'active'

    const existing = await this.keycloak.findUserByUsername(user.username)
    let keycloakUserId: string
    if (existing === null) {
      const created = await this.keycloak.createUser(
        {
          username: user.username,
          email: user.primaryEmail,
          firstName: user.firstName,
          lastName: user.lastName,
          enabled: desiredEnabled,
          attributes: user.attributes,
        },
        definitions,
      )
      keycloakUserId = created.id
    } else {
      await this.keycloak.updateUser(
        user.username,
        {
          email: user.primaryEmail,
          firstName: user.firstName,
          lastName: user.lastName,
          attributes: user.attributes,
        },
        definitions,
      )
      // updateUser deliberately excludes `enabled` (see its own doc
      // comment) — asserted separately so it converges independently of
      // the rest of the profile.
      await this.keycloak.setEnabled(user.username, desiredEnabled)
      keycloakUserId = existing.id
    }

    await this.syncEffectiveGroups(tx, user.id, user.username)

    await tx
      .insert(externalIdentities)
      .values({
        userId: user.id,
        system: 'keycloak',
        externalId: keycloakUserId,
        lastSyncedAt: new Date(),
        syncState: 'synced',
      })
      .onConflictDoUpdate({
        target: [externalIdentities.userId, externalIdentities.system],
        set: {
          externalId: keycloakUserId,
          lastSyncedAt: new Date(),
          syncState: 'synced',
          updatedAt: new Date(),
        },
      })
  }

  /**
   * Pushes EFFECTIVE membership, flattened — settled decision (see the
   * milestone plan / progress ledger): our groups are a nested DAG,
   * Keycloak's are a flat-by-name tree (`ensureGroup` maps one Keycloak
   * group per local group, at the realm's top level; see its own doc
   * comment), so a user in a nested child group is pushed into EVERY
   * ancestor group in Keycloak too, via `listEffectiveGroupsForUser`. This
   * is recomputed fresh on every call — never cached, never taken from an
   * event payload — so it is correct regardless of how many membership
   * edges have changed since this user's Keycloak state was last synced.
   *
   * `setUserGroups` (Task 2) diffs against Keycloak's actual current
   * membership and issues only the adds/removes needed, so calling this
   * with an unchanged desired set is a zero-write no-op.
   *
   * Takes `tx` and threads it into both `GroupsRepository` reads below —
   * finding C1 (docs/superpowers/audit-integrity.md): this method runs from
   * inside `reconcileUser`, itself always inside the worker's own open
   * transaction (the outer claim transaction, or the nested savepoint for a
   * fanned-out call — see `runOnce`'s doc comment). Defaulting either read
   * to the pool here would check out a second connection for the lifetime
   * of a query that runs while the worker's own transaction connection is
   * still held, permanently pinning 2 of the pool's connections per
   * in-flight claim while `SyncWorker` drains — the same shape as the HTTP
   * write handlers' fix, just for the worker's own transaction instead of a
   * request's.
   */
  private async syncEffectiveGroups(tx: DbHandle, userId: string, username: string): Promise<void> {
    const effectiveGroupIds = await this.groupsRepository.listEffectiveGroupsForUser(userId, tx)
    const localGroups =
      effectiveGroupIds.length === 0
        ? []
        : await this.groupsRepository.listByIds(
            effectiveGroupIds,
            { limit: effectiveGroupIds.length, offset: 0, scopePaths: null },
            tx,
          )

    const keycloakGroupIds: string[] = []
    for (const group of localGroups) {
      const keycloakGroup = await this.keycloak.ensureGroup(group.name)
      keycloakGroupIds.push(keycloakGroup.id)
    }

    await this.keycloak.setUserGroups(username, keycloakGroupIds)
  }

  /**
   * A group's own `created`/`updated` event. `ensureGroup` keeps a
   * Keycloak group of the CURRENT name existing — but Task 2's client has
   * no rename/delete primitive, so a rename alone would otherwise leave
   * every existing member pointing at a stale, orphaned Keycloak group
   * under the OLD name until something else re-synced them. Re-running
   * `reconcileUser` (idempotent — a no-op for anyone already correct) for
   * every CURRENTLY effective member closes that gap immediately instead
   * of waiting for the on-demand reconciliation job.
   *
   * KNOWN LIMIT, documented rather than closed (task-4-brief.md, Task 3
   * concern (b) — cheap-or-document, not expand): this still only reaches
   * members effective AT THE MOMENT this event is processed. A user removed
   * from the group in the same window, before this event runs, is not
   * fanned out to here (they are no longer in `listEffectiveUserMembers`'s
   * result) — closing that would need this event to know who was a member
   * BEFORE the removal, which nothing here currently records. `SyncState
   * Repository`'s own doc comment documents the identical limit on the
   * READ-model side. `ReconciliationJob` (Milestone 4, Task 4,
   * outbox/reconciliation.job.ts) is the actual general backstop for both:
   * it compares every user's CURRENT desired groups against Keycloak's
   * CURRENT actual ones directly, independent of which fan-out did or
   * did not reach them.
   */
  private async reconcileGroup(tx: DbHandle, groupId: string): Promise<void> {
    const group = await this.groupsRepository.findById(groupId, tx)
    if (group === null) {
      throw new Error(`sync worker: no group found for id ${groupId}`)
    }

    await this.keycloak.ensureGroup(group.name)

    const memberIds = await this.groupsRepository.listEffectiveUserMembers(groupId, tx)
    for (const memberId of memberIds) {
      await this.reconcileUser(tx, memberId)
    }
  }

  /**
   * A `membership_changed` event, anchored on the PARENT group's id (see
   * OutboxWriter's/GroupsController's doc comments) — a pure edge change
   * with no aggregate row of its own to re-read. `payload` is used here
   * ONLY to identify WHOM the edge change might affect, never as the source
   * of what to write — every affected user's actual desired groups are
   * still recomputed fresh inside `reconcileUser`. This is not "replaying
   * the delta": it is the same kind of indirection `aggregateId` itself
   * provides for a `user`/`group` event (a pointer to re-read from), just
   * carried in `payload` because a membership edge has no id column of its
   * own to be the aggregateId.
   *
   * `payload.userId` (direct user add/remove) names the single affected
   * user directly. `payload.childGroupId` (child-group add/remove) affects
   * every user EFFECTIVELY under that child today — traversal starts from
   * the child, which is never removed by this edge change, so it remains
   * discoverable regardless of whether the edge itself was just added or
   * removed (contrast trying to traverse from the PARENT after a removal,
   * which would no longer reach the very users who just lost membership).
   */
  private async reconcileMembership(tx: DbHandle, event: ClaimedOutboxEvent): Promise<void> {
    const payload = event.payload as { userId?: unknown; childGroupId?: unknown }
    const affected = new Set<string>()

    if (typeof payload.userId === 'string') {
      affected.add(payload.userId)
    }
    if (typeof payload.childGroupId === 'string') {
      const members = await this.groupsRepository.listEffectiveUserMembers(payload.childGroupId, tx)
      for (const memberId of members) {
        affected.add(memberId)
      }
    }

    for (const userId of affected) {
      await this.reconcileUser(tx, userId)
    }
  }

  // -------------------------------------------------------------------
  // Draining and the start/stop lifecycle
  // -------------------------------------------------------------------

  /** Calls `runOnce` until it reports `'idle'`. Returns how many it processed. */
  async drain(maxIterations = 10_000): Promise<number> {
    let processed = 0
    for (let i = 0; i < maxIterations; i++) {
      const result = await this.runOnce()
      if (result === 'idle') {
        break
      }
      processed++
    }
    return processed
  }

  /**
   * Starts a background polling loop: drain the whole backlog, then wait
   * `pollIntervalMs` before draining again. Idempotent — calling `start`
   * while already started does nothing.
   *
   * Called only from `main.ts`'s `bootstrap()` (Milestone 4, Task 4), gated
   * by `env.syncWorkerEnabled` — never from a Nest lifecycle hook on this
   * class itself, which is what keeps every test safe (see this class's
   * file-level doc comment).
   */
  start(): void {
    if (!this.stopped) {
      return
    }
    this.stopped = false
    this.scheduleTick(0)
  }

  /** `true` once `start()` has run and `stop()` has not yet fully settled. */
  get isRunning(): boolean {
    return !this.stopped
  }

  private scheduleTick(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.currentRun = this.tick()
    }, delayMs)
  }

  private async tick(): Promise<void> {
    if (this.stopped) {
      return
    }
    try {
      await this.drain()
    } catch (error) {
      // A bug in the drain/claim machinery itself, NOT a per-event
      // Keycloak/Postgres failure (already caught and turned into
      // retry/dead-letter bookkeeping inside `runOnce`). Logged and
      // swallowed so one unexpected error cannot silently kill the whole
      // polling loop.
      console.error('[sync.worker] unexpected error during drain', error)
    }
    if (!this.stopped) {
      this.scheduleTick(this.config.pollIntervalMs)
    }
  }

  /**
   * Stops the polling loop and waits for any currently in-flight tick to
   * finish, so a caller can rely on "no further processing happens after
   * `stop()` resolves." Safe to call when already stopped.
   */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.currentRun
  }

  /**
   * Nest's standard shutdown hook — fires on `app.close()`, including the
   * SIGTERM/SIGINT path `main.ts` enables via `app.enableShutdownHooks()`.
   * Unconditional and idempotent: calling `stop()` when `start()` was never
   * invoked is a harmless no-op (see `stop()`'s own doc comment), so this is
   * safe to leave wired up regardless of whether this particular process
   * ever actually started the worker — including every test that constructs
   * an app via DI and closes it (e.g. app.module.spec.ts), where this fires
   * but has nothing to do. This is what satisfies "shut down cleanly... so
   * no in-flight event is left `processing` forever" for a GRACEFUL
   * shutdown; an ungraceful kill (`taskkill /F`, SIGKILL) never reaches this
   * method at all, but is already handled independently at the database
   * level — see OutboxRepository.claimNext's doc comment: the claim lives
   * inside a single open transaction, so a killed process simply never
   * commits the `processing` write, and Postgres reverts the row to
   * `pending` on connection loss.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.stop()
  }
}
