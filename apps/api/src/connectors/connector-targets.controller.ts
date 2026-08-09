import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Patch, UseGuards, Req } from '@nestjs/common'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import { JwtGuard } from '../auth/jwt.guard'
import { AuditWriter } from '../audit/audit.writer'
import { PermissionGuard, type AuthorizedRequest } from '../authz/permission.guard'
import { RequirePermission } from '../authz/require-permission.decorator'
import { DB_CLIENT } from '../common/db.token'
import { PermissionEngine } from '../authz/permission.engine'
import { ForbiddenError, ValidationError } from '../common/errors'
import { parseBody } from '../common/http/parse-body'
import * as schema from '../db/schema/index'
import {
  type TargetReconciliationOptions,
  type TargetReconciliationReport,
  TargetReconciliationJob,
} from '../outbox/target-reconciliation.job'
import type { ConnectorHealth, ConnectorTarget } from './connector'
import { ConnectorRegistry } from './connector-registry'
import {
  ALL_CONNECTOR_TARGETS,
  type ConfigPatchValue,
  type ConnectorTargetRow,
  ConnectorTargetsRepository,
} from './connector-targets.repository'

/**
 * "Readable at a glance," and — the task's own single non-negotiable —
 * "configured but never successfully synced must not read as healthy": five
 * distinct states, not a boolean. `never_synced` sits strictly BETWEEN
 * `disabled`/`not_configured` (nothing to check) and `healthy` (checked and
 * has a proven track record) — the live `health()` check passed (the target
 * IS reachable and authenticates right now), but no principal has EVER
 * actually landed there, which is exactly the gap docs/product-brief.md's own #2
 * requirement calls "the worst outcome this product can produce" applied to
 * a whole target rather than one user.
 */
export type ConnectorHealthStatus = 'not_configured' | 'disabled' | 'failing' | 'never_synced' | 'healthy'

export interface ConnectorTargetSummary extends ConnectorTargetRow {
  healthStatus: ConnectorHealthStatus
  /** `connector.health()`'s own `detail` — always secret-VALUE-free by that interface's own contract (connector.ts) — or `null` when no live check was attempted (`not_configured`/`disabled`). */
  healthDetail: string | null
  lastSuccessfulSyncAt: Date | null
}

// Built FROM the canonical catalog, never a re-typed literal list — a stale
// copy here silently makes a real target unaddressable through the whole
// console API (no list, no configure, no enable, and critically no DISABLE).
const connectorTargetParamSchema = z.enum(ALL_CONNECTOR_TARGETS)

function parseTargetParam(raw: string): ConnectorTarget {
  const parsed = connectorTargetParamSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ValidationError([
      `target: must be one of ${ALL_CONNECTOR_TARGETS.join(', ')} — got "${raw}"`,
    ])
  }
  return parsed.data
}

const configPatchValueSchema = z.union([z.string().max(4000), z.number(), z.boolean(), z.null()])

const patchTargetBodySchema = z
  .object({
    enabled: z.boolean().optional(),
    config: z.record(z.string().min(1).max(128), configPatchValueSchema).optional(),
    blastRadiusThreshold: z.number().int().min(1).max(100).optional(),
    blastRadiusFloor: z.number().int().min(0).optional(),
  })
  .strict()

const reconcileBodySchema = z
  .object({
    dryRun: z.boolean(),
    force: z.boolean().optional(),
  })
  .strict()

function snapshotTarget(row: ConnectorTargetRow): Record<string, unknown> {
  return {
    target: row.target,
    enabled: row.enabled,
    config: row.config,
    blastRadiusThreshold: row.blastRadiusThreshold,
    blastRadiusFloor: row.blastRadiusFloor,
  }
}

/**
 * Milestone 14, Task 9 — the connector admin console's API surface for
 * target configuration and health. Everything here is global,
 * organisation-wide infrastructure (`connector_targets` has no `orgUnitId`
 * column, unlike every scoped resource this app otherwise manages).
 *
 * Because there is no containing scope to narrow a request TO, every
 * MUTATING route additionally requires a GLOBAL grant — see
 * `requireGlobalManageGrant` below, and the security-audit finding it
 * records. This paragraph previously claimed the opposite ("holding
 * `connector:read`/`connector:manage` at all is the whole authorization
 * question," citing `RoleAssignmentsController`); that was the bug, and the
 * cited precedent did not actually say what it was claimed to say.
 *
 * SECRET DISCIPLINE (decision 4): `config` is returned to the caller
 * VERBATIM, never redacted — because nothing in this codebase ever writes a
 * secret VALUE into `connector_targets.config` in the first place (only a
 * secret's NAME, e.g. `credentialSecretName`). The one place this endpoint
 * genuinely touches a real credential is `health()`, called through the
 * SAME `ConnectorRegistry`/`secrets.ts` plumbing every connector already
 * uses, whose own contract guarantees `detail` never repeats a resolved
 * value (connector.ts's own doc comment) — see
 * test/connector-targets.controller.spec.ts for the sentinel-value proof
 * this actually holds through THIS endpoint specifically, not just assumed
 * to inherit Task 2's own proof.
 */
@Controller('connector-targets')
@UseGuards(JwtGuard, PermissionGuard)
export class ConnectorTargetsController {
  /**
   * Every `connector:manage` route requires a GLOBAL grant, never merely a
   * grant of the action at SOME scope.
   *
   * Security audit finding. `PermissionGuard` satisfies `@RequirePermission`
   * with `assertCanAnywhere` — "does this actor hold it ANYWHERE at all?" —
   * and `connector_targets` has no `orgUnitId`, so there is no containing
   * scope to narrow a request TO. That combination meant an org-unit-scoped
   * `super_admin` (a legitimate, supported configuration:
   * `role_assignments.scope_org_unit_id` is nullable, and
   * `PrivilegeGuards.assertCanAssignRole` explicitly supports scoped
   * `super_admin` grants) held the SAME authority over global connector
   * infrastructure as a global one. Concretely, an admin scoped to Sales —
   * who gets 403 merely READING a user outside Sales — could rewrite any
   * target's config and then `POST /reconcile`, which walks the whole
   * directory (`TargetReconciliationJob` pages with `scopePaths: null`) and
   * pushes every user in the organisation to that target. They could equally
   * disable `keycloak` and stop credential sync org-wide.
   *
   * The fix is the OTHER half of an idiom this codebase already had for
   * resources with no containing org unit — `OrgUnitsController.create` for
   * a root org unit, `GroupsController.requireGroup` for a global group,
   * both `scopePathsFor(actor, action) === null`. This controller was written
   * citing `RoleAssignmentsController` as precedent for "holding the action
   * at all is the whole authorization question," but that analogy was already
   * false when it was written: that controller runs `assertCanIn` on every
   * mutating path.
   *
   * READ routes are deliberately left alone. `connector:read` exposes
   * non-secret config and a health status; reading it from a narrower scope
   * is not the escalation, mutating global infrastructure is.
   */
  private async requireGlobalManageGrant(request: AuthorizedRequest): Promise<void> {
    const scopePaths = await this.engine.scopePathsFor(request.actor, 'connector:manage')
    if (scopePaths !== null) {
      throw new ForbiddenError(
        'managing connector targets requires a global grant of connector:manage — ' +
          'connector configuration is organisation-wide infrastructure, and reconciling a ' +
          'target pushes every principal in the directory',
      )
    }
  }

  constructor(
    @Inject(ConnectorTargetsRepository) private readonly targets: ConnectorTargetsRepository,
    @Inject(PermissionEngine) private readonly engine: PermissionEngine,
    @Inject(ConnectorRegistry) private readonly registry: ConnectorRegistry,
    @Inject(TargetReconciliationJob) private readonly reconciliationJob: TargetReconciliationJob,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  @Get()
  @RequirePermission('connector:read')
  async list(): Promise<ConnectorTargetSummary[]> {
    return Promise.all(ALL_CONNECTOR_TARGETS.map((target) => this.summarize(target)))
  }

  @Get(':target')
  @RequirePermission('connector:read')
  async findOne(@Param('target') rawTarget: string): Promise<ConnectorTargetSummary> {
    return this.summarize(parseTargetParam(rawTarget))
  }

  /**
   * Enable/disable, non-secret config, and the blast-radius threshold/floor
   * — the BUILD section's first bullet, verbatim. `config` is a MERGE (see
   * `ConnectorTargetsRepository.upsert`'s own doc comment) so a field this
   * form does not know about is never silently destroyed.
   */
  @Patch(':target')
  @RequirePermission('connector:manage')
  async update(
    @Param('target') rawTarget: string,
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ): Promise<ConnectorTargetSummary> {
    await this.requireGlobalManageGrant(request)
    const target = parseTargetParam(rawTarget)
    const parsed = parseBody(patchTargetBodySchema, body)
    const patch = {
      enabled: parsed.enabled,
      config: parsed.config as Record<string, ConfigPatchValue> | undefined,
      blastRadiusThreshold: parsed.blastRadiusThreshold,
      blastRadiusFloor: parsed.blastRadiusFloor,
    }

    await this.db.transaction(async (tx) => {
      const before = await this.targets.findOne(target, tx)
      const after = await this.targets.upsert(tx, target, patch)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'connector_target:configure',
        resourceType: 'connector_target',
        // audit_log.resource_id is uuid-typed; a target name is not one —
        // `target` travels inside before/after instead, mirroring
        // TargetReconciliationJob.auditOverride's own identical shape.
        resourceId: null,
        before: before.configured ? snapshotTarget(before) : null,
        after: snapshotTarget(after),
      })
    })

    return this.summarize(target)
  }

  /**
   * Dry-run a reconcile plan, or apply one — "same safety-rail idiom as the
   * import preview" (this task's own BUILD section). `dryRun: true` writes
   * nothing anywhere (TargetReconciliationJob's own contract); `dryRun:
   * false` is a REAL apply, itself still gated by the blast-radius guard
   * unless `force` is set. Every invocation is audited — not just an
   * overridden one (TargetReconciliationJob.auditOverride already covers
   * that narrower case on its own) — so "who ran a reconcile against this
   * target, and what did it do" is answerable for a dry run too.
   */
  @Post(':target/reconcile')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('connector:manage')
  async reconcile(
    @Param('target') rawTarget: string,
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ): Promise<TargetReconciliationReport> {
    await this.requireGlobalManageGrant(request)
    const target = parseTargetParam(rawTarget)
    const parsed = parseBody(reconcileBodySchema, body)

    const row = await this.targets.findOne(target)
    if (!row.configured) {
      throw new ValidationError([
        `target: "${target}" has no blast-radius threshold/floor configured yet — configure it before running a reconcile`,
      ])
    }

    const options: TargetReconciliationOptions = { dryRun: parsed.dryRun, force: parsed.force }
    const report = await this.reconciliationJob.reconcile(target, options)

    await this.db.transaction(async (tx) => {
      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'connector_target:reconcile',
        resourceType: 'connector_target',
        resourceId: null,
        before: null,
        after: {
          target,
          dryRun: report.dryRun,
          force: parsed.force ?? false,
          populationSize: report.populationSize,
          changedCount: report.toMutate.length + report.toMutateGroups.length,
          appliedCount: report.appliedCount,
          appliedGroupCount: report.appliedGroupCount,
          halted: report.halted,
          overridden: report.overridden,
          failedCount: report.failed.length + report.failedGroups.length,
        },
      })
    })

    return report
  }

  /**
   * `not_configured`/`disabled` never attempt a LIVE check — there is
   * nothing to reach (an unconfigured target has no secret name to resolve;
   * a disabled one is deliberately not in use). `resolve()`/`health()` both
   * run OUTSIDE any open transaction — `health()` is real network I/O
   * (LDAPS, Graph, the Admin SDK) and holding a Postgres transaction open
   * across it would reproduce the exact pool-exhaustion shape finding C1
   * already fixed elsewhere; `ConnectorRegistry.resolve`'s own one Postgres
   * read (`connector_targets.config`) runs in its own short, throwaway
   * transaction first, mirroring `TargetReconciliationJob.hasGroupConnector`'s
   * identical "one cheap, closed transaction before the real work" shape.
   */
  private async summarize(target: ConnectorTarget): Promise<ConnectorTargetSummary> {
    const [row, lastSuccessfulSyncAt] = await Promise.all([
      this.targets.findOne(target),
      this.targets.lastSuccessfulSyncAt(target),
    ])

    if (!row.configured) {
      return { ...row, healthStatus: 'not_configured', healthDetail: null, lastSuccessfulSyncAt }
    }
    if (!row.enabled) {
      return { ...row, healthStatus: 'disabled', healthDetail: null, lastSuccessfulSyncAt }
    }

    let health: ConnectorHealth
    try {
      // healthFor, not resolve+health: `resolve` only knows the
      // user-directory family, so it throws "no connector registered" for
      // keycloak_sso and this catch would report a healthy target as failing.
      health = await this.db.transaction((tx) => this.registry.healthFor(target, tx))
    } catch (error) {
      health = { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }

    const healthStatus: ConnectorHealthStatus = !health.ok
      ? 'failing'
      : lastSuccessfulSyncAt === null
        ? 'never_synced'
        : 'healthy'

    return { ...row, healthStatus, healthDetail: health.detail, lastSuccessfulSyncAt }
  }
}
