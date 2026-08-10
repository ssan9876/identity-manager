import { Inject, Injectable, Optional } from '@nestjs/common'
import { and, asc, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import { ConflictError, NotFoundError } from '../common/errors'
import {
  businessRoleConditions,
  businessRoleExceptions,
  businessRoleGrants,
  businessRoles,
} from '../db/schema/business-roles'
import * as schema from '../db/schema/index'
import { orgUnits } from '../db/schema/org-units'
import { users } from '../db/schema/users'
import { OrganizationsRepository } from '../organizations/organizations.repository'
import { hashDefinition, parseDefinition } from './draft'
import type { EvaluableRole, EvaluableUser } from './role-evaluator'

/** One `business_roles` row, exactly as stored. */
export type BusinessRoleRow = typeof businessRoles.$inferSelect

/** One `business_role_exceptions` row, exactly as stored. */
export type BusinessRoleExceptionRow = typeof businessRoleExceptions.$inferSelect

const UNIQUE_VIOLATION = '23505'
const NAME_UNIQUE_CONSTRAINT = 'business_roles_name_idx'

/**
 * Two roles cannot share a name (`business_roles_name_idx`). The message
 * deliberately does NOT echo the submitted name back -- finding SEC-L2: a
 * 404/409 that repeats the caller's own input turns a write endpoint into an
 * existence oracle for anyone who can reach it, and there is nothing the
 * caller learns from the echo that they did not already type.
 *
 * Matched on the CONSTRAINT NAME, not on `code === '23505'` alone, for the
 * reason `UsersRepository` and `GroupsRepository` already state at length: a
 * future second unique index on this table would otherwise be misreported as
 * a duplicate name.
 */
function translateWriteError(error: unknown): never {
  const pgError = error as { code?: string; constraint?: string }
  if (pgError?.code === UNIQUE_VIOLATION && pgError.constraint === NAME_UNIQUE_CONSTRAINT) {
    throw new ConflictError('a business role with that name already exists')
  }
  throw error
}

@Injectable()
export class BusinessRolesRepository {
  constructor(
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
    // OPTIONAL, defaulting to a raw instance bound to the same `db` — the
    // pattern OrgUnitsRepository and GroupsRepository already use for this
    // exact dependency, and what keeps every existing single-argument
    // `new BusinessRolesRepository(db)` in the test suite compiling while
    // real Nest DI hands this the SAME managed instance every other
    // provider gets.
    @Optional()
    @Inject(OrganizationsRepository)
    private readonly organizations: OrganizationsRepository = new OrganizationsRepository(db),
  ) {}

  /**
   * Every write below takes an OPTIONAL trailing `db` handle defaulting to
   * the injected pooled connection, exactly as `listEnabledForEvaluation`
   * does (see its own doc comment). `BusinessRolesController` always passes
   * its own open `tx`, so the mutation, its audit row and any outbox event
   * commit together -- and, just as importantly, so nothing here ever checks
   * out a SECOND pooled connection while the controller holds a transaction
   * open (finding C1, docs/archive/audits/audit-integrity.md;
   * regression-guarded by test/pool-exhaustion.spec.ts).
   */
  async create(
    input: { name: string; description: string | null },
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<BusinessRoleRow> {
    // Milestone: organizations multi-tenancy, Task 5. `organization_id` is
    // NOT NULL and there is no API surface yet that can name a target
    // organization (Task 12), so a new role falls back to master exactly
    // like OrgUnitsRepository.createRoot and GroupsRepository.create's
    // global-group case. Resolved on the CALLER's handle, never a second
    // pooled connection — BusinessRolesController always has a transaction
    // open when this runs (finding C1, guarded by
    // test/pool-exhaustion.spec.ts).
    const master = await this.organizations.findMaster(db)
    const [row] = await db
      .insert(businessRoles)
      .values({ ...input, organizationId: master.id })
      .returning()
      .catch(translateWriteError)
    return row
  }

  /** Every role, name-ordered -- the console's index. */
  async list(db: NodePgDatabase<typeof schema> = this.db): Promise<BusinessRoleRow[]> {
    return db.select().from(businessRoles).orderBy(asc(businessRoles.name))
  }

  /**
   * `name` and `description` ONLY, and that is a safety property rather than
   * an omission: neither can affect who holds anything, so this write sits
   * outside the draft/simulate/publish gate entirely (the design's own "The
   * safety gate" section says exactly that). Conditions and grants are
   * reachable only through `saveDraft` followed by `publish`.
   */
  async update(
    id: string,
    patch: { name?: string; description?: string | null },
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<BusinessRoleRow> {
    const [row] = await db
      .update(businessRoles)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(businessRoles.id, id))
      .returning()
      .catch(translateWriteError)

    if (!row) throw new NotFoundError('business role', id)
    return row
  }

  /**
   * Writing a draft clears the simulation record as well as failing the hash
   * comparison at publish time. Two mechanisms, deliberately: the cleared
   * record is what the console reads to show "draft pending simulation", and
   * the hash comparison is what makes the gate correct even if some future
   * caller forgets to clear.
   */
  async saveDraft(
    id: string,
    definition: unknown,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<void> {
    const parsed = parseDefinition(definition)
    const updated = await db
      .update(businessRoles)
      .set({
        // A fresh object literal here (rather than the `parsed` variable
        // itself) satisfies the column's `Record<string, unknown>` type
        // structurally — `RoleDefinition` is a named interface with no index
        // signature, so passing the variable directly would need a cast.
        draftDefinition: { conditions: parsed.conditions, grants: parsed.grants },
        simulatedAt: null,
        simulatedDraftHash: null,
        updatedAt: new Date(),
      })
      .where(eq(businessRoles.id, id))
      .returning({ id: businessRoles.id })

    if (updated.length === 0) throw new NotFoundError('business role', id)
  }

  async recordSimulation(
    id: string,
    hash: string,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<void> {
    const updated = await db
      .update(businessRoles)
      .set({ simulatedAt: new Date(), simulatedDraftHash: hash })
      .where(eq(businessRoles.id, id))
      .returning({ id: businessRoles.id })

    if (updated.length === 0) throw new NotFoundError('business role', id)
  }

  /**
   * THE gate. Refuses unless a simulation ran against this exact draft, then
   * replaces the published child rows and clears the draft in ONE transaction
   * — a half-published role would be a formula with someone else's grants.
   */
  async publish(id: string): Promise<void> {
    await this.db.transaction(async (tx) => this.publishWithin(tx, id))
  }

  /**
   * The same gate, run on a transaction the CALLER already opened, so that
   * the publish and its audit row commit together (Milestone 17, Task 11 --
   * `BusinessRolesController.publish`). `publish` above is now nothing but
   * this method plus a transaction: there is exactly ONE implementation of
   * the gate, not two that could drift apart.
   */
  async publishWithin(tx: NodePgDatabase<typeof schema>, id: string): Promise<void> {
    const [role] = await tx.select().from(businessRoles).where(eq(businessRoles.id, id)).for('update')
    if (!role) throw new NotFoundError('business role', id)
    if (role.draftDefinition === null) throw new ConflictError('there is no draft to publish')

    const definition = parseDefinition(role.draftDefinition)
    if (role.simulatedDraftHash === null || role.simulatedDraftHash !== hashDefinition(definition)) {
      throw new ConflictError('this draft has not been simulated — simulate it before publishing')
    }

    await tx.delete(businessRoleConditions).where(eq(businessRoleConditions.businessRoleId, id))
    await tx.delete(businessRoleGrants).where(eq(businessRoleGrants.businessRoleId, id))

    if (definition.conditions.length > 0) {
      await tx.insert(businessRoleConditions).values(
        definition.conditions.map((c) => ({ businessRoleId: id, field: c.field, operator: c.operator, value: c.value })),
      )
    }
    if (definition.grants.length > 0) {
      await tx.insert(businessRoleGrants).values(
        definition.grants.map((g) => ({ businessRoleId: id, kind: g.kind, groupId: g.groupId, target: g.target })),
      )
    }

    await tx
      .update(businessRoles)
      .set({ draftDefinition: null, simulatedDraftHash: null, updatedAt: new Date() })
      .where(eq(businessRoles.id, id))
  }

  async setEnabled(
    id: string,
    enabled: boolean,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<BusinessRoleRow> {
    const [row] = await db
      .update(businessRoles)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(businessRoles.id, id))
      .returning()

    if (!row) throw new NotFoundError('business role', id)
    return row
  }

  /**
   * The catalogue-visibility flag (access-request catalogue). Mirrors
   * `setEnabled` but is deliberately NOT the kill switch: flipping
   * `requestable` off removes the role from the self-service catalogue and
   * blocks NEW requests, while granting nothing and revoking nothing —
   * exceptions already approved through past requests stand untouched.
   */
  async setRequestable(
    id: string,
    requestable: boolean,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<BusinessRoleRow> {
    const [row] = await db
      .update(businessRoles)
      .set({ requestable, updatedAt: new Date() })
      .where(eq(businessRoles.id, id))
      .returning()

    if (!row) throw new NotFoundError('business role', id)
    return row
  }

  /**
   * Add or replace ONE person's exception on a role.
   *
   * An upsert rather than a plain insert, keyed on the table's own
   * `(business_role_id, user_id)` unique index: re-stating an exception for
   * somebody who already has one is an EDIT (flip `include` to `exclude`,
   * extend an expiry, correct a reason), not a duplicate to reject. The
   * previous row is returned alongside the new one so the caller can write an
   * honest before/after audit row instead of pretending every write was a
   * creation.
   */
  async upsertException(
    db: NodePgDatabase<typeof schema>,
    input: {
      businessRoleId: string
      userId: string
      mode: 'include' | 'exclude'
      reason: string
      expiresAt: Date | null
      grantedBy: string | null
    },
  ): Promise<{ row: BusinessRoleExceptionRow; previous: BusinessRoleExceptionRow | null }> {
    const [previous] = await db
      .select()
      .from(businessRoleExceptions)
      .where(
        and(
          eq(businessRoleExceptions.businessRoleId, input.businessRoleId),
          eq(businessRoleExceptions.userId, input.userId),
        ),
      )

    const [row] = await db
      .insert(businessRoleExceptions)
      .values(input)
      .onConflictDoUpdate({
        target: [businessRoleExceptions.businessRoleId, businessRoleExceptions.userId],
        set: {
          mode: input.mode,
          reason: input.reason,
          expiresAt: input.expiresAt,
          grantedBy: input.grantedBy,
        },
      })
      .returning()

    return { row, previous: previous ?? null }
  }

  /** Remove one person's exception. Absent is a 404, never a silent no-op. */
  async deleteException(
    db: NodePgDatabase<typeof schema>,
    businessRoleId: string,
    userId: string,
  ): Promise<BusinessRoleExceptionRow> {
    const [row] = await db
      .delete(businessRoleExceptions)
      .where(
        and(
          eq(businessRoleExceptions.businessRoleId, businessRoleId),
          eq(businessRoleExceptions.userId, userId),
        ),
      )
      .returning()

    if (!row) throw new NotFoundError('business role exception', userId)
    return row
  }

  /**
   * One page of the directory, shaped for the evaluator -- the population a
   * simulation walks (Milestone 17, Task 11).
   *
   * It lives HERE rather than on `UsersRepository` because of what it
   * selects: `EvaluableUser` needs the org unit's ltree PATH, and `users`
   * carries only the `org_unit_id` FK, so this is a join `UsersRepository.
   * list` does not perform and whose result would not fit its `User` shape.
   * It is the query `RoleReconciler.loadEvaluableUser` already runs for ONE
   * person, widened to a page and carrying `username` so a simulation report
   * can name people rather than only counting them.
   *
   * EVERY status, not just `active` -- the same reasoning as
   * `RoleReconciliationJob`'s own `ALL_USER_STATUSES` note: a formula may
   * condition on `status` itself, and a simulation that hid deactivated
   * people would under-report precisely the revocations an admin most needs
   * to see BEFORE publishing. Ordered by `username`, which is unique and
   * which nothing in reconciliation ever writes, so the offset walk cannot
   * skip or repeat a row behind its own back.
   *
   * Scoped to ONE organization (Task 5), and required rather than optional
   * for the same reason `listEnabledForEvaluation` is: a simulation report
   * that counted another tenant's people would both leak that tenant's
   * headcount and mis-state the diff the admin is about to publish.
   */
  async listEvaluableUsers(
    db: NodePgDatabase<typeof schema>,
    page: { limit: number; offset: number },
    organizationId: string,
  ): Promise<(EvaluableUser & { username: string })[]> {
    return db
      .select({
        id: users.id,
        username: users.username,
        status: users.status,
        jobTitle: users.jobTitle,
        location: users.location,
        orgUnitId: users.orgUnitId,
        orgUnitPath: orgUnits.path,
        attributes: users.attributes,
      })
      .from(users)
      .innerJoin(orgUnits, eq(users.orgUnitId, orgUnits.id))
      .where(eq(users.organizationId, organizationId))
      .orderBy(asc(users.username))
      .limit(page.limit)
      .offset(page.offset)
  }

  /**
   * Every enabled role, shaped for the evaluator. The reconciler's hot read.
   *
   * Takes an OPTIONAL trailing `db` handle, defaulting to the injected
   * pooled connection (`this.db`) — same contract as UsersRepository's
   * write methods (see that class's own doc comment for the full
   * explanation this mirrors). `RoleReconciler.reconcileUser` (Milestone
   * 17, Task 8) always runs inside a caller's already-open transaction and
   * passes it through here rather than defaulting to the pool: this
   * project has previously deadlocked its own connection pool by opening a
   * transaction and then calling something that checked out a SECOND
   * connection from the same pool while the first sat open (finding C1,
   * docs/archive/audits/audit-integrity.md; regression-guarded by
   * test/pool-exhaustion.spec.ts).
   *
   * Milestone: organizations multi-tenancy, Task 5 — `organizationId` is a
   * REQUIRED, LEADING parameter, not an optional filter and not a trailing
   * one a caller can drop. This is the query that decides what a role is
   * allowed to grant, so a caller that forgets the tenant does not merely
   * over-fetch: it evaluates one tenant's formulas against another
   * tenant's people. Making it the first argument means the compiler, not
   * a reviewer, is what catches the omission.
   *
   * The database is a second line of defence rather than the first: a
   * cross-tenant GROUP grant would be rejected by `gum_user_organization_fk`
   * (Task 4) when the membership edge is written, but a cross-tenant
   * TARGET-ACCOUNT grant has no such guard — `user_target_accounts` carries
   * no organization — so filtering here is the only thing standing in front
   * of it.
   */
  async listEnabledForEvaluation(
    organizationId: string,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<EvaluableRole[]> {
    const roles = await db
      .select()
      .from(businessRoles)
      .where(and(eq(businessRoles.organizationId, organizationId), eq(businessRoles.enabled, true)))
    return Promise.all(roles.map((role) => this.loadDefinition(role.id, role.name, db)))
  }

  async findById(id: string, db: NodePgDatabase<typeof schema> = this.db) {
    const [role] = await db.select().from(businessRoles).where(eq(businessRoles.id, id))
    if (!role) return null
    const definition = await this.loadDefinition(role.id, role.name, db)
    return { ...role, conditions: definition.conditions, grants: definition.grants, exceptions: definition.exceptions }
  }

  /**
   * The published definition, plus the role's exceptions AS STORED.
   *
   * The exception rows are returned WHOLE rather than mapped down to the
   * three fields the evaluator reads. `reason` is `NOT NULL` and required on
   * every write precisely because an unexplained exception is what a later
   * recertification campaign cannot act on -- and narrowing it away here made
   * that column unreadable through any route, so the console was collecting
   * a mandatory justification and then apologising for not being able to show
   * it. `grantedBy` is the same story: "who decided this" is half of what
   * makes an exception reviewable.
   *
   * The widened element type is still structurally a `RoleException`, so
   * `evaluateRoles` and every other consumer of `EvaluableRole` are unchanged
   * -- they read the three fields they always did and ignore the rest.
   */
  private async loadDefinition(
    id: string,
    name: string,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<EvaluableRole & { exceptions: BusinessRoleExceptionRow[] }> {
    const [conditions, grants, exceptions] = await Promise.all([
      db.select().from(businessRoleConditions).where(eq(businessRoleConditions.businessRoleId, id)),
      db.select().from(businessRoleGrants).where(eq(businessRoleGrants.businessRoleId, id)),
      db.select().from(businessRoleExceptions).where(eq(businessRoleExceptions.businessRoleId, id)),
    ])

    return {
      id,
      name,
      conditions: conditions.map((c) => ({ field: c.field, operator: c.operator, value: c.value })),
      grants: grants.map((g) => ({ kind: g.kind, groupId: g.groupId, target: g.target })),
      exceptions,
    }
  }
}
