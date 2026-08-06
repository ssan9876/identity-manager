import { Body, Controller, Get, Inject, Patch, Req, UseGuards } from '@nestjs/common'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import {
  type AttributeDefinition,
  rawAttributesSchema,
  validateAttributes,
} from '../attributes/attribute-validator'
import { type AuthenticatedRequest, JwtGuard } from '../auth/jwt.guard'
import { AuditWriter } from '../audit/audit.writer'
import { type Actor, PermissionEngine } from '../authz/permission.engine'
import { DB_CLIENT } from '../common/db.token'
import { NotFoundError } from '../common/errors'
import { parseBody } from '../common/http/parse-body'
import { noNulChar } from '../common/http/safe-string'
import * as schema from '../db/schema/index'
import { type Group, GroupsRepository } from '../groups/groups.repository'
import { OutboxWriter } from '../outbox/outbox.writer'
import { snapshotUser } from '../users/users.controller'
import { type User, UsersRepository } from '../users/users.repository'

/**
 * The ONLY core `users` columns a caller may edit about THEMSELVES via
 * `PATCH /self`, on top of whatever `attribute_definitions` rows separately
 * mark `self_editable` (see `selfEditableAttributeDefinitions` below).
 * Deliberately tiny, and reviewed here rather than derived from some other
 * list:
 *
 *  - `status`, `orgUnitId`, `username`, `primaryEmail`, `employeeId` and
 *    `managerId` are exactly the fields task-3-brief.md calls out — how a
 *    user would escalate scope, change identity, or resurrect themselves —
 *    and are permanently excluded, never just "not listed yet".
 *  - `firstName`/`lastName` are ALSO excluded even though the brief does not
 *    name them: this system has no separate "display name" concept
 *    (`displayName` is DERIVED from firstName/lastName — see
 *    `UsersRepository.update`), and that name is shown to every other user
 *    in the directory, so letting someone silently rewrite it would let them
 *    impersonate a colleague.
 *  - `jobTitle` is excluded for the same "shown to others, unverified"
 *    reason.
 *
 * That leaves `location` — the brief's own example of a safe field — as the
 * entire core-field surface. Extending this set later is a deliberate,
 * reviewable one-line change, exactly like extending an allowlist anywhere
 * else in this codebase (e.g. `AUTHENTICATION_ONLY` in guard-coverage.spec.ts).
 */
const SELF_EDITABLE_CORE_FIELDS = ['location'] as const

/**
 * `.strict()` is what makes every OTHER core column (status, orgUnitId,
 * username, primaryEmail, employeeId, managerId, firstName, lastName,
 * jobTitle, startDate, endDate — and any id-shaped field like `id`/`userId`
 * an attacker might try) a 400 VALIDATION_FAILED naming that exact key,
 * never a silently-ignored extra property. This is what makes "attempting a
 * non-editable field is a 400 naming the field, never a silent drop" a
 * property of the schema, not a convention the handler has to remember.
 */
// noNulChar — see docs/superpowers/audit-injection.md's HIGH "JSON-escaped
// NUL" finding (confirmed live on PATCH /self, which needs no role, so any
// authenticated user can trigger it) and safe-string.ts's own doc comment.
const selfUpdateBodySchema = z
  .object({
    location: noNulChar(z.string().min(1).max(255)).nullable().optional(),
    attributes: rawAttributesSchema,
  })
  .strict()

/**
 * `GET /self`'s response: the caller's OWN user record (never anyone else's
 * — see this file's file-level doc comment) plus enough metadata for a
 * client to build an edit form WITHOUT hard-coding which fields are
 * editable (task-4-brief.md: "driven by the attribute definitions, not
 * hard-coded"). `editable.attributes` is already filtered to
 * active+self_editable — the client never needs to know the filtering rule
 * itself, only the resulting list. Mirrors the existing convention of
 * extending `User` with request-scoped context rather than nesting it (see
 * `UserWithSyncState` in users.controller.ts).
 */
export interface SelfProfileResponse extends User {
  editable: {
    coreFields: readonly string[]
    attributes: AttributeDefinition[]
  }
}

/**
 * `GET /self/groups`'s response. `effective` is always a SUPERSET of
 * `direct` (see `GroupsRepository.listDirectGroupsForUser`'s doc comment) —
 * a client renders anything in `direct` as directly assigned and anything
 * present only in `effective` as inherited-through-nesting, which is how
 * task-4-brief.md's "direct and effective group membership must be visually
 * distinct" gets enough information to be implemented client-side without a
 * third, differenced list from the server.
 */
export interface SelfGroupsResponse {
  direct: Group[]
  effective: Group[]
}

/**
 * `GET /self`, `PATCH /self`, `GET /self/groups` — Milestone 6, Task 3.
 *
 * THE FOUR THINGS THAT MATTER MOST (from the milestone brief), and where
 * each is enforced:
 *
 *  1. **No user id, anywhere.** No route here declares a `:id`/`:userId`
 *     path segment, no body schema field names one (`selfUpdateBodySchema`
 *     is `.strict()` — an `id`/`userId` key is a 400, not a silent no-op),
 *     and no handler ever reads `@Query()`. Every handler's ONLY source of
 *     "which user" is `resolveCaller`, below, which resolves exclusively
 *     from the verified JWT principal. There is no id anywhere in this file
 *     for a caller to tamper with — IDOR is impossible by construction, not
 *     by a check that could be forgotten on a future route.
 *  2. **Works with no role at all.** `@UseGuards(JwtGuard)` ONLY — no
 *     `PermissionGuard`, no `@RequirePermission` anywhere below. Registered
 *     in `AUTHENTICATION_ONLY` in guard-coverage.spec.ts, the same
 *     exemption `MeController` already uses. `resolveCaller` calls
 *     `PermissionEngine.resolveActor`, which requires only an ACTIVE local
 *     user — never a role assignment (see its own doc comment).
 *  3. **Default-deny on edits.** `PATCH /self` touches only
 *     `SELF_EDITABLE_CORE_FIELDS` (via the strict body schema) plus
 *     attributes whose definition has `self_editable = true` (via
 *     `validateAttributes`, called with ONLY the self-editable definitions
 *     — see `update` below). Both reject an out-of-scope field by name with
 *     400 VALIDATION_FAILED; neither ever silently drops one.
 *  4. **Deactivated -> 403.** `resolveCaller` is the very first thing every
 *     handler does, before any read or write; `resolveActor` throws
 *     `ForbiddenError` for anything but an active user, which
 *     `DomainExceptionFilter` maps to 403.
 *
 * Credential management (password, MFA) has no route here at all, by
 * design — see task-4-brief.md: that is a deep link to Keycloak's Account
 * Console on the client side, never a server-side reimplementation.
 */
@Controller('self')
@UseGuards(JwtGuard)
export class SelfServiceController {
  constructor(
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(GroupsRepository) private readonly groups: GroupsRepository,
    @Inject(PermissionEngine) private readonly engine: PermissionEngine,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
    @Inject(OutboxWriter) private readonly outboxWriter: OutboxWriter,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Resolves the CALLER, and only the caller — never anything request-
   * supplied. Called first, unconditionally, by every handler below: doing
   * this before any other work means a deactivated (or otherwise
   * non-active) principal is rejected with 403 before touching any other
   * table, and it means there is exactly ONE place in this controller that
   * ever turns a principal into a user id, so every handler is provably
   * looking at the same identity resolution as every other. Resolved fresh
   * on every call, never cached — same reasoning as PermissionGuard's own
   * `resolveActor` call (see its doc comment): a revoked/deactivated
   * account must be denied on the very next request, not after some
   * arbitrary cache expiry.
   */
  private async resolveCaller(request: AuthenticatedRequest): Promise<Actor> {
    return this.engine.resolveActor(request.principal)
  }

  /** Active, self-editable, user-scoped attribute definitions only — the exact set `PATCH /self` may touch and `GET /self` advertises as editable. */
  private async selfEditableAttributeDefinitions(): Promise<AttributeDefinition[]> {
    const definitions = await this.users.listActiveAttributeDefinitions()
    return definitions.filter((definition) => definition.selfEditable)
  }

  private async toProfileResponse(user: User): Promise<SelfProfileResponse> {
    return {
      ...user,
      editable: {
        coreFields: SELF_EDITABLE_CORE_FIELDS,
        attributes: await this.selfEditableAttributeDefinitions(),
      },
    }
  }

  @Get()
  async me(@Req() request: AuthenticatedRequest): Promise<SelfProfileResponse> {
    const actor = await this.resolveCaller(request)

    // Defensive only: `actor.userId` was just resolved from a `users` row
    // that exists right now (resolveActor's own SELECT found it) — there is
    // no delete for users, ever (see UsersRepository.changeStatus's doc
    // comment), so this can only be null if that invariant is somehow
    // violated. NotFoundError, not a silent 500, either way.
    const user = await this.users.findById(actor.userId)
    if (user === null) {
      throw new NotFoundError('user', actor.userId)
    }

    return this.toProfileResponse(user)
  }

  /**
   * Effective groups are the brief's headline requirement; `direct` is
   * returned alongside so task-4-brief.md's "direct and effective... must be
   * visually distinct" is implementable without the client re-deriving
   * ancestry itself. Both are resolved for `actor.userId` — the CALLER,
   * never anything from the request — and both are looked up UNSCOPED
   * (`scopePaths: null` below): the whole point of this route is "show me
   * MY OWN memberships," which must never be narrower than an admin's own
   * directory-browse scope would allow (that scope question does not even
   * apply to your own data).
   */
  @Get('groups')
  async myGroups(@Req() request: AuthenticatedRequest): Promise<SelfGroupsResponse> {
    const actor = await this.resolveCaller(request)

    const [directIds, effectiveIds] = await Promise.all([
      this.groups.listDirectGroupsForUser(actor.userId),
      this.groups.listEffectiveGroupsForUser(actor.userId),
    ])

    const [direct, effective] = await Promise.all([
      this.groups.listByIds(directIds, { limit: directIds.length, offset: 0, scopePaths: null }),
      this.groups.listByIds(effectiveIds, { limit: effectiveIds.length, offset: 0, scopePaths: null }),
    ])

    return { direct, effective }
  }

  /**
   * Loads the CURRENT row inside the same transaction that performs the
   * mutation and writes the audit row — same shape as
   * `UsersController.update` — but narrows the writable surface instead of
   * narrowing WHICH row (there is only ever one candidate row: the actor's
   * own, resolved by `resolveCaller` before this transaction even opens).
   *
   * `attributes`, when present, MERGES onto the current row rather than
   * replacing it wholesale. This is deliberately DIFFERENT from
   * `UsersRepository.update`'s own contract (a full-object replace — see
   * its doc comment), and the difference is load-bearing, not cosmetic:
   * `validateAttributes` below is called with ONLY the self-editable
   * definitions, so `patch` can never contain a non-self-editable key by
   * construction. If that restricted `patch` were written wholesale as the
   * user's entire `attributes` column, every OTHER attribute an admin had
   * already set on this same user (anything not self-editable) would be
   * silently erased the moment this user touched any ONE self-editable
   * attribute — exactly the "silent drop" the brief prohibits, just aimed
   * at a different set of fields than the 400-by-name case. Merging onto
   * `current.attributes` (loaded inside this same transaction, so it can
   * never be a stale read racing a concurrent write) preserves every
   * attribute this request didn't name.
   */
  @Patch()
  async update(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<SelfProfileResponse> {
    const actor = await this.resolveCaller(request)
    const parsed = parseBody(selfUpdateBodySchema, body)

    const selfEditableDefinitions = await this.selfEditableAttributeDefinitions()

    // Validated OUTSIDE the transaction, same ordering as
    // UsersController.update: this is pure Zod validation against an
    // in-memory definitions list (no DB access of its own), so there is
    // nothing to gain by holding a transaction open across it — a request
    // naming a non-self-editable or unknown attribute key throws here and
    // never opens one at all. Only the MERGE below (which needs the
    // CURRENT row) has to happen inside the transaction.
    const attributePatch =
      parsed.attributes === undefined
        ? undefined
        : validateAttributes(selfEditableDefinitions, parsed.attributes)

    const updated = await this.db.transaction(async (tx) => {
      const current = await this.users.findById(actor.userId, tx)
      if (current === null) {
        throw new NotFoundError('user', actor.userId)
      }

      const attributes =
        attributePatch === undefined ? undefined : { ...current.attributes, ...attributePatch }

      const updated = await this.users.update(
        actor.userId,
        { location: parsed.location, attributes },
        tx,
      )

      await this.auditWriter.record(tx, {
        actorUserId: actor.userId,
        // Distinct from 'user:update' (an ADMIN acting on someone else) so
        // an audit review can tell "the user changed their own profile"
        // apart from "an administrator changed it for them" at a glance,
        // without having to compare actorUserId against resourceId.
        action: 'user:self_update',
        resourceType: 'user',
        resourceId: actor.userId,
        before: snapshotUser(current),
        after: snapshotUser(updated),
      })

      await this.outboxWriter.record(tx, {
        aggregateType: 'user',
        aggregateId: actor.userId,
        eventType: 'updated',
        payload: { ...snapshotUser(updated), action: 'user:self_update' },
      })

      return updated
    })

    return {
      ...updated,
      editable: { coreFields: SELF_EDITABLE_CORE_FIELDS, attributes: selfEditableDefinitions },
    }
  }
}
