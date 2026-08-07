import { Inject, Injectable, Optional } from '@nestjs/common'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { AttributeTargetMappingsRepository } from '../attributes/attribute-target-mappings.repository'
import { AuditWriter } from '../audit/audit.writer'
import { DB_CLIENT } from '../common/db.token'
import { buildTargetAttributes, computeCoreFieldValues, type ResolvedTargetMapping } from '../connectors/attribute-mapping'
import * as schema from '../db/schema/index'
import { GroupsRepository } from '../groups/groups.repository'
import { type KeycloakUser, KeycloakAdminClient } from '../keycloak/keycloak-admin.client'
import { OrgUnitsRepository } from '../org-units/org-units.repository'
import { snapshotUser } from '../users/users.controller'
import { type User, UsersRepository, type UserStatus } from '../users/users.repository'
import { OutboxWriter } from './outbox.writer'
import { SyncWorker } from './sync.worker'

// Every status, not just 'active' — see this file's class-level doc comment
// on why walking `deactivated`/`pending`/`suspended` users too is
// deliberate, not an oversight.
const ALL_USER_STATUSES: readonly UserStatus[] = ['pending', 'active', 'suspended', 'deactivated']

// An internal pagination chunk size for the user walk — NOT a client-facing
// limit (contrast common/pagination.ts's MAX_LIMIT=100, which bounds an
// HTTP request). UsersRepository.list enforces no cap of its own on this
// parameter; a larger internal batch just means fewer round trips for a
// trusted, on-demand admin script.
const PAGE_SIZE = 200

export type DriftReason =
  | 'missing_in_keycloak'
  | 'enabled_mismatch'
  | 'email_mismatch'
  | 'first_name_mismatch'
  | 'last_name_mismatch'
  | 'attributes_mismatch'
  | 'group_mismatch'

export interface UserDrift {
  userId: string
  username: string
  reasons: DriftReason[]
}

export interface ReconciliationReport {
  usersChecked: number
  usersWithDrift: UserDrift[]
  /** Fresh repair events this run enqueued for drifted users. */
  eventsEnqueued: number
  /** Total outbox events actually drained afterward — may exceed `eventsEnqueued` if other events were already pending. */
  eventsProcessed: number
}

/** Set-equality on two `Record<string, string[]>` attribute maps, order-independent within each value array. */
function attributesEqual(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
  const aKeys = Object.keys(a).sort()
  const bKeys = Object.keys(b).sort()
  if (aKeys.length !== bKeys.length || aKeys.some((key, i) => key !== bKeys[i])) {
    return false
  }
  return aKeys.every((key) => {
    const av = [...(a[key] ?? [])].sort()
    const bv = [...(b[key] ?? [])].sort()
    return av.length === bv.length && av.every((value, i) => value === bv[i])
  })
}

function sameNameSet(a: readonly string[], b: readonly string[]): boolean {
  const setA = new Set(a)
  const setB = new Set(b)
  return setA.size === setB.size && [...setA].every((name) => setB.has(name))
}

/**
 * On-demand drift detection + repair (Milestone 4, Task 4): "walk users,
 * compare against Keycloak, report and repair drift." Runnable like
 * `db:migrate` — a plain script (see `reconcile-cli.ts`), no scheduler in
 * this milestone (the milestone brief overrides the earlier core-design
 * doc's "nightly" framing — see task-4-brief.md).
 *
 * DETECTION (`detectDrift`) is new, read-only code: it fetches the CURRENT
 * Keycloak representation for a user and independently compares it,
 * field-by-field, against the same desired-state computation
 * `SyncWorker.reconcileUser` uses (profile, `enabled`, default-deny-filtered
 * attributes, flattened effective groups) — without writing anything, so a
 * report can name exactly what differs before anything is touched.
 *
 * REPAIR deliberately reuses the EXISTING, already-tested
 * `SyncWorker.reconcileUser` machinery rather than re-implementing "push
 * full desired state to Keycloak" a second time: a drifted user gets a
 * fresh `user`-aggregate `updated` outbox event enqueued via the same
 * `OutboxWriter` every controller mutation already uses, and once the whole
 * walk completes, one `SyncWorker.drain()` call processes everything just
 * enqueued (plus anything already pending from normal operation) through
 * the SAME reconcile-to-desired-state code path Task 3 already proved
 * idempotent, ordered, and retry/dead-letter-safe. A repair that itself
 * fails (e.g. Keycloak flakes mid-run) gets the exact same backoff/
 * dead-letter handling as any other event, and stays visible via
 * `syncState`/`outbox_events` — never a bespoke, unaudited write path.
 *
 * Walks EVERY status, including `deactivated` — not just active users.
 * Desired `enabled` is `false` for anything but `active` (mirroring
 * `SyncWorker.reconcileUser`), so this also catches and reverts a
 * deactivated (or pending/suspended) user who was manually RE-ENABLED
 * directly in Keycloak, bypassing this system entirely — a genuinely
 * security-relevant class of drift, not merely cosmetic, and squarely
 * within "compare against Keycloak... repair drift."
 */
@Injectable()
export class ReconciliationJob {
  private readonly attributeTargetMappingsRepository: AttributeTargetMappingsRepository
  private readonly orgUnitsRepository: OrgUnitsRepository

  constructor(
    @Inject(UsersRepository) private readonly usersRepository: UsersRepository,
    @Inject(GroupsRepository) private readonly groupsRepository: GroupsRepository,
    @Inject(KeycloakAdminClient) private readonly keycloak: KeycloakAdminClient,
    @Inject(OutboxWriter) private readonly outboxWriter: OutboxWriter,
    @Inject(SyncWorker) private readonly syncWorker: SyncWorker,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
    // Milestone 10, Task 3 — same trailing-optional-with-fallback-default
    // shape `SyncWorker`'s own constructor uses for the identical pair (see
    // its doc comment): every pre-existing raw `new ReconciliationJob(...)`
    // call site (reconciliation.spec.ts's `makeJob`, reconcile-cli.ts's
    // `main`) keeps compiling and behaving unchanged; Nest DI supplies both
    // real, already-registered providers in production.
    @Optional() @Inject(AttributeTargetMappingsRepository)
    attributeTargetMappingsRepository?: AttributeTargetMappingsRepository,
    @Optional() @Inject(OrgUnitsRepository) orgUnitsRepository?: OrgUnitsRepository,
  ) {
    this.attributeTargetMappingsRepository =
      attributeTargetMappingsRepository ?? new AttributeTargetMappingsRepository(db)
    this.orgUnitsRepository = orgUnitsRepository ?? new OrgUnitsRepository(db)
  }

  async run(): Promise<ReconciliationReport> {
    // This job compares against KEYCLOAK only (its constructor takes a
    // single `KeycloakAdminClient`, not a `ConnectorRegistry` — genuine
    // multi-target reconciliation is Milestone 10, Task 4). `mappings` is
    // therefore fetched once for `target: 'keycloak'` and reused for every
    // user in the walk — the SAME "compute once, reuse per-user" shape the
    // `definitions` local this replaces already had.
    const mappings = await this.attributeTargetMappingsRepository.listForTarget('keycloak')
    const drifted: UserDrift[] = []
    let checked = 0
    let enqueued = 0

    for (const status of ALL_USER_STATUSES) {
      let offset = 0
      for (;;) {
        const page = await this.usersRepository.list({
          status,
          limit: PAGE_SIZE,
          offset,
          scopePaths: null,
        })
        if (page.length === 0) {
          break
        }

        for (const user of page) {
          checked += 1
          const { reasons, observed } = await this.detectDrift(user, mappings)
          if (reasons.length > 0) {
            drifted.push({ userId: user.id, username: user.username, reasons })
            await this.enqueueRepair(user, reasons, observed)
            enqueued += 1
          }
        }

        if (page.length < PAGE_SIZE) {
          break
        }
        offset += PAGE_SIZE
      }
    }

    const eventsProcessed = await this.syncWorker.drain()

    return { usersChecked: checked, usersWithDrift: drifted, eventsEnqueued: enqueued, eventsProcessed }
  }

  /**
   * Compares Keycloak's CURRENT representation of `user` against desired
   * state, reporting every axis that differs, ALONGSIDE the raw observed
   * Keycloak state itself (`observed`) — finding M2 (docs/superpowers/
   * audit-integrity.md): `enqueueRepair` needs it verbatim as the audit
   * row's `before`, so it is threaded back out here rather than re-fetched
   * a second time. Returns `{ reasons: ['missing_in_keycloak'], observed:
   * null }` when the user does not exist in Keycloak at all — there is
   * nothing further to compare, and the repair path (create, via the
   * ordinary `reconcileUser`) is the same either way.
   */
  private async detectDrift(
    user: User,
    mappings: ResolvedTargetMapping[],
  ): Promise<{ reasons: DriftReason[]; observed: KeycloakUser | null }> {
    const existing = await this.keycloak.findUserByUsername(user.username)
    if (existing === null) {
      return { reasons: ['missing_in_keycloak'], observed: null }
    }

    const reasons: DriftReason[] = []
    const desiredEnabled = user.status === 'active'

    if (existing.enabled !== desiredEnabled) reasons.push('enabled_mismatch')
    if ((existing.email ?? '') !== user.primaryEmail) reasons.push('email_mismatch')
    if ((existing.firstName ?? '') !== user.firstName) reasons.push('first_name_mismatch')
    if ((existing.lastName ?? '') !== user.lastName) reasons.push('last_name_mismatch')

    // Milestone 10, Task 3 — mirrors SyncWorker.reconcileUser's own
    // computation exactly, INCLUDING the lazy org-unit fetch (`mappings`
    // here is likewise pre-scoped to `target: 'keycloak'` — see `run()`
    // above), so this job's notion of "desired" never drifts from what a
    // real sync would actually assert.
    const orgUnit = mappings.some((mapping) => mapping.source === 'core')
      ? await this.orgUnitsRepository.findById(user.orgUnitId)
      : null
    const coreFieldValues = computeCoreFieldValues(user, orgUnit)
    const desiredAttributes = buildTargetAttributes(mappings, user.attributes, coreFieldValues)
    if (!attributesEqual(existing.attributes, desiredAttributes)) {
      reasons.push('attributes_mismatch')
    }

    const desiredGroupNames = await this.desiredGroupNames(user.id)
    const existingGroups = await this.keycloak.listUserGroups(user.username)
    if (!sameNameSet(desiredGroupNames, existingGroups.map((group) => group.name))) {
      reasons.push('group_mismatch')
    }

    return { reasons, observed: existing }
  }

  /** Same flattened-effective-membership computation SyncWorker.syncEffectiveGroups uses, resolved to NAMES for comparison. */
  private async desiredGroupNames(userId: string): Promise<string[]> {
    const effectiveGroupIds = await this.groupsRepository.listEffectiveGroupsForUser(userId)
    if (effectiveGroupIds.length === 0) {
      return []
    }
    const groups = await this.groupsRepository.listByIds(effectiveGroupIds, {
      limit: effectiveGroupIds.length,
      offset: 0,
      scopePaths: null,
    })
    return groups.map((group) => group.name)
  }

  /**
   * Enqueues the repair — see this class's own doc comment for why this is
   * a fresh outbox event rather than a direct Keycloak write. `reasons` ride
   * along in the payload purely as an operator-visible diagnostic (matching
   * OutboxEvent.payload's existing "diagnostics and ordering only"
   * contract — see outbox.writer.ts); the actual repair, once drained,
   * re-derives and re-asserts full desired state exactly like any other
   * `user`-aggregate event, never replaying this payload.
   *
   * ALSO writes an audit row, in the SAME transaction as the outbox event —
   * finding M2 (docs/superpowers/audit-integrity.md): binding constraint 7
   * requires every mutation be "audited AND outboxed in one transaction,"
   * and automated repair is still a change to identity state (the measured
   * repro: a suspended user manually re-enabled directly in Keycloak,
   * re-disabled by this job, with zero audit rows written pre-fix) — "who
   * disabled this account, and why" must be answerable even when the
   * answer is "the system did, because it drifted." `actorUserId: null` is
   * the existing convention for a trusted, on-demand system action with no
   * human actor to attribute it to — the same one `LifecycleJob` and
   * `RuleApplier` already use (see either's own doc comment); this was the
   * one write path in that category that had not adopted it yet. `before`
   * is the OBSERVED Keycloak state `detectDrift` already fetched (verbatim,
   * not re-fetched); `after` is the DESIRED state this repair will assert
   * once drained, plus `reasons` for why — matching the audit's own
   * suggested shape.
   */
  private async enqueueRepair(
    user: User,
    reasons: DriftReason[],
    observed: KeycloakUser | null,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.auditWriter.record(tx, {
        actorUserId: null,
        action: 'reconciliation:repair',
        resourceType: 'user',
        resourceId: user.id,
        before: observed,
        after: { ...snapshotUser(user), reasons },
      })

      await this.outboxWriter.record(tx, {
        aggregateType: 'user',
        aggregateId: user.id,
        eventType: 'updated',
        payload: { action: 'reconciliation:repair', username: user.username, reasons },
      })
    })
  }
}
