import { Inject, Injectable, type OnApplicationShutdown, Optional } from '@nestjs/common'
import { and, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { AttributeTargetMappingsRepository } from '../attributes/attribute-target-mappings.repository'
import { DB_CLIENT } from '../common/db.token'
import { buildTargetAttributes, computeCoreFieldValues } from '../connectors/attribute-mapping'
import { ConnectorRegistry } from '../connectors/connector-registry'
import { OrganizationConnector } from '../connectors/organization.connector'
import type { DesiredGroup, DesiredUser, DirectoryGroupConnector } from '../connectors/connector'
import { NotApplicableError } from '../connectors/connector'
import { connectorTargets } from '../db/schema/connector-targets'
import { groups } from '../db/schema/groups'
import * as schema from '../db/schema/index'
import { externalGroupIdentities } from '../db/schema/external-group-identities'
import { externalIdentities } from '../db/schema/external-identities'
import { organizations } from '../db/schema/organizations'
import { externalSsoAppIdentities } from '../db/schema/external-sso-app-identities'
import { userTargetAccounts } from '../db/schema/user-target-accounts'
import { type Group, GroupsRepository } from '../groups/groups.repository'
import { KeycloakAdminClient } from '../keycloak/keycloak-admin.client'
import { KeycloakAdminClientFactory } from '../keycloak/keycloak-admin-client.factory'
import { OrgUnitsRepository } from '../org-units/org-units.repository'
import { SsoAppsRepository } from '../sso-apps/sso-apps.repository'
import { type User, UsersRepository } from '../users/users.repository'
import { DeferredError } from './deferred.error'
import { NotFoundError } from '../common/errors'
import { type ClaimedOutboxEvent, OutboxRepository } from './outbox.repository'
import type { DbHandle, OutboxTarget } from './outbox.writer'

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
 * The high 32 bits of the per-user advisory lock key `reconcileUser` takes
 * (see its own doc comment) — paired with `pg_advisory_xact_lock(key1, key2)`
 * so the resulting 64-bit key space is disjoint from
 * `GroupsRepository.GROUP_GRAPH_LOCK_ID` (0x1d3a_0001), which uses the
 * single-bigint-argument form: Postgres packs that form's `bigint` as
 * `(key1 << 32) | key2`, so any single-bigint value below 2^32 — as
 * `GROUP_GRAPH_LOCK_ID` is — always has high bits `0` and can never collide
 * with a two-argument call whose first argument is this nonzero namespace.
 */
const SYNC_USER_LOCK_NAMESPACE = 0x1d3a_0002

/**
 * Targets whose connector needs `DesiredUser.existingExternalId`/
 * `managedAttributeRemoteNames` — see either field's own doc comment
 * (connectors/connector.ts) for the full reasoning. A closed-set array
 * checked via `.includes`, never an object-keyed catalog lookup — no
 * `Object.hasOwn`/`Object.create(null)` hazard applies here (that defence
 * is specific to INDEXING an object by an untrusted key, e.g.
 * `ConnectorRegistry.factories`/`groupFactories`; this is a fixed,
 * developer-written array checked with `.includes` against a value, never
 * used as an index). Milestone 11, Task 5 introduced this gate scoped to
 * `active_directory` alone; Milestone 12, Task 7 widened it to a real array
 * shared by two targets (`entra_id` gains the SAME two fields for a
 * DIFFERENT but analogous reason: Microsoft Graph's `id` is immutable
 * exactly like AD's `objectGUID` — `userPrincipalName`/`mail` both move —
 * and Graph's `PATCH` is a partial update exactly like LDAP's `modify`, a
 * name dropped from the request body left untouched, never cleared,
 * confirmed directly against Graph's own "Update user" doc); Milestone 13,
 * Task 8 widens it a THIRD time to `google_workspace`, for the identical
 * reasoning again: Google's own `id` is immutable exactly like AD's
 * `objectGUID`/Graph's `id` (`primaryEmail` moves — this task's own binding
 * rule), and the Admin SDK's `users.update` is a partial update exactly
 * like LDAP's `modify`/Graph's `PATCH` — confirmed directly against
 * https://developers.google.com/admin-sdk/directory/reference/rest/v1/users/update's
 * own "you only need to include the fields you wish to update... fields
 * set to null will be cleared" text, independently of Graph's own,
 * separately-confirmed identical-shaped gap.
 */
// SPLIT (sub-project 4) from a single `TARGETS_NEEDING_IMMUTABLE_ID_CORRELATION`
// that gated BOTH `existingExternalId` and `managedAttributeRemoteNames`
// together. They were ever one constant only because the three vendor targets
// above happen to need both; `mail_server` needs exactly one of them, and
// gating them together would buy it a per-event
// `listAllRemoteNamesForTarget` query for data it never reads.
//
// `mail_server` needs THIS half because its eligibility branch must tell
// "never had mail" from "had mail, now revoked" — see
// `MailServerConnector.apply`'s own doc comment. Without it an ineligible
// user would be PUT unconditionally, and the counterpart's upsert CREATES on
// first write: a mailbox for someone who should never have had one, their
// address reserved against future collisions, then deactivated.
const TARGETS_NEEDING_EXTERNAL_ID_CORRELATION: readonly OutboxTarget[] = [
  'active_directory',
  'entra_id',
  'google_workspace',
  'mail_server',
]

/** Targets that additionally need every remote name ever mapped for them, so one whose mapping was just disabled can be actively CLEARED — see `DesiredUser.managedAttributeRemoteNames`'s own doc comment for why omitting a key is not enough against a partial-update API. Membership is unchanged by the split above. */
const TARGETS_NEEDING_MANAGED_ATTRIBUTE_NAMES: readonly OutboxTarget[] = [
  'active_directory',
  'entra_id',
  'google_workspace',
]

/**
 * Targets whose own status model has more than the two states `enabled`
 * expresses — see `DesiredUser.status`'s own doc comment for why collapsing
 * four lifecycle values into a boolean is data loss for the mail target
 * specifically. Its own gate rather than a reuse of either constant above:
 * these are unrelated questions about a target, and `mail_server` happens to
 * answer them differently.
 */
const TARGETS_NEEDING_FULL_STATUS: readonly OutboxTarget[] = ['mail_server']

/**
 * MILESTONE 18, TASK 14/15 - one target's provisioning mode, plus which
 * users hold an account entitlement for it, resolved ONCE and handed to
 * `buildDesiredUser` (which resolves it itself when given nothing).
 *
 * Exists so `TargetReconciliationJob` can pay for the entitlement read ONCE
 * PER RUN rather than once per user while walking an entire directory, and
 * so the answer it plans against is the same answer the apply phase asserts
 * - the identical "one implementation of desired state, never two that can
 * drift" reason `buildDesiredUser` itself was extracted for (see its own
 * doc comment).
 *
 * `entitledUserIds` is meaningless - and always empty - when `mode` is
 * `all_users`: nothing consults it, because on an `all_users` target every
 * user's account is desired regardless of any entitlement, which is exactly
 * what makes that mode a bit-for-bit reproduction of pre-business-roles
 * behaviour.
 */
export interface TargetProvisioning {
  mode: 'all_users' | 'entitled_only'
  entitledUserIds: ReadonlySet<string>
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
  private readonly connectorRegistry: ConnectorRegistry
  private readonly attributeTargetMappingsRepository: AttributeTargetMappingsRepository
  private readonly orgUnitsRepository: OrgUnitsRepository
  private readonly ssoAppsRepository: SsoAppsRepository
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
    // Milestone 10, Task 2 — appended AFTER `config`, and OPTIONAL, so every
    // pre-existing call site (raw `new SyncWorker(db, ..., keycloak)`, with
    // or without a 6th `config` argument — reconcile-cli.ts, reconciliation.
    // spec.ts, revocation.spec.ts, and this file's own `makeWorker`) keeps
    // compiling unchanged. When omitted, this worker builds its OWN registry
    // wrapping the SAME `keycloak` instance it was already given — including
    // a test's `unreachableClient()`/`GatedKeycloakAdminClient` substitute —
    // so every existing Keycloak-focused test keeps exercising the exact
    // client it configured, now reached one layer further in (through
    // `KeycloakConnector`) rather than called directly. Nest DI supplies a
    // real, properly-wired one in production (see app.module.ts) — this
    // default only matters for the raw-constructor call sites above.
    @Optional() @Inject(ConnectorRegistry) connectorRegistry?: ConnectorRegistry,
    // Milestone 10, Task 3 — same trailing-optional-with-fallback-default
    // shape as `connectorRegistry` immediately above, for the identical
    // reason: every pre-existing raw `new SyncWorker(...)` call site
    // (reconcile-cli.ts, reconciliation.spec.ts, revocation.spec.ts,
    // connector-secrets.spec.ts, this file's own `makeWorker`) keeps
    // compiling and behaving unchanged. Both default to a fresh instance
    // bound to the SAME `db` this worker itself was given (the `db`
    // PARAMETER above, not `this.db` — referencing an earlier constructor
    // parameter in a later one's default/body is fine; `this` is not yet
    // initialised at this point, but these are plain `??` fallbacks
    // evaluated in the body, not parameter defaults). Nest DI supplies both
    // real, already-registered providers in production (app.module.ts) —
    // this default only matters for the raw-constructor call sites above.
    @Optional() @Inject(AttributeTargetMappingsRepository)
    attributeTargetMappingsRepository?: AttributeTargetMappingsRepository,
    @Optional() @Inject(OrgUnitsRepository) orgUnitsRepository?: OrgUnitsRepository,
    @Optional() @Inject(SsoAppsRepository) ssoAppsRepository?: SsoAppsRepository,
    // Organizations milestone, Task 14 — same trailing-optional shape as
    // every parameter above, and for the same reason: every raw
    // `new SyncWorker(...)` call site in the suite keeps compiling. Both
    // default to NULL rather than to a constructed instance, because neither
    // can be built without real provisioning credentials — a worker without
    // them simply cannot process an `organization` event, and says so
    // (`reconcileOrganization` below) instead of pretending it can.
    @Optional()
    @Inject(OrganizationConnector)
    private readonly organizationConnector: OrganizationConnector | null = null,
    @Optional()
    @Inject(KeycloakAdminClientFactory)
    private readonly keycloakFactory: KeycloakAdminClientFactory | null = null,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.connectorRegistry = connectorRegistry ?? new ConnectorRegistry(keycloak)
    this.attributeTargetMappingsRepository =
      attributeTargetMappingsRepository ?? new AttributeTargetMappingsRepository(db)
    this.orgUnitsRepository = orgUnitsRepository ?? new OrgUnitsRepository(db)
    this.ssoAppsRepository = ssoAppsRepository ?? new SsoAppsRepository(db)
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
        // Organizations, Task 14. A DEFERRAL is not a failure — see
        // DeferredError's own doc comment. It takes the same backoff as a
        // retry but leaves `attempts` exactly as it was, so waiting on a
        // prerequisite can never exhaust the dead-letter budget. Branched
        // BEFORE `recordFailure` so nothing else about the failure path
        // changes.
        if (error instanceof DeferredError) {
          await this.recordDeferral(tx, claimed, error)
        } else {
          await this.recordFailure(tx, claimed, error)
        }
      }
    })

    return didWork ? 'processed' : 'idle'
  }

  /**
   * Reschedules a DEFERRED event: still `pending`, backed off, with the
   * reason recorded in `last_error` so an operator can see WHY it is
   * waiting — and with `attempts` untouched, which is the whole difference
   * from `recordFailure` below.
   *
   * The backoff is computed from `attempts + 1` rather than `attempts`
   * purely so a first deferral (attempts = 0) waits `baseDelayMs` rather
   * than nothing. Because `attempts` never grows, that delay never grows
   * either: a deferred event polls at a steady ~`baseDelayMs`, which is the
   * right shape for "waiting on something that is actively being created a
   * few rows earlier in this same outbox" and converges within a second or
   * two of the realm landing.
   *
   * `last_error` is a slightly awkward home for a non-error, and it is
   * deliberate: it is the column `/outbox/dead-letters` and every operator
   * runbook already look at, and inventing a `last_deferral` beside it would
   * split one question ("why is this event not done?") across two places.
   * The message always begins with what it is waiting ON, so the two cases
   * read differently at a glance.
   */
  private async recordDeferral(
    tx: DbHandle,
    claimed: ClaimedOutboxEvent,
    error: DeferredError,
  ): Promise<void> {
    const nextAttemptAt = new Date(Date.now() + computeBackoffDelayMs(claimed.attempts + 1, this.config))
    await this.outboxRepository.markForRetry(tx, claimed.id, {
      attempts: claimed.attempts,
      nextAttemptAt,
      lastError: error.message,
    })
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

    // A PERMANENT failure is one no amount of retrying can fix — an address
    // collision, an unhosted domain, a malformed payload. The mail server's
    // own spec asks callers to distinguish these: "409 and 422 are permanent
    // failures the connector should dead-letter rather than retry forever;
    // 5xx is retriable." Retrying them burns the full backoff schedule AND,
    // because ordering is per (aggregate, target), head-of-line blocks every
    // later event for that same principal on that same target for the
    // duration — so one malformed alias would stall a user's mail sync for
    // the ~40 minutes the schedule takes to exhaust.
    //
    // Structural check rather than `instanceof`: the flag is the contract, so
    // any connector can opt in without this generic layer importing a
    // target-specific error type.
    const permanent = (error as { permanent?: unknown } | null)?.permanent === true

    if (permanent || attempts >= this.config.maxAttempts) {
      await this.outboxRepository.markFailed(tx, claimed.id, { attempts, lastError: message })
      if (claimed.aggregateType === 'user') {
        await this.markUserSyncFailed(tx, claimed.aggregateId, claimed.target)
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
   *
   * `target` (Milestone 10, Task 2) scopes the regression to the SAME
   * `external_identities` row `reconcileUser` would have written on success
   * — `system` and `outbox_events.target` share one literal set (see
   * `ConnectorTarget`'s own doc comment), so `claimed.target` is used
   * directly, with no mapping step.
   */
  private async markUserSyncFailed(tx: DbHandle, userId: string, target: OutboxTarget): Promise<void> {
    await tx
      .update(externalIdentities)
      .set({ syncState: 'failed', updatedAt: new Date() })
      .where(and(eq(externalIdentities.userId, userId), eq(externalIdentities.system, target)))
  }

  // -------------------------------------------------------------------
  // Reconciliation — one branch per aggregate type
  // -------------------------------------------------------------------

  /**
   * Dispatches on `event.aggregateType` AND, since Milestone 10 Task 2,
   * `event.target` — every branch below threads `event.target` down into
   * `reconcileUser`/`reconcileGroup`/`reconcileMembership`, which resolve a
   * connector for THAT target via `ConnectorRegistry.resolve` instead of
   * calling `KeycloakAdminClient` directly. This closes the gap Task 1's own
   * report flagged: "claimed non-Keycloak events would be silently
   * misprocessed as Keycloak ones" — a claimed `echo`-targeted event now
   * genuinely reaches `EchoConnector`, never Keycloak, and a target with no
   * registered connector fails loudly (`ConnectorRegistry.resolve` throws,
   * caught by `runOnce`'s existing retry/dead-letter bookkeeping) rather
   * than silently doing the wrong thing.
   */
  private async applyEvent(tx: DbHandle, event: ClaimedOutboxEvent): Promise<void> {
    switch (event.aggregateType) {
      case 'user':
        await this.reconcileUser(tx, event.aggregateId, event.target)
        return
      case 'group':
        await this.reconcileGroup(tx, event.aggregateId, event.target)
        return
      case 'membership':
        await this.reconcileMembership(tx, event)
        return
      case 'sso_app':
        await this.reconcileSsoApp(tx, event.aggregateId, event.target)
        return
      case 'organization':
        await this.reconcileOrganization(tx, event.aggregateId)
        return
      case 'org_unit':
        // Org units have no representation in ANY target in this milestone
        // — no connector's DesiredUser carries anything derived from
        // org-unit fields — so there is nothing to reconcile, regardless of
        // target. The event still exists and is drained (marked `done`) so
        // it does not sit `pending` forever.
        return
    }
  }

  /**
   * Reconciles ONE user's full desired state INTO `target`: profile fields,
   * `enabled`, default-deny-filtered attributes, and flattened effective
   * group membership — asserted via `ConnectorRegistry.resolve(target,
   * tx).apply(desired)` (Milestone 10, Task 2), then recorded in
   * `external_identities`. Called directly for a `user`-aggregate event, and
   * indirectly (fanned out) from `reconcileGroup`/`reconcileMembership` —
   * every caller ends up here because this is the ONE place a user's sync
   * actually completes, for whichever target its own event named.
   *
   * Reads `users` fresh via `tx` and reasserts the WHOLE desired state on
   * every call, never a delta — calling this twice in a row for the same
   * user is a no-op the second time (proven by the idempotence test). Every
   * connector's `apply` shares this same reconcile-to-desired-state
   * contract (`DirectoryConnector`'s own doc comment) — building `desired`
   * ONCE, here, and handing it to whichever connector `target` resolves to,
   * is what keeps that property target-agnostic rather than something each
   * connector has to separately re-earn.
   *
   * FIRST ACTION, before any read: takes a per-user advisory lock scoped to
   * the CALLER's transaction — finding H2 (docs/archive/audits/audit-
   * integrity.md): `OutboxRepository.claimNext` enforces strict ordering
   * only per `(aggregate_type, aggregate_id)`, but a `user`, a `group` and a
   * `membership` event are three DIFFERENT aggregates that all fan into
   * THIS method for the SAME user — `claimNext` therefore happily hands them
   * to different workers in parallel. Without a lock, two workers can each
   * read this user's effective groups, race their own sequence of Keycloak
   * calls, and whichever calls `setUserGroups` LAST wins regardless of who
   * read fresher data — reproduced 20/20 in both directions (an admin's
   * group removal silently restored by a stale concurrent worker) by
   * sync.worker.spec.ts's "cross-aggregate races" tests.
   *
   * `pg_advisory_xact_lock` is held until the END of the OUTER transaction
   * (commit or rollback), never released early by a `ROLLBACK TO SAVEPOINT`
   * — confirmed against Postgres's own documented behaviour and already
   * relied on by `GroupsRepository.addChildGroup`'s identical-shape
   * `GROUP_GRAPH_LOCK_ID` (see its doc comment: "pg_advisory_xact_lock taken
   * inside the savepoint is still scoped to the outer transaction"). `tx`
   * here is frequently the NESTED savepoint `runOnce` opens for
   * `applyEvent` (see that method's doc comment), so taking the lock via
   * `tx` still scopes it to `runOnce`'s own OUTER `db.transaction(...)` —
   * i.e. for as long as THIS worker holds its claim on the triggering event,
   * covering every round trip to the target this call makes, not just the
   * Postgres reads. A second worker calling `reconcileUser` for the SAME
   * `userId` — whether fanned out from a `group`/`membership` event or
   * claimed directly as a `user` event — blocks here until the first
   * worker's whole `runOnce()` transaction ends, then re-reads (this method
   * always re-reads fresh, never trusts a value read before the lock) the
   * now-current state. Serializing per USER, not per aggregate row, is what
   * closes the gap: the three aggregate types are different rows, but they
   * all mutate the same entity's Keycloak state, which is the unit that
   * actually needs to be serialized.
   *
   * `hashtext` takes `text`; the explicit `::text` cast is required because
   * `userId` is otherwise bound as an untyped parameter Postgres cannot
   * resolve to `hashtext`'s single overload without it.
   *
   * Milestone 10, Task 4 — widened from `private` to `public` (no other
   * change) so `TargetReconciliationJob` (connectors/target-reconciliation.
   * job.ts) can call this SAME, already-proven method directly for its own
   * "apply" phase, instead of re-implementing "read fresh, build desired,
   * assert into the connector, record `external_identities`" a second time.
   * That job computes ITS OWN "would this change anything" via `plan()`
   * (see `buildDesiredUser` below for the read half it reuses), then, once
   * its blast-radius guard clears, calls this method once per flagged user
   * — the exact same lock/read/apply/correlate sequence an outbox-driven
   * sync already uses, just invoked synchronously and on demand rather than
   * from a claimed `outbox_events` row. Every precondition documented above
   * (must run inside an open transaction; always re-reads fresh; safe to
   * call twice) holds identically for that caller.
   */
  async reconcileUser(tx: DbHandle, userId: string, target: OutboxTarget): Promise<void> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${SYNC_USER_LOCK_NAMESPACE}, hashtext(${userId}::text))`,
    )

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

    const desired = await this.buildDesiredUser(tx, user, target)

    // Organizations milestone, Task 14 — WHICH REALM does this person live
    // in? Only `keycloak` has an answer: every other target is realm-blind,
    // and a tenant never reaches one anyway (Task 13's fan-out narrowing).
    const realm = target === 'keycloak' ? await this.requireProvisionedRealm(tx, user) : null

    // Per-organization connector targets: resolution is by (organization of
    // the aggregate, target) — the USER's own organization, read from the
    // row this method just re-read, never a caller-supplied value and never
    // any other organization's row. An organization with no row for this
    // target resolves an empty config and fails loudly, exactly like a
    // globally-unconfigured target always did.
    const connector = await this.connectorRegistry.resolve(target, tx, user.organizationId, realm)

    let externalId: string
    try {
      ;({ externalId } = await connector.apply(desired))
    } catch (error) {
      if (error instanceof NotApplicableError) {
        // NOT a failure: this connector has nothing to represent for this
        // user, so there is no id to correlate and nothing to retry. The
        // event completes normally — see NotApplicableError's own doc
        // comment. Every OTHER error falls through to `runOnce`'s existing
        // retry/dead-letter bookkeeping, unchanged.
        return
      }
      throw error
    }

    await tx
      .insert(externalIdentities)
      .values({
        userId: user.id,
        system: target,
        externalId,
        lastSyncedAt: new Date(),
        syncState: 'synced',
      })
      .onConflictDoUpdate({
        target: [externalIdentities.userId, externalIdentities.system],
        set: {
          externalId,
          lastSyncedAt: new Date(),
          syncState: 'synced',
          updatedAt: new Date(),
        },
      })
  }

  /**
   * The Keycloak realm `user` belongs in — `null` for master, or a DEFERRAL
   * if a tenant's realm does not exist yet.
   *
   * MASTER RETURNS `null`, NOT ITS REALM NAME, and is exempt from the
   * deferral. Both halves are deliberate deviations from the milestone plan,
   * which deferred on `realmProvisionedAt === null` alone and routed every
   * user by realm name.
   *
   *  - EXEMPT, because master's `realm_provisioned_at` is null and always
   *    will be. Master's realm ALREADY EXISTS — it is the one named by
   *    `KEYCLOAK_ISSUER` that this API authenticates against — so nothing
   *    ever provisions it and nothing ever stamps that column (see
   *    master-organization.ts's `adoptMasterRealm`, which makes no Keycloak
   *    call at all). Applying the plan's rule literally would defer EVERY
   *    user in every single-tenant deployment, forever, on a realm that has
   *    been there the whole time. The column means "this system created a
   *    realm for this organization"; for master the honest answer is "it did
   *    not have to".
   *  - `null`, because `ConnectorRegistry.resolve` deliberately routes
   *    master through the ONE injected `KeycloakAdminClient` rather than
   *    through the factory (see its own doc comment), so master has no use
   *    for a realm name here. Returning one would be an argument that is
   *    always ignored — and, worse, would make this method depend on
   *    `organizations.realm` having been resolved by startup, which is not
   *    true in any test that never boots `main.ts`.
   *
   * A tenant's `realm` is NOT NULL by construction — the
   * `organizations_realm_present` CHECK permits null for master alone — so
   * the non-null assertion below is a schema guarantee, not an assumption.
   */
  private async requireProvisionedRealm(tx: DbHandle, user: User): Promise<string | null> {
    const [organization] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, user.organizationId))

    if (organization === undefined) {
      // `users.organization_id` is NOT NULL with a foreign key, so this is
      // unreachable short of a corrupt database — a genuine failure, not a
      // deferral, and it must be visible rather than retried silently.
      throw new NotFoundError('organization', user.organizationId)
    }

    if (organization.isMaster) {
      return null
    }

    if (organization.realmProvisionedAt === null) {
      throw new DeferredError(
        `waiting on realm provisioning for organization ${organization.slug}`,
      )
    }

    return organization.realm
  }

  /**
   * Desired state for the REALM itself — the `organization` aggregate's
   * reconcile branch (organizations milestone, Task 14).
   *
   * Re-reads the row rather than replaying the payload, exactly as every
   * other reconcile method here does, so a replayed or out-of-order event
   * converges on what the database currently says rather than on what was
   * true when the event was written.
   *
   * MASTER IS NEVER RECONCILED HERE. `POST /organizations` cannot create
   * master, `PATCH` refuses to change it, and `OrganizationConnector` throws
   * for the master realm on both of its methods — so an `organization` event
   * for master could only come from a hand-written row, and the connector's
   * own refusal is the right answer to that.
   *
   * `realmProvisionedAt` is stamped LAST, after both connector calls have
   * returned. That ordering is what makes the deferral above correct: the
   * column flips to non-null only once the realm genuinely exists and is in
   * the right enabled state, so a user event that reads it can trust it. If
   * either call throws, the whole nested transaction rolls back, the column
   * stays null, and the users of that organization keep deferring — which is
   * exactly right, because their realm still is not there.
   *
   * Re-stamped on EVERY pass, not only the first: `ensureRealm` is
   * idempotent, and a status change (suspend, then reactivate) re-runs this
   * whole method. Treating the column as "when we last confirmed the realm"
   * rather than "when we first made it" is both more useful to an operator
   * and cheaper to reason about than a conditional write.
   */
  async reconcileOrganization(tx: DbHandle, organizationId: string): Promise<void> {
    const [organization] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId))

    if (organization === undefined) {
      throw new NotFoundError('organization', organizationId)
    }
    if (organization.realm === null) {
      // Only master may have a null realm (`organizations_realm_present`),
      // and an `organization` event for master is already a hand-written
      // anomaly — see this method's own doc comment. A genuine failure, so
      // it is visible rather than retried forever as a deferral.
      throw new Error(
        `organization ${organization.slug} has no realm to provision — only the master ` +
          'organization may have a null realm, and it is never provisioned through this path',
      )
    }
    if (this.organizationConnector === null) {
      // A worker built without provisioning credentials cannot create a
      // realm. A real, retryable failure rather than a deferral: no amount
      // of waiting fixes an unconfigured deployment, and dead-lettering it
      // is how the operator finds out. `POST /organizations` refuses up
      // front with NOT_CONFIGURED (Task 12) precisely so this is normally
      // unreachable.
      throw new Error(
        'cannot provision a realm: this worker has no OrganizationConnector — set ' +
          'KEYCLOAK_PROVISION_CLIENT_ID and KEYCLOAK_PROVISION_CLIENT_SECRET',
      )
    }

    await this.organizationConnector.ensureRealm({
      realm: organization.realm,
      displayName: organization.name,
    })

    const enabled = organization.status === 'active'
    await this.organizationConnector.setRealmEnabled(organization.realm, enabled)

    if (!enabled) {
      // Drop the memoized admin client — and the live access token inside
      // it — for a realm this system has just been told to stop
      // administering. `KeycloakAdminClientFactory.forRealm` memoizes
      // forever, so without this a suspended tenant's working admin client
      // would sit in that map for the life of the process. Deliberately
      // AFTER the disable call, which needs that very client.
      this.keycloakFactory?.evict(organization.realm)
    }

    await tx
      .update(organizations)
      .set({ realmProvisionedAt: new Date(), updatedAt: new Date() })
      .where(eq(organizations.id, organizationId))
  }

  /**
   * Computes ONE user's full desired state for `target` — profile fields,
   * `enabled`, and default-deny-filtered attributes/groups — WITHOUT
   * asserting it anywhere. Extracted out of `reconcileUser` in Milestone 10,
   * Task 4 (pure extraction: identical reads, identical order, identical
   * result — `reconcileUser` above is this method's only behavioural
   * change, and it has none) so the SAME "what does desired state look
   * like" computation has exactly one implementation, reused by two very
   * different callers: `reconcileUser` (which goes on to APPLY it) and
   * `TargetReconciliationJob` (connectors/target-reconciliation.job.ts),
   * which calls this directly, hands the result to a connector's `plan()`
   * ONLY, and never applies anything itself during that read-only pass.
   * Keeping this ONE method, rather than two independently-maintained
   * copies, is what stops "what a target's dry-run plan shows" and "what an
   * outbox-driven sync actually asserts" from ever silently drifting apart
   * — precisely the class of bug Milestone 10, Task 3's default-deny work
   * already had to guard against once (see that task's own report).
   *
   * Deliberately does NOT take the advisory lock itself (unlike
   * `reconcileUser`) — a caller wanting a race-free READ, immediately
   * followed by a WRITE, must take it via `reconcileUser`, exactly as
   * before. A caller that only wants to know what desired state currently
   * looks like (a plan/dry-run pass) does not need to serialize against
   * concurrent writers to answer that question, any more than
   * `ReconciliationJob.detectDrift` (Milestone 4, Task 4) needed to lock
   * before comparing against Keycloak — see that method's own doc comment
   * for the identical precedent.
   *
   * Takes an already-loaded `user: User` (not a `userId` to re-fetch) —
   * `reconcileUser` already has one in hand by the time it calls this, and
   * `TargetReconciliationJob`'s own population walk already has one per
   * page from `UsersRepository.list`; neither caller benefits from a
   * redundant re-read here.
   */
  async buildDesiredUser(
    tx: DbHandle,
    user: User,
    target: OutboxTarget,
    targetProvisioning?: TargetProvisioning,
  ): Promise<DesiredUser> {
    // Milestone 10, Task 3 — the per-target, default-deny attribute filter.
    // `mappings` is EVERY enabled `attribute_target_mappings` row for THIS
    // event's own `target`, custom attributes and core fields alike,
    // already remote-name-resolved (ONE round trip — see
    // AttributeTargetMappingsRepository.listForTarget's own doc comment on
    // why that matters specifically here). `orgUnit` backs the
    // `department` core field ("derived from the org path" — see
    // connectors/attribute-mapping.ts's `computeCoreFieldValues` doc
    // comment) and is fetched LAZILY — only when `mappings` actually
    // contains a core-field row for this target, OR `target` is
    // `'active_directory'` (Milestone 11, Task 5 — AD structurally needs the
    // FULL org-unit path to place a principal in the right nested OU, not
    // just the leaf NAME `department` carries; see `DesiredUser.orgUnitPath`'s
    // own doc comment) — rather than unconditionally on every call: no OTHER
    // target seeds a core-field mapping by default (this task's own
    // migration deliberately seeds none for 'keycloak' — see
    // attribute-target-mappings.ts), so this keeps every non-AD target at
    // exactly the SAME round-trip count Milestone 10, Task 3 already
    // calibrated against the timing-sensitive finding-H2 races (see that
    // task's own report — the identical reason this stayed lazy rather than
    // unconditional in the first place). Both reads go through `tx` — never
    // a second pool connection while this worker's own transaction is open
    // (finding C1, docs/archive/audits/audit-integrity.md).
    const mappings = await this.attributeTargetMappingsRepository.listForTarget(target, tx)
    const needsOrgUnit = target === 'active_directory' || mappings.some((mapping) => mapping.source === 'core')
    const orgUnit = needsOrgUnit ? await this.orgUnitsRepository.findById(user.orgUnitId, tx) : null
    const coreFieldValues = computeCoreFieldValues(user, orgUnit)

    // Milestone 11, Task 5 (widened to `entra_id` in Milestone 12, Task 7) —
    // the SAME `needsImmutableIdCorrelation` gate as `orgUnit` immediately
    // above is NOT reused here on purpose: `orgUnitPath` stays AD-only (Graph
    // has no OU-equivalent nested placement concept — `entra_id` never reads
    // that field), but THIS pair of fields is needed by both real targets —
    // see `TARGETS_NEEDING_IMMUTABLE_ID_CORRELATION`'s own doc comment, and
    // `DesiredUser.existingExternalId`'s own doc comment for why AD/Entra
    // need this and Keycloak/echo do not: `apply(desired)` has no
    // `externalId` parameter of its own (Milestone 10, Task 2 — settled
    // interface), so a connector wanting to re-identify a principal by its
    // IMMUTABLE id (never DN/sAMAccountName/mail for AD, never
    // userPrincipalName/mail for Entra) has nowhere else to receive its own
    // past correlation from. One extra indexed lookup —
    // `external_identities_user_system_unique` — paid only by a target that
    // structurally needs it.
    const existingExternalId = TARGETS_NEEDING_EXTERNAL_ID_CORRELATION.includes(target)
      ? await this.findExistingExternalId(tx, user.id, target)
      : undefined

    // Same gate again, for `DesiredUser.managedAttributeRemoteNames`'s own
    // purpose: EVERY remote name ever configured for this target, enabled or
    // not (see `AttributeTargetMappingsRepository.listAllRemoteNamesForTarget`'s
    // own doc comment for why `mappings` above — enabled-only — is the WRONG
    // source here: a mapping that just transitioned to disabled must still be
    // found so its stale AD/Entra value can be actively cleared, and
    // `mappings` no longer contains it the moment it is disabled).
    const managedAttributeRemoteNames = TARGETS_NEEDING_MANAGED_ATTRIBUTE_NAMES.includes(target)
      ? await this.attributeTargetMappingsRepository.listAllRemoteNamesForTarget(target, tx)
      : undefined

    // Only an 'active' user is treated as a live principal anywhere else in
    // this system (PermissionEngine.resolveActor requires it). Mirroring
    // that here keeps a pending/suspended/deactivated user's account
    // disabled in the target — blocking login — until they are genuinely
    // active. Suspend/deactivate additionally get a SYNCHRONOUS
    // setEnabled(false) call against Keycloak on the request path (Task 4);
    // this eventual-consistency pass is what converges everything else,
    // including re-enabling on reactivation, and is the only path that ever
    // flips it back to true.
    //
    // MILESTONE 18, TASK 14 - an ACTIVE user is additionally disabled on an
    // `entitled_only` target they hold no `user_target_accounts` row for.
    // Without this clause the whole of Task 14 would be theatre: losing a
    // business role deletes the entitlement row and enqueues an explicit
    // disable event (see `RoleReconciler.reconcileUser`), and that event
    // lands HERE - where, computing `enabled` from status alone, this
    // method would cheerfully re-assert `enabled: true` and leave exactly
    // the live, unmanaged account the disable existed to close. It is also
    // what makes `TargetReconciliationJob`'s plan and its apply agree about
    // an unentitled user, which is this method's whole reason to be shared
    // between them. On an `all_users` target - the default, and every
    // target until an operator opts one in - `entitled` is unconditionally
    // true and this reduces to the single status check it always was.
    const provisioning =
      targetProvisioning ?? (await this.loadTargetProvisioningForUser(tx, user.organizationId, target, user.id))
    const entitled = provisioning.mode === 'all_users' || provisioning.entitledUserIds.has(user.id)
    const desiredEnabled = user.status === 'active' && entitled

    return {
      userId: user.id,
      username: user.username,
      email: user.primaryEmail,
      firstName: user.firstName,
      lastName: user.lastName,
      enabled: desiredEnabled,
      // The FULL four-value status, for a target that models more than
      // enabled/disabled — see `DesiredUser.status`'s own doc comment for why
      // `desiredEnabled` above cannot stand in for it.
      status: TARGETS_NEEDING_FULL_STATUS.includes(target) ? user.status : undefined,
      // Default-deny filter, computed ONCE here (per-TARGET, since Milestone
      // 10 Task 3 — `mappings` above is already scoped to this event's own
      // `target`) and handed to whichever connector `target` resolves to.
      // See `DesiredUser`'s own doc comment for why this field's SHAPE is
      // unchanged (still `Record<string, string[]>`, keyed by REMOTE name),
      // and KeycloakConnector's doc comment for why that connector's own
      // `createUser`/`updateUser` calls do not need to filter a second time.
      attributes: buildTargetAttributes(mappings, user.attributes, coreFieldValues),
      groups: await this.effectiveGroupNames(tx, user.id),
      orgUnitPath: target === 'active_directory' && orgUnit !== null ? orgUnit.path.split('.') : undefined,
      existingExternalId,
      managedAttributeRemoteNames,
    }
  }

  /**
   * MILESTONE 18, TASK 15 - `target`'s provisioning mode plus, when that
   * mode is `entitled_only`, the FULL set of users holding an account
   * entitlement for it. One read of `connector_targets` and at most one
   * indexed read of `user_target_accounts`
   * (`user_target_accounts_target_idx` is exactly this query), for a whole
   * reconciliation run rather than for each of its users.
   *
   * Both reads go through the caller's `tx` - never a second pooled
   * connection while a transaction is open (finding C1,
   * docs/archive/audits/audit-integrity.md).
   *
   * A target with NO `connector_targets` row falls back to `all_users`.
   * That is deliberately the opposite posture to `TargetReconciliationJob.
   * loadBlastRadiusConfig`, which fails loudly for the same missing row:
   * there, an absent admin-reviewed risk tolerance must never be guessed;
   * here, the fail-safe answer is the one that provisions and enables
   * exactly whom this system enabled before business roles existed. Guessing
   * `entitled_only` for an unconfigured target would disable everybody in it.
   */
  async loadTargetProvisioning(
    tx: DbHandle,
    organizationId: string,
    target: OutboxTarget,
  ): Promise<TargetProvisioning> {
    const mode = await this.loadProvisioningMode(tx, organizationId, target)
    if (mode === 'all_users') {
      return { mode, entitledUserIds: new Set() }
    }

    const rows = await tx
      .select({ userId: userTargetAccounts.userId })
      .from(userTargetAccounts)
      .where(eq(userTargetAccounts.target, target))
    return { mode, entitledUserIds: new Set(rows.map((row) => row.userId)) }
  }

  /**
   * The SINGLE-user flavour of `loadTargetProvisioning` above - what
   * `buildDesiredUser` falls back to when no caller precomputed the answer
   * (i.e. every outbox-driven sync, which is about one user by definition).
   * Reads at most one row instead of the whole target's entitlement set.
   */
  private async loadTargetProvisioningForUser(
    tx: DbHandle,
    organizationId: string,
    target: OutboxTarget,
    userId: string,
  ): Promise<TargetProvisioning> {
    const mode = await this.loadProvisioningMode(tx, organizationId, target)
    if (mode === 'all_users') {
      return { mode, entitledUserIds: new Set() }
    }

    const rows = await tx
      .select({ userId: userTargetAccounts.userId })
      .from(userTargetAccounts)
      .where(and(eq(userTargetAccounts.target, target), eq(userTargetAccounts.userId, userId)))
      .limit(1)
    return { mode, entitledUserIds: new Set(rows.map((row) => row.userId)) }
  }

  /** The one `connector_targets` read both flavours above share - see `loadTargetProvisioning` for why a missing row means `all_users`. Keyed by (organization, target) — per-organization connector targets — and a missing row for THIS organization still answers `all_users`, never another organization's mode. */
  private async loadProvisioningMode(
    tx: DbHandle,
    organizationId: string,
    target: OutboxTarget,
  ): Promise<'all_users' | 'entitled_only'> {
    const [row] = await tx
      .select({ mode: connectorTargets.provisioningMode })
      .from(connectorTargets)
      .where(and(eq(connectorTargets.organizationId, organizationId), eq(connectorTargets.target, target)))
      .limit(1)
    return row?.mode ?? 'all_users'
  }

  /**
   * The organization a GROUP belongs to — needed because `GroupsRepository.
   * findById`'s `Group` shape does not expose `organization_id`, and
   * per-organization connector-target resolution needs it for every
   * group-shaped reconcile. One indexed read via the caller's own `tx`.
   */
  private async organizationIdOfGroup(tx: DbHandle, groupId: string): Promise<string> {
    const [row] = await tx
      .select({ organizationId: groups.organizationId })
      .from(groups)
      .where(eq(groups.id, groupId))
      .limit(1)
    if (row === undefined) {
      throw new Error(`sync worker: no group found for id ${groupId}`)
    }
    return row.organizationId
  }

  /**
   * The MASTER organization's id — the catalog `sso_app` events resolve
   * against (an SSO application is registered in the master realm and is
   * platform-level; see resolveAggregateOrganizationId's doc comment in
   * aggregate-organization.ts for the identical classification the WRITER
   * uses, kept in lockstep here).
   */
  private async masterOrganizationId(tx: DbHandle): Promise<string> {
    const [row] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.isMaster, true))
      .limit(1)
    if (row === undefined) {
      throw new Error('sync worker: no master organization exists — has the organizations backfill migration run?')
    }
    return row.id
  }

  /**
   * The immutable id a PAST successful `apply()` correlated for
   * (userId, target), if any — a direct read of `external_identities`
   * (Milestone 11, Task 5). `undefined` on a genuine first-ever sync (no row
   * yet) — never distinguished from "row exists but is stale/failed": even a
   * `syncState: 'failed'` row's `external_id` is still the target's real,
   * still-valid immutable id for whatever was last successfully applied (see
   * `external_identities.sync_state`'s own doc comment — a regression to
   * `'failed'` never clears `external_id`), so it remains the right value to
   * re-identify by.
   */
  private async findExistingExternalId(
    tx: DbHandle,
    userId: string,
    target: OutboxTarget,
  ): Promise<string | undefined> {
    const [row] = await tx
      .select({ externalId: externalIdentities.externalId })
      .from(externalIdentities)
      .where(and(eq(externalIdentities.userId, userId), eq(externalIdentities.system, target)))
      .limit(1)
    return row?.externalId
  }

  /**
   * The user's EFFECTIVE membership, flattened, as group NAMES — settled
   * decision (see the milestone plan / progress ledger): our groups are a
   * nested DAG; a user in a nested child group is effectively a member of
   * EVERY ancestor group too, via `listEffectiveGroupsForUser`. Recomputed
   * fresh on every call — never cached, never taken from an event payload —
   * so it is correct regardless of how many membership edges have changed
   * since this user's target-side state was last synced. Read-only: turning
   * this into each target's OWN representation of membership (Keycloak:
   * `ensureGroup` + `setUserGroups`, one Keycloak group per local group,
   * flat at the realm's top level; echo: recorded verbatim) is each
   * connector's own job inside `apply` (see `KeycloakConnector`/
   * `EchoConnector`), not this method's — this method's only contract is
   * "the locally-true flattened set of group NAMES," identical across every
   * target.
   *
   * Takes `tx` and threads it into both `GroupsRepository` reads below —
   * finding C1 (docs/archive/audits/audit-integrity.md): this method runs from
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
  private async effectiveGroupNames(tx: DbHandle, userId: string): Promise<string[]> {
    const effectiveGroupIds = await this.groupsRepository.listEffectiveGroupsForUser(userId, tx)
    const localGroups =
      effectiveGroupIds.length === 0
        ? []
        : await this.groupsRepository.listByIds(
            effectiveGroupIds,
            { limit: effectiveGroupIds.length, offset: 0, scopePaths: null },
            tx,
          )
    return localGroups.map((group) => group.name)
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
   * The direct `this.keycloak.ensureGroup(group.name)` call below is
   * deliberately gated to `target === 'keycloak'`, NOT run for every target
   * unconditionally — it exists ONLY to keep a Keycloak group's own name
   * current for a group that currently has ZERO effective members (any
   * group WITH members already gets this for free, per-member, inside
   * `KeycloakConnector.apply`'s own `ensureGroup` calls — see
   * `effectiveGroupNames`). `DirectoryConnector` has no "ensure this empty
   * group exists" primitive (deliberately exactly four, user-centric,
   * methods — see its own doc comment), so a target with no member to fan
   * out to has nothing here for THIS milestone to assert into it; this is a
   * known, narrow gap for a target with its own first-class empty-group
   * concept (documented rather than silently generalised into a guess at an
   * interface Milestones 11-13 have not designed yet).
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
   *
   * Milestone 11, Task 6 — widened from `private` to `public` (no other
   * change), the SAME "let a proven method be called directly instead of
   * re-implementing its logic" reasoning `reconcileUser`'s own doc comment
   * already gives for its identical widening in Milestone 10, Task 4: this
   * lets `test/active-directory-groups.connector.spec.ts` drive one group's
   * full sync (identity + direct membership, native-nested or flattened per
   * `ActiveDirectoryConnector`'s own rule) directly, the same way Task 5's
   * own connector tests drive `reconcileUser` directly, rather than needing
   * every scenario to round-trip through the full outbox claim/drain
   * machinery.
   */
  /**
   * Asserts an `sso_apps` row into whichever target implements the SSO
   * connector family.
   *
   * Takes NO advisory lock, unlike `reconcileUser`. That lock exists because
   * a user is reconciled from several aggregates at once — a `user` event and
   * a `membership` event for the same person can be claimed concurrently by
   * two workers and race on the same Keycloak account. An application has
   * exactly one aggregate and one target, so two concurrent events for it are
   * necessarily the same stream, and `claimNext`'s own row lock already
   * serialises them.
   *
   * Neither missing row below is drained quietly: an event whose connector or
   * whose aggregate cannot be loaded is a real inconsistency, and marking it
   * `done` would hide it. Throwing puts it through the ordinary retry and
   * dead-letter path where an operator can see it.
   */
  async reconcileSsoApp(tx: DbHandle, appId: string, target: OutboxTarget): Promise<void> {
    const connector = await this.connectorRegistry.resolveSsoConnector(target, tx, await this.masterOrganizationId(tx))
    if (connector === null) {
      throw new Error(`sync worker: target "${target}" implements no SSO connector`)
    }

    const app = await this.ssoAppsRepository.findById(appId, tx)
    if (app === null) {
      throw new Error(`sync worker: no SSO application found for id ${appId}`)
    }

    // The Keycloak client UUID from a previous sync, absent before the first
    // one. Passing it is what makes a clientId renamed in Keycloak
    // self-correcting rather than duplicating the client.
    const existingExternalId = (await this.ssoAppsRepository.findExternalId(appId, tx)) ?? undefined

    const { externalId } = await connector.applyApp({
      clientId: app.clientId,
      name: app.name,
      description: app.description,
      protocol: app.protocol,
      publicClient: app.publicClient,
      redirectUris: app.redirectUris,
      webOrigins: app.webOrigins,
      groupsClaim: app.groupsClaim,
      enabled: app.enabled,
      existingExternalId,
    })

    await tx
      .insert(externalSsoAppIdentities)
      .values({
        appId: app.id,
        system: target,
        externalId,
        lastSyncedAt: new Date(),
        syncState: 'synced',
      })
      .onConflictDoUpdate({
        target: [externalSsoAppIdentities.appId, externalSsoAppIdentities.system],
        set: {
          externalId,
          lastSyncedAt: new Date(),
          syncState: 'synced',
          updatedAt: new Date(),
        },
      })
  }

  async reconcileGroup(tx: DbHandle, groupId: string, target: OutboxTarget): Promise<void> {
    const group = await this.groupsRepository.findById(groupId, tx)
    if (group === null) {
      throw new Error(`sync worker: no group found for id ${groupId}`)
    }

    // Milestone 11, Task 6 — a target with a real DirectoryGroupConnector
    // (today: active_directory only — see ConnectorRegistry.
    // resolveGroupConnector's own doc comment) asserts this group's own
    // identity and DIRECT membership edges natively/flattened per this
    // connector's own nesting rule, and returns here WITHOUT falling
    // through to the per-member fan-out below: AD's membership is a
    // GROUP-level assert (reconcileAdStyleGroup), never a per-user one, and
    // a rename needs no member re-assertion at all — AD maintains every
    // `member`/`memberOf` DN reference itself across a `modifyDN` (verified
    // empirically — see ActiveDirectoryConnector's own "THE NESTING
    // DECISION" doc comment).
    const groupConnector = await this.connectorRegistry.resolveGroupConnector(
      target,
      tx,
      await this.organizationIdOfGroup(tx, groupId),
    )
    if (groupConnector !== null) {
      await this.reconcileAdStyleGroup(tx, group, target, groupConnector)
      return
    }

    if (target === 'keycloak') {
      await this.keycloak.ensureGroup(group.name)
    }

    const memberIds = await this.groupsRepository.listEffectiveUserMembers(groupId, tx)
    for (const memberId of memberIds) {
      await this.reconcileUser(tx, memberId, target)
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
    // Milestone 11, Task 6 — same early-return shape as `reconcileGroup`
    // immediately above, for the identical reason: a `membership_changed`
    // event is always anchored on the PARENT group's id (see
    // GroupsController's own doc comment on why every membership mutation
    // handler anchors its outbox write there), so re-resolving and
    // re-asserting THAT group's own full desired membership — direct users
    // AND direct child groups alike, native-nested or flattened per this
    // connector's own rule — is exactly what both a user-edge change AND a
    // child-group-edge change need, without needing to distinguish which
    // one `payload` describes.
    const groupConnector = await this.connectorRegistry.resolveGroupConnector(
      event.target,
      tx,
      await this.organizationIdOfGroup(tx, event.aggregateId),
    )
    if (groupConnector !== null) {
      const group = await this.groupsRepository.findById(event.aggregateId, tx)
      if (group === null) {
        throw new Error(`sync worker: no group found for id ${event.aggregateId}`)
      }
      await this.reconcileAdStyleGroup(tx, group, event.target, groupConnector)
      return
    }

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
      await this.reconcileUser(tx, userId, event.target)
    }
  }

  // -------------------------------------------------------------------
  // Group-shaped sync (Milestone 11, Task 6) — for any target with a real
  // DirectoryGroupConnector (`active_directory` in production; `echo` too,
  // as of Milestone 13 Task 8 — see EchoConnector's own doc comment for why
  // the in-repo target gained this capability). Mirrors `reconcileUser`/
  // `buildDesiredUser`'s own split (assert vs. compute) for the identical
  // reason: Milestone 11 Task 6's own report flagged, as a carried gap, that
  // `TargetReconciliationJob`'s dry-run/plan path did not walk groups —
  // Milestone 13 Task 8 closes that gap by reusing BOTH halves of this
  // split directly (`buildDesiredGroup` for its PLAN phase,
  // `reconcileGroupById` — a thin public wrapper around
  // `reconcileAdStyleGroup` immediately below — for its APPLY phase), the
  // identical "one computation, no future risk of a plan/apply divergence"
  // reasoning `buildDesiredUser` already established for users.
  // -------------------------------------------------------------------

  /**
   * Asserts one group's own desired identity + direct membership into
   * `target` via `connector.applyGroup`, then records the correlation in
   * `external_group_identities` — the group-shaped mirror of `reconcileUser`
   * recording `external_identities`. Always re-reads fresh from Postgres
   * (via `buildDesiredGroup`) and reasserts the WHOLE desired state, never a
   * delta — calling this twice in a row for an already-converged group is a
   * no-op the second time, the same idempotence guarantee every other
   * reconcile method in this class already holds.
   *
   * Deliberately does NOT take `reconcileUser`'s own per-USER advisory lock
   * (`SYNC_USER_LOCK_NAMESPACE`) — that lock exists because a `user`, a
   * `group` and a `membership` event can all fan into `reconcileUser` for
   * the SAME user concurrently (finding H2). A group's own AD identity and
   * membership, by contrast, is asserted from ONE of exactly THREE gated
   * entry points (`reconcileGroup`/`reconcileMembership`, both driven by the
   * OUTBOX's own per-(aggregate, target) ordering; `reconcileGroupById`,
   * driven synchronously and on-demand by `TargetReconciliationJob` — added
   * Milestone 13, Task 8, the identical relationship `reconcileUser` already
   * has with THAT job's own per-user apply phase). `OutboxRepository.
   * claimNext`'s per-(aggregate, target) ordering serializes the first two
   * against each other and against themselves; `TargetReconciliationJob`'s
   * OWN per-group try/catch loop (never concurrent within one reconcile
   * run — see that job's own doc comment) serializes the third against
   * itself. Two DIFFERENT mechanisms (the outbox claim, driven by real
   * mutations; a synchronous on-demand reconcile pass) could in principle
   * still race each other for the SAME group — the identical "two
   * independent mutation paths for the same entity" shape H2 found for
   * users — but `TargetReconciliationJob.reconcile`'s own per-entity
   * transaction already reasserts the group's WHOLE desired state read
   * fresh at that moment (never a delta), so the worst a genuine race
   * produces is one of the two writers' assertions being immediately
   * superseded by the other's — never a corrupted intermediate state —
   * and the NEXT reconcile pass (either path) converges regardless, the
   * same self-healing property every other reconcile-to-desired-state path
   * in this codebase already relies on.
   */
  private async reconcileAdStyleGroup(
    tx: DbHandle,
    group: Group,
    target: OutboxTarget,
    connector: DirectoryGroupConnector,
  ): Promise<void> {
    const desired = await this.buildDesiredGroup(tx, group, target)
    const { externalId } = await connector.applyGroup(desired)

    await tx
      .insert(externalGroupIdentities)
      .values({
        groupId: group.id,
        system: target,
        externalId,
        lastSyncedAt: new Date(),
        syncState: 'synced',
      })
      .onConflictDoUpdate({
        target: [externalGroupIdentities.groupId, externalGroupIdentities.system],
        set: {
          externalId,
          lastSyncedAt: new Date(),
          syncState: 'synced',
          updatedAt: new Date(),
        },
      })
  }

  /**
   * Computes one group's `DesiredGroup` — its name, its previously-correlated id (if any), and its direct membership resolved per `DesiredGroup.memberExternalIds`'s own doc comment (connector.ts) — WITHOUT asserting it anywhere. Pure read, same "compute vs. assert" split `buildDesiredUser` already establishes.
   *
   * Milestone 13, Task 8 — widened from `private` to `public` (no other
   * change), the SAME "let a proven method be called directly instead of
   * re-implementing its logic" reasoning `buildDesiredUser`'s own doc
   * comment already gives for its identical widening in Milestone 10, Task
   * 4: this lets `TargetReconciliationJob` (connectors/target-reconciliation.
   * job.ts) compute a group's desired state for its own PLAN phase — reused
   * by `connector.planGroup(...)` only, never applied during that read-only
   * pass — closing Milestone 11 Task 6's own carried gap ("the dry-run/
   * blast-radius guard... does not walk groups this milestone" — that
   * task's own report, Concerns #1). Keeping this ONE computation, rather
   * than a second independently-maintained copy, is what stops a group's
   * dry-run PLAN from ever silently drifting from what a real reconcile
   * would actually assert — the identical reasoning `buildDesiredUser`'s own
   * doc comment already gives for users.
   */
  async buildDesiredGroup(tx: DbHandle, group: Group, target: OutboxTarget): Promise<DesiredGroup> {
    const existingExternalId = await this.findExistingGroupExternalId(tx, group.id, target)
    const memberExternalIds = await this.buildDesiredGroupMemberExternalIds(tx, group.id, target)
    return { name: group.name, memberExternalIds, existingExternalId }
  }

  /**
   * Milestone 13, Task 8 — the GROUP-shaped mirror of `reconcileUser`'s own
   * public contract (see that method's own doc comment for the identical
   * "widened so `TargetReconciliationJob` can call this SAME, already-proven
   * method directly for its own apply phase" reasoning): asserts ONE
   * already-flagged group's desired state into `target`, closing Milestone
   * 11 Task 6's own carried gap for the APPLY half (the PLAN half is closed
   * by `buildDesiredGroup`'s own widening immediately above).
   *
   * Resolves its OWN group connector fresh via `ConnectorRegistry.
   * resolveGroupConnector` — never trusts one a caller resolved earlier and
   * might be holding stale — and RE-READS `groupId` fresh via `tx`, the
   * identical "never trust a value read before this call" discipline
   * `reconcileUser` already follows for `userId` (see that method's own doc
   * comment: "always re-reads fresh, never trusts a value read before the
   * lock"). A `null` group connector (target has no native group-nesting
   * capability) is a silent no-op, not an error — mirrors `reconcileGroup`'s
   * OWN existing early-return shape for exactly the same target check; a
   * caller that already used `buildDesiredGroup`/`resolveGroupConnector` to
   * confirm one exists before flagging this group for APPLY (as
   * `TargetReconciliationJob` does) never actually hits this branch in
   * practice, but it is safe regardless — the same "safe even though never
   * exercised by this caller" posture `DirectoryConnector.disable`'s own
   * unknown-id handling documents elsewhere in this codebase.
   *
   * Deliberately does NOT take `reconcileUser`'s own per-USER advisory lock
   * — see `reconcileAdStyleGroup`'s own doc comment for why no analogous
   * cross-aggregate race exists for a group's own AD identity/membership.
   */
  async reconcileGroupById(tx: DbHandle, groupId: string, target: OutboxTarget): Promise<void> {
    const groupConnector = await this.connectorRegistry.resolveGroupConnector(
      target,
      tx,
      await this.organizationIdOfGroup(tx, groupId),
    )
    if (groupConnector === null) {
      return
    }
    const group = await this.groupsRepository.findById(groupId, tx)
    if (group === null) {
      throw new Error(`sync worker: no group found for id ${groupId}`)
    }
    await this.reconcileAdStyleGroup(tx, group, target, groupConnector)
  }

  /**
   * The core of the nesting rule (see `ActiveDirectoryConnector`'s own "THE
   * NESTING DECISION" doc comment for the full reasoning this implements):
   * for each of this group's DIRECT local edges, contribute EITHER a native
   * reference (the edge's own target's correlated id) OR a flattened
   * stand-in (that target's current locally-effective users' correlated
   * ids), never both, per edge:
   *
   *  - a direct USER edge contributes that user's own correlated id for
   *    `target`, or nothing if they have not synced there yet.
   *  - a direct CHILD-GROUP edge contributes that child's own correlated id
   *    for `target` IF one exists (NATIVE nesting) — otherwise it
   *    contributes that child's current EFFECTIVE users' correlated ids
   *    instead (FLATTENED stand-in), via `listEffectiveUserMembers`, which
   *    already walks the child's own full descendant closure regardless of
   *    depth, so the flattened set is complete even for a multi-level
   *    uncorrelated subtree.
   *
   * A plain `Set` de-duplicates the result — the same principal can be
   * reachable both as a direct member AND via a flattened child (or via
   * two different flattened children), and AD's `member` is itself a SET,
   * not a multiset.
   *
   * Every read below threads `tx` — this runs from inside `reconcileAdStyleGroup`,
   * itself always inside the worker's own open transaction (finding C1,
   * docs/archive/audits/audit-integrity.md) — never a second pool connection.
   */
  private async buildDesiredGroupMemberExternalIds(
    tx: DbHandle,
    groupId: string,
    target: OutboxTarget,
  ): Promise<string[]> {
    const directUserIds = await this.groupsRepository.listDirectUserMembers(groupId, tx)
    const directChildGroupIds = await this.groupsRepository.listDirectChildGroups(groupId, tx)

    const externalIds = new Set<string>()

    for (const userId of directUserIds) {
      const id = await this.findExistingExternalId(tx, userId, target)
      if (id !== undefined) {
        externalIds.add(id)
      }
    }

    for (const childGroupId of directChildGroupIds) {
      const childExternalId = await this.findExistingGroupExternalId(tx, childGroupId, target)
      if (childExternalId !== undefined) {
        // NATIVE NESTING: the child already has its own AD presence — refer
        // to IT directly, never its members.
        externalIds.add(childExternalId)
        continue
      }
      // FLATTEN: the child has no AD presence yet — stand in with its
      // current locally-effective users so this group's OWN membership
      // stays complete and correct in the meantime. Self-heals into a real
      // nested edge the moment the child itself finishes syncing — no
      // special "upgrade" step, just what this method computes fresh next
      // time.
      const effectiveUserIds = await this.groupsRepository.listEffectiveUserMembers(childGroupId, tx)
      for (const userId of effectiveUserIds) {
        const id = await this.findExistingExternalId(tx, userId, target)
        if (id !== undefined) {
          externalIds.add(id)
        }
      }
    }

    return [...externalIds]
  }

  /**
   * The immutable id a PAST successful `applyGroup()` correlated for
   * (groupId, target), if any — the group-shaped mirror of
   * `findExistingExternalId` above, reading `external_group_identities`
   * instead of `external_identities`. `undefined` on a genuine first-ever
   * sync (no row yet).
   */
  private async findExistingGroupExternalId(
    tx: DbHandle,
    groupId: string,
    target: OutboxTarget,
  ): Promise<string | undefined> {
    const [row] = await tx
      .select({ externalId: externalGroupIdentities.externalId })
      .from(externalGroupIdentities)
      .where(and(eq(externalGroupIdentities.groupId, groupId), eq(externalGroupIdentities.system, target)))
      .limit(1)
    return row?.externalId
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
