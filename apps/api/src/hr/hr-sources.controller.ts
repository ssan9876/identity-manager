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
  Req,
  UseGuards,
} from '@nestjs/common'
import { and, desc, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import { AuditWriter } from '../audit/audit.writer'
import { JwtGuard } from '../auth/jwt.guard'
import { PermissionEngine } from '../authz/permission.engine'
import { PermissionGuard, type AuthorizedRequest } from '../authz/permission.guard'
import { RequirePermission } from '../authz/require-permission.decorator'
import { DB_CLIENT } from '../common/db.token'
import { ForbiddenError, NotFoundError, ValidationError } from '../common/errors'
import { parseBody } from '../common/http/parse-body'
import { parseId } from '../common/http/parse-id'
import { noNulChar } from '../common/http/safe-string'
import { auditLog } from '../db/schema/audit-log'
import type { HrSource } from '../db/schema/hr-sources'
import * as schema from '../db/schema/index'
import { organizations } from '../db/schema/organizations'
import { parseColumnMapping, parseJsonFeedConfig } from './hr-feed'
import {
  HrSourcesRepository,
  type CreateHrSourceInput,
  type UpdateHrSourceInput,
} from './hr-sources.repository'
import { HrSyncService, type HrSyncReport } from './hr-sync.service'

const urlSchema = noNulChar(z.string().min(1).max(2048).url()).refine(
  (value) => value.startsWith('https://'),
  'must be an https URL',
)

/**
 * The auth pair travels TOGETHER, or not at all — mirrors the
 * `hr_sources_auth_pair` CHECK. `secretName`'s CONNECTOR_* shape is
 * enforced at point of USE by `resolveSecret` (connectors/secrets.ts, the
 * one audited resolution site), but validating it here too means an
 * operator learns about a bad name at configure time, not at the first 2am
 * sync run.
 */
const authSchema = z
  .object({
    headerName: noNulChar(z.string().min(1).max(128).regex(/^[A-Za-z0-9-]+$/, 'must be a valid header name')),
    secretName: noNulChar(
      z
        .string()
        .min(1)
        .max(128)
        .regex(/^CONNECTOR_[A-Za-z0-9_]+$/, 'must name a CONNECTOR_* environment variable'),
    ),
  })
  .strict()

const createBodySchema = z
  .object({
    organizationId: z.string().uuid(),
    name: noNulChar(z.string().min(1).max(255)),
    kind: z.enum(['csv_url', 'rest_json']),
    url: urlSchema,
    auth: authSchema.nullable().optional(),
    // Validated by parseColumnMapping, not here — see its doc comment for
    // why a z.record() would silently DROP a `__proto__` source column.
    columnMapping: z.unknown().optional(),
    // Kind-specific settings. Validated per kind by `parseSourceConfig`
    // below, not here — `csv_url` accepts none at all, and `rest_json`'s own
    // closed pagination union lives with the code that dispatches on it
    // (hr-feed.ts's `parseJsonFeedConfig`).
    config: z.unknown().optional(),
    enabled: z.boolean().optional(),
    blastRadiusThreshold: z.number().int().min(1).max(100).optional(),
    blastRadiusFloor: z.number().int().min(0).optional(),
  })
  .strict()

const patchBodySchema = z
  .object({
    name: noNulChar(z.string().min(1).max(255)).optional(),
    url: urlSchema.optional(),
    auth: authSchema.nullable().optional(),
    columnMapping: z.unknown().optional(),
    config: z.unknown().optional(),
    enabled: z.boolean().optional(),
    blastRadiusThreshold: z.number().int().min(1).max(100).optional(),
    blastRadiusFloor: z.number().int().min(0).optional(),
  })
  .strict()

const previewBodySchema = z.object({}).strict().optional()

/**
 * Validates `config` FOR THIS SOURCE'S KIND, at write time — so a malformed
 * pagination block is a named 400 on the configure screen rather than a
 * `fetch_failed` run at 2am, exactly the reasoning the `CONNECTOR_*` secret
 * name check above already follows ("an operator learns about a bad name at
 * configure time").
 *
 * `csv_url` accepts NO settings at all rather than ignoring stray keys: a
 * `recordsPath` silently accepted on a CSV source would read, on the screen
 * and in the audit row, as though it were doing something.
 *
 * The kind lookup is `Object.hasOwn` over a null-prototype catalog for the
 * same reason `HrSyncService.FEED_LOADERS` is — the value is a Postgres enum
 * label, and this function is also reachable with a kind read back out of
 * storage (PATCH, which cannot change `kind`).
 */
const CONFIG_PARSERS: Record<HrSource['kind'], (value: unknown) => Record<string, unknown>> =
  Object.assign(Object.create(null) as Record<HrSource['kind'], (value: unknown) => Record<string, unknown>>, {
    csv_url: (value: unknown) => {
      if (value === undefined || value === null) return {}
      if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0) {
        throw new ValidationError(['config: a csv_url source takes no configuration'])
      }
      return {}
    },
    rest_json: (value: unknown) => ({ ...parseJsonFeedConfig(value) }),
  } satisfies Record<HrSource['kind'], (value: unknown) => Record<string, unknown>>)

function parseSourceConfig(kind: HrSource['kind'], value: unknown): Record<string, unknown> {
  if (!Object.hasOwn(CONFIG_PARSERS, kind)) {
    throw new ValidationError([`kind: unsupported feed kind "${kind}"`])
  }
  return CONFIG_PARSERS[kind](value)
}

/**
 * What every read/write returns. Everything on the row is non-secret BY
 * CONSTRUCTION — `authSecretName` is the NAME of a CONNECTOR_* environment
 * variable (the reference the operator configured), never a credential
 * value, because no value is ever written to this table by anything in this
 * codebase (decision 4's discipline, verbatim from connector_targets: not
 * redacted on the way out — ABSENT from the start). The credential itself
 * is write-only in the strongest sense: it lives in the process
 * environment, resolved at fetch time through `resolveSecret`, and no
 * endpoint can return it.
 */
export interface HrSourceView {
  id: string
  organizationId: string
  name: string
  kind: HrSource['kind']
  url: string
  authHeaderName: string | null
  authSecretName: string | null
  columnMapping: Record<string, string>
  config: Record<string, unknown>
  enabled: boolean
  blastRadiusThreshold: number
  blastRadiusFloor: number
  lastRunStartedAt: Date | null
  lastRunFinishedAt: Date | null
  lastRunOutcome: HrSource['lastRunOutcome']
  lastRunCounts: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
}

function toView(row: HrSource): HrSourceView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    kind: row.kind,
    url: row.url,
    authHeaderName: row.authHeaderName,
    authSecretName: row.authSecretName,
    columnMapping: row.columnMapping,
    config: row.config,
    enabled: row.enabled,
    blastRadiusThreshold: row.blastRadiusThreshold,
    blastRadiusFloor: row.blastRadiusFloor,
    lastRunStartedAt: row.lastRunStartedAt,
    lastRunFinishedAt: row.lastRunFinishedAt,
    lastRunOutcome: row.lastRunOutcome,
    lastRunCounts: row.lastRunCounts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** The audit snapshot for a CRUD mutation — the whole configured surface (all of it non-secret, see HrSourceView), never the last_run scratch fields. */
function snapshotSource(row: HrSource): Record<string, unknown> {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    kind: row.kind,
    url: row.url,
    authHeaderName: row.authHeaderName,
    authSecretName: row.authSecretName,
    columnMapping: row.columnMapping,
    config: row.config,
    enabled: row.enabled,
    blastRadiusThreshold: row.blastRadiusThreshold,
    blastRadiusFloor: row.blastRadiusFloor,
  }
}

/** One row of the run-history view — read straight off the append-only `hr_source:sync` audit rows `HrSyncService.finish` writes, so history can never be edited or lost even though `last_run_*` on the source row only holds the LATEST run. */
export interface HrSourceRunView {
  at: Date
  actorUserId: string | null
  batchId: string | null
  detail: Record<string, unknown> | null
}

/**
 * The HR inbound admin surface: CRUD-minus-delete over `hr_sources`, a
 * run-history view, and "run preview now". There is deliberately NO
 * @Delete route — a source that has run is named by append-only audit
 * rows, so it is disabled instead (the table's own contract).
 *
 * AUTHORIZATION follows ConnectorTargetsController exactly: reads need
 * `connector:read`; every MUTATING route (and the run-preview route, which
 * fetches from an admin-configured URL with a resolved credential and walks
 * the directory through the import pipeline's preview) needs
 * `connector:manage` held GLOBALLY — an HR feed is organization-wide
 * infrastructure, and `PermissionGuard` alone only proves the action is
 * held at SOME scope (see requireGlobalManageGrant's precedent, the
 * security-audit finding recorded on ConnectorTargetsController).
 */
@Controller('hr-sources')
@UseGuards(JwtGuard, PermissionGuard)
export class HrSourcesController {
  constructor(
    @Inject(HrSourcesRepository) private readonly sources: HrSourcesRepository,
    @Inject(HrSyncService) private readonly sync: HrSyncService,
    @Inject(PermissionEngine) private readonly engine: PermissionEngine,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /** Same shape and same reasoning as ConnectorTargetsController.requireGlobalManageGrant — see that method's doc comment for the finding it closes. */
  private async requireGlobalManageGrant(request: AuthorizedRequest): Promise<void> {
    const scopePaths = await this.engine.scopePathsFor(request.actor, 'connector:manage')
    if (scopePaths !== null) {
      throw new ForbiddenError(
        'managing HR sources requires a global grant of connector:manage — an HR feed is ' +
          'organization-wide infrastructure, and a sync run writes people across the whole tenant',
      )
    }
  }

  @Get()
  @RequirePermission('connector:read')
  async list(): Promise<HrSourceView[]> {
    const rows = await this.sources.list()
    return rows.map(toView)
  }

  @Get(':id')
  @RequirePermission('connector:read')
  async findOne(@Param('id') rawId: string): Promise<HrSourceView> {
    const source = await this.requireSource(rawId)
    return toView(source)
  }

  /**
   * Run history: the append-only `hr_source:sync` audit rows for this
   * source, newest first. `last_run_*` on the row itself only ever shows
   * the LATEST run; this is the durable ledger behind it. Guarded by
   * `connector:read` like the rest of this controller's reads — the rows
   * contain counts and outcomes only, never row-level user data
   * (HrSyncService.finish's own contract).
   */
  @Get(':id/runs')
  @RequirePermission('connector:read')
  async runs(@Param('id') rawId: string): Promise<HrSourceRunView[]> {
    const source = await this.requireSource(rawId)
    const rows = await this.db
      .select({
        at: auditLog.createdAt,
        actorUserId: auditLog.actorUserId,
        batchId: auditLog.batchId,
        detail: auditLog.after,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'hr_source:sync'),
          eq(auditLog.resourceType, 'hr_source'),
          eq(auditLog.resourceId, source.id),
        ),
      )
      .orderBy(desc(auditLog.id))
      .limit(50)
    return rows.map((row) => ({ ...row, detail: (row.detail as Record<string, unknown> | null) ?? null }))
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('connector:manage')
  async create(@Body() body: unknown, @Req() request: AuthorizedRequest): Promise<HrSourceView> {
    await this.requireGlobalManageGrant(request)
    const parsed = parseBody(createBodySchema, body)
    const columnMapping = parseColumnMapping(parsed.columnMapping ?? {})
    const config = parseSourceConfig(parsed.kind, parsed.config)

    // Existence checked up front so the operator gets a named 400 rather
    // than a raw FK violation surfacing as a 500.
    const [organization] = await this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, parsed.organizationId))
      .limit(1)
    if (organization === undefined) {
      throw new ValidationError(['organizationId: organization not found'])
    }

    const input: CreateHrSourceInput = {
      organizationId: parsed.organizationId,
      name: parsed.name,
      kind: parsed.kind,
      url: parsed.url,
      authHeaderName: parsed.auth?.headerName ?? null,
      authSecretName: parsed.auth?.secretName ?? null,
      columnMapping,
      config,
      enabled: parsed.enabled,
      blastRadiusThreshold: parsed.blastRadiusThreshold,
      blastRadiusFloor: parsed.blastRadiusFloor,
    }

    const created = await this.db.transaction(async (tx) => {
      const row = await this.sources.create(tx, input)
      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'hr_source:create',
        resourceType: 'hr_source',
        resourceId: row.id,
        before: null,
        after: snapshotSource(row),
      })
      return row
    })

    return toView(created)
  }

  @Patch(':id')
  @RequirePermission('connector:manage')
  async update(
    @Param('id') rawId: string,
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ): Promise<HrSourceView> {
    await this.requireGlobalManageGrant(request)
    const source = await this.requireSource(rawId)
    const parsed = parseBody(patchBodySchema, body)

    const patch: UpdateHrSourceInput = {
      name: parsed.name,
      url: parsed.url,
      auth: parsed.auth,
      columnMapping: parsed.columnMapping !== undefined ? parseColumnMapping(parsed.columnMapping) : undefined,
      // Validated against the STORED kind — `kind` is not patchable, and
      // re-reading it here is what stops a rest_json config being accepted
      // onto a csv_url source.
      config: parsed.config !== undefined ? parseSourceConfig(source.kind, parsed.config) : undefined,
      enabled: parsed.enabled,
      blastRadiusThreshold: parsed.blastRadiusThreshold,
      blastRadiusFloor: parsed.blastRadiusFloor,
    }

    const updated = await this.db.transaction(async (tx) => {
      const row = await this.sources.update(tx, source.id, patch)
      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'hr_source:update',
        resourceType: 'hr_source',
        resourceId: row.id,
        before: snapshotSource(source),
        after: snapshotSource(row),
      })
      return row
    })

    return toView(updated)
  }

  /**
   * "Run preview now" — fetches the feed, applies the mapping, and runs the
   * import pipeline's PREVIEW (never a commit; commits happen through the
   * `hr:sync --commit` CLI, where the operator owns the cadence). Writes
   * nothing about any user — `ImportsController.preview`'s own structural
   * guarantee — but does record the run's outcome on the source row and one
   * `hr_source:sync` audit row, so even preview probing is traceable.
   * 200, not 201: nothing is created.
   *
   * The import pipeline's per-row scope checks run against THIS caller
   * (`request.actor`), so the preview an admin sees is the preview their
   * own grants would produce — never an escalated system view.
   */
  @Post(':id/preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('connector:manage')
  async preview(
    @Param('id') rawId: string,
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ): Promise<HrSyncReport> {
    await this.requireGlobalManageGrant(request)
    parseBody(previewBodySchema, body ?? {})
    const source = await this.requireSource(rawId)
    return this.sync.run(source, { commit: false, actor: request.actor })
  }

  private async requireSource(rawId: string): Promise<HrSource> {
    const id = parseId(rawId)
    const source = await this.sources.findById(id)
    if (source === null) {
      throw new NotFoundError('HR source', rawId)
    }
    return source
  }
}
