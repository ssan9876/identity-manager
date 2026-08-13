import {
  Body,
  Controller,
  Delete,
  Get,
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
import { DIRECTORY_TARGETS } from '../connectors/connector'
import { JwtGuard } from '../auth/jwt.guard'
import { AuditWriter } from '../audit/audit.writer'
import { PermissionGuard, type AuthorizedRequest } from '../authz/permission.guard'
import { RequirePermission } from '../authz/require-permission.decorator'
import { DB_CLIENT } from '../common/db.token'
import { ConflictError, NotFoundError, ValidationError } from '../common/errors'
import { PermissionEngine } from '../authz/permission.engine'
import { ForbiddenError } from '../common/errors'
import { parseBody } from '../common/http/parse-body'
import { parseId } from '../common/http/parse-id'
import { noNulChar } from '../common/http/safe-string'
import * as schema from '../db/schema/index'
import type { DbHandle } from '../outbox/outbox.writer'
import {
  AttributeTargetMappingsRepository,
  type AttributeTargetMappingRow,
  type ExportImpact,
  type ExportImpactQuery,
  type MappingRecord,
} from './attribute-target-mappings.repository'

// From the canonical catalog — a stale copy here makes a target's attribute
// mappings unconstructible, so its default-deny gate can never be opened.
// DIRECTORY_TARGETS, not the full catalog: an attribute mapping says which
// user attribute reaches which backend, and `keycloak_sso` carries
// applications, not users. Offering it here would let an admin configure a
// mapping that can never fire.
const connectorTargetSchema = z.enum(DIRECTORY_TARGETS)
const coreFieldSchema = z.enum(['given_name', 'surname', 'title', 'department'])

// noNulChar — the same JSON-escaped-NUL defence every other admin-editable
// free-text field in this codebase applies (docs/archive/audits/audit-
// injection.md) — remoteName is admin-configured, user-facing-adjacent text
// with no other shape constraint (each vendor's own attribute-name alphabet
// differs, and this layer deliberately does not attempt to validate against
// any one of them — see connector.ts's own doc comment: "a wrong remoteName
// fails loudly with the target's OWN error the moment it is actually sent").
const remoteNameSchema = noNulChar(z.string().min(1).max(255))

const createMappingBodySchema = z
  .object({
    attributeDefinitionId: z.string().uuid().optional(),
    coreField: coreFieldSchema.optional(),
    target: connectorTargetSchema,
    remoteName: remoteNameSchema,
    enabled: z.boolean().default(true),
    // The count the caller was shown. Required only when the write would
    // leave this row enabled over a non-empty population — see
    // `assertAcknowledged`, which re-derives it rather than trusting it.
    acknowledgedExportCount: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((body) => (body.attributeDefinitionId !== undefined) !== (body.coreField !== undefined), {
    message: 'exactly one of attributeDefinitionId or coreField is required, never both, never neither',
  })

/**
 * The export-impact query. Same `attributeDefinitionId` XOR `coreField`
 * discriminant every row in this table carries, and the same `.refine` the
 * create body uses — a caller who names both is asking about two different
 * populations at once, and a caller who names neither is asking about none.
 */
const exportImpactQuerySchema = z
  .object({
    target: connectorTargetSchema,
    attributeDefinitionId: z.string().uuid().optional(),
    coreField: coreFieldSchema.optional(),
  })
  .strict()
  .refine((q) => (q.attributeDefinitionId !== undefined) !== (q.coreField !== undefined), {
    message: 'exactly one of attributeDefinitionId or coreField is required, never both, never neither',
  })

const updateMappingBodySchema = z
  .object({
    remoteName: remoteNameSchema.optional(),
    enabled: z.boolean().optional(),
    // The count the caller was shown. Required only when the write would
    // leave this row enabled over a non-empty population — see
    // `assertAcknowledged`, which re-derives it rather than trusting it.
    acknowledgedExportCount: z.number().int().nonnegative().optional(),
  })
  .strict()

function snapshotMapping(row: MappingRecord, impact: ExportImpact | null = null): Record<string, unknown> {
  return {
    attributeDefinitionId: row.attributeDefinitionId,
    coreField: row.coreField,
    target: row.target,
    remoteName: row.remoteName,
    enabled: row.enabled,
    // Present only on the write that turned propagation ON, which is the only
    // moment the number means anything. Finding 4 leaves an audit row unable
    // to show a sensitive attribute's values; this at least records how many
    // people's values one click sent outward, and whether they were values
    // the log is forbidden to hold.
    ...(impact === null
      ? {}
      : { acknowledgedExportCount: impact.holderCount, sensitive: impact.sensitive }),
  }
}

/**
 * Milestone 14, Task 9 — "Attribute mapping editor over
 * `attribute_target_mappings`." The whole reason this screen exists is to
 * make default-deny LEGIBLE, not just true (this task's own BUILD section):
 * `GET` returns every row that exists, so the console can render it against
 * the full attribute × target grid and show the GAPS as plainly as the
 * rows — an attribute with no cell filled in for a target is not a toggle
 * switched off, it is a row that was never created, and default-deny means
 * that field structurally cannot reach that target (db/schema/attribute-
 * target-mappings.ts's own doc comment).
 *
 * Global — a mapping row is organisation-wide configuration, not a
 * per-org-unit resource. Because there is therefore no containing scope to
 * narrow a request TO, every MUTATING route additionally requires a GLOBAL
 * grant of `connector:manage`; see `requireGlobalManageGrant` below. This
 * paragraph previously said there was "no scope check beyond the route-level
 * `@RequirePermission`", citing `ConnectorTargetsController` — which carried
 * the identical security-audit finding, and has been fixed the same way.
 */
@Controller('attribute-target-mappings')
@UseGuards(JwtGuard, PermissionGuard)
export class AttributeTargetMappingsController {
  /**
   * Mutating a mapping row requires a GLOBAL grant, never merely a grant of
   * `connector:manage` at SOME scope — `PermissionGuard` satisfies
   * `@RequirePermission` with `assertCanAnywhere`, and these rows have no
   * `orgUnitId` to narrow against.
   *
   * Creating one is the single write that turns default-deny propagation ON
   * for a (field, target) pair, for EVERY user in the directory. Without this
   * check a super_admin scoped to one org unit — who gets 403 merely reading
   * a user outside it — could start propagating a sensitive field
   * organisation-wide, or DELETE a mapping another org depends on. Same
   * `scopePathsFor(actor, action) === null` idiom as
   * `OrgUnitsController.create` and `GroupsController`.
   */
  private async requireGlobalManageGrant(request: AuthorizedRequest): Promise<void> {
    const scopePaths = await this.engine.scopePathsFor(request.actor, 'connector:manage')
    if (scopePaths !== null) {
      throw new ForbiddenError(
        'managing attribute target mappings requires a global grant of connector:manage — ' +
          'a mapping governs propagation for every principal in the directory, not one org unit',
      )
    }
  }

  constructor(
    @Inject(AttributeTargetMappingsRepository) private readonly mappings: AttributeTargetMappingsRepository,
    @Inject(PermissionEngine) private readonly engine: PermissionEngine,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  @Get()
  @RequirePermission('connector:read')
  async list(): Promise<AttributeTargetMappingRow[]> {
    return this.mappings.listAllRows()
  }

  /**
   * The acknowledgement, RE-DERIVED INSIDE the caller's transaction.
   *
   * Security finding 5. Enabling a mapping exports every existing holder's
   * value on their next sync, retroactively and silently. This does not
   * refuse that — an admin who reads the number and means it proceeds — it
   * refuses to let it happen without the number having been in front of
   * someone.
   *
   * RE-DERIVING is the whole difference between a guard and a decoration. A
   * bulk import landing between the caller's GET and their POST invalidates
   * the acknowledgement rather than slipping under it, because the count this
   * compares against is the one true inside the transaction that is about to
   * write.
   *
   * A count of zero requires nothing, which is what keeps every existing
   * caller that exports nothing working unchanged.
   *
   * Absent is a ValidationError naming the real number — the message IS the
   * information the caller was missing, so a curl user and the console learn
   * the same thing. A mismatch is a ConflictError, the same status and the
   * same reasoning as a superseded `previewHash` on the attribute migration:
   * they acknowledged a smaller export than the one they are about to
   * perform, and the honest answer is "re-read it", not "close enough".
   */
  private async assertAcknowledged(
    tx: DbHandle,
    query: ExportImpactQuery,
    acknowledged: number | undefined,
  ): Promise<ExportImpact> {
    const impact = await this.mappings.countExportImpact(query, tx)
    if (impact.holderCount === 0) return impact

    const people = impact.holderCount === 1 ? "1 person's" : `${impact.holderCount} people's`

    if (acknowledged === undefined) {
      throw new ValidationError([
        `acknowledgedExportCount: enabling this mapping exports ${people} values to ` +
          `${query.target} on their next sync, and nothing recalls them afterwards` +
          (impact.sensitive
            ? '. This attribute is marked sensitive, so the audit log will not record what was sent'
            : '') +
          `. Send acknowledgedExportCount: ${impact.holderCount} to confirm.`,
      ])
    }

    if (acknowledged !== impact.holderCount) {
      throw new ConflictError(
        `acknowledgedExportCount ${acknowledged} is no longer the number: enabling this mapping ` +
          `now exports ${people} values to ${query.target}. Re-read the export impact and ` +
          'confirm the current number.',
      )
    }

    return impact
  }

  /**
   * What enabling this mapping would newly export, as a number — security
   * finding 5.
   *
   * A GET, and `connector:read`, because this returns a COUNT and a boolean
   * and never a stored value. The attribute migration's preview is a POST
   * precisely because it hands back real values out of `users.attributes`,
   * and a GET is the shape of a thing browsers prefetch, proxies retry and
   * logs record whole; nothing crossing this route is worth that care. Gated
   * beside the sibling list for the same reason: an auditor who can see WHICH
   * mappings exist can see how much each one carries.
   *
   * The count itself, and the scoping that makes it meaningful, belong to
   * `countExportImpact` — this method neither derives nor second-guesses it.
   */
  @Get('export-impact')
  @RequirePermission('connector:read')
  async exportImpact(@Query() query: unknown): Promise<{ target: string } & ExportImpact> {
    const parsed = parseBody(exportImpactQuerySchema, query)
    const impact = await this.mappings.countExportImpact({
      target: parsed.target,
      attributeDefinitionId: parsed.attributeDefinitionId ?? null,
      coreField: parsed.coreField ?? null,
    })
    return { target: parsed.target, ...impact }
  }

  /**
   * Creates the opt-in row — the one write that turns default-deny INTO
   * propagation for one (field, target) pair. `attributeDefinitionId` XOR
   * `coreField`, enforced by the body schema's own `.refine` before this
   * method ever runs (the table's `exactlyOneSource` CHECK constraint is the
   * structural backstop, not the primary defence — see the repository's own
   * doc comment).
   */
  @Post()
  @RequirePermission('connector:manage')
  async create(@Body() body: unknown, @Req() request: AuthorizedRequest): Promise<MappingRecord> {
    await this.requireGlobalManageGrant(request)
    const parsed = parseBody(createMappingBodySchema, body)

    return this.db.transaction(async (tx) => {
      // `enabled` defaults to true, so an ordinary create IS an enable — the
      // shortest path to exporting everything, and therefore guarded.
      const impact = (parsed.enabled ?? true)
        ? await this.assertAcknowledged(
            tx,
            {
              target: parsed.target,
              attributeDefinitionId: parsed.attributeDefinitionId ?? null,
              coreField: parsed.coreField ?? null,
            },
            parsed.acknowledgedExportCount,
          )
        : null

      const row = await this.mappings.create(tx, {
        attributeDefinitionId: parsed.attributeDefinitionId ?? null,
        coreField: parsed.coreField ?? null,
        target: parsed.target,
        remoteName: parsed.remoteName,
        // `.default(true)` in the schema guarantees a real boolean at
        // runtime; the `?? true` is a belt-and-braces fallback for the
        // TYPE (ZodEffects' inferred output through `.refine()` widens this
        // field back to `boolean | undefined` under `strict: true`), never
        // reachable in practice.
        enabled: parsed.enabled ?? true,
      })

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'attribute_target_mapping:create',
        resourceType: 'attribute_target_mapping',
        resourceId: row.id,
        before: null,
        after: snapshotMapping(row, impact),
      })

      return row
    })
  }

  /** Toggles `enabled` and/or renames `remoteName` — never which field or which target this row governs (see the repository's own `update` doc comment for why that is a deliberately narrower surface than a full replace). */
  @Patch(':id')
  @RequirePermission('connector:manage')
  async update(
    @Param('id') rawId: string,
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ): Promise<MappingRecord> {
    await this.requireGlobalManageGrant(request)
    const id = parseId(rawId)
    const parsed = parseBody(updateMappingBodySchema, body)

    return this.db.transaction(async (tx) => {
      const before = await this.mappings.findById(id, tx)
      if (before === null) {
        throw new NotFoundError('attribute target mapping', id)
      }

      // Only a transition INTO enabled is a new export. `true -> true`
      // changes nothing about what flows, `-> false` reduces it, and a
      // `remoteName` rename relocates values that already flow.
      const turningOn = parsed.enabled === true && !before.enabled
      const impact = turningOn
        ? await this.assertAcknowledged(
            tx,
            {
              target: before.target,
              attributeDefinitionId: before.attributeDefinitionId,
              coreField: before.coreField,
            },
            parsed.acknowledgedExportCount,
          )
        : null

      const after = await this.mappings.update(tx, id, parsed)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'attribute_target_mapping:update',
        resourceType: 'attribute_target_mapping',
        resourceId: id,
        before: snapshotMapping(before),
        after: snapshotMapping(after, impact),
      })

      return after
    })
  }

  /**
   * Removes the row outright — behaviourally identical to disabling it (see
   * the repository's own `remove` doc comment), offered so the editor need
   * not accumulate disabled rows an admin no longer wants to see at all.
   */
  @Delete(':id')
  @RequirePermission('connector:manage')
  async remove(@Param('id') rawId: string, @Req() request: AuthorizedRequest): Promise<{ deleted: true }> {
    await this.requireGlobalManageGrant(request)
    const id = parseId(rawId)

    await this.db.transaction(async (tx) => {
      const before = await this.mappings.findById(id, tx)
      if (before === null) {
        throw new NotFoundError('attribute target mapping', id)
      }

      await this.mappings.remove(tx, id)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'attribute_target_mapping:delete',
        resourceType: 'attribute_target_mapping',
        resourceId: id,
        before: snapshotMapping(before),
        after: null,
      })
    })

    return { deleted: true }
  }
}
