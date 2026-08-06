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
import { validateAttributes } from '../attributes/attribute-validator'
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
import { type Page, parsePageQuery } from '../common/pagination'
import * as schema from '../db/schema/index'
import { OutboxWriter } from '../outbox/outbox.writer'
import { UsersRepository, type User, type UserStatus } from './users.repository'

const statusSchema = z
  .enum(['pending', 'active', 'suspended', 'deactivated'])
  .optional()

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

const createUserBodySchema = z
  .object({
    primaryEmail: z.string().min(1).max(320).email(),
    username: z.string().min(1).max(128),
    firstName: z.string().min(1).max(128),
    lastName: z.string().min(1).max(128),
    orgUnitId: z.string().uuid(),
    employeeId: z.string().min(1).max(64).optional(),
    jobTitle: z.string().min(1).max(255).optional(),
    managerId: z.string().uuid().optional(),
    location: z.string().min(1).max(255).optional(),
    startDate: isoDateSchema.optional(),
    endDate: isoDateSchema.optional(),
    attributes: z.record(z.unknown()).optional(),
  })
  .strict()

// Every field optional (a PATCH touches only what it names) and every
// already-nullable column ALSO accepts `null` explicitly, to clear it.
// primaryEmail, username, orgUnitId and status are deliberately absent —
// see UsersRepository.update's doc comment for why each is out of this
// milestone's PATCH surface.
const updateUserBodySchema = z
  .object({
    firstName: z.string().min(1).max(128).optional(),
    lastName: z.string().min(1).max(128).optional(),
    jobTitle: z.string().min(1).max(255).nullable().optional(),
    employeeId: z.string().min(1).max(64).nullable().optional(),
    managerId: z.string().uuid().nullable().optional(),
    location: z.string().min(1).max(255).nullable().optional(),
    startDate: isoDateSchema.nullable().optional(),
    endDate: isoDateSchema.nullable().optional(),
    attributes: z.record(z.unknown()).optional(),
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
 */
function snapshotUser(user: User): Record<string, unknown> {
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
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  @Get()
  @RequirePermission('user:read')
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: AuthorizedRequest,
  ): Promise<Page<User>> {
    const page = parsePageQuery(query)

    const status = statusSchema.safeParse(query.status)
    if (!status.success) {
      throw new ValidationError(['status: must be one of pending, active, suspended, deactivated'])
    }

    const orgUnitId =
      query.orgUnitId === undefined
        ? undefined
        : parseId(String(query.orgUnitId), 'orgUnitId')

    // null = unrestricted (no filter); [] = entitled nowhere (filter that
    // matches nothing). Passed straight through to the repository, which
    // applies the same null-vs-[] distinction — never collapsed here first.
    const scopePaths = await this.engine.scopePathsFor(request.actor, 'user:read')

    const filter = { status: status.data as UserStatus | undefined, orgUnitId, scopePaths }

    const [items, total] = await Promise.all([
      this.users.list({ ...page, ...filter }),
      this.users.count(filter),
    ])

    return { items, total, limit: page.limit, offset: page.offset }
  }

  @Get(':id')
  @RequirePermission('user:read')
  async findOne(@Param('id') rawId: string, @Req() request: AuthorizedRequest): Promise<User> {
    const id = parseId(rawId)
    const user = await this.users.findById(id)
    if (user === null) {
      throw new NotFoundError('user', id)
    }
    // Out-of-scope existing resource -> 403, not 404 (decision 2): the
    // directory's existence is not secret, its contents are.
    await this.engine.assertCanIn(request.actor, 'user:read', user.orgUnitId)
    return user
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
  async create(@Body() body: unknown, @Req() request: AuthorizedRequest): Promise<User> {
    const parsed = parseBody(createUserBodySchema, body)

    await this.engine.assertCanIn(request.actor, 'user:create', parsed.orgUnitId)

    const definitions = await this.users.listActiveAttributeDefinitions()
    const attributes = validateAttributes(definitions, parsed.attributes)

    return this.db.transaction(async (tx) => {
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
   */
  @Patch(':id')
  @RequirePermission('user:update')
  async update(
    @Param('id') rawId: string,
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ): Promise<User> {
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

    return this.db.transaction(async (tx) => {
      const current = await this.users.findById(id, tx)
      if (current === null) {
        throw new NotFoundError('user', id)
      }

      await this.engine.assertCanIn(request.actor, 'user:update', current.orgUnitId)
      await this.privileges.assertCanModifyPrincipal(request.actor, current.id)

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
  }

  /**
   * The only path to `deactivated`, which is terminal — there is no DELETE
   * route for users, ever (see UsersRepository.changeStatus's doc comment).
   * Same load-inside-the-transaction, pair-both-checks shape as `update`
   * above. 200, not the POST-default 201: this acts on an existing
   * resource, it does not create one.
   */
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('user:deactivate')
  async deactivate(@Param('id') rawId: string, @Req() request: AuthorizedRequest): Promise<User> {
    const id = parseId(rawId)

    return this.db.transaction(async (tx) => {
      const current = await this.users.findById(id, tx)
      if (current === null) {
        throw new NotFoundError('user', id)
      }

      await this.engine.assertCanIn(request.actor, 'user:deactivate', current.orgUnitId)
      await this.privileges.assertCanModifyPrincipal(request.actor, current.id)

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
      // that lands a user on that terminal status.
      await this.outboxWriter.record(tx, {
        aggregateType: 'user',
        aggregateId: id,
        eventType: 'status_changed',
        payload: { ...snapshotUser(updated), action: 'user:deactivate' },
      })

      return updated
    })
  }
}
