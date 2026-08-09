import { Inject, Injectable } from '@nestjs/common'
import { eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import { DataIntegrityError, ForbiddenError } from '../common/errors'
import * as schema from '../db/schema/index'
import { roleAssignments } from '../db/schema/role-assignments'
import { ROLE_RANK, type RoleKey } from './actions'
import type { Actor, ActorAssignment } from './permission.engine'

const NO_PRIVILEGE = -1

@Injectable()
export class PrivilegeGuards {
  constructor(
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * The actor's own highest rank. ACTOR side of an intentionally asymmetric
   * pair with assertCanModifyPrincipal's target-rank lookup below: an
   * assignment whose roleKey is not present in ROLE_RANK (the database
   * enum can grow independently of this static catalog — see
   * ROLE_PERMISSIONS's doc comment) contributes NO privilege, rather than
   * corrupting the whole reduction.
   *
   * Finding I-1: `ROLE_RANK[unknownKey]` is `undefined`, and
   * `Math.max(n, undefined)` is `NaN`. Math.max returns NaN if ANY argument
   * ever was NaN, so one unrecognized assignment anywhere in the array
   * poisons every subsequent step of this reduce, and NaN fails every `<`
   * and `>` comparison — the caller's rank check would then never throw,
   * for ANY comparison, not just ones involving the unknown role. Demonstrated
   * live: `highestRank([super_admin, ghost])` was `NaN`, not `40`. An
   * unknown role must be ignored, never allowed to silently defeat every
   * later comparison.
   *
   * Finding I-1, round 2 (Critical): `ROLE_RANK[key] ?? NO_PRIVILEGE` alone
   * is not enough, because `??` only catches `null`/`undefined` — a
   * `roleKey` of `'constructor'`, `'toString'`, `'__proto__'`, etc.
   * resolves to a real, truthy, INHERITED value from `Object.prototype`
   * (e.g. `ROLE_RANK['constructor']` is the `Object` function), so `??`
   * never fires and `Math.max` coerces that inherited value to `NaN`
   * anyway — the exact bug this comment already describes, reopened via a
   * different door. This is belt-and-braces with ROLE_RANK now being built
   * on `Object.create(null)` (see actions.ts): even if that ever
   * regressed, this check does not depend on it.
   *
   * Finding I-1, round 3 (Minor, hardening): reads `ROLE_RANK[roleKey]`
   * exactly ONCE into `rank`, then checks `typeof rank === 'number'` —
   * rather than the round-2 shape, which evaluated `roleKey` twice (once
   * in `Object.hasOwn`, once in the index expression, each going through
   * `ToPropertyKey`). A double-read `Object.hasOwn(o, k) ? o[k] : d` can
   * only diverge from a single read if `k`'s string conversion is
   * unstable across the two reads (e.g. a hand-fabricated `roleKey` with a
   * flip-flopping `toString`), which is unreachable through the pg driver
   * (row values are plain strings) — but the single-read `typeof` form is
   * strictly stronger regardless: it validates the VALUE actually found is
   * a `number`, not merely that some own key by that name is present,
   * with no window for the two evaluations to disagree at all.
   */
  highestRank(assignments: ActorAssignment[]): number {
    return assignments.reduce((highest, assignment) => {
      const rank = ROLE_RANK[assignment.roleKey]
      return Math.max(highest, typeof rank === 'number' ? rank : NO_PRIVILEGE)
    }, NO_PRIVILEGE)
  }

  /**
   * An administrator may only grant a role they themselves hold, at a scope
   * their own holding covers. Without this, "help desk can reset passwords"
   * becomes "help desk can make themselves a super admin".
   *
   * CONTRACT — what this does NOT check: whether the actor may assign
   * roles AT ALL. An actor holding only a global `read_only` assignment
   * passes `assertCanAssignRole(actor, 'read_only', null)` — they DO hold
   * `read_only`, globally, so the "what do they hold, at what scope" logic
   * below is satisfied — even though nothing entitles them to reach a
   * role-assignment operation in the first place; that same actor's
   * `permissionEngine.canAnywhere(actor, 'role:assign')` is false. This is
   * a deliberate NARROWING guard (which role, at which scope), not a
   * complete authorization decision on its own. Callers MUST additionally
   * pair this with a `role:assign` permission check —
   * `PermissionEngine.assertCanAnywhere`/`assertCanIn`, scoped as
   * appropriate — before this method is ever reached.
   *
   * `db` is an OPTIONAL trailing handle, defaulting to the injected pooled
   * connection (`this.db`) — same contract, and same availability stakes,
   * as `PermissionEngine.canIn`/`assertCanIn` (see that doc comment): a
   * caller already inside `db.transaction(async (tx) => ...)` MUST pass its
   * `tx` here, or this re-enters the pool for a second connection while the
   * caller's transaction still holds its first — docs/archive/audits/audit-
   * integrity.md finding C1.
   */
  async assertCanAssignRole(
    actor: Actor,
    roleKey: RoleKey,
    scopeOrgUnitId: string | null,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<void> {
    const holdings = actor.assignments.filter(
      (assignment) =>
        assignment.roleKey === roleKey || assignment.roleKey === 'super_admin',
    )

    if (holdings.length === 0) {
      throw new ForbiddenError(`not permitted to grant ${roleKey}`)
    }

    // A global holding covers every scope, including a global grant.
    if (holdings.some((assignment) => assignment.scopeOrgUnitId === null)) {
      return
    }

    // Only a global holding may create a global grant.
    if (scopeOrgUnitId === null) {
      throw new ForbiddenError(`not permitted to grant ${roleKey} globally`)
    }

    const scopePaths = holdings
      .map((assignment) => assignment.scopePath)
      .filter((path): path is string => path !== null)

    // scopePaths must be bound via sql.param as ONE array-typed parameter,
    // not a bare `${scopePaths}` interpolation. Drizzle's sql tag treats a
    // raw JS array specially: it splices it in as a parenthesized,
    // comma-separated list of individually-bound scalar params (its IN/ANY
    // convenience feature), not as one bound `ltree[]` value. Confirmed
    // against a real Postgres — the bare form throws "malformed array
    // literal" for any non-empty scopePaths (22P02). Same root cause and
    // fix as PermissionEngine.canIn; see its comment and task-3-report.md
    // for the full Drizzle-source-level explanation.
    const { rows } = await db.execute<{ contained: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
          FROM org_units
         WHERE id = ${scopeOrgUnitId}::uuid
           AND path <@ ANY (${sql.param(scopePaths)}::ltree[])
      ) AS contained
    `)

    if (rows[0]?.contained !== true) {
      throw new ForbiddenError(`not permitted to grant ${roleKey} at that scope`)
    }
  }

  /**
   * An administrator may not modify a principal whose privileges exceed their
   * own — otherwise a help-desk account becomes a path to any executive's.
   *
   * CONTRACT — what this does NOT check: org-unit scope, on either side. A
   * `user_admin` scoped to Sales passes this against a global `read_only`
   * user who happens to live in Engineering: rank alone says "not more
   * privileged than me," which is true, and says nothing about whether the
   * actor may reach that principal at all. Rank and scope are
   * independently load-bearing; neither subsumes the other. Callers MUST
   * additionally pair this with
   * `permissionEngine.assertCanIn(actor, 'user:update', target.orgUnitId)`
   * (or the read-path equivalent) before this method is ever reached.
   *
   * `db` is an OPTIONAL trailing handle, defaulting to the injected pooled
   * connection (`this.db`) — identical contract, and identical availability
   * stakes, to `assertCanAssignRole` above (see its doc comment) and
   * `PermissionEngine.canIn`/`assertCanIn`. A caller already inside
   * `db.transaction(async (tx) => ...)` MUST pass its `tx` here.
   */
  async assertCanModifyPrincipal(
    actor: Actor,
    targetUserId: string,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<void> {
    const targetAssignments = await db
      .select({ roleKey: roleAssignments.roleKey })
      .from(roleAssignments)
      .where(eq(roleAssignments.userId, targetUserId))

    this.assertRankPermitsModifying(
      actor,
      targetAssignments.map((row) => row.roleKey),
    )
  }

  /**
   * "The role keys held by each of these principals", in ONE round trip —
   * the set-based half of `assertCanModifyPrincipal` above, for a caller
   * that must make the SAME decision about many targets at once. Bulk
   * import checks one target per matched CSV row, and paying a round trip
   * each is a measurable share of that endpoint's per-row cost (see
   * `ImportLookups`, imports/import-lookups.ts, the only caller today).
   *
   * A user id with no assignment row simply has no entry in the returned
   * map, which a caller must read as the empty list — the same thing the
   * single-target query returns for such a principal, i.e. `NO_PRIVILEGE`.
   * The decision itself is NOT duplicated here: callers pass what this
   * returns straight to `assertRankPermitsModifying`, the one place the
   * rank comparison and the unknown-role-key fault live, so a batched
   * caller and a single-target caller can never drift apart on what
   * "permitted" means.
   */
  async loadRoleKeysByUserId(
    userIds: readonly string[],
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<Map<string, RoleKey[]>> {
    const byUserId = new Map<string, RoleKey[]>()
    if (userIds.length === 0) return byUserId

    const rows = await db
      .select({ userId: roleAssignments.userId, roleKey: roleAssignments.roleKey })
      .from(roleAssignments)
      .where(sql`${roleAssignments.userId} = ANY (${sql.param([...userIds])}::uuid[])`)

    for (const row of rows) {
      const existing = byUserId.get(row.userId)
      if (existing === undefined) byUserId.set(row.userId, [row.roleKey])
      else existing.push(row.roleKey)
    }
    return byUserId
  }

  /**
   * The decision half of `assertCanModifyPrincipal`, over role keys already
   * fetched — pure, no database access. Called by `assertCanModifyPrincipal`
   * itself and by batched callers holding a `loadRoleKeysByUserId` map; it
   * is the single place the rank comparison and the unknown-role-key
   * data-integrity fault are expressed.
   */
  assertRankPermitsModifying(actor: Actor, targetRoleKeys: readonly RoleKey[]): void {
    // TARGET side of the asymmetric pair with highestRank above — see
    // Finding I-1. An unrecognized role_key here must NEVER read as "this
    // principal holds no privilege, go ahead": role_assignments.role_key is
    // a Postgres enum that can grow independently of this code's ROLE_RANK
    // catalog (ROLE_PERMISSIONS's doc comment: the catalog is deliberately
    // static code, changed only by review). A target row referencing a key
    // this catalog doesn't recognise is a data-integrity fault, not a
    // legitimate low-privilege principal, so this throws, never returns a
    // rank that could satisfy the comparison below.
    //
    // Finding AUTHZ-L-4 (docs/archive/audits/audit-authz.md), carried as an
    // Item-10 residual: this used to throw a PLAIN Error. That failed
    // closed — the audit verified it live with `ALTER TYPE role_key ADD
    // VALUE 'ghost'` — but produced a bodyless 500 indistinguishable from a
    // genuine crash, on a principal who is by then permanently unmodifiable
    // through the API with no actionable error anywhere. `DataIntegrityError`
    // is still a 500 and still fails closed; it just says WHICH key and why,
    // so the fault is a one-line fix instead of a mystery. It is the one
    // DomainError that maps to 5xx — see its own doc comment in
    // common/errors.ts for why that does not weaken this file's
    // "a non-DomainError is a bug" taxonomy.
    //
    // Finding I-1, round 2 (Critical): the original `in` operator walks
    // the prototype chain, so `'constructor' in ROLE_RANK` and
    // `'toString' in ROLE_RANK` are both `true` on an ordinary object even
    // though neither is an OWN property — the throw below was silently
    // skipped for any role_key colliding with an inherited
    // Object.prototype name, and ROLE_RANK[row.roleKey] then returned that
    // inherited (truthy, non-numeric) value straight into Math.max, which
    // coerces it to NaN. `Object.hasOwn` checks only own properties, never
    // inherited ones, so it is correct regardless of whether ROLE_RANK has
    // a prototype — belt-and-braces with ROLE_RANK now being built on
    // `Object.create(null)` (actions.ts). This is also what lets
    // `row.roleKey` be indexed into ROLE_RANK without an `as RoleKey`
    // cast — the previous `ROLE_RANK[row.roleKey as RoleKey]` cast is
    // exactly what suppressed the compiler's ability to flag this as
    // possibly `undefined`.
    const targetRank = targetRoleKeys.reduce((highest, roleKey) => {
      if (!Object.hasOwn(ROLE_RANK, roleKey)) {
        throw new DataIntegrityError(
          `role_assignments references a role_key this build does not recognise: "${roleKey}"`,
        )
      }
      return Math.max(highest, ROLE_RANK[roleKey])
    }, NO_PRIVILEGE)

    if (this.highestRank(actor.assignments) < targetRank) {
      throw new ForbiddenError('not permitted to modify a more privileged principal')
    }
  }
}
