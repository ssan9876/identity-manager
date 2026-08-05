import { Inject, Injectable } from '@nestjs/common'
import { eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { Principal } from '../auth/jwt.guard'
import { DB_CLIENT } from '../common/db.token'
import { ForbiddenError } from '../common/errors'
import * as schema from '../db/schema/index'
import { orgUnits } from '../db/schema/org-units'
import { roleAssignments } from '../db/schema/role-assignments'
import { users } from '../db/schema/users'
import { ROLE_PERMISSIONS, type Action, type RoleKey } from './actions'

export interface ActorAssignment {
  roleKey: RoleKey
  scopeOrgUnitId: string | null
  scopePath: string | null
}

export interface Actor {
  userId: string
  username: string
  orgUnitId: string
  assignments: ActorAssignment[]
}

@Injectable()
export class PermissionEngine {
  constructor(@Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>) {}

  /**
   * Maps an authenticated Keycloak principal onto a local user by username.
   * The sync design pushes our `username` to Keycloak, so `preferred_username`
   * is the same value by construction.
   *
   * INTERIM: Milestone 4 introduces `external_identities`, which stores the
   * Keycloak subject and becomes the authoritative mapping. Replace this then.
   *
   * Fails closed: an unmatched or non-active principal is denied, never
   * treated as an anonymous or default actor. The status check below is an
   * ALLOWLIST (`=== 'active'`), deliberately not a denylist of known-bad
   * statuses — a status added to the enum later (there are only four today:
   * pending/active/suspended/deactivated) is denied by default, not granted
   * by default.
   */
  async resolveActor(principal: Principal): Promise<Actor> {
    const [row] = await this.db
      .select({
        id: users.id,
        username: users.username,
        orgUnitId: users.orgUnitId,
        status: users.status,
      })
      .from(users)
      .where(sql`lower(${users.username}) = lower(${principal.username})`)
      .limit(1)

    if (row === undefined) {
      throw new ForbiddenError('principal does not map to a known user')
    }

    if (row.status !== 'active') {
      throw new ForbiddenError('principal does not map to an active user')
    }

    const assignments = await this.db
      .select({
        roleKey: roleAssignments.roleKey,
        scopeOrgUnitId: roleAssignments.scopeOrgUnitId,
        scopePath: orgUnits.path,
      })
      .from(roleAssignments)
      .leftJoin(orgUnits, eq(roleAssignments.scopeOrgUnitId, orgUnits.id))
      .where(eq(roleAssignments.userId, row.id))

    return {
      userId: row.id,
      username: row.username,
      orgUnitId: row.orgUnitId,
      assignments: assignments as ActorAssignment[],
    }
  }

  private grantingAssignments(actor: Actor, action: Action): ActorAssignment[] {
    return actor.assignments.filter((assignment) =>
      ROLE_PERMISSIONS[assignment.roleKey]?.includes(action) ?? false,
    )
  }

  /**
   * Does this actor hold `action` at ANY scope at all? Pure in-memory check
   * against the assignments `resolveActor` already fetched — no database
   * access, hence synchronous.
   *
   * This says nothing about WHICH org units are in scope. For a list route:
   * use this to decide whether to enter the route at all, then narrow
   * results with `scopePathsFor`. For a single, already-identified target,
   * use `canIn` instead — never treat "no target" and "an unresolved
   * target" as the same thing (see `canIn`).
   */
  canAnywhere(actor: Actor, action: Action): boolean {
    return this.grantingAssignments(actor, action).length > 0
  }

  assertCanAnywhere(actor: Actor, action: Action): void {
    if (!this.canAnywhere(actor, action)) {
      throw new ForbiddenError(`not permitted: ${action}`)
    }
  }

  /**
   * Does this actor hold `action` over this SPECIFIC, already-resolved org
   * unit? `orgUnitId` is required on purpose — it must be a real id, not
   * `string | undefined`. A failed lookup (e.g. `user?.orgUnitId` when
   * `findById` returned null) has to be handled by the caller BEFORE
   * reaching this method. The previous single `can(actor, action, target?)`
   * let "the target doesn't exist" and "there is no target to check, this is
   * a list route" collapse into the same `undefined`, and the list-route
   * branch resolved to an accidental allow — see task-3-report.md, Finding
   * I-2. Making the parameter required makes that shape fail to compile
   * instead of fail at runtime.
   */
  async canIn(actor: Actor, action: Action, orgUnitId: string): Promise<boolean> {
    const granting = this.grantingAssignments(actor, action)

    if (granting.length === 0) {
      return false
    }

    // A global assignment (NULL scope) applies everywhere.
    if (granting.some((assignment) => assignment.scopeOrgUnitId === null)) {
      return true
    }

    const scopePaths = granting
      .map((assignment) => assignment.scopePath)
      .filter((path): path is string => path !== null)

    if (scopePaths.length === 0) {
      return false
    }

    // scopePaths must be bound as ONE array-typed parameter, not interpolated
    // as SQL text (an injected ltree path would be an injection vector) and
    // not left as a bare `${scopePaths}` interpolation either: Drizzle's sql
    // tag treats a raw JS array specially — it splices it in as a
    // parenthesized, comma-separated list of individually-bound scalar
    // params (its IN/ANY-list convenience feature), not as one bound
    // `text[]`/`ltree[]` value. For a single scope that degrades to one
    // unwrapped scalar param, and `('a.b')::ltree[]` is not valid ltree
    // array syntax ("malformed array literal"); for two or more scopes it
    // becomes a parenthesized list, which cannot cast to ltree[] either.
    // Confirmed against a real Postgres (see task-3-report.md). `sql.param`
    // wraps the array as an opaque bound value instead, so the driver sends
    // it as a genuine array parameter and `path <@ ANY ($1::ltree[])`
    // evaluates correctly, with no string interpolation anywhere.
    const { rows } = await this.db.execute<{ contained: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
          FROM org_units
         WHERE id = ${orgUnitId}::uuid
           AND path <@ ANY (${sql.param(scopePaths)}::ltree[])
      ) AS contained
    `)

    return rows[0]?.contained ?? false
  }

  async assertCanIn(actor: Actor, action: Action, orgUnitId: string): Promise<void> {
    if (!(await this.canIn(actor, action, orgUnitId))) {
      throw new ForbiddenError(`not permitted: ${action}`)
    }
  }

  /**
   * The ltree paths within which this actor may perform `action`.
   * `null` means UNRESTRICTED (a global assignment) — apply no filter.
   * `[]` means NOWHERE (no applicable assignment at all) — apply a filter
   * that matches nothing.
   *
   * TRAP — do not conflate these by truthiness. `[]` is a truthy value (JS
   * arrays are always truthy, regardless of length), but `[].length` is
   * falsy. A caller who writes:
   *
   *   if (paths?.length) applyFilter(paths)   // else: no filter
   *
   * silently treats an actor entitled to NOTHING the same as one entitled to
   * EVERYTHING, because the `[]` case skips `applyFilter` too. The correct
   * guard checks presence, not length:
   *
   *   if (paths) applyFilter(paths)           // [] still filters correctly
   *   // else: paths is null — unrestricted, apply no filter at all
   */
  async scopePathsFor(actor: Actor, action: Action): Promise<string[] | null> {
    const granting = this.grantingAssignments(actor, action)

    if (granting.some((assignment) => assignment.scopeOrgUnitId === null)) {
      return null
    }

    return granting
      .map((assignment) => assignment.scopePath)
      .filter((path): path is string => path !== null)
  }
}
