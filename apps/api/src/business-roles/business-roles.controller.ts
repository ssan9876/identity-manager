import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import { AuditWriter } from '../audit/audit.writer'
import { JwtGuard } from '../auth/jwt.guard'
import { PermissionEngine } from '../authz/permission.engine'
import { PermissionGuard, type AuthorizedRequest } from '../authz/permission.guard'
import { RequirePermission } from '../authz/require-permission.decorator'
import { DB_CLIENT } from '../common/db.token'
import { ConflictError, ForbiddenError, NotFoundError } from '../common/errors'
import { parseBody } from '../common/http/parse-body'
import { parseId } from '../common/http/parse-id'
import { noNulChar } from '../common/http/safe-string'
import type { ConnectorTarget } from '../connectors/connector'
import * as schema from '../db/schema/index'
import { UsersRepository } from '../users/users.repository'
import {
  type BusinessRoleRow,
  BusinessRolesRepository,
} from './business-roles.repository'
import { type RoleDefinition, hashDefinition, parseDefinition } from './draft'
import { type EvaluableRole, type EvaluableUser, evaluateRoles } from './role-evaluator'
import { RoleReconciler } from './role-reconciler'
import { RoleReconciliationJob } from './role-reconciliation.job'

/**
 * The simulation walks the WHOLE directory a page at a time, on the pooled
 * handle with no transaction open — the same chunk size, and the same
 * "internal batch size, never a client-facing limit" posture, as
 * `RoleReconciliationJob`'s own walk.
 */
const PAGE_SIZE = 200

/**
 * A simulation over a large directory can name tens of thousands of people,
 * and a response that large is neither readable nor safe to build in memory.
 * `gainCount`/`lossCount` are always the TRUE totals across the whole
 * directory; `gains`/`losses` carry at most this many examples each, with
 * `truncated` saying so explicitly rather than letting a silently-short list
 * read as the complete answer.
 */
const SIMULATION_SAMPLE_LIMIT = 500

const nameSchema = noNulChar(z.string().min(1).max(255))
const descriptionSchema = noNulChar(z.string().max(2000))

const createBodySchema = z
  .object({
    name: nameSchema,
    description: descriptionSchema.nullable().default(null),
  })
  .strict()

/**
 * `name` and `description` only. Nothing that can affect access is reachable
 * here: `enabled` is a separately-audited verb route, and conditions/grants
 * are reachable ONLY through the draft/simulate/publish gate. `.strict()`
 * means sending one of them is a 400 naming the field rather than a silent
 * no-op — an admin who believes they just changed a formula must not be told
 * it worked.
 */
const patchBodySchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.nullable().optional(),
  })
  .strict()

/**
 * `reason` is REQUIRED, and that is the point of the field rather than
 * ceremony: `business_role_exceptions.reason` is NOT NULL because an
 * unexplained exception is exactly what a later recertification campaign
 * cannot act on. `noNulChar` on every free-text field, per finding INJ-H-2.
 *
 * `expiresAt` is an ISO-8601 instant, not a date: an exception that expires
 * "on the 1st" is ambiguous across timezones, and the evaluator compares
 * instants (`RoleException.expiresAt`, exclusive at the boundary).
 */
const exceptionBodySchema = z
  .object({
    userId: z.string().uuid(),
    mode: z.enum(['include', 'exclude']),
    reason: noNulChar(z.string().min(1).max(2000)),
    expiresAt: z.string().datetime({ offset: true }).nullable().default(null),
  })
  .strict()

/** One person's movement under a simulated draft. */
export interface SimulationEntry {
  userId: string
  username: string
  groupIds: string[]
  targets: ConnectorTarget[]
}

export interface SimulationReport {
  /** Every user visited, across every status. */
  scanned: number
  /** People this role would START granting something to. The true total, regardless of `truncated`. */
  gainCount: number
  /** People this role would STOP granting something to. The true total, regardless of `truncated`. */
  lossCount: number
  gains: SimulationEntry[]
  losses: SimulationEntry[]
  /** True when `gains`/`losses` are samples rather than the whole list — see SIMULATION_SAMPLE_LIMIT. */
  truncated: boolean
}

function snapshotRole(role: BusinessRoleRow): Record<string, unknown> {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    enabled: role.enabled,
    draftDefinition: role.draftDefinition,
    simulatedAt: role.simulatedAt?.toISOString() ?? null,
    simulatedDraftHash: role.simulatedDraftHash,
  }
}

function snapshotDefinition(definition: {
  conditions: EvaluableRole['conditions']
  grants: EvaluableRole['grants']
}): Record<string, unknown> {
  return {
    conditions: definition.conditions.map((c) => ({ field: c.field, operator: c.operator, value: c.value })),
    grants: definition.grants.map((g) => ({ kind: g.kind, groupId: g.groupId, target: g.target })),
  }
}

/**
 * Milestone 17, Task 11 — the admin API for business roles: the catalog, the
 * draft/simulate/publish gate, the enable/disable kill switch, and the
 * per-person exceptions.
 *
 * GLOBAL GRANT ONLY on every mutating route. A business role has no
 * containing org unit — `business_roles` has no `org_unit_id` column at all —
 * so there is nothing for a scoped grant to narrow a request TO, exactly as
 * for the audit log, dead letters, connector targets, attribute mappings and
 * SSO applications. `PermissionGuard` only answers "does this actor hold the
 * action ANYWHERE?" (`assertCanAnywhere`), so without the explicit check in
 * `requireGlobalManageGrant` an org-unit-scoped `super_admin` — a legitimate,
 * supported configuration — would hold the SAME authority over directory-wide
 * infrastructure as a global one. That is finding AUTHZ-M-2, already fixed
 * once on `ConnectorTargetsController`, and here it would bite HARDER than it
 * did there: a role's formula spans the whole directory and its grants can
 * place ANYONE into ANY group, so an admin scoped to Sales — who gets a 403
 * merely READING a user outside Sales — could author a formula that puts
 * every engineer in the company into a group they choose. That is precisely
 * the escalation shape `PrivilegeGuards.assertCanAssignRole` exists to
 * prevent, arriving through a different door.
 *
 * READ routes are deliberately NOT global-gated, matching
 * `ConnectorTargetsController` rather than `SsoAppsController`: a role's
 * conditions and grants DESCRIBE access, they do not confer it, and
 * `business_role:read` is deliberately held by `auditor`/`read_only`, who
 * routinely hold their grants at a scope. Reading a formula from a narrower
 * scope is not the escalation; mutating global infrastructure is.
 *
 * TRANSACTION AND CONNECTION DISCIPLINE. Each mutation, its audit row and any
 * outbox event commit together on ONE `tx`, and every repository call inside
 * takes that `tx` explicitly rather than defaulting to its own pooled handle.
 * The reconciliation sweeps (`reconcileRole`) run strictly AFTER the
 * transaction commits, never inside it: that job opens one transaction PER
 * USER of its own, and calling it while this controller held a transaction
 * open would check out a second pooled connection behind the first — finding
 * C1 (docs/archive/audits/audit-integrity.md), which deadlocked this API for
 * real and is regression-guarded by test/pool-exhaustion.spec.ts. The
 * per-person `reconcileUser` is the opposite case and runs INSIDE the
 * transaction, because it accepts the caller's `tx` by design.
 */
@Controller('business-roles')
@UseGuards(JwtGuard, PermissionGuard)
export class BusinessRolesController {
  constructor(
    @Inject(BusinessRolesRepository) private readonly roles: BusinessRolesRepository,
    @Inject(RoleReconciler) private readonly reconciler: RoleReconciler,
    @Inject(RoleReconciliationJob) private readonly reconciliation: RoleReconciliationJob,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(PermissionEngine) private readonly engine: PermissionEngine,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * The whole of the authorization decision that `PermissionGuard` cannot
   * make — see this class's own doc comment, and finding AUTHZ-M-2.
   * `scopePathsFor(...) === null` is the codebase's existing idiom for "held
   * globally", the same test `OrgUnitsController.create` and
   * `GroupsController.requireGroup` already apply to resources with no
   * containing org unit. It is deliberately NOT "holds the action at some
   * scope".
   */
  private async requireGlobalManageGrant(request: AuthorizedRequest): Promise<void> {
    const scopePaths = await this.engine.scopePathsFor(request.actor, 'business_role:manage')
    if (scopePaths !== null) {
      throw new ForbiddenError(
        'managing a business role requires a global grant of business_role:manage — ' +
          'a business role belongs to no org unit, its formula spans the whole directory, ' +
          'and its grants can place anyone into any group',
      )
    }
  }

  /**
   * A missing role is a 404 naming only the id the caller already sent —
   * never a message echoing a submitted name or hinting that some OTHER role
   * matched (finding SEC-L2).
   */
  private async requireRole(id: string, db?: NodePgDatabase<typeof schema>) {
    const role = await this.roles.findById(id, db)
    if (role === null) {
      throw new NotFoundError('business role', id)
    }
    return role
  }

  @Get()
  @RequirePermission('business_role:read')
  async list(): Promise<BusinessRoleRow[]> {
    return this.roles.list()
  }

  /**
   * A new role is DISABLED and undrafted by construction — `business_roles`
   * defaults `enabled` to false and this route exposes no way to override it.
   * Creating a role can therefore never, by itself, change anyone's access;
   * that takes a draft, a simulation, a publish and an enable, each audited
   * separately.
   */
  @Post()
  @RequirePermission('business_role:manage')
  async create(@Body() body: unknown, @Req() request: AuthorizedRequest): Promise<BusinessRoleRow> {
    await this.requireGlobalManageGrant(request)
    const parsed = parseBody(createBodySchema, body)

    return this.db.transaction(async (tx) => {
      const role = await this.roles.create({ name: parsed.name, description: parsed.description ?? null }, tx)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'business_role:create',
        resourceType: 'business_role',
        resourceId: role.id,
        before: null,
        after: snapshotRole(role),
      })

      return role
    })
  }

  @Get(':id')
  @RequirePermission('business_role:read')
  async findOne(@Param('id') rawId: string) {
    return this.requireRole(parseId(rawId))
  }

  @Patch(':id')
  @RequirePermission('business_role:manage')
  async update(
    @Param('id') rawId: string,
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ): Promise<BusinessRoleRow> {
    await this.requireGlobalManageGrant(request)
    const id = parseId(rawId)
    const parsed = parseBody(patchBodySchema, body)

    return this.db.transaction(async (tx) => {
      const before = await this.roles.findById(id, tx)
      if (before === null) throw new NotFoundError('business role', id)

      // Rebuilt rather than spread: an absent key and a key explicitly set to
      // `undefined` are different things under exactOptionalPropertyTypes, and
      // only the keys the caller actually sent may reach the UPDATE.
      const patch: { name?: string; description?: string | null } = {}
      if (parsed.name !== undefined) patch.name = parsed.name
      if (parsed.description !== undefined) patch.description = parsed.description

      const after = await this.roles.update(id, patch, tx)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'business_role:update',
        resourceType: 'business_role',
        resourceId: id,
        before: snapshotRole(before),
        after: snapshotRole(after),
      })

      return after
    })
  }

  /**
   * Writing a draft affects NOBODY. It replaces `draft_definition` wholesale
   * (a PUT, not a PATCH — a formula is meaningful only as a whole) and clears
   * `simulated_at`/`simulated_draft_hash`, so an edit made after a successful
   * simulation cannot be published on the strength of that simulation.
   *
   * The body is handed to `parseDefinition` rather than to a `z.record(...)`:
   * `ZodRecord` silently DROPS a key literally named `__proto__` instead of
   * reporting it (finding INJ-H-1), which for admin-authored condition values
   * bound for a `jsonb` column would mean an admin's draft quietly not saying
   * what they wrote.
   */
  @Put(':id/draft')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('business_role:manage')
  async saveDraft(
    @Param('id') rawId: string,
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ) {
    await this.requireGlobalManageGrant(request)
    const id = parseId(rawId)

    return this.db.transaction(async (tx) => {
      const before = await this.roles.findById(id, tx)
      if (before === null) throw new NotFoundError('business role', id)

      await this.roles.saveDraft(id, body, tx)
      const after = await this.requireRole(id, tx)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'business_role:draft',
        resourceType: 'business_role',
        resourceId: id,
        before: { draftDefinition: before.draftDefinition },
        after: { draftDefinition: after.draftDefinition },
      })

      return after
    })
  }

  /**
   * The safety rail standing in front of publish: a dry run of the draft
   * across the whole directory that COMMITS NO MEMBERSHIP ROW and returns the
   * diff — N people gain these grants, M people lose these.
   *
   * It is a POST rather than a GET because it does write one thing, and only
   * that one thing: `simulated_at` and `simulated_draft_hash`, which are what
   * the publish gate checks. Recording the hash of the EXACT draft simulated
   * is what makes the gate airtight — it is not enough to have simulated
   * something, you must have simulated this.
   *
   * The walk runs on the pooled handle with NO transaction open, and the
   * short transaction that records the simulation opens only afterwards; see
   * this class's connection-discipline note.
   *
   * An unevaluable draft REFUSES rather than recording a simulation. A
   * condition this binary cannot understand means the diff shown to the admin
   * would be a guess, and the whole point of this endpoint is that the number
   * in front of them is real.
   */
  @Post(':id/simulate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('business_role:manage')
  async simulate(
    @Param('id') rawId: string,
    @Req() request: AuthorizedRequest,
  ): Promise<SimulationReport> {
    await this.requireGlobalManageGrant(request)
    const id = parseId(rawId)
    const role = await this.requireRole(id)

    if (role.draftDefinition === null) {
      throw new ConflictError('there is no draft to simulate')
    }

    const draft = parseDefinition(role.draftDefinition)
    const report = await this.runSimulation(role, draft, new Date())

    await this.db.transaction(async (tx) => {
      await this.roles.recordSimulation(id, hashDefinition(draft), tx)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'business_role:simulate',
        resourceType: 'business_role',
        resourceId: id,
        before: null,
        after: {
          scanned: report.scanned,
          gainCount: report.gainCount,
          lossCount: report.lossCount,
          draftHash: hashDefinition(draft),
        },
      })
    })

    return report
  }

  /**
   * Copies the simulated draft down into the published child rows and clears
   * it — refusing unless a simulation ran against this exact draft
   * (`BusinessRolesRepository.publishWithin`, THE gate).
   *
   * Then sweeps. Publishing a new definition to an already-enabled role
   * changes who holds it, and without this sweep those grants would not move
   * until the next periodic pass — exactly the lag this sub-project exists to
   * remove. The sweep runs after the transaction has COMMITTED, both because
   * it opens its own per-user transactions (see the connection-discipline
   * note) and because it must reconcile against the published definition, not
   * against an uncommitted one.
   */
  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('business_role:manage')
  async publish(@Param('id') rawId: string, @Req() request: AuthorizedRequest) {
    await this.requireGlobalManageGrant(request)
    const id = parseId(rawId)

    const published = await this.db.transaction(async (tx) => {
      const before = await this.roles.findById(id, tx)
      if (before === null) throw new NotFoundError('business role', id)

      await this.roles.publishWithin(tx, id)
      const after = await this.requireRole(id, tx)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'business_role:publish',
        resourceType: 'business_role',
        resourceId: id,
        before: snapshotDefinition(before),
        after: snapshotDefinition(after),
      })

      return after
    })

    const reconciliation = await this.reconciliation.reconcileRole(id, new Date())
    return { ...published, reconciliation }
  }

  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('business_role:manage')
  async enable(@Param('id') rawId: string, @Req() request: AuthorizedRequest) {
    return this.setEnabled(parseId(rawId), true, request)
  }

  /**
   * Disable is a REVOCATION, not a pause: the reconciler's desired set is the
   * union over ENABLED roles, so this role's rows leave that set and are
   * removed on the sweep this route runs immediately. `principalsRevoked` is
   * in the response body precisely because of that — the console must be able
   * to say how many people just lost access, not merely that a flag flipped.
   */
  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('business_role:manage')
  async disable(@Param('id') rawId: string, @Req() request: AuthorizedRequest) {
    return this.setEnabled(parseId(rawId), false, request)
  }

  private async setEnabled(id: string, enabled: boolean, request: AuthorizedRequest) {
    await this.requireGlobalManageGrant(request)

    const role = await this.db.transaction(async (tx) => {
      const before = await this.roles.findById(id, tx)
      if (before === null) throw new NotFoundError('business role', id)

      const after = await this.roles.setEnabled(id, enabled, tx)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: enabled ? 'business_role:enable' : 'business_role:disable',
        resourceType: 'business_role',
        resourceId: id,
        before: { enabled: before.enabled },
        after: { enabled: after.enabled },
      })

      return after
    })

    // After the commit, never inside it — see the connection-discipline note.
    const reconciliation = await this.reconciliation.reconcileRole(id, new Date())

    return {
      ...role,
      reconciliation,
      // `changed` counts USERS whose entitlements moved. On a disable every
      // such move is a removal of this role's grants, so it is exactly "how
      // many people lost something"; on an enable the same number is how many
      // gained.
      principalsRevoked: enabled ? 0 : reconciliation.changed,
      principalsGranted: enabled ? reconciliation.changed : 0,
    }
  }

  /**
   * An exception is the live adjustment made to a RUNNING role without
   * touching the formula that governs everyone else — which is why, unlike a
   * definition change, it goes through no draft and is permitted while the
   * role is enabled and published. That is the entire point of the feature.
   *
   * It therefore re-evaluates exactly ONE person, inside this same
   * transaction (`RoleReconciler.reconcileUser` takes the caller's `tx` by
   * design), rather than enqueuing a sweep: walking the whole directory
   * because one person was granted a covering exception would be absurd, and
   * the admin who wrote it expects it to have taken effect by the time the
   * response arrives.
   *
   * A REFUSAL rolls the whole thing back. `reconcileUser` refuses when some
   * enabled role is unevaluable, and a refusal means nothing was granted and
   * nothing revoked — so committing the exception row anyway would leave an
   * admin holding a 201 for an exception that silently did nothing, which is
   * this project's own named worst outcome (a principal who looks healthy
   * while something is broken). It surfaces as a 409 naming the role at
   * fault.
   */
  @Post(':id/exceptions')
  @RequirePermission('business_role:manage')
  async addException(
    @Param('id') rawId: string,
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ) {
    await this.requireGlobalManageGrant(request)
    const id = parseId(rawId)
    const parsed = parseBody(exceptionBodySchema, body)
    const now = new Date()

    return this.db.transaction(async (tx) => {
      await this.requireRole(id, tx)

      // Checked explicitly so an unknown user is a clean 404 rather than a
      // raw foreign-key violation surfacing as an unmapped 500. On `tx`, not
      // on the pool — a second pooled connection under an open transaction is
      // finding C1.
      const user = await this.users.findById(parsed.userId, tx)
      if (user === null) throw new NotFoundError('user', parsed.userId)

      const { row, previous } = await this.roles.upsertException(tx, {
        businessRoleId: id,
        userId: parsed.userId,
        mode: parsed.mode,
        reason: parsed.reason,
        expiresAt: typeof parsed.expiresAt === 'string' ? new Date(parsed.expiresAt) : null,
        grantedBy: request.actor.userId,
      })

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'business_role:exception_set',
        resourceType: 'business_role',
        resourceId: id,
        before:
          previous === null
            ? null
            : { userId: previous.userId, mode: previous.mode, reason: previous.reason, expiresAt: previous.expiresAt?.toISOString() ?? null },
        after: {
          userId: row.userId,
          mode: row.mode,
          reason: row.reason,
          expiresAt: row.expiresAt?.toISOString() ?? null,
        },
      })

      const outcome = await this.reconciler.reconcileUser(tx, parsed.userId, request.actor.userId, now)
      if (outcome.status === 'refused') {
        throw new ConflictError(
          `the exception was not applied: role "${outcome.roleName}" (${outcome.roleId}) is unevaluable — ${outcome.reason}`,
        )
      }

      return { exception: row, reconciliation: outcome }
    })
  }

  /** The mirror of `addException`, with the same one-person re-evaluation. */
  @Delete(':id/exceptions/:userId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('business_role:manage')
  async removeException(
    @Param('id') rawId: string,
    @Param('userId') rawUserId: string,
    @Req() request: AuthorizedRequest,
  ) {
    await this.requireGlobalManageGrant(request)
    const id = parseId(rawId)
    const userId = parseId(rawUserId, 'userId')
    const now = new Date()

    return this.db.transaction(async (tx) => {
      await this.requireRole(id, tx)
      const removed = await this.roles.deleteException(tx, id, userId)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'business_role:exception_clear',
        resourceType: 'business_role',
        resourceId: id,
        before: {
          userId: removed.userId,
          mode: removed.mode,
          reason: removed.reason,
          expiresAt: removed.expiresAt?.toISOString() ?? null,
        },
        after: null,
      })

      const outcome = await this.reconciler.reconcileUser(tx, userId, request.actor.userId, now)
      if (outcome.status === 'refused') {
        throw new ConflictError(
          `the exception was not removed: role "${outcome.roleName}" (${outcome.roleId}) is unevaluable — ${outcome.reason}`,
        )
      }

      return { removed: true, reconciliation: outcome }
    })
  }

  /**
   * PUBLISHED versus DRAFT, role-locally.
   *
   * For each person the evaluator is run twice over a one-role list — once
   * with the role as published, once with the draft substituted — and the
   * difference between the two grant sets is what this person gains or loses
   * FROM THIS ROLE. Stated plainly because it matters when reading the
   * number: this is what the role will start and stop granting, not a
   * prediction of which membership ROWS will move. Another enabled role, or a
   * `manual` grant, may already be holding the same group open for somebody
   * counted in `gains` — `RoleReconciler` never re-adds a row that exists
   * from any source, and never revokes one that is not `business_role`. The
   * conservative direction is the safe one here: `lossCount` can over-state
   * revocations, never under-state them.
   *
   * The role's EXCEPTIONS are carried into both sides unchanged, because a
   * publish does not touch them — simulating without them would report an
   * excluded person as gaining access they will not get.
   */
  private async runSimulation(
    role: EvaluableRole,
    draft: RoleDefinition,
    now: Date,
  ): Promise<SimulationReport> {
    const publishedRole: EvaluableRole = {
      id: role.id,
      name: role.name,
      conditions: role.conditions,
      grants: role.grants,
      exceptions: role.exceptions,
    }
    const draftRole: EvaluableRole = {
      id: role.id,
      name: role.name,
      conditions: draft.conditions,
      grants: draft.grants,
      exceptions: role.exceptions,
    }

    const gains: SimulationEntry[] = []
    const losses: SimulationEntry[] = []
    let gainCount = 0
    let lossCount = 0
    let scanned = 0
    let truncated = false

    let offset = 0
    for (;;) {
      const page = await this.roles.listEvaluableUsers(this.db, { limit: PAGE_SIZE, offset })
      if (page.length === 0) break

      for (const user of page) {
        scanned += 1

        const before = this.evaluateOne(publishedRole, user, now)
        const after = this.evaluateOne(draftRole, user, now)

        const gained = difference(after, before)
        const lost = difference(before, after)

        if (gained.groupIds.length > 0 || gained.targets.length > 0) {
          gainCount += 1
          if (gains.length < SIMULATION_SAMPLE_LIMIT) {
            gains.push({ userId: user.id, username: user.username, ...gained })
          } else {
            truncated = true
          }
        }
        if (lost.groupIds.length > 0 || lost.targets.length > 0) {
          lossCount += 1
          if (losses.length < SIMULATION_SAMPLE_LIMIT) {
            losses.push({ userId: user.id, username: user.username, ...lost })
          } else {
            truncated = true
          }
        }
      }

      if (page.length < PAGE_SIZE) break
      offset += PAGE_SIZE
    }

    return { scanned, gainCount, lossCount, gains, losses, truncated }
  }

  /**
   * `evaluateRoles` over a ONE-role list, so a refusal names the role and the
   * exact condition that could not be understood. A refusal here aborts the
   * whole simulation rather than skipping the person: a diff computed over
   * "everyone we happened to understand" is not the diff, and publishing on
   * the strength of it is what the gate exists to prevent.
   */
  private evaluateOne(
    role: EvaluableRole,
    user: EvaluableUser,
    now: Date,
  ): { groupIds: string[]; targets: ConnectorTarget[] } {
    const evaluation = evaluateRoles(user, [role], now)
    if (!evaluation.evaluable) {
      throw new ConflictError(
        `role "${evaluation.roleName}" (${evaluation.roleId}) cannot be evaluated, so it cannot be simulated — ${evaluation.reason}`,
      )
    }
    return { groupIds: evaluation.groupIds, targets: evaluation.targets }
  }
}

function difference(
  a: { groupIds: string[]; targets: ConnectorTarget[] },
  b: { groupIds: string[]; targets: ConnectorTarget[] },
): { groupIds: string[]; targets: ConnectorTarget[] } {
  const heldGroups = new Set(b.groupIds)
  const heldTargets = new Set(b.targets)
  return {
    groupIds: a.groupIds.filter((id) => !heldGroups.has(id)),
    targets: a.targets.filter((target) => !heldTargets.has(target)),
  }
}
