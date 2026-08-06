import { randomUUID } from 'node:crypto'
import { Body, Controller, HttpCode, HttpStatus, Inject, Post, Req, UseGuards } from '@nestjs/common'
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
 */
function domainErrorReasons(error: unknown): string[] {
  if (error instanceof ValidationError) return error.issues
  if (error instanceof DomainError) return [error.message]
  throw error
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
 *  1. Preview writes nothing — `preview()` below calls `resolveRow` only,
 *     which performs reads alone (no INSERT/UPDATE statement anywhere in
 *     that call graph); the write path is exclusively inside `commit()`.
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
  constructor(
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(OrgUnitsRepository) private readonly orgUnits: OrgUnitsRepository,
    @Inject(PermissionEngine) private readonly engine: PermissionEngine,
    @Inject(PrivilegeGuards) private readonly privileges: PrivilegeGuards,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
    @Inject(OutboxWriter) private readonly outboxWriter: OutboxWriter,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

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
   */
  private async parseAndPrepare(
    body: unknown,
  ): Promise<{
    rows: Array<Record<string, string>>
    fileHasExtraHeaders: boolean
    definitions: AttributeDefinition[]
  }> {
    const parsed = parseBody(importBodySchema, body)
    const { headers, rows } = parseCsv(parsed.csv)

    const missing = missingRequiredHeaders(headers)
    if (missing.length > 0) {
      throw new ValidationError([`csv: missing required column(s): ${missing.join(', ')}`])
    }

    const fileHasExtraHeaders = extraHeaders(headers).length > 0
    const definitions = await this.users.listActiveAttributeDefinitions()

    return { rows, fileHasExtraHeaders, definitions }
  }

  /**
   * Dry-run diff: every row is resolved exactly as `commit` would resolve
   * it, but nothing is written — `resolveRow` never calls
   * `this.users.create`/`update`, `this.auditWriter.record`, or
   * `this.outboxWriter.record`; it only reads. 200, not 201: nothing is
   * created by this request.
   */
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('user:create')
  async preview(@Body() body: unknown, @Req() request: AuthorizedRequest): Promise<ImportPreviewResponse> {
    const { rows, fileHasExtraHeaders, definitions } = await this.parseAndPrepare(body)

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
          reasons: domainErrorReasons(error),
        })
      }
    }

    return { batchId, created, updated, failed: failures.length, failures }
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

    try {
      await this.engine.assertCanIn(actor, 'user:create', existing.orgUnitId)
    } catch (error) {
      reasons.push(...domainErrorReasons(error))
    }

    try {
      await this.privileges.assertCanModifyPrincipal(actor, existing.id)
    } catch (error) {
      reasons.push(...domainErrorReasons(error))
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

    const existingByEmail = await this.users.findByEmail(row.primaryEmail)
    if (existingByEmail !== null) {
      reasons.push(`primaryEmail: a user with email "${row.primaryEmail}" already exists`)
    }
    const existingByUsername = await this.users.findByUsername(row.username)
    if (existingByUsername !== null) {
      reasons.push(`username: a user with username "${row.username}" already exists`)
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
