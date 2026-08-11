import type { Action, RoleKey } from '../authz/actions'
import type { Actor, PermissionEngine } from '../authz/permission.engine'
import type { PrivilegeGuards } from '../authz/privilege.guards'
import type { OrgUnitsRepository } from '../org-units/org-units.repository'
import type { User, UsersRepository } from '../users/users.repository'
import type { ShapeParsedRow } from './import-row'

/**
 * Every database READ the per-row resolution of a bulk import needs, fetched
 * ONCE PER REQUEST as a handful of set-based queries instead of once per row
 * as a handful of single-key ones.
 *
 * WHY THIS EXISTS — measured, not assumed. Against a real Postgres
 * (Testcontainers, 5,000 rows), `POST /imports/preview` — which is pure
 * resolution, no writes at all — took **14.9 s (2.99 ms/row)**, and
 * `POST /imports/commit` took **60.9 s (12.18 ms/row)**. Resolution issued up
 * to SIX single-row queries per row (`findByEmployeeId`, `assertCanIn`'s
 * ltree containment, `assertCanModifyPrincipal`'s role-assignment select,
 * `orgUnits.findById`, the manager `findById`, and `findByEmail`/
 * `findByUsername`), each one a full network round trip. Nothing about that
 * work is inherently per-row: the keys are all known the moment the file is
 * parsed. This class resolves them in one query per KIND per request, then
 * answers each row from memory.
 *
 * IT CHANGES NO DECISION. Each lookup below mirrors, exactly, the
 * single-key call it replaces — same matching rule (`employeeId`
 * case-sensitive; email/username folded with `lower()`), same permission
 * logic (the scope check calls the REAL `PermissionEngine.assertCanIn`,
 * memoised per org unit rather than reimplemented; the privilege check calls
 * the REAL `PrivilegeGuards.assertRankPermitsModifying` over pre-fetched
 * role keys). Preview and commit share ONE instance built the same way, so
 * the property that preview predicts commit exactly is untouched.
 *
 * THE OVERLAY. A commit writes as it walks, so maps read once before the loop
 * would go stale mid-request: row 40 naming an email row 3 just created must
 * still resolve against that creation, exactly as the old per-row
 * `findByEmail`/`findByUsername`/`findById` re-queries did. `noteCreated`
 * folds each COMMITTED row back in (called after its transaction returns,
 * never inside it, so a rolled-back row leaves no trace).
 *
 * Honest note on what that is worth: for email and username the caller-
 * visible outcome is the same either way, because
 * `UsersRepository.translateWriteError` deliberately reports a unique
 * violation with the SAME wording resolution uses (`primaryEmail: not
 * available`) — a stale map would have let the row reach the INSERT and fail
 * there with an identical reason. The overlay is what keeps that a coincidence
 * of wording rather than a dependency: resolution stays truthful about the
 * state this request has already produced, no row is sent to a write that is
 * already known to be doomed, and a manager reference to a user created
 * earlier in the same file still resolves. Preview never calls it — preview
 * writes nothing, so there is nothing to fold in.
 */
export class ImportLookups {
  private constructor(
    private readonly engine: PermissionEngine,
    private readonly privileges: PrivilegeGuards,
    private readonly actor: Actor,
    private readonly usersByEmployeeId: Map<string, User>,
    private readonly usersByEmailLower: Map<string, User>,
    private readonly usersByUsernameLower: Map<string, User>,
    private readonly usersById: Map<string, User>,
    private readonly existingOrgUnitIds: Set<string>,
    private readonly roleKeysByUserId: Map<string, RoleKey[]>,
    /**
     * Memoised `assertCanIn` outcomes, keyed `action|orgUnitId`. `null` is a
     * pass; a non-null value is the error that check threw, rethrown
     * verbatim on every later row naming the same org unit — so a scope
     * rejection still reads identically per row (`resolveRow` turns it into
     * that row's own failure reasons), it is simply not re-queried. Scope
     * cannot change mid-request: `actor.assignments` is the snapshot
     * `resolveActor` already fetched, and org-unit paths are not written by
     * this endpoint.
     */
    private readonly scopeDecisions: Map<string, unknown>,
  ) {}

  /**
   * Fetches everything the given rows can possibly ask for. Only rows that
   * PASSED shape validation contribute keys — a malformed row never reached
   * a query before this change either, and its unvalidated values must not
   * reach one now (`orgUnitId`/`managerId` are bound as `uuid[]`, and
   * `parseImportRowShape` is what guarantees they are UUIDs).
   */
  static async build(
    rows: readonly ShapeParsedRow[],
    actor: Actor,
    deps: {
      users: UsersRepository
      orgUnits: OrgUnitsRepository
      engine: PermissionEngine
      privileges: PrivilegeGuards
    },
  ): Promise<ImportLookups> {
    const employeeIds = new Set<string>()
    const emails = new Set<string>()
    const usernames = new Set<string>()
    const managerIds = new Set<string>()
    const orgUnitIds = new Set<string>()

    for (const row of rows) {
      employeeIds.add(row.employeeId)
      emails.add(row.primaryEmail)
      usernames.add(row.username)
      orgUnitIds.add(row.orgUnitId)
      if (row.managerId !== null) managerIds.add(row.managerId)
    }

    const [byEmployeeId, byEmail, byUsername, managers, existingOrgUnitIds] = await Promise.all([
      deps.users.listByEmployeeIds([...employeeIds]),
      deps.users.listByEmails([...emails]),
      deps.users.listByUsernames([...usernames]),
      deps.users.listByIds([...managerIds]),
      deps.orgUnits.listExistingIds([...orgUnitIds]),
    ])

    const usersByEmployeeId = new Map<string, User>()
    for (const user of byEmployeeId) {
      if (user.employeeId !== null) usersByEmployeeId.set(user.employeeId, user)
    }
    const usersByEmailLower = new Map(byEmail.map((user) => [user.primaryEmail.toLowerCase(), user]))
    const usersByUsernameLower = new Map(byUsername.map((user) => [user.username.toLowerCase(), user]))
    const usersById = new Map<string, User>()
    for (const user of [...managers, ...byEmployeeId, ...byEmail, ...byUsername]) {
      usersById.set(user.id, user)
    }

    // Only the users an UPDATE row could match need a privilege check — a
    // create row has no existing principal to out-rank.
    const roleKeysByUserId = await deps.privileges.loadRoleKeysByUserId([...usersByEmployeeId.values()].map((user) => user.id))

    return new ImportLookups(
      deps.engine,
      deps.privileges,
      actor,
      usersByEmployeeId,
      usersByEmailLower,
      usersByUsernameLower,
      usersById,
      existingOrgUnitIds,
      roleKeysByUserId,
      new Map(),
    )
  }

  /** Replaces `UsersRepository.findByEmployeeId` — case-SENSITIVE, same as that method. */
  findByEmployeeId(employeeId: string): User | null {
    return this.usersByEmployeeId.get(employeeId) ?? null
  }

  /** Replaces `UsersRepository.findByEmail` — case-insensitive, same as that method. */
  findByEmail(email: string): User | null {
    return this.usersByEmailLower.get(email.toLowerCase()) ?? null
  }

  /**
   * Replaces `UsersRepository.findByUsername`'s CASE-FOLDING (insensitive,
   * same as that method) but NOT its organization scope: this map is built
   * from `listByUsernames`, which is global, whereas `findByUsername` is
   * scoped to the master organization because its contract is "the user
   * `resolveActor` would resolve" (see its doc comment).
   *
   * The divergence is deliberate and pre-existing, and the caller depends on
   * it: `resolveRow` uses this only to reject a row whose username is
   * already taken, and the reasoning behind that check's "not available"
   * wording (imports.controller.ts, the fix-wave-C oracle note) is written
   * against a GLOBAL lookup. Since `users_username_unique` became
   * per-tenant in 0028 this over-rejects — a username free in master but
   * taken in some tenant is reported unavailable — which fails CLOSED
   * (a creatable row is refused, never a foreign row silently updated) and
   * so is left alone here rather than changed as a side effect of the
   * authorization-path fix. Narrowing it is an import-scope decision of its
   * own.
   */
  findByUsername(username: string): User | null {
    return this.usersByUsernameLower.get(username.toLowerCase()) ?? null
  }

  /** Replaces `UsersRepository.findById` (used only to test manager resolvability). */
  findById(id: string): User | null {
    return this.usersById.get(id) ?? null
  }

  /** Replaces `OrgUnitsRepository.findById(...) === null` — existence is the only thing the caller asked. */
  orgUnitExists(orgUnitId: string): boolean {
    return this.existingOrgUnitIds.has(orgUnitId)
  }

  /**
   * Replaces a per-row `PermissionEngine.assertCanIn`. Calls the real one on
   * the first row naming a given (action, org unit) pair and replays its
   * outcome — pass or the exact thrown error — for every later row naming
   * the same pair. A file's rows name few DISTINCT org units, so this is a
   * handful of queries per request rather than one per row, with the
   * decision itself still made entirely by `PermissionEngine`.
   */
  async assertCanIn(action: Action, orgUnitId: string): Promise<void> {
    const key = `${action}|${orgUnitId}`
    if (this.scopeDecisions.has(key)) {
      const remembered = this.scopeDecisions.get(key)
      if (remembered !== null) throw remembered
      return
    }

    try {
      await this.engine.assertCanIn(this.actor, action, orgUnitId)
      this.scopeDecisions.set(key, null)
    } catch (error) {
      this.scopeDecisions.set(key, error)
      throw error
    }
  }

  /**
   * Replaces a per-row `PrivilegeGuards.assertCanModifyPrincipal`. The role
   * keys were fetched in one query above; the decision is made by
   * `PrivilegeGuards` itself, so an unknown `role_key` still raises the same
   * `DataIntegrityError` and a more-privileged target still raises the same
   * `ForbiddenError`.
   */
  assertCanModifyPrincipal(targetUserId: string): void {
    this.privileges.assertRankPermitsModifying(this.actor, this.roleKeysByUserId.get(targetUserId) ?? [])
  }

  /**
   * Folds a row this request just committed into the maps, so later rows see
   * it exactly as a re-query would have. See this class's doc comment.
   */
  noteCreated(user: User): void {
    if (user.employeeId !== null) this.usersByEmployeeId.set(user.employeeId, user)
    this.usersByEmailLower.set(user.primaryEmail.toLowerCase(), user)
    this.usersByUsernameLower.set(user.username.toLowerCase(), user)
    this.usersById.set(user.id, user)
  }
}
