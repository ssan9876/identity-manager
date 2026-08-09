import { Inject, Injectable } from '@nestjs/common'
import { and, asc, eq, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { AttributeDefinition, ValidationRules } from '../attributes/attribute-validator'
import { DB_CLIENT } from '../common/db.token'
import { ConflictError, InvalidTransitionError, NotFoundError } from '../common/errors'
import { attributeDefinitions } from '../db/schema/attribute-definitions'
import * as schema from '../db/schema/index'
import { orgUnits } from '../db/schema/org-units'
import { users } from '../db/schema/users'

export type UserStatus = 'pending' | 'active' | 'suspended' | 'deactivated'

export interface User {
  id: string
  status: UserStatus
  primaryEmail: string
  username: string
  firstName: string
  lastName: string
  displayName: string
  employeeId: string | null
  jobTitle: string | null
  orgUnitId: string
  managerId: string | null
  location: string | null
  startDate: string | null
  endDate: string | null
  attributes: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
  deactivatedAt: Date | null
}

export interface CreateUserInput {
  primaryEmail: string
  username: string
  firstName: string
  lastName: string
  orgUnitId: string
  employeeId?: string
  jobTitle?: string
  managerId?: string
  location?: string
  startDate?: string
  endDate?: string
  attributes?: Record<string, unknown>
}

/**
 * A partial update to an existing user. A field left `undefined` (omitted
 * from the request body) leaves the corresponding column untouched; a field
 * explicitly `null` clears it, for every column that is itself nullable.
 * `attributes`, when present, REPLACES the stored object wholesale (the
 * same whole-object contract `create` already has) rather than merging —
 * see UsersController.update.
 *
 * Deliberately excludes primaryEmail, username, orgUnitId and status: see
 * UsersRepository.update's doc comment for why each is left out of this
 * milestone's PATCH surface.
 */
export interface UpdateUserInput {
  firstName?: string
  lastName?: string
  jobTitle?: string | null
  employeeId?: string | null
  managerId?: string | null
  location?: string | null
  startDate?: string | null
  endDate?: string | null
  attributes?: Record<string, unknown>
}

// `pending -> deactivated` (finding M5, docs/archive/audits/audit-integrity.md):
// a leaver whose end_date passes before they were ever activated is exactly
// as much a leaver as an active one — see
// `listNonDeactivatedWithEndDateOnOrBefore`'s own doc comment, which already
// documents that intent. Omitting this transition made that intent
// unreachable by construction: `LifecycleJob.deactivateDueUsers` selects
// such a user, then `changeStatus(id, 'deactivated')` unconditionally threw
// `InvalidTransitionError` for every single one, forever (caught and
// `console.warn`'d — see that method's own doc comment for why silent
// skipping is itself part of the finding).
const ALLOWED_TRANSITIONS: Record<UserStatus, readonly UserStatus[]> = {
  pending: ['active', 'deactivated'],
  active: ['suspended', 'deactivated'],
  suspended: ['active', 'deactivated'],
  deactivated: [],
}

/**
 * The statuses from which `next` may be reached directly, derived from
 * ALLOWED_TRANSITIONS so the two can never drift apart. Used as the `WHERE
 * status IN (...)` guard on the atomic transition update below. Empty for a
 * `next` nothing transitions into (currently only `pending`).
 */
function statusesThatMayTransitionTo(next: UserStatus): UserStatus[] {
  return (Object.keys(ALLOWED_TRANSITIONS) as UserStatus[]).filter((from) =>
    ALLOWED_TRANSITIONS[from].includes(next),
  )
}

const FOREIGN_KEY_VIOLATION = '23503'
const UNIQUE_VIOLATION = '23505'

// Exact constraint/index names, taken from the generated migration SQL
// (Drizzle's `${table}_${column(s)}_..._fk` / `..._unique` naming
// convention) — never guessed. See db/migrations/0001_curly_quentin_quire.sql
// for both FKs and db/schema/users.ts for both unique indexes.
const ORG_UNIT_FK_CONSTRAINT = 'users_org_unit_id_org_units_id_fk'
const MANAGER_FK_CONSTRAINT = 'users_manager_id_users_id_fk'
const EMAIL_UNIQUE_CONSTRAINT = 'users_primary_email_unique'
const USERNAME_UNIQUE_CONSTRAINT = 'users_username_unique'
const EMPLOYEE_ID_UNIQUE_CONSTRAINT = 'users_employee_id_unique'

@Injectable()
export class UsersRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>) {}

  /**
   * `create`, `findById`, `update` and `changeStatus` below all accept an
   * OPTIONAL trailing `db` handle, defaulting to the injected pooled
   * connection (`this.db`). A caller that already opened a transaction —
   * every write in UsersController does, so its mutation and its
   * AuditWriter.record(tx, …) audit row commit or roll back together —
   * passes that `tx` through instead, and every query in the call runs on
   * the SAME connection as the audit write.
   *
   * The parameter is typed as the WIDE `NodePgDatabase<typeof schema>`
   * (what `this.db` already is), not the narrow `DbHandle` AuditWriter
   * uses. Drizzle's `PgTransaction` class extends `PgDatabase` and only
   * ADDS members (`rollback`, etc.) — a structural SUBTYPE — so a `tx`
   * satisfies this wider parameter with no cast, while `this.db` still
   * works as the default. This is the opposite direction from
   * AuditWriter.record's `DbHandle`, which deliberately narrows so a
   * *pooled* handle is rejected there; here, widening is what lets every
   * EXISTING one-argument call site across the test suite keep compiling
   * unchanged.
   */
  async create(input: CreateUserInput, db: NodePgDatabase<typeof schema> = this.db): Promise<User> {
    const [unit] = await db
      .select({ organizationId: orgUnits.organizationId })
      .from(orgUnits)
      .where(eq(orgUnits.id, input.orgUnitId))
    if (unit === undefined) {
      throw new NotFoundError('org unit', input.orgUnitId)
    }
    // Derived, never client-supplied: a request cannot place a person in
    // another tenant, and this is the value Task 4's composite FK checks.
    const organizationId = unit.organizationId

    try {
      const [row] = await db
        .insert(users)
        .values({
          organizationId,
          primaryEmail: input.primaryEmail,
          // LOW finding (docs/archive/audits/audit-injection.md): unnormalised
          // Unicode input (NFD, RTL overrides, ZWJ, homoglyphs) was stored
          // verbatim. `users_username_unique` and PermissionEngine.resolveActor
          // both already agree exactly on `lower(username)` — this is NOT an
          // ambiguous-principal-resolution bug, Postgres's own `lower()`
          // folding rejects a same-fold collision with 409 regardless — but
          // NFC "café" and NFD "café" fold to DIFFERENT byte sequences even
          // after lower(), so both currently succeed as two visually
          // IDENTICAL, distinct accounts (a display-layer impersonation risk:
          // displayName is shown to every user in the directory). This is the
          // only site that ever sets `username` on a user — see
          // UsersRepository.update's own doc comment for why PATCH excludes
          // it — so normalising here, once, on write closes the gap: two
          // requests differing only in normalisation form now collide on the
          // SAME stored NFC form and correctly 409 via the unique index.
          username: input.username.normalize('NFC'),
          firstName: input.firstName,
          lastName: input.lastName,
          displayName: `${input.firstName} ${input.lastName}`.trim(),
          orgUnitId: input.orgUnitId,
          employeeId: input.employeeId ?? null,
          jobTitle: input.jobTitle ?? null,
          managerId: input.managerId ?? null,
          location: input.location ?? null,
          startDate: input.startDate ?? null,
          endDate: input.endDate ?? null,
          attributes: input.attributes ?? {},
        })
        .returning()

      return row as User
    } catch (cause) {
      this.translateWriteError(cause, input)
    }
  }

  async findById(id: string, db: NodePgDatabase<typeof schema> = this.db): Promise<User | null> {
    const [row] = await db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1)

    return (row as User | undefined) ?? null
  }

  /**
   * Same as `findById`, but `SELECT ... FOR UPDATE`: takes a row-level write
   * lock on this user for the rest of the caller's transaction, so a SECOND
   * concurrent caller's own `findByIdForUpdate` on the same id BLOCKS until
   * the first commits, then reads the first's committed result rather than
   * racing it — Postgres's documented READ COMMITTED + `FOR UPDATE`
   * behaviour: a blocked `SELECT ... FOR UPDATE` that is unblocked by the
   * blocker's COMMIT re-fetches the just-committed row version, not the
   * snapshot it originally requested.
   *
   * Exists for finding H4 (docs/archive/audits/audit-integrity.md): a caller
   * that reads `current`, computes something derived from it (a merged
   * `attributes` object, a recomputed `displayName`), and writes that
   * derived value back is a lost-update hazard under a PLAIN `findById` —
   * two concurrent callers can both read the same starting row, both
   * compute against that same stale snapshot, and whichever writes last
   * silently discards the other's change, taking no lock and colliding with
   * nothing on the way in. `SelfServiceController.update` (attribute merge)
   * and `RuleApplier.applySetAttribute` (JML `set_attribute`, identical
   * merge shape) both call this instead of `findById` for exactly that
   * reason; see their own doc comments. Contrast `changeStatus`, which needs
   * no row lock at all because its own conditional `UPDATE ... WHERE status
   * IN (...)` already makes the decision and the write one atomic step
   * (EvalPlanQual) — a lock is the right tool only when the WRITE's value
   * itself depends on a separately-computed READ, which a plain conditional
   * UPDATE's WHERE clause cannot express for an arbitrary jsonb merge.
   */
  async findByIdForUpdate(id: string, db: NodePgDatabase<typeof schema> = this.db): Promise<User | null> {
    const [row] = await db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .for('update')
      .limit(1)

    return (row as User | undefined) ?? null
  }

  async findByEmail(email: string): Promise<User | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.primaryEmail}) = lower(${email})`)
      .limit(1)

    return (row as User | undefined) ?? null
  }

  /**
   * Case-insensitive match on `username` — the same field and comparison
   * `PermissionEngine.resolveActor` uses to map an authenticated principal
   * onto a local user (`lower(username) = lower(principal.username)`; see
   * permission.engine.ts). Callers that need "the user the guard would
   * resolve for this principal" must use this, not `findByEmail`: email and
   * username are independent, both-unique columns, so a row can match one
   * without matching the other, and matching on the wrong one finds (and
   * risks acting on) an unrelated user.
   */
  async findByUsername(username: string): Promise<User | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.username}) = lower(${username})`)
      .limit(1)

    return (row as User | undefined) ?? null
  }

  /**
   * Exact (case-sensitive — `employee_id` has no case-insensitive uniqueness
   * contract, unlike email/username) match on `employeeId`. Milestone 5's
   * bulk import is idempotent on this field (`users_employee_id_unique`,
   * this table's partial unique index): ImportsController calls this once
   * per row to decide create-vs-update before ever attempting a write, which
   * is what lets preview report the same decision while writing nothing.
   */
  async findByEmployeeId(employeeId: string): Promise<User | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.employeeId, employeeId))
      .limit(1)

    return (row as User | undefined) ?? null
  }

  /**
   * Partial update of an existing user's profile fields. `id` must already
   * exist — 404s otherwise. This re-check is defensive: every current
   * caller (UsersController.update) has already loaded the row moments
   * earlier for its own assertCanIn/assertCanModifyPrincipal checks, but a
   * public repository method should not rely on a caller having done that.
   *
   * Deliberately does NOT accept primaryEmail, username, orgUnitId or
   * status — those are not part of this milestone's PATCH contract
   * (task-2-brief.md specifies create/update/deactivate, not a "transfer
   * between org units" or "rename" operation):
   *   - status transitions are `changeStatus`'s job alone (atomic,
   *     validated, and the only path to `deactivated` — see its own doc
   *     comment below).
   *   - `username` is what `PermissionEngine.resolveActor` matches a
   *     principal against (`lower(username) = lower(principal.username)`).
   *     Silently repointing it here, with no Keycloak-side sync (that is
   *     Milestone 4's `external_identities` work), would strand the
   *     affected user's next login.
   *   - `orgUnitId` reassignment is a materially different authorization
   *     question than editing a user in place — it would need its own
   *     scope check against the DESTINATION unit, not just the current
   *     one, which is outside what this task specifies.
   *
   * Reads `current` via `findByIdForUpdate` (`SELECT ... FOR UPDATE`), not
   * a plain read — finding M1 (docs/archive/audits/audit-integrity.md):
   * `displayName` is DERIVED from `patch.firstName ?? current.firstName` /
   * `patch.lastName ?? current.lastName` below, so a stale `current` under
   * concurrency produces a stale derived value with the SAME lost-update
   * mechanism as H4's attribute merge — two concurrent PATCHes, one naming
   * only `firstName` and one naming only `lastName`, each recompute
   * `displayName` from their own unlocked, stale half, measured 30/30. Every
   * caller of this method runs inside its own transaction already (see this
   * method's own `db` parameter doc comment), so the lock is released the
   * moment that transaction ends — no caller needs to change to benefit.
   * `displayName` is shown to every other user in the directory (see
   * SelfServiceController's own doc comment on why `firstName`/`lastName`
   * are excluded from self-service for exactly this reason), so a
   * permanently-inconsistent derived value is a real, not cosmetic, defect.
   */
  async update(
    id: string,
    patch: UpdateUserInput,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<User> {
    const current = await this.findByIdForUpdate(id, db)
    if (current === null) {
      throw new NotFoundError('user', id)
    }

    const setValues: Record<string, unknown> = { updatedAt: new Date() }
    if (patch.firstName !== undefined) setValues.firstName = patch.firstName
    if (patch.lastName !== undefined) setValues.lastName = patch.lastName
    if (patch.jobTitle !== undefined) setValues.jobTitle = patch.jobTitle
    if (patch.employeeId !== undefined) setValues.employeeId = patch.employeeId
    if (patch.managerId !== undefined) setValues.managerId = patch.managerId
    if (patch.location !== undefined) setValues.location = patch.location
    if (patch.startDate !== undefined) setValues.startDate = patch.startDate
    if (patch.endDate !== undefined) setValues.endDate = patch.endDate
    if (patch.attributes !== undefined) setValues.attributes = patch.attributes

    // displayName is DERIVED, never accepted directly from the client —
    // recompute it whenever either half of its input changes, falling back
    // to the pre-patch value for whichever half didn't, so it never goes
    // stale relative to firstName/lastName.
    if (patch.firstName !== undefined || patch.lastName !== undefined) {
      const firstName = patch.firstName ?? current.firstName
      const lastName = patch.lastName ?? current.lastName
      setValues.displayName = `${firstName} ${lastName}`.trim()
    }

    try {
      const [row] = await db.update(users).set(setValues).where(eq(users.id, id)).returning()
      return row as User
    } catch (cause) {
      this.translateWriteError(cause, { managerId: patch.managerId })
    }
  }

  /**
   * There is no delete. Removal is a transition to `deactivated`, which is
   * terminal, so historical access questions stay answerable.
   *
   * The read-validate-write pattern is not safe here: two concurrent callers
   * can both read the same starting status, both pass validation against
   * that stale snapshot, and both blindly overwrite the row, silently
   * discarding whichever write lost the race — including a `deactivated`
   * write, which must never be undone. Instead this issues a single
   * conditional UPDATE whose WHERE clause re-checks the transition legality
   * against the row's *current* committed status at write time. Postgres
   * serializes concurrent UPDATEs on the same row (row-level lock) and
   * re-evaluates a blocked UPDATE's WHERE clause against the winner's
   * committed data before applying it (EvalPlanQual), so the decision and
   * the write are one atomic step with no window for a lost update.
   */
  async changeStatus(
    id: string,
    next: UserStatus,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<User> {
    const permittedFrom = statusesThatMayTransitionTo(next)

    // A `next` with no valid predecessor (only `pending` today) can never
    // match any row. `inArray` with an empty array is unsafe to send to the
    // driver, and there is nothing to gain by trying — skip straight to
    // error determination below.
    if (permittedFrom.length > 0) {
      const [row] = await db
        .update(users)
        .set({
          status: next,
          updatedAt: new Date(),
          // Only touched when landing on `deactivated`; omitted entirely
          // from the SET clause otherwise so the existing value, if any, is
          // left untouched rather than being reset.
          ...(next === 'deactivated' ? { deactivatedAt: new Date() } : {}),
        })
        .where(and(eq(users.id, id), inArray(users.status, permittedFrom)))
        .returning()

      if (row) {
        return row as User
      }
    }

    // Zero rows matched (or there was no valid predecessor to try at all).
    // This read is advisory only, purely to report an accurate reason — the
    // atomic UPDATE above already made the real decision. Uses the SAME
    // handle passed in (tx, if the caller opened one), not `this.db`, so a
    // failed transition never depends on a second, out-of-transaction
    // connection.
    const current = await this.findById(id, db)
    if (current === null) {
      throw new NotFoundError('user', id)
    }

    if (current.status === 'deactivated') {
      throw new InvalidTransitionError(
        'deactivated is terminal; the user cannot be reactivated',
      )
    }

    throw new InvalidTransitionError(
      `cannot transition from ${current.status} to ${next}`,
    )
  }

  /**
   * Maps a Postgres write-constraint violation to the right DomainError, by
   * CONSTRAINT NAME — never by SQLSTATE alone. `users` carries two foreign
   * keys (org_unit_id, manager_id) and three unique indexes (primary_email,
   * username, employee_id); matching on `code === '23503'`/`'23505'` alone
   * would report every violation on this table as whichever single
   * resource happened to be tested first, mislabelling every other one —
   * the exact bug task-2-brief.md calls out closing for the FK case, and
   * the same table already has a second FK today, not just hypothetically
   * "in future". `input`'s fields are the ones each branch below actually
   * needs to explain that ONE violation; a caller that didn't touch a given
   * field simply never matches that branch. Anything unrecognized
   * (including a genuine bug's non-Postgres throw) is rethrown verbatim,
   * never swallowed.
   */
  private translateWriteError(
    cause: unknown,
    input: {
      orgUnitId?: string
      managerId?: string | null
      primaryEmail?: string
      username?: string
    },
  ): never {
    const pgError = cause as { code?: string; constraint?: string }

    if (pgError.code === FOREIGN_KEY_VIOLATION) {
      if (pgError.constraint === ORG_UNIT_FK_CONSTRAINT && input.orgUnitId !== undefined) {
        throw new NotFoundError('org unit', input.orgUnitId)
      }
      if (pgError.constraint === MANAGER_FK_CONSTRAINT && input.managerId) {
        throw new NotFoundError('manager', input.managerId)
      }
    }

    if (pgError.code === UNIQUE_VIOLATION) {
      // "not available", NOT `... "<value>" already exists`. Both unique
      // indexes are GLOBAL and unscoped, so echoing a confirmation back let
      // any holder of `user:create` in ONE org unit verify, one candidate per
      // request, that a given email or username exists somewhere in the
      // directory — including for principals `GET /users/:id` 403s them on.
      // The transaction rolls back, so the probing wrote no audit rows and was
      // silent. Wave D fixed exactly this on the import path
      // (imports.controller.ts's `primaryEmail: not available`) and missed the
      // direct-create sibling; finding SEC-L2,
      // docs/archive/audits/carried-findings-verification.md.
      //
      // The `field: message` shape is load-bearing for the console: it is what
      // api-field-errors.ts matches to put the error on the right input rather
      // than in a top-of-form banner.
      if (pgError.constraint === EMAIL_UNIQUE_CONSTRAINT && input.primaryEmail !== undefined) {
        throw new ConflictError('primaryEmail: not available')
      }
      if (pgError.constraint === USERNAME_UNIQUE_CONSTRAINT && input.username !== undefined) {
        throw new ConflictError('username: not available')
      }
      if (pgError.constraint === EMPLOYEE_ID_UNIQUE_CONSTRAINT) {
        throw new ConflictError('a user with this employee id already exists')
      }
    }

    throw cause
  }

  /**
   * Active, user-scoped custom attribute definitions, in the shape
   * `validateAttributes` expects. UsersController's create/update handlers
   * use this to build the schema a request's `attributes` is checked
   * against. Attribute propagation is default-deny (Milestone 3b global
   * constraint): with zero active definitions — true in every environment
   * until `attribute_definitions` gets its own write path (decision 4, not
   * this milestone) — any submitted attribute is rejected as unrecognized
   * rather than silently stored.
   *
   * `db` is an OPTIONAL trailing handle, defaulting to the injected pooled
   * connection (`this.db`) - same contract as create/findById/update above.
   * Added for SyncWorker.reconcileUser (finding C1,
   * docs/archive/audits/audit-integrity.md): that method runs inside the
   * worker's own open claim transaction and now passes it through here
   * rather than defaulting to the pool, so draining the outbox no longer
   * permanently pins two of the pool's connections per in-flight claim.
   */
  async listActiveAttributeDefinitions(
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<AttributeDefinition[]> {
    const rows = await db
      .select()
      .from(attributeDefinitions)
      .where(
        and(eq(attributeDefinitions.isActive, true), eq(attributeDefinitions.appliesTo, 'user')),
      )

    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      label: row.label,
      dataType: row.dataType,
      required: row.required,
      validationRules: (row.validationRules ?? {}) as ValidationRules,
      appliesTo: row.appliesTo,
      isActive: row.isActive,
      selfEditable: row.selfEditable,
    }))
  }

  /**
   * Builds the shared status/orgUnit/scope/search/ids WHERE clause for
   * list() and count(), so the two can never drift apart on which rows they
   * agree count as "in".
   *
   * Deactivated users are excluded from all default list and search views
   * (core design spec). An explicit `status` — including `status:
   * 'deactivated'` itself, so an admin can still find them — overrides that
   * default rather than combining with it. `ids` (Milestone 8, Task 4) ALSO
   * overrides that default, when `status` was not itself given: this branch
   * exists to resolve an already-known, already-identified set of ids (a
   * group's membership — see UsersController.list's own doc comment on
   * `ids`), and silently dropping a deactivated member from that resolution
   * would look like a shorter membership list rather than what it actually
   * is — exactly the kind of silent mismatch docs/product-brief.md calls out ("a user
   * who *looks* healthy while their group sync dead-lettered is the worst
   * outcome this product can produce" — the same "don't silently hide state
   * that changes what a screen is telling you" principle, applied here to
   * status instead of sync).
   *
   * `scopePaths` follows PermissionEngine.scopePathsFor's contract exactly:
   * `undefined`/`null` means unrestricted (no scope filter at all); an array
   * — including `[]` — adds a real filter, and `[]` matches no row. Do not
   * collapse this to `if (filter.scopePaths?.length)`: that would treat an
   * actor entitled to `[]` (nowhere) the same as one passing `undefined`
   * (everywhere). See PermissionEngine.scopePathsFor's doc comment.
   *
   * `search`, when present, is already trimmed and non-empty (the
   * controller's job — see UsersController.list) and is ANDed together with
   * every other active filter, not ORed: a caller filtering by
   * status=active AND searching "ada" expects someone who is both, not
   * either. `ids`, when present, is guaranteed non-empty by both callers
   * below (list()/count() short-circuit an explicitly-empty `ids` before
   * ever reaching this method — see their own doc comments) — `inArray`
   * with an empty array is unsafe to hand to the driver, mirroring
   * GroupsRepository.listByIds's identical guard and reasoning.
   */
  private listFilters(filter: {
    status?: UserStatus
    orgUnitId?: string
    scopePaths?: string[] | null
    search?: string
    ids?: string[]
  }) {
    const filters = []
    if (filter.status !== undefined) {
      filters.push(eq(users.status, filter.status))
    } else if (filter.ids === undefined) {
      filters.push(ne(users.status, 'deactivated'))
    }
    if (filter.orgUnitId !== undefined) filters.push(eq(users.orgUnitId, filter.orgUnitId))
    if (filter.scopePaths !== undefined && filter.scopePaths !== null) {
      filters.push(this.scopeFilter(filter.scopePaths))
    }
    if (filter.search !== undefined) {
      filters.push(this.searchFilter(filter.search))
    }
    if (filter.ids !== undefined) {
      filters.push(inArray(users.id, filter.ids))
    }
    return and(...filters)
  }

  /**
   * Case-insensitive substring match across displayName, username and
   * primaryEmail — the fields an admin would actually recognise someone by.
   * Milestone 8, Task 2: `GET /users` had no text search at all before
   * this, only status/orgUnitId, which cannot do docs/product-brief.md's #1 job
   * ("find a person fast... search that survives hundreds of rows") on
   * their own — a client-side filter over a single fetched page cannot
   * either, once the directory outgrows one page.
   *
   * `%`, `_` and `\` in the caller's own term are escaped (prefixed with
   * `\`) before being wrapped in `%...%`: Postgres's LIKE/ILIKE pattern
   * language treats backslash as the default escape character WITHIN the
   * pattern itself, independent of how that pattern string reaches the
   * driver — so without this, a literal "%" or "_" in someone's name
   * (or in whatever a caller types) would act as an ILIKE wildcard instead
   * of matching itself. The pattern is bound as ONE parameter via the `sql`
   * tag's ordinary `${...}` interpolation (a plain string, not an array —
   * see PermissionEngine.canIn's doc comment for why arrays specifically
   * need `sql.param`), never spliced into the query text, so there is no
   * injection concern on top of the escaping.
   */
  private searchFilter(term: string) {
    const escaped = term.replace(/[\\%_]/g, (match) => `\\${match}`)
    const pattern = `%${escaped}%`
    return sql`(${users.displayName} ILIKE ${pattern} OR ${users.username} ILIKE ${pattern} OR ${users.primaryEmail} ILIKE ${pattern})`
  }

  /**
   * `users` has no `path` column of its own — a user's location in the tree
   * is only known via its `orgUnitId` FK — so scoping requires a correlated
   * EXISTS against `org_units` rather than a direct `<@ ANY (...)` on this
   * table. `scopePaths` is bound as ONE array-typed parameter via
   * `sql.param`, never interpolated into the query text: Drizzle's `sql` tag
   * splices a bare JS array in as a parenthesized list of individually-bound
   * scalars (its IN/ANY convenience feature), not as one `ltree[]` value, and
   * that shape cannot cast to `ltree[]` — see PermissionEngine.canIn's doc
   * comment (permission.engine.ts:131) for the confirmed-against-Postgres
   * explanation this follows.
   */
  private scopeFilter(scopePaths: string[]) {
    return sql`EXISTS (
      SELECT 1 FROM org_units ou
       WHERE ou.id = ${users.orgUnitId}
         AND ou.path <@ ANY (${sql.param(scopePaths)}::ltree[])
    )`
  }

  async list(
    options: {
      limit: number
      offset: number
      status?: UserStatus
      orgUnitId?: string
      scopePaths?: string[] | null
      search?: string
      ids?: string[]
    },
  ): Promise<User[]> {
    // An explicitly-empty `ids` (the caller asked to resolve "no ids") means
    // "matches nothing" — returned directly, never sent to Postgres as
    // `IN ()` (invalid SQL) or, worse, silently treated as "no ids filter"
    // (which would return everyone). Mirrors GroupsRepository.listByIds's
    // identical early return.
    if (options.ids !== undefined && options.ids.length === 0) {
      return []
    }

    const rows = await this.db
      .select()
      .from(users)
      .where(this.listFilters(options))
      .orderBy(asc(users.username))
      .limit(options.limit)
      .offset(options.offset)

    return rows as User[]
  }

  async count(
    filter: {
      status?: UserStatus
      orgUnitId?: string
      scopePaths?: string[] | null
      search?: string
      ids?: string[]
    } = {},
  ): Promise<number> {
    if (filter.ids !== undefined && filter.ids.length === 0) {
      return 0
    }

    const [row] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(users)
      .where(this.listFilters(filter))

    return row?.value ?? 0
  }

  /**
   * Every `pending` user whose `start_date` has arrived (<= `onOrBeforeDate`,
   * an ISO `YYYY-MM-DD` string, matching how `startDate`/`endDate` are
   * already accepted and stored — see CreateUserInput's doc comment) —
   * Milestone 7, Task 7's join half. `status = 'pending'` in the WHERE
   * clause is what makes LifecycleJob's activation pass naturally
   * idempotent: once a returned user has been transitioned to `active`, a
   * second run's identical query no longer returns them at all, with no
   * separate "already processed" bookkeeping needed. Unscoped
   * (`scopePaths`-free) on purpose — this is a trusted, on-demand system
   * script, not a request from a scoped actor (see LifecycleJob's own doc
   * comment), so it must see every eligible user, not just some actor's
   * subtree.
   */
  async listPendingWithStartDateOnOrBefore(onOrBeforeDate: string): Promise<User[]> {
    const rows = await this.db
      .select()
      .from(users)
      .where(
        and(eq(users.status, 'pending'), isNotNull(users.startDate), lte(users.startDate, onOrBeforeDate)),
      )
      .orderBy(asc(users.id))

    return rows as User[]
  }

  /**
   * Every `pending` user, optionally narrowed to ONE org-unit SUBTREE —
   * `BulkActivateJob`'s candidate query.
   *
   * Deliberately NOT `listPendingWithStartDateOnOrBefore`'s shape: that one
   * exists for the SCHEDULED path and therefore requires a `start_date`,
   * which is exactly what strands a user created without one (they are
   * never selectable, so they sit `pending` — and disabled in every
   * connector, since `desiredEnabled = status === 'active'` — forever).
   * This query has no date predicate at all: an operator asking to activate
   * a subtree is making that decision directly, not asking the calendar to
   * make it for them.
   *
   * `status = 'pending'` is the whole filter, so `deactivated` (terminal)
   * and `suspended` are both excluded. Suspension is a deliberate act and
   * un-suspending in bulk would silently undo it; `deactivated` must never
   * be resurrected at all. Reuses `scopeFilter` — the SAME ltree `<@`
   * containment the permission scope path uses — so "subtree" means here
   * exactly what it means everywhere else, rather than a second, drifting
   * definition.
   */
  async listPending(scopePath?: string): Promise<User[]> {
    const filters = [eq(users.status, 'pending')]
    if (scopePath !== undefined) {
      filters.push(this.scopeFilter([scopePath]))
    }

    const rows = await this.db
      .select()
      .from(users)
      .where(and(...filters))
      .orderBy(asc(users.id))

    return rows as User[]
  }

  /**
   * Every NOT-YET-`deactivated` user whose `end_date` has passed (<=
   * `onOrBeforeDate`) — Milestone 7, Task 7's leaver half. `status <>
   * 'deactivated'` (rather than restricting to `active`) deliberately also
   * catches a `pending` or `suspended` user whose end date arrived without
   * ever being activated (or while suspended) — an offboarded-before-ever-
   * onboarded/resumed employee is exactly as much a leaver as an active one.
   * `deactivated` is terminal (UsersRepository.changeStatus's own doc
   * comment), so excluding it here is what makes this query naturally
   * idempotent across repeated runs, the same mechanism
   * `listPendingWithStartDateOnOrBefore` uses above.
   */
  async listNonDeactivatedWithEndDateOnOrBefore(onOrBeforeDate: string): Promise<User[]> {
    const rows = await this.db
      .select()
      .from(users)
      .where(
        and(ne(users.status, 'deactivated'), isNotNull(users.endDate), lte(users.endDate, onOrBeforeDate)),
      )
      .orderBy(asc(users.id))

    return rows as User[]
  }
}
