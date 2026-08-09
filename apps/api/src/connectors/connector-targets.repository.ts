import { Inject, Injectable } from '@nestjs/common'
import { and, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import { connectorTargets } from '../db/schema/connector-targets'
import { externalIdentities } from '../db/schema/external-identities'
import * as schema from '../db/schema/index'
import type { DbHandle } from '../outbox/outbox.writer'
import type { ConnectorTarget } from './connector'

/**
 * Every target this console shows, in a fixed, deliberate order. Keycloak is
 * included: Milestone 10, Task 2 made it a genuine `DirectoryConnector`
 * citizen with its own `connector_targets` row, so it is configurable and
 * inspectable through this same console, not a special case.
 *
 * RE-EXPORT, not a second list. This was its own hand-copied literal array
 * and drifted from `ConnectorTarget` the moment `mail_server` was added,
 * hiding a live target from the console entirely — see `ALL_CONNECTOR_TARGETS`'
 * own doc comment in connectors/connector.ts for the full finding. The name
 * is kept so existing importers are unaffected.
 */
export { ALL_CONNECTOR_TARGETS } from './connector'

export interface ConnectorTargetRow {
  target: ConnectorTarget
  /** `false` when no `connector_targets` row exists at all — Task 2's own doc comment: "no row" and "a row with enabled = false" are behaviourally identical to every consumer, but the CONSOLE needs to tell them apart, so an admin sees "never configured" rather than a row that looks like someone deliberately disabled it. */
  configured: boolean
  enabled: boolean
  /** Non-secret only, by construction — see `connector-targets.ts`'s own doc comment: a secret's NAME may appear here (e.g. `credentialSecretName: "AD_BIND_PASSWORD"`), never a value, because no value is ever written to this column by anything in this codebase. Safe to return to any caller holding `connector:read` as-is. */
  config: Record<string, unknown>
  blastRadiusThreshold: number
  blastRadiusFloor: number
}

/**
 * Serializes `upsert` per target — finding INT-H4's residual
 * (docs/archive/audits/carried-findings-verification.md, "the read-merge-write
 * pattern recurs in newer code"). Wave D fixed the two sites the original
 * audit found; this one was written afterwards with the same shape and no
 * lock, so two concurrent `PATCH /connector-targets/:target` calls setting
 * DIFFERENT config keys lost one of them — the same mechanism the audit
 * measured at 30/30 on `PATCH /self`.
 *
 * WHY AN ADVISORY LOCK AND NOT `SELECT ... FOR UPDATE`, which is what the
 * H4 fix used elsewhere. FOR UPDATE can only lock a row that EXISTS, and
 * this method's whole job is "create it if it isn't there" — every target
 * starts with no row at all (`findOne` returns a synthetic default; see
 * `defaultRow`). Two concurrent FIRST writes would each lock nothing, each
 * merge onto `{}`, and each INSERT; `ON CONFLICT DO UPDATE` then resolves
 * the collision by letting the loser's `set` overwrite the winner's config
 * wholesale. The lost update survives precisely in the case FOR UPDATE
 * cannot cover. An advisory lock keyed on the TARGET NAME does not depend
 * on a row existing.
 *
 * `pg_advisory_xact_lock` (not the session variant) so the lock is released
 * by the surrounding transaction's COMMIT/ROLLBACK and cannot leak back into
 * the pool — the same rule GROUP_GRAPH_LOCK_ID and SYNC_USER_LOCK_NAMESPACE
 * already follow, and the reason `upsert` takes a REQUIRED `tx` rather than
 * defaulting to the pool.
 *
 * Namespace `0x1d3a_0003`, following 0x1d3a_0001 (group graph) and
 * 0x1d3a_0002 (per-user sync). Distinct namespace, so a connector-target
 * write can never collide with a `hashtext(userId)` that happens to hash to
 * the same 32 bits. Contention is nil in practice: there are a handful of
 * targets and these are rare admin writes.
 */
const CONNECTOR_TARGET_LOCK_NAMESPACE = 0x1d3a_0003

const DEFAULT_BLAST_RADIUS_THRESHOLD = 20
const DEFAULT_BLAST_RADIUS_FLOOR = 5

function defaultRow(target: ConnectorTarget): ConnectorTargetRow {
  return {
    target,
    configured: false,
    enabled: false,
    config: {},
    blastRadiusThreshold: DEFAULT_BLAST_RADIUS_THRESHOLD,
    blastRadiusFloor: DEFAULT_BLAST_RADIUS_FLOOR,
  }
}

/**
 * A `config` PATCH value: a present scalar SETS that key, `null` DELETES it
 * from the stored config (see `upsert`'s own doc comment for why this is a
 * merge, never a wholesale replace). Deliberately no nested objects/arrays —
 * every real per-target config field (host/baseDN/bindDN/tenantId/clientId/
 * domain/impersonatedAdminEmail/credentialSecretName/booleans) is a flat
 * scalar; see each connector's own `ConnectorConfig` interface
 * (active-directory.connector.ts / entra-id.connector.ts /
 * google-workspace.connector.ts).
 */
export type ConfigPatchValue = string | number | boolean | null

export interface ConnectorTargetPatch {
  enabled?: boolean
  config?: Record<string, ConfigPatchValue>
  blastRadiusThreshold?: number
  blastRadiusFloor?: number
}

/**
 * Milestone 14, Task 9 — the admin-facing read/write surface for
 * `connector_targets`, the table Milestone 10 Task 2 built but deliberately
 * shipped with no write endpoint ("this milestone ships the mechanism...
 * Milestone 14 Task 9 adds the console" — that task's own report, Concerns
 * #1). Every write here goes through `upsert`, which MERGES onto whatever
 * config already exists rather than replacing it wholesale — an out-of-band
 * key a test harness or a future field added (e.g. `graphBaseUrl`,
 * `connectTimeoutMs`) survives an admin editing an unrelated field, exactly
 * like `SelfServiceController.update`'s own attribute merge (see that
 * method's doc comment for the identical reasoning, applied to a different
 * table).
 */
@Injectable()
export class ConnectorTargetsRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>) {}

  /** Every REAL row in `connector_targets`, keyed by target — never the full `ALL_CONNECTOR_TARGETS` catalog (a caller that wants the complete, always-five-entries list merges this against that catalog itself — see ConnectorTargetsController.list). */
  async listAll(db: NodePgDatabase<typeof schema> = this.db): Promise<Map<ConnectorTarget, ConnectorTargetRow>> {
    const rows = await db.select().from(connectorTargets)
    const byTarget = new Map<ConnectorTarget, ConnectorTargetRow>()
    for (const row of rows) {
      byTarget.set(row.target, {
        target: row.target,
        configured: true,
        enabled: row.enabled,
        config: row.config,
        blastRadiusThreshold: row.blastRadiusThreshold,
        blastRadiusFloor: row.blastRadiusFloor,
      })
    }
    return byTarget
  }

  /** One target's row, or a synthetic "never configured" default (see `defaultRow`) when none exists — never `null`, since every target in `ALL_CONNECTOR_TARGETS` is a valid thing to ask about even before an admin has touched it. */
  async findOne(target: ConnectorTarget, db: NodePgDatabase<typeof schema> = this.db): Promise<ConnectorTargetRow> {
    const [row] = await db.select().from(connectorTargets).where(eq(connectorTargets.target, target)).limit(1)
    if (row === undefined) {
      return defaultRow(target)
    }
    return {
      target: row.target,
      configured: true,
      enabled: row.enabled,
      config: row.config,
      blastRadiusThreshold: row.blastRadiusThreshold,
      blastRadiusFloor: row.blastRadiusFloor,
    }
  }

  /**
   * Creates the row if none exists (defaulting the fields `patch` omits to
   * this table's own schema defaults — see `connector-targets.ts`), or
   * updates it in place. `patch.config`, if given, is MERGED onto the
   * CURRENT stored config — see this class's own doc comment — with any
   * `null`-valued key in the patch removed from the result entirely
   * (letting an admin explicitly clear an optional field, e.g. a
   * `tlsServerName` override, without that key lingering as a stale value
   * no form field points at any more).
   *
   * Runs inside the caller's own transaction (`tx`) so the row write and its
   * audit entry (`ConnectorTargetsController.update`) commit or roll back
   * together, the same discipline every other mutation in this codebase
   * follows.
   */
  async upsert(tx: DbHandle, target: ConnectorTarget, patch: ConnectorTargetPatch): Promise<ConnectorTargetRow> {
    // Serialize this target's read-merge-write against any concurrent one —
    // finding INT-H4 residual. Taken BEFORE the read, or the read it is
    // meant to protect has already happened. See
    // CONNECTOR_TARGET_LOCK_NAMESPACE for why this is an advisory lock and
    // not `SELECT ... FOR UPDATE`.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${CONNECTOR_TARGET_LOCK_NAMESPACE}, hashtext(${target}::text))`,
    )

    const [existingRow] = await tx.select().from(connectorTargets).where(eq(connectorTargets.target, target)).limit(1)
    const current = existingRow ?? {
      enabled: false,
      config: {} as Record<string, unknown>,
      blastRadiusThreshold: DEFAULT_BLAST_RADIUS_THRESHOLD,
      blastRadiusFloor: DEFAULT_BLAST_RADIUS_FLOOR,
    }

    const mergedConfig: Record<string, unknown> = { ...current.config, ...(patch.config ?? {}) }
    for (const [key, value] of Object.entries(mergedConfig)) {
      if (value === null) delete mergedConfig[key]
    }

    const next = {
      enabled: patch.enabled ?? current.enabled,
      config: mergedConfig,
      blastRadiusThreshold: patch.blastRadiusThreshold ?? current.blastRadiusThreshold,
      blastRadiusFloor: patch.blastRadiusFloor ?? current.blastRadiusFloor,
    }

    await tx
      .insert(connectorTargets)
      .values({ target, ...next })
      .onConflictDoUpdate({
        target: connectorTargets.target,
        set: { ...next, updatedAt: new Date() },
      })

    return { target, configured: true, ...next }
  }

  /**
   * The last time a sync to `target` genuinely SUCCEEDED, for ANY principal
   * — `MAX(external_identities.last_synced_at)` where this target's own
   * correlation is `synced` (see `SyncWorker.reconcileUser`'s upsert: every
   * successful `apply()` sets exactly these two columns together, whether
   * this is the row's first sync or its hundredth). `null` means genuinely
   * never — no principal has ever successfully synced to this target — which
   * is the exact fact `ConnectorTargetsController.list` needs to tell
   * "healthy" apart from "configured but never successfully synced" (this
   * task's own single most important state). Deliberately NOT scoped to
   * `sync_state = 'synced'` alone at the CURRENT moment (a row can regress to
   * `'failed'` on a LATER attempt without losing its own `last_synced_at` —
   * see that column's own doc comment) — this reports the last SUCCESS ever
   * recorded, not "is anything synced right now," which is a different
   * question this console answers separately via `health()`.
   */
  async lastSuccessfulSyncAt(
    target: ConnectorTarget,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<Date | null> {
    const [row] = await db
      .select({ last: sql<Date | null>`max(${externalIdentities.lastSyncedAt})` })
      .from(externalIdentities)
      .where(and(eq(externalIdentities.system, target), eq(externalIdentities.syncState, 'synced')))
    return row?.last ?? null
  }
}
