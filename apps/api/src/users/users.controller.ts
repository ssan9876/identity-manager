import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import { rawAttributesSchema, validateAttributes } from '../attributes/attribute-validator'
import { JwtGuard } from '../auth/jwt.guard'
import { AuditWriter } from '../audit/audit.writer'
import { PermissionEngine } from '../authz/permission.engine'
import { PermissionGuard, type AuthorizedRequest } from '../authz/permission.guard'
import { PrivilegeGuards } from '../authz/privilege.guards'
import { RequirePermission } from '../authz/require-permission.decorator'
import { DB_CLIENT } from '../common/db.token'
import { NotFoundError, ValidationError } from '../common/errors'
import { parseBody } from '../common/http/parse-body'
import { parseId } from '../common/http/parse-id'
import { noNulChar } from '../common/http/safe-string'
import { type Page, parsePageQuery } from '../common/pagination'
import * as schema from '../db/schema/index'
import { KeycloakAdminClient } from '../keycloak/keycloak-admin.client'
import { OutboxWriter } from '../outbox/outbox.writer'
import { type SyncState, SyncStateRepository } from '../outbox/sync-state.repository'
import { UsersRepository, type User, type UserStatus } from './users.repository'

/**
 * Every user-returning route in this controller responds with this shape,
 * never bare `User` — ONE consistent read shape (Milestone 4, Task 4), so a
 * caller never has to know which endpoint it called to know whether
 * `syncState` will be present. See `SyncStateRepository`'s doc comment for
 * what the value means and how it is derived.
 */
export interface UserWithSyncState extends User {
  syncState: SyncState
}

const statusSchema = z
  .enum(['pending', 'active', 'suspended', 'deactivated'])
  .optional()

// Milestone 8, Task 2: GET /users had no text search at all before this —
// only status/orgUnitId, which cannot do docs/product-brief.md's #1 job ("find a
// person fast... search that survives hundreds of rows") on their own. No
// `.min()` — an empty or whitespace-only term is treated as "no search"
// by the trim-and-check below, never a 400: a debounced search box that
// clears itself sends exactly this, and erroring on it would be hostile,
// not helpful. `.max(255)` matches every other free-text field's ceiling
// in this controller (jobTitle, location). noNulChar — same
// docs/archive/audits/audit-injection.md convention as every other free-text
// field; this value reaches a bound SQL parameter (UsersRepository's own
// ILIKE filter), never spliced into query text, so this is defence in
// depth/consistency, not a distinct vulnerability being closed here.
const searchQuerySchema = noNulChar(z.string().max(255)).optional()

// Milestone 8, Task 4: lets a caller resolve a known SET of user ids to full
// records in one round trip. The admin console's group-membership screens
// learn a group's member ids from GET /groups/:id/members and GET
// /groups/:id/effective-members (both return bare `string[]` of ids, never
// full records — see GroupsController), and need a way to turn those into
// displayable name/status/sync rows without one GET per member. Reuses this
// existing list route (with its existing scope narrowing and default
// deactivated-user exclusion both still applying — see `listFilters` below)
// rather than a new endpoint, the same "extend GET /users with a query
// param" move Milestone 8 Task 2 already made for `search`.
//
// Comma-separated, not `ids[]=`/a repeated `ids=`: every other filter on
// this route is a single scalar value, and a comma-separated string needs no
// special query-string array handling on either side (see parsePageQuery's
// own `scalarOnly` doc comment for the kind of surprise a repeated/array
// query param can cause here). `MAX_IDS` bounds the list defensively — this
// is a lookup for a known, already-small set (a single group's membership,
// not an open-ended search), never expected to legitimately need thousands.
const MAX_IDS = 200
const idsQuerySchema = noNulChar(z.string().max(8000)).optional()

/**
 * `undefined` (the param was never sent) means "no ids filter at all" — list
 * behaves exactly as before. A param that IS sent but resolves to zero
 * actual ids (`ids=`, or `ids=,,`) means "filter to nothing", returned as
 * `[]` — never silently reinterpreted as "no filter", which would turn an
 * explicit empty request into "show everyone". Every non-empty entry must be
 * a real UUID, named by its own position — a malformed id is a 400, not a
 * silently-dropped filter.
 */
function parseIdsQuery(raw: unknown): string[] | undefined {
  const parsed = idsQuerySchema.safeParse(raw)
  if (!parsed.success) {
    throw new ValidationError(['ids: must be a comma-separated list of UUIDs'])
  }
  if (parsed.data === undefined) {
    return undefined
  }

  const rawIds = parsed.data
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  if (rawIds.length > MAX_IDS) {
    throw new ValidationError([`ids: at most ${MAX_IDS} ids per request`])
  }

  return rawIds.map((rawId, index) => parseId(rawId, `ids[${index}]`))
}

// YYYY-MM-DD shape only, not full calendar validity (e.g. "2026-02-30"
// passes this and would then be rejected by Postgres's own `date` column,
// which is out of scope to harden further here — see the comment on
// attribute-validator.ts's isIsoCalendarDate, which owns that job for
// custom date attributes). Matches this milestone's actual carried finding
// (a bogus reference 500ing instead of erroring cleanly) closely enough to
// reject obviously-malformed input before it reaches Postgres at all,
// without inventing full calendar parsing in a file the brief scopes to
// controller/repository concerns only.
const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)')

// noNulChar wraps every free-text field (never orgUnitId/managerId, already
// UUID-constrained, or startDate/endDate, already ISO-date-regex-
// constrained) — see docs/archive/audits/audit-injection.md's HIGH
// "JSON-escaped NUL" finding and safe-string.ts's own doc comment.
const createUserBodySchema = z
  .object({
    primaryEmail: noNulChar(z.string().min(1).max(320).email()),
    username: noNulChar(z.string().min(1).max(128)),
    firstName: noNulChar(z.string().min(1).max(128)),
    lastName: noNulChar(z.string().min(1).max(128)),
    orgUnitId: z.string().uuid(),
    employeeId: noNulChar(z.string().min(1).max(64)).optional(),
    jobTitle: noNulChar(z.string().min(1).max(255)).optional(),
    managerId: z.string().uuid().optional(),
    location: noNulChar(z.string().min(1).max(255)).optional(),
    startDate: isoDateSchema.optional(),
    endDate: isoDateSchema.optional(),
    attributes: rawAttributesSchema,
  })
  .strict()

// Every field optional (a PATCH touches only what it names) and every
// already-nullable column ALSO accepts `null` explicitly, to clear it.
// primaryEmail, username, orgUnitId and status are deliberately absent —
// see UsersRepository.update's doc comment for why each is out of this
// milestone's PATCH surface.
const updateUserBodySchema = z
  .object({
    firstName: noNulChar(z.string().min(1).max(128)).optional(),
    lastName: noNulChar(z.string().min(1).max(128)).optional(),
    jobTitle: noNulChar(z.string().min(1).max(255)).nullable().optional(),
    employeeId: noNulChar(z.string().min(1).max(64)).nullable().optional(),
    managerId: z.string().uuid().nullable().optional(),
    location: noNulChar(z.string().min(1).max(255)).nullable().optional(),
    startDate: isoDateSchema.nullable().optional(),
    endDate: isoDateSchema.nullable().optional(),
    attributes: rawAttributesSchema,
  })
  .strict()

/**
 * Builds an audit `before`/`after` payload from explicitly named fields —
 * never `{ ...user }`. A spread would silently carry forward any column
 * added to `users` later, including a future sensitive one, into an
 * append-only log a leak can never be removed from (see AuditWriter's doc
 * comment). `id` is omitted — it is already the audit row's own
 * `resourceId` — and `createdAt`/`updatedAt` are omitted as bookkeeping
 * that changes on every write and adds nothing to a before/after diff.
 *
 * Exported so ImportsController (Milestone 5) reuses this EXACT function for
 * its own audit/outbox payloads rather than growing a second, divergence-prone
 * copy — the same "share one function" rule the milestone brief states for
 * the write path itself applies just as much to the snapshot helper the
 * write path's audit/outbox calls depend on.
 */
export function snapshotUser(user: User): Record<string, unknown> {
  return {
    status: user.status,
    primaryEmail: user.primaryEmail,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    displayName: user.displayName,
    employeeId: user.employeeId,
    jobTitle: user.jobTitle,
    orgUnitId: user.orgUnitId,
    managerId: user.managerId,
    location: user.location,
    startDate: user.startDate,
    endDate: user.endDate,
    attributes: user.attributes,
    deactivatedAt: user.deactivatedAt,
  }
}

@Controller('users')
@UseGuards(JwtGuard, PermissionGuard)
export class UsersController {
  constructor(
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(PermissionEngine) private readonly engine: PermissionEngine,
    @Inject(PrivilegeGuards) private readonly privileges: PrivilegeGuards,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
    @Inject(OutboxWriter) private readonly outboxWriter: OutboxWriter,
    @Inject(KeycloakAdminClient) private readonly keycloak: KeycloakAdminClient,
    @Inject(SyncStateRepository) private readonly syncStates: SyncStateRepository,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  @Get()
  @RequirePermission('user:read')
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: AuthorizedRequest,
  ): Promise<Page<UserWithSyncState>> {
    const page = parsePageQuery(query)

    const status = statusSchema.safeParse(query.status)
    if (!status.success) {
      throw new ValidationError(['status: must be one of pending, active, suspended, deactivated'])
    }

    const orgUnitId =
      query.orgUnitId === undefined
        ? undefined
        : parseId(String(query.orgUnitId), 'orgUnitId')

    const searchParsed = searchQuerySchema.safeParse(query.search)
    if (!searchParsed.success) {
      throw new ValidationError(['search: must be a string of at most 255 characters'])
    }
    const trimmedSearch = searchParsed.data?.trim()
    const search = trimmedSearch !== undefined && trimmedSearch.length > 0 ? trimmedSearch : undefined

    const ids = parseIdsQuery(query.ids)

    // null = unrestricted (no filter); [] = entitled nowhere (filter that
    // matches nothing). Passed straight through to the repository, which
    // applies the same null-vs-[] distinction — never collapsed here first.
    const scopePaths = await this.engine.scopePathsFor(request.actor, 'user:read')

    const filter = { status: status.data as UserStatus | undefined, orgUnitId, scopePaths, search, ids }

    const [items, total] = await Promise.all([
      this.users.list({ ...page, ...filter }),
      this.users.count(filter),
    ])

    // ONE batched syncState lookup for the whole page (see
    // SyncStateRepository.resolveForUsers' doc comment) rather than N
    // separate per-row calls.
    const syncStates = await this.syncStates.resolveForUsers(items.map((user) => user.id))
    const withSyncState = items.map((user) => this.attachSyncState(user, syncStates.get(user.id)))

    return { items: withSyncState, total, limit: page.limit, offset: page.offset }
  }

  @Get(':id')
  @RequirePermission('user:read')
  async findOne(
    @Param('id') rawId: string,
    @Req() request: AuthorizedRequest,
  ): Promise<UserWithSyncState> {
    const id = parseId(rawId)
    const user = await this.users.findById(id)
    if (user === null) {
      throw new NotFoundError('user', id)
    }
    // Out-of-scope existing resource -> 403, not 404 (decision 2): the
    // directory's existence is not secret, its contents are.
    await this.engine.assertCanIn(request.actor, 'user:read', user.orgUnitId)
    const syncState = await this.syncStates.resolveForUser(id)
    return this.attachSyncState(user, syncState)
  }

  private attachSyncState(user: User, syncState: SyncState | undefined): UserWithSyncState {
    return { ...user, syncState: syncState ?? 'pending' }
  }

  /**
   * `assertCanIn` runs BEFORE opening a transaction: unlike PATCH/
   * deactivate, the target org unit comes straight from the request body,
   * not from a row that has to be loaded first, so there is nothing to gain
   * by holding a transaction open across a check that can only ever reject.
   * Same for attribute validation — a plain read against
   * `attribute_definitions` (no write path for it this milestone —
   * decision 4), needing no transactional consistency of its own. Only the
   * actual insert and its audit row share a transaction.
   */
  @Post()
  @RequirePermission('user:create')
  async create(@Body() body: unknown, @Req() request: AuthorizedRequest): Promise<UserWithSyncState> {
    const parsed = parseBody(createUserBodySchema, body)

    await this.engine.assertCanIn(request.actor, 'user:create', parsed.orgUnitId)

    const definitions = await this.users.listActiveAttributeDefinitions()
    const attributes = validateAttributes(definitions, parsed.attributes)

    const user = await this.db.transaction(async (tx) => {
      const user = await this.users.create(
        {
          primaryEmail: parsed.primaryEmail,
          username: parsed.username,
          firstName: parsed.firstName,
          lastName: parsed.lastName,
          orgUnitId: parsed.orgUnitId,
          employeeId: parsed.employeeId,
          jobTitle: parsed.jobTitle,
          managerId: parsed.managerId,
          location: parsed.location,
          startDate: parsed.startDate,
          endDate: parsed.endDate,
          attributes,
        },
        tx,
      )

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'user:create',
        resourceType: 'user',
        resourceId: user.id,
        before: null,
        after: snapshotUser(user),
      })

      await this.outboxWriter.record(tx, {
        aggregateType: 'user',
        aggregateId: user.id,
        eventType: 'created',
        payload: { ...snapshotUser(user), action: 'user:create' },
      })

      return user
    })

    // Freshly enqueued, unprocessed 'created' event -> always resolves
    // 'pending' here; included for response-shape consistency with every
    // other user-returning route (see UserWithSyncState's doc comment)
    // rather than special-cased away.
    const syncState = await this.syncStates.resolveForUser(user.id)
    return this.attachSyncState(user, syncState)
  }

  /**
   * PATCH loads the CURRENT row inside the same transaction that performs
   * the mutation and writes the audit row, then runs BOTH narrowing checks
   * against it — `assertCanIn` (does this actor reach this org unit?) and
   * `assertCanModifyPrincipal` (does this actor outrank this specific
   * principal?). Neither subsumes the other: rank alone would let two
   * peer help-desks in disjoint subtrees touch each other, and scope alone
   * would let a help-desk modify a global super_admin who merely happens to
   * sit in their subtree (see task-2-brief.md and PrivilegeGuards'
   * own doc comments). A rejection at either check throws before any write,
   * so the transaction has nothing to roll back and no audit row is ever
   * written.
   *
   * Both checks below are passed `tx` explicitly — never omitted to fall
   * back on the pooled default. This handler already holds one pool
   * connection for `tx`; letting either check default to the pool would
   * check out a SECOND one for the lifetime of a query that runs while the
   * first is still held, which is finding C1
   * (docs/archive/audits/audit-integrity.md): 11 concurrent `PATCH /users/:id`
   * was enough to exhaust a 10-connection pool and deadlock the whole API
   * process permanently. See test/pool-exhaustion.spec.ts for the
   * regression coverage.
   */
  @Patch(':id')
  @RequirePermission('user:update')
  async update(
    @Param('id') rawId: string,
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ): Promise<UserWithSyncState> {
    const id = parseId(rawId)
    const parsed = parseBody(updateUserBodySchema, body)

    // Only fetched/validated when the request actually names `attributes` —
    // PATCH semantics must never overwrite a user's existing attributes
    // with `{}` just because a request omitted the key entirely.
    let attributes: Record<string, unknown> | undefined
    if (parsed.attributes !== undefined) {
      const definitions = await this.users.listActiveAttributeDefinitions()
      attributes = validateAttributes(definitions, parsed.attributes)
    }

    const updated = await this.db.transaction(async (tx) => {
      const current = await this.users.findById(id, tx)
      if (current === null) {
        throw new NotFoundError('user', id)
      }

      await this.engine.assertCanIn(request.actor, 'user:update', current.orgUnitId, tx)
      await this.privileges.assertCanModifyPrincipal(request.actor, current.id, tx)

      const updated = await this.users.update(
        id,
        {
          firstName: parsed.firstName,
          lastName: parsed.lastName,
          jobTitle: parsed.jobTitle,
          employeeId: parsed.employeeId,
          managerId: parsed.managerId,
          location: parsed.location,
          startDate: parsed.startDate,
          endDate: parsed.endDate,
          attributes,
        },
        tx,
      )

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'user:update',
        resourceType: 'user',
        resourceId: id,
        before: snapshotUser(current),
        after: snapshotUser(updated),
      })

      await this.outboxWriter.record(tx, {
        aggregateType: 'user',
        aggregateId: id,
        eventType: 'updated',
        payload: { ...snapshotUser(updated), action: 'user:update' },
      })

      return updated
    })

    const syncState = await this.syncStates.resolveForUser(id)
    return this.attachSyncState(updated, syncState)
  }

  /**
   * The only path to `deactivated`, which is terminal — there is no DELETE
   * route for users, ever (see UsersRepository.changeStatus's doc comment).
   * Same load-inside-the-transaction, pair-both-checks shape as `update`
   * above — including passing `tx` explicitly into both checks, for the
   * same finding-C1 reason (see `update`'s doc comment). 200, not the
   * POST-default 201: this acts on an existing resource, it does not create
   * one.
   *
   * Milestone 4, Task 4 (decision 4 — "synchronous-first"): once the local
   * transaction below has committed, this ALSO attempts to revoke
   * Keycloak-side access INLINE, before this method returns — see
   * `revokeKeycloakAccess`'s doc comment. Offboarding is the one operation
   * in this system that cannot wait for the outbox to drain; a deactivated
   * user with a still-live Keycloak session is a real security exposure for
   * as long as it persists.
   */
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('user:deactivate')
  async deactivate(
    @Param('id') rawId: string,
    @Req() request: AuthorizedRequest,
  ): Promise<UserWithSyncState> {
    const id = parseId(rawId)

    const updated = await this.db.transaction(async (tx) => {
      const current = await this.users.findById(id, tx)
      if (current === null) {
        throw new NotFoundError('user', id)
      }

      await this.engine.assertCanIn(request.actor, 'user:deactivate', current.orgUnitId, tx)
      await this.privileges.assertCanModifyPrincipal(request.actor, current.id, tx)

      const updated = await this.users.changeStatus(id, 'deactivated', tx)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'user:deactivate',
        resourceType: 'user',
        resourceId: id,
        before: snapshotUser(current),
        after: snapshotUser(updated),
      })

      // No 'deleted' event type exists (there is no delete for users, ever
      // — see this handler's own doc comment). Removal propagates as
      // 'status_changed' carrying `deactivated` — already present as
      // snapshotUser(updated).status, since deactivate is the only path
      // that lands a user on that terminal status. This event is the
      // DURABILITY fallback for the synchronous revocation attempted below
      // — written unconditionally, before we even know whether that
      // synchronous attempt will succeed.
      await this.outboxWriter.record(tx, {
        aggregateType: 'user',
        aggregateId: id,
        eventType: 'status_changed',
        payload: { ...snapshotUser(updated), action: 'user:deactivate' },
      })

      return updated
    })

    // Runs AFTER the transaction has committed — never before: a Keycloak
    // call must never run ahead of, or gate, the local mutation it reflects
    // (see revokeKeycloakAccess's doc comment for the full reasoning,
    // including why a failure here never fails this request).
    await this.revokeKeycloakAccess(updated.username)

    // Resolved fresh, AFTER the revocation attempt above: the outbox event
    // written inside the transaction is still 'pending' (no worker runs
    // inline here), so this reads 'pending' regardless of whether the
    // synchronous Keycloak call above just succeeded or failed — which is
    // exactly the contract: never imply access is already fully
    // synced/revoked from this response alone; the queued event is the
    // thing that still has to land for full reconciliation (profile,
    // groups, attributes), even when the synchronous disable+revoke did
    // land. See UsersController's file-level test coverage
    // (test/revocation.spec.ts) for the failure-path proof.
    const syncState = await this.syncStates.resolveForUser(id)
    return this.attachSyncState(updated, syncState)
  }

  /**
   * Attempts to end Keycloak-side access for `username` RIGHT NOW:
   * `setEnabled(false)` (blocks future logins) followed by `revokeSessions`
   * (kills sessions/tokens already issued) — see revokeSessions' own doc
   * comment for why neither substitutes for the other. The two are wrapped
   * in a single try/catch because they express ONE intent ("kill this
   * account's access") rather than two independent ones: if the account
   * cannot even be found/disabled, there is equally nothing this method can
   * usefully do about that account's sessions either, and the outbox's
   * eventual `reconcileUser` pass (which separately re-asserts `enabled`
   * every time it runs — see SyncWorker.reconcileUser) is what actually
   * finishes the job either way.
   *
   * NEVER throws. A Keycloak outage (or a user who never finished their
   * FIRST sync yet, surfacing as Keycloak-side NotFoundError) must never
   * fail a deactivate request that has already committed locally — the
   * contract is "log it, still enqueue" (the caller already enqueued,
   * unconditionally, before calling this), never "fail the mutation because
   * Keycloak is down." Logged via `console.error` — this codebase has no
   * structured logger yet (see health.controller.ts and every other
   * best-effort log call in this milestone, e.g. SyncWorker.tick) — with
   * enough detail (username, cause) for an operator to correlate against
   * the outbox row that will retry it.
   */
  private async revokeKeycloakAccess(username: string): Promise<void> {
    try {
      await this.keycloak.setEnabled(username, false)
      await this.keycloak.revokeSessions(username)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(
        `[users.controller] synchronous Keycloak revocation failed for "${username}" — the outbox event will retry it: ${message}`,
      )
    }
  }
}
