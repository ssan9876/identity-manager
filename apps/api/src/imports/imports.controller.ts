import { randomUUID } from 'node:crypto'
import { Body, Controller, HttpCode, HttpStatus, Inject, Optional, Post, Req, UseGuards } from '@nestjs/common'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import type { AttributeDefinition } from '../attributes/attribute-validator'
import { validateAttributes } from '../attributes/attribute-validator'
import { JwtGuard } from '../auth/jwt.guard'
import { AuditWriter } from '../audit/audit.writer'
import type { Actor } from '../authz/permission.engine'
import { PermissionEngine } from '../authz/permission.engine'
import { PermissionGuard, type AuthorizedRequest } from '../authz/permission.guard'
import { PrivilegeGuards } from '../authz/privilege.guards'
import { RequirePermission } from '../authz/require-permission.decorator'
import { DB_CLIENT } from '../common/db.token'
import { DomainError, ValidationError } from '../common/errors'
import { parseBody } from '../common/http/parse-body'
import * as schema from '../db/schema/index'
import { OrgUnitsRepository } from '../org-units/org-units.repository'
import { OutboxWriter } from '../outbox/outbox.writer'
import { snapshotUser } from '../users/users.controller'
import {
  type CreateUserInput,
  type UpdateUserInput,
  type User,
  UsersRepository,
} from '../users/users.repository'
import { parseCsv } from './csv'
import { extraHeaders, missingRequiredHeaders, parseImportRowShape, type ShapeParsedRow } from './import-row'

const importBodySchema = z.object({ csv: z.string() }).strict()

/** DI token for `ImportsConfig` — same reasoning as KEYCLOAK_ADMIN_CONFIG (a plain TS interface erases at runtime, so it cannot be a constructor-injected token on its own). */
export const IMPORTS_CONFIG = Symbol('IMPORTS_CONFIG')

export interface ImportsConfig {
  /** Ceiling on DATA rows (header excluded) one preview/commit request may carry. */
  maxRows: number
}

// Same value as env.ts's IMPORT_MAX_ROWS default — kept independent (not
// imported from env.ts) so this controller has a sane bound even when
// constructed directly, outside AppModule's DI graph (every existing test
// in imports.write.spec.ts does exactly that, with no IMPORTS_CONFIG
// provider) — same pattern SyncWorker's DEFAULT_CONFIG uses for its own
// @Optional() config token.
const DEFAULT_IMPORTS_CONFIG: ImportsConfig = { maxRows: 5_000 }

export interface ImportRowFailure {
  row: number
  employeeId: string | null
  reasons: string[]
}

export interface ImportPreviewCreateRow {
  row: number
  employeeId: string
  primaryEmail: string
  username: string
}

export interface ImportPreviewUpdateRow {
  row: number
  employeeId: string
  userId: string
  primaryEmail: string
  username: string
}

export interface ImportPreviewResponse {
  toCreate: ImportPreviewCreateRow[]
  toUpdate: ImportPreviewUpdateRow[]
  failures: ImportRowFailure[]
  summary: { toCreate: number; toUpdate: number; failed: number; total: number }
}

export interface ImportCommitResponse {
  batchId: string
  created: number
  updated: number
  /**
   * Rows that matched an existing `employeeId` but whose resolved
   * `UpdateUserInput` was field-for-field identical to the current row —
   * finding M4 (docs/archive/audits/audit-integrity.md): re-running an
   * unchanged file used to still write a full round of no-op `user:update`
   * audit rows (`before` === `after`) and Keycloak sync events every time.
   * Counted separately from `updated`, which now means "the row genuinely
   * changed something."
   */
  unchanged: number
  failed: number
  failures: ImportRowFailure[]
}

type RowResolution =
  | { kind: 'failure'; row: number; employeeId: string | null; reasons: string[] }
  | { kind: 'create'; row: number; employeeId: string; input: CreateUserInput }
  | {
      kind: 'update'
      row: number
      employeeId: string
      userId: string
      input: UpdateUserInput
      current: User
    }

/**
 * Every DomainError this controller can catch mid-row (ForbiddenError from
 * assertCanIn/assertCanModifyPrincipal, AttributeValidationError from
 * validateAttributes, or a translateWriteError DomainError surfacing from a
 * real INSERT/UPDATE at commit time) becomes one or more human-readable
 * reason strings for that row's failure entry — never a thrown exception
 * that would abort the whole request. Anything that is NOT a DomainError is
 * a genuine bug (see common/errors.ts) and is rethrown to surface as a 500,
 * exactly like every other handler in this codebase.
 *
 * Used by `resolveRow`/`resolveCreateRow`/`resolveUpdateRow` below — every
 * call site there wraps a PURE READ (a permission check, an attribute
 * validation, a manager lookup) performed BEFORE any write is attempted, so
 * an unrecognized throw there really is a bug worth surfacing loudly. It is
 * deliberately NOT used for `commit`'s own per-row WRITE attempt — see
 * `writeAttemptFailureReasons` below for why that one specific call site
 * needs a non-rethrowing sibling instead.
 */
function domainErrorReasons(error: unknown): string[] {
  if (error instanceof ValidationError) return error.issues
  if (error instanceof DomainError) return [error.message]
  throw error
}

/**
 * `commit`'s per-row catch around the actual `this.users.create`/`update`
 * write attempt uses THIS, not `domainErrorReasons` above — the one
 * deliberate difference between the two. A DomainError here (typically a
 * `translateWriteError` ConflictError/NotFoundError surfacing from a race
 * against `resolveRow`'s own earlier, non-transactional reads) still
 * reports its normal specific message. But anything else must NEVER
 * rethrow: doing so aborts the whole `commit` request mid-loop, and the
 * caller never receives `batchId` — the only handle for auditing or
 * reversing whatever earlier rows in the SAME request already committed
 * (docs/archive/audits/audit-injection.md HIGH finding — a NUL-encoding error
 * on row 2 used to leave row 1 committed, row 3 never attempted, and return
 * a bare 500 with no way to identify what was written). Logged server-side
 * (this codebase's established best-effort `console.error` convention —
 * see UsersController.revokeKeycloakAccess) with full detail for an
 * operator to investigate; reported to the caller as a generic reason that
 * never echoes raw driver internals, and — critically — the loop continues
 * to the next row rather than aborting the request.
 */
function writeAttemptFailureReasons(error: unknown): string[] {
  if (error instanceof ValidationError) return error.issues
  if (error instanceof DomainError) return [error.message]
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[imports.controller] row write failed with an unexpected error: ${message}`)
  return ['an unexpected error occurred while writing this row']
}

/**
 * Set-equality on two flat string-keyed attribute bags, `===` per value —
 * sufficient for every `AttributeDataType` this system has
 * (`'string' | 'number' | 'boolean' | 'date' | 'enum'`, attribute-
 * validator.ts): none is array- or object-valued, so a shallow comparison
 * is a full comparison, no recursive/deep-equal needed.
 */
function attributesEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
}

/**
 * True when applying `input` to `current` would change NOTHING — finding M4
 * (docs/archive/audits/audit-integrity.md): "re-running the identical file
 * updates rather than duplicates" held for user rows, but not for audit/
 * outbox rows, which grew by a full batch on every re-run even when every
 * field already matched. Only fields `input` actually NAMES are compared
 * (an `undefined` field, per UpdateUserInput's own contract, means "this
 * request doesn't touch it" — never itself a source of "changed"); every
 * field `resolveUpdateRow` builds is always named for a real import row
 * (see its own doc comment), so in practice this compares the row's whole
 * writable surface, but the function stays correct even for a partial
 * input.
 */
function isNoopUpdate(input: UpdateUserInput, current: User): boolean {
  if (input.firstName !== undefined && input.firstName !== current.firstName) return false
  if (input.lastName !== undefined && input.lastName !== current.lastName) return false
  if (input.jobTitle !== undefined && input.jobTitle !== current.jobTitle) return false
  if (input.employeeId !== undefined && input.employeeId !== current.employeeId) return false
  if (input.managerId !== undefined && input.managerId !== current.managerId) return false
  if (input.location !== undefined && input.location !== current.location) return false
  if (input.startDate !== undefined && input.startDate !== current.startDate) return false
  if (input.endDate !== undefined && input.endDate !== current.endDate) return false
  if (input.attributes !== undefined && !attributesEqual(input.attributes, current.attributes)) return false
  return true
}

/**
 * Shared by both resolveCreateRow and resolveUpdateRow: manager resolvability
 * has no scope dimension and no create-vs-update variant (unlike orgUnitId),
 * so there is exactly one way to check it — mirrors the single-record
 * endpoint's own manager handling, which is likewise identical for create
 * and update (a plain FK, translated by UsersRepository.translateWriteError).
 */
async function appendManagerReason(
  users: UsersRepository,
  managerId: string | null,
  reasons: string[],
): Promise<void> {
  if (managerId === null) return
  const manager = await users.findById(managerId)
  if (manager === null) reasons.push('managerId: manager not found')
}

/**
 * `POST /imports/preview` and `POST /imports/commit` — Milestone 5 bulk
 * import. Both routes share ALL validation (`resolveRow` below); commit
 * additionally performs the write. See this class's method-level doc
 * comments for the full design, and task-1-2-report.md for the record of
 * the scope decisions made while implementing the plan's CONTRACTS (the
 * plan specifies behaviour, not a CSV column layout or response shape).
 *
 * THE FOUR THINGS THAT MATTER MOST (from the milestone brief), and where
 * each is enforced:
 *  1. Preview writes nothing ABOUT A USER — `preview()` below calls
 *     `resolveRow` only, which performs reads alone (no user INSERT/UPDATE
 *     statement anywhere in that call graph, and no outbox event); the
 *     user-facing write path is exclusively inside `commit()`. The one
 *     deliberate exception, added for docs/archive/audits/audit-secrets.md
 *     finding H1, is a single append-only audit row per PREVIEW INVOCATION
 *     (actor, row count, timestamp — never per candidate row) so mass
 *     cross-scope probing through this endpoint is no longer silent — see
 *     `preview()`'s own doc comment.
 *  2. Reuses the existing single-record write paths — `commit()` calls
 *     `this.users.create`/`this.users.update`, `this.auditWriter.record`,
 *     `this.outboxWriter.record`: the SAME functions UsersController's
 *     POST/PATCH call, not a second copy.
 *  3. Scope narrows the import — `resolveRow` calls
 *     `this.engine.assertCanIn(actor, 'user:create', ...)` for every row and
 *     turns a rejection into a reported failure, never a silent skip.
 *  4. Idempotent on `employee_id`, one `batch_id` per import — `resolveRow`
 *     matches via `this.users.findByEmployeeId`; `commit()` mints one
 *     `randomUUID()` per HTTP request and threads it through every audit row
 *     that request produces.
 */
@Controller('imports')
@UseGuards(JwtGuard, PermissionGuard)
export class ImportsController {
  private readonly config: ImportsConfig

  constructor(
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(OrgUnitsRepository) private readonly orgUnits: OrgUnitsRepository,
    @Inject(PermissionEngine) private readonly engine: PermissionEngine,
    @Inject(PrivilegeGuards) private readonly privileges: PrivilegeGuards,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
    @Inject(OutboxWriter) private readonly outboxWriter: OutboxWriter,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
    @Optional() @Inject(IMPORTS_CONFIG) config?: Partial<ImportsConfig>,
  ) {
    this.config = { ...DEFAULT_IMPORTS_CONFIG, ...config }
  }

  /**
   * Parses and validates the request's CSV body identically for both
   * routes: `parseBody` (body shape) -> `parseCsv` (tokenize) ->
   * `missingRequiredHeaders` (structural — a required COLUMN absent from the
   * header entirely can never produce a valid row, so this throws for the
   * whole request rather than becoming per-row noise, exactly like
   * `parseCsv`'s own malformed-input errors). Returns the parsed rows plus
   * whether the file carries any custom-attribute columns at all (computed
   * once, not per row — see ShapeParsedRow's doc comment on why that
   * matters for the undefined-vs-{} distinction on `attributes`) and the
   * active attribute definitions (fetched once per request, not once per
   * row, same batching rationale as SyncStateRepository).
   *
   * Also enforces `this.config.maxRows` — finding M6 (docs/archive/audits/
   * audit-integrity.md): "the no row-count or file-size cap open item is
   * real, but the damage is bounded by something nobody chose" (express's
   * own accidental ~100 KiB body limit, which capped a request at roughly
   * 800 rows purely by accident — see `main.ts`'s own `BODY_LIMIT_BYTES`
   * fix for the other, deliberate half). Checked here, structurally, the
   * same way `missingRequiredHeaders` already is: a whole-request rejection
   * with a clear 400 VALIDATION_FAILED naming the actual and allowed counts,
   * BEFORE a single row is resolved (permission-checked, looked up,
   * written) — never a truncated silent partial-apply, and never a chance
   * for `commit`'s per-row loop to run unbounded.
   */
  private async parseAndPrepare(
    body: unknown,
  ): Promise<{
    rows: Array<Record<string, string>>
    fileHasExtraHeaders: boolean
    definitions: AttributeDefinition[]
  }> {
    const parsed = parseBody(importBodySchema, body)

    // Cheap structural check BEFORE parsing. `parseCsv` materialises every row
    // into an object, so checking `rows.length` afterwards means an oversized
    // file is fully allocated and only then rejected — the row cap bounds what
    // gets WRITTEN, but not what gets ALLOCATED to find that out.
    //
    // Counting line breaks is O(n) over a string that is already in memory and
    // allocates nothing per row, so an over-cap file is refused before the
    // expensive part. Deliberately an over-COUNT (a quoted field may contain
    // newlines, and the header takes one line), so this never rejects a file
    // the real check below would have accepted — it only short-circuits ones
    // that cannot possibly fit.
    let lineBreaks = 0
    for (let i = 0; i < parsed.csv.length; i += 1) {
      if (parsed.csv.charCodeAt(i) === 10) lineBreaks += 1
    }
    if (lineBreaks > this.config.maxRows + 1) {
      throw new ValidationError([
        `csv: too many rows (more than ${this.config.maxRows}); the maximum per request is ${this.config.maxRows}`,
      ])
    }

    const { headers, rows } = parseCsv(parsed.csv)

    const missing = missingRequiredHeaders(headers)
    if (missing.length > 0) {
      throw new ValidationError([`csv: missing required column(s): ${missing.join(', ')}`])
    }

    if (rows.length > this.config.maxRows) {
      throw new ValidationError([
        `csv: too many rows (${rows.length}); the maximum per request is ${this.config.maxRows}`,
      ])
    }

    const fileHasExtraHeaders = extraHeaders(headers).length > 0
    const definitions = await this.users.listActiveAttributeDefinitions()

    return { rows, fileHasExtraHeaders, definitions }
  }

  /**
   * Dry-run diff: every row is resolved exactly as `commit` would resolve
   * it, but nothing about a USER is written — `resolveRow` never calls
   * `this.users.create`/`update` or `this.outboxWriter.record`; it only
   * reads. 200, not 201: nothing is created by this request.
   *
   * The ONE exception is the invocation-level audit row written
   * immediately below, once `parseAndPrepare` has already succeeded —
   * docs/archive/audits/audit-secrets.md finding H1 (mirrored in
   * audit-injection.md): `resolveRow` performs globally UNSCOPED
   * `findByEmployeeId`/`findByEmail`/`findByUsername` lookups and reports
   * per-field mismatches as named reasons, so an actor holding
   * `user:create` in ONE org unit can enumerate email/username/employeeId
   * existence and confirm guessed field values for users anywhere in the
   * directory — entirely silently, since this endpoint previously wrote
   * NOTHING at all, ever. `resolveUpdateRow` now also stops disclosing
   * per-field detail the moment scope/privilege rejects a row (the other
   * half of that finding), but a scoped actor probing rows they ARE
   * entitled to touch is unaffected by that — this audit row is what makes
   * mass probing visible after the fact either way: one row per HTTP
   * invocation (actor, row count, timestamp via `created_at`), never one
   * per candidate row — `audit_log` is append-only, so turning THIS into a
   * per-row log would itself become a second amplified write for the exact
   * unbounded-row-count endpoint the audit flags.
   */
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('user:create')
  async preview(@Body() body: unknown, @Req() request: AuthorizedRequest): Promise<ImportPreviewResponse> {
    const { rows, fileHasExtraHeaders, definitions } = await this.parseAndPrepare(body)

    // Only reached once parsing/permission have already succeeded — a
    // rejected request (bad CSV, no permission anywhere) writes nothing,
    // same contract as every other write handler in this codebase.
    await this.db.transaction(async (tx) => {
      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'import:preview',
        resourceType: 'import',
        resourceId: null,
        before: null,
        after: { rowCount: rows.length },
      })
    })

    const toCreate: ImportPreviewCreateRow[] = []
    const toUpdate: ImportPreviewUpdateRow[] = []
    const failures: ImportRowFailure[] = []
    const seen = new Map<string, number>()

    for (let index = 0; index < rows.length; index++) {
      const rowNumber = index + 2 // +1 for 1-based, +1 for the header line itself
      const resolution = await this.resolveRow(
        rows[index],
        rowNumber,
        request.actor,
        seen,
        fileHasExtraHeaders,
        definitions,
      )

      if (resolution.kind === 'failure') {
        failures.push({ row: resolution.row, employeeId: resolution.employeeId, reasons: resolution.reasons })
      } else if (resolution.kind === 'create') {
        toCreate.push({
          row: resolution.row,
          employeeId: resolution.employeeId,
          primaryEmail: resolution.input.primaryEmail,
          username: resolution.input.username,
        })
      } else {
        toUpdate.push({
          row: resolution.row,
          employeeId: resolution.employeeId,
          userId: resolution.userId,
          primaryEmail: resolution.current.primaryEmail,
          username: resolution.current.username,
        })
      }
    }

    return {
      toCreate,
      toUpdate,
      failures,
      summary: { toCreate: toCreate.length, toUpdate: toUpdate.length, failed: failures.length, total: rows.length },
    }
  }

  /**
   * Applies the batch. Same per-row resolution as `preview` (`resolveRow`),
   * then — for every row that resolved to a create/update, never for a
   * failure — one `db.transaction(...)` PER ROW that calls the exact same
   * `UsersRepository.create`/`update` + `AuditWriter.record` +
   * `OutboxWriter.record` sequence UsersController's own POST/PATCH call,
   * stamping every audit row with the SAME `batchId` (minted once above the
   * loop). Deliberately one transaction per row, not one for the whole
   * batch: a row that fails mid-write (a race against `resolveRow`'s
   * earlier, non-transactional reads — e.g. another request took the same
   * email a moment later) rolls back ONLY that row's own transaction and is
   * reported as a failure; every other row's already-committed transaction
   * is untouched. 200, not 201: this creates AND updates in one request, and
   * a batch with only failures still returns 200 with `created: 0` — the
   * request itself was well-formed, only the currently-empty apply-result is
   * what a 200 with `failed > 0` reports.
   */
  @Post('commit')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('user:create')
  async commit(@Body() body: unknown, @Req() request: AuthorizedRequest): Promise<ImportCommitResponse> {
    const { rows, fileHasExtraHeaders, definitions } = await this.parseAndPrepare(body)

    const batchId = randomUUID()
    let created = 0
    let updated = 0
    let unchanged = 0
    const failures: ImportRowFailure[] = []
    const seen = new Map<string, number>()

    for (let index = 0; index < rows.length; index++) {
      const rowNumber = index + 2
      const resolution = await this.resolveRow(
        rows[index],
        rowNumber,
        request.actor,
        seen,
        fileHasExtraHeaders,
        definitions,
      )

      if (resolution.kind === 'failure') {
        failures.push({ row: resolution.row, employeeId: resolution.employeeId, reasons: resolution.reasons })
        continue
      }

      try {
        if (resolution.kind === 'create') {
          await this.db.transaction(async (tx) => {
            const user = await this.users.create(resolution.input, tx)

            await this.auditWriter.record(tx, {
              actorUserId: request.actor.userId,
              action: 'user:create',
              resourceType: 'user',
              resourceId: user.id,
              before: null,
              after: snapshotUser(user),
              batchId,
            })

            await this.outboxWriter.record(tx, {
              aggregateType: 'user',
              aggregateId: user.id,
              eventType: 'created',
              payload: { ...snapshotUser(user), action: 'user:create', batchId },
            })
          })
          created += 1
        } else if (isNoopUpdate(resolution.input, resolution.current)) {
          // Finding M4 (docs/archive/audits/audit-integrity.md): the resolved
          // update would change nothing — skip the write (and both
          // records) entirely rather than writing a `before` === `after`
          // audit row and a no-op Keycloak sync event. `resolution.current`
          // is a non-transactional read taken during `resolveRow`, same as
          // every other field this branch already trusted (e.g. the
          // primaryEmail/username/orgUnitId equality checks above it) — a
          // rare concurrent change in the gap would at worst cost one
          // legitimate update on a LATER re-run of the same file, not
          // silent data loss.
          unchanged += 1
        } else {
          await this.db.transaction(async (tx) => {
            const updatedUser = await this.users.update(resolution.userId, resolution.input, tx)

            await this.auditWriter.record(tx, {
              actorUserId: request.actor.userId,
              action: 'user:update',
              resourceType: 'user',
              resourceId: resolution.userId,
              before: snapshotUser(resolution.current),
              after: snapshotUser(updatedUser),
              batchId,
            })

            await this.outboxWriter.record(tx, {
              aggregateType: 'user',
              aggregateId: resolution.userId,
              eventType: 'updated',
              payload: { ...snapshotUser(updatedUser), action: 'user:update', batchId },
            })
          })
          updated += 1
        }
      } catch (error) {
        failures.push({
          row: resolution.row,
          employeeId: resolution.employeeId,
          reasons: writeAttemptFailureReasons(error),
        })
      }
    }

    return { batchId, created, updated, unchanged, failed: failures.length, failures }
  }

  /**
   * Resolves ONE CSV row to either a create, an update, or a failure —
   * shared verbatim by `preview` and `commit` (task-2-brief.md: "same
   * validation as preview, then applies"), so the two routes can never
   * silently disagree on what a row means. Every DB access here is a READ
   * (`findByEmployeeId`, `findById`, `findByEmail`, `findByUsername`,
   * `assertCanIn`'s/`assertCanModifyPrincipal`'s own internal reads) —
   * nothing in this method writes, which is what makes `preview` writing
   * nothing a property of the CODE, not a convention callers must remember.
   *
   * Idempotency (task-2-brief.md, decision 6): matched by `employeeId`
   * alone. A match makes this an UPDATE; the reused write path is
   * `UsersRepository.update`, whose `UpdateUserInput` type structurally
   * cannot carry `primaryEmail`/`username`/`orgUnitId` — the exact same
   * restriction the JSON `PATCH /users/:id` surface already has, and for
   * the exact same reason (see UsersRepository.update's doc comment:
   * `username` is what `resolveActor` matches a principal against, and a
   * silent rename here has no Keycloak-side sync in this milestone either).
   * Reusing that restricted type is deliberate, not an oversight — building
   * a SEPARATE path that let import rename a user would be exactly the
   * "side door around the existing write path" the brief prohibits. So
   * rather than silently keeping the OLD value while reporting a row as
   * "updated" (a silent drop of what the file asked for — precisely what
   * the brief's scope-narrowing example warns against, generalized to every
   * field this write path cannot express), a row whose primaryEmail,
   * username, or orgUnitId disagrees with the already-matched existing
   * user is reported as a named failure instead.
   *
   * All OTHER fields (firstName, lastName, jobTitle, managerId, location,
   * startDate, endDate, attributes) ARE overwritten from the CSV on every
   * matched row, including on a re-run of an unchanged file (harmless:
   * same values back in) — the file is treated as each row's full desired
   * state, which is what makes "re-running the identical file updates
   * rather than duplicates" (task-2-brief.md) a meaningful, useful
   * operation rather than a no-op that merely avoids erroring.
   */
  private async resolveRow(
    raw: Record<string, string>,
    rowNumber: number,
    actor: Actor,
    seen: Map<string, number>,
    fileHasExtraHeaders: boolean,
    definitions: AttributeDefinition[],
  ): Promise<RowResolution> {
    const employeeIdForReporting = (raw.employeeId ?? '').trim() || null

    const shape = parseImportRowShape(raw, fileHasExtraHeaders)
    if (!shape.ok) {
      return { kind: 'failure', row: rowNumber, employeeId: employeeIdForReporting, reasons: shape.issues }
    }
    const row: ShapeParsedRow = shape.row

    const firstSeenAtRow = seen.get(row.employeeId)
    if (firstSeenAtRow !== undefined) {
      return {
        kind: 'failure',
        row: rowNumber,
        employeeId: row.employeeId,
        reasons: [`employeeId: duplicate within this file (first used at row ${firstSeenAtRow})`],
      }
    }
    seen.set(row.employeeId, rowNumber)

    const reasons: string[] = []
    const rawAttributes = row.rawAttributes ?? {}
    const existing = await this.users.findByEmployeeId(row.employeeId)

    if (existing !== null) {
      return this.resolveUpdateRow(
        row,
        rowNumber,
        actor,
        existing,
        reasons,
        rawAttributes,
        fileHasExtraHeaders,
        definitions,
      )
    }
    return this.resolveCreateRow(row, rowNumber, actor, reasons, rawAttributes, definitions)
  }

  private async resolveUpdateRow(
    row: ShapeParsedRow,
    rowNumber: number,
    actor: Actor,
    existing: User,
    reasons: string[],
    rawAttributes: Record<string, string>,
    fileHasExtraHeaders: boolean,
    definitions: AttributeDefinition[],
  ): Promise<RowResolution> {
    // Scope AND privilege are checked FIRST, before anything else about
    // this row is computed or disclosed — docs/archive/audits/audit-secrets.md
    // H1 (mirrored in audit-injection.md): resolveRow's own caller already
    // resolves `existing` via a GLOBALLY UNSCOPED findByEmployeeId lookup,
    // so an out-of-scope actor already learns "this employeeId exists
    // somewhere" the moment a row lands here at all. The three field-
    // mismatch reasons below would ADDITIONALLY confirm, one guessed field
    // at a time, exactly which of primaryEmail/username/orgUnitId is
    // correct for a record that actor cannot even read via
    // GET /users/:id (403 today) — each wrong guess emits its own named
    // reason, and a correct guess makes it silently vanish, turning this
    // endpoint into a per-field confirmation oracle: ~1,500 candidate rows
    // per request, no trace (preview writes nothing — see the audit row
    // this class's `preview()` now writes per INVOCATION to close that
    // half). Once scope OR privilege rejects, this returns IMMEDIATELY
    // with that rejection alone — the mismatch, manager-resolvability, and
    // attribute-validity checks below never run and never leak anything
    // about this specific row.
    const scopeReasons: string[] = []
    try {
      // Finding L-3 (docs/archive/audits/audit-authz.md): an UPDATE row is
      // narrowed with 'user:update', not 'user:create' — this is the update
      // branch (resolveRow already matched an EXISTING user by employeeId;
      // see resolveCreateRow just below for the create branch, which
      // correctly uses 'user:create'). Not exploitable today (every role
      // holding 'user:create' also holds 'user:update' — see ROLE_PERMISSIONS
      // in authz/actions.ts — and this whole controller's routes are gated
      // on 'user:create' at PermissionGuard besides), but it was a
      // route/action mismatch that would misauthorize silently the moment
      // that catalog fact ever changed.
      await this.engine.assertCanIn(actor, 'user:update', existing.orgUnitId)
    } catch (error) {
      scopeReasons.push(...domainErrorReasons(error))
    }

    try {
      await this.privileges.assertCanModifyPrincipal(actor, existing.id)
    } catch (error) {
      scopeReasons.push(...domainErrorReasons(error))
    }

    if (scopeReasons.length > 0) {
      return { kind: 'failure', row: rowNumber, employeeId: row.employeeId, reasons: scopeReasons }
    }

    // From here on the actor has proven they may act on THIS record — the
    // checks below (and their results) are safe to run and disclose.

    // These three are the exact fields UpdateUserInput cannot express — see
    // this method's caller's doc comment for why a mismatch is a reported
    // failure rather than a silent partial-apply.
    if (row.primaryEmail.toLowerCase() !== existing.primaryEmail.toLowerCase()) {
      reasons.push(
        'primaryEmail: cannot be changed via import; does not match the existing user with this employeeId',
      )
    }
    if (row.username.toLowerCase() !== existing.username.toLowerCase()) {
      reasons.push(
        'username: cannot be changed via import; does not match the existing user with this employeeId',
      )
    }
    if (row.orgUnitId !== existing.orgUnitId) {
      reasons.push(
        'orgUnitId: cannot be changed via import; does not match the existing user with this employeeId',
      )
    }

    await appendManagerReason(this.users, row.managerId, reasons)

    let attributes: Record<string, unknown> | undefined
    if (fileHasExtraHeaders) {
      try {
        attributes = validateAttributes(definitions, rawAttributes, 'user')
      } catch (error) {
        reasons.push(...domainErrorReasons(error))
      }
    }

    if (reasons.length > 0) {
      return { kind: 'failure', row: rowNumber, employeeId: row.employeeId, reasons }
    }

    const input: UpdateUserInput = {
      firstName: row.firstName,
      lastName: row.lastName,
      jobTitle: row.jobTitle,
      employeeId: row.employeeId,
      managerId: row.managerId,
      location: row.location,
      startDate: row.startDate,
      endDate: row.endDate,
      attributes,
    }

    return { kind: 'update', row: rowNumber, employeeId: row.employeeId, userId: existing.id, input, current: existing }
  }

  private async resolveCreateRow(
    row: ShapeParsedRow,
    rowNumber: number,
    actor: Actor,
    reasons: string[],
    rawAttributes: Record<string, string>,
    definitions: AttributeDefinition[],
  ): Promise<RowResolution> {
    // Scope BEFORE existence, mirroring UsersController.create's own
    // assertCanIn-then-insert ordering: a GLOBAL grant short-circuits
    // assertCanIn to true regardless of whether the target exists (see
    // PermissionEngine.canIn), so existence is only checked once scope has
    // already passed — a SCOPED actor targeting a nonexistent org unit gets
    // "not permitted" (assertCanIn's own ltree containment query matches no
    // row either way), matching that actor's real 403 outcome through the
    // single-record endpoint; only a global actor ever reaches "not found".
    let scopeOk = false
    try {
      await this.engine.assertCanIn(actor, 'user:create', row.orgUnitId)
      scopeOk = true
    } catch (error) {
      reasons.push(...domainErrorReasons(error))
    }
    if (scopeOk) {
      const orgUnit = await this.orgUnits.findById(row.orgUnitId)
      if (orgUnit === null) reasons.push('orgUnitId: org unit not found')
    }

    await appendManagerReason(this.users, row.managerId, reasons)

    // Residual half of the cross-scope enumeration oracle from fix wave C
    // (docs/archive/audits/fix-wave-c-report.md's own "Concerns" note,
    // audit-secrets.md): `findByEmail`/`findByUsername` are GLOBAL,
    // unscoped lookups — the ROW's own target org unit passed the scope
    // check above, but the EXISTING colliding user they find can be a
    // completely different, OUT-OF-SCOPE victim anywhere in the directory.
    // The old message (`a user with email "X" already exists`) confirmed
    // that victim's existence and echoed the guessed value back verbatim,
    // turning an in-scope "create" attempt into a directory-wide
    // email/username oracle. "not available" still correctly rejects the
    // row (the row IS un-creatable either way) without confirming WHY a
    // specific guessed value is taken, and never echoes it back.
    const existingByEmail = await this.users.findByEmail(row.primaryEmail)
    if (existingByEmail !== null) {
      reasons.push('primaryEmail: not available')
    }
    const existingByUsername = await this.users.findByUsername(row.username)
    if (existingByUsername !== null) {
      reasons.push('username: not available')
    }

    // Unconditional — mirrors UsersController.create's own unconditional
    // validateAttributes call, so a required active definition is enforced
    // on every new row exactly like it is on POST /users.
    let attributes: Record<string, unknown> = {}
    try {
      attributes = validateAttributes(definitions, rawAttributes, 'user')
    } catch (error) {
      reasons.push(...domainErrorReasons(error))
    }

    if (reasons.length > 0) {
      return { kind: 'failure', row: rowNumber, employeeId: row.employeeId, reasons }
    }

    const input: CreateUserInput = {
      primaryEmail: row.primaryEmail,
      username: row.username,
      firstName: row.firstName,
      lastName: row.lastName,
      orgUnitId: row.orgUnitId,
      employeeId: row.employeeId,
      jobTitle: row.jobTitle ?? undefined,
      managerId: row.managerId ?? undefined,
      location: row.location ?? undefined,
      startDate: row.startDate ?? undefined,
      endDate: row.endDate ?? undefined,
      attributes,
    }

    return { kind: 'create', row: rowNumber, employeeId: row.employeeId, input }
  }
}
