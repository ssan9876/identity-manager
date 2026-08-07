import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import { JwtGuard } from '../auth/jwt.guard'
import { AuditWriter } from '../audit/audit.writer'
import { PermissionGuard, type AuthorizedRequest } from '../authz/permission.guard'
import { RequirePermission } from '../authz/require-permission.decorator'
import { DB_CLIENT } from '../common/db.token'
import { NotFoundError } from '../common/errors'
import { parseBody } from '../common/http/parse-body'
import { parseId } from '../common/http/parse-id'
import { noNulChar } from '../common/http/safe-string'
import * as schema from '../db/schema/index'
import {
  AttributeTargetMappingsRepository,
  type AttributeTargetMappingRow,
  type MappingRecord,
} from './attribute-target-mappings.repository'

const connectorTargetSchema = z.enum(['keycloak', 'active_directory', 'entra_id', 'google_workspace', 'echo'])
const coreFieldSchema = z.enum(['given_name', 'surname', 'title', 'department'])

// noNulChar — the same JSON-escaped-NUL defence every other admin-editable
// free-text field in this codebase applies (docs/superpowers/audit-
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
  })
  .strict()
  .refine((body) => (body.attributeDefinitionId !== undefined) !== (body.coreField !== undefined), {
    message: 'exactly one of attributeDefinitionId or coreField is required, never both, never neither',
  })

const updateMappingBodySchema = z
  .object({
    remoteName: remoteNameSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()

function snapshotMapping(row: MappingRecord): Record<string, unknown> {
  return {
    attributeDefinitionId: row.attributeDefinitionId,
    coreField: row.coreField,
    target: row.target,
    remoteName: row.remoteName,
    enabled: row.enabled,
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
 * Global, unscoped, like `ConnectorTargetsController` — a mapping row is
 * organisation-wide configuration, not a per-org-unit resource, so there is
 * no scope check beyond the route-level `@RequirePermission`.
 */
@Controller('attribute-target-mappings')
@UseGuards(JwtGuard, PermissionGuard)
export class AttributeTargetMappingsController {
  constructor(
    @Inject(AttributeTargetMappingsRepository) private readonly mappings: AttributeTargetMappingsRepository,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  @Get()
  @RequirePermission('connector:read')
  async list(): Promise<AttributeTargetMappingRow[]> {
    return this.mappings.listAllRows()
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
    const parsed = parseBody(createMappingBodySchema, body)

    return this.db.transaction(async (tx) => {
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
        after: snapshotMapping(row),
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
    const id = parseId(rawId)
    const parsed = parseBody(updateMappingBodySchema, body)

    return this.db.transaction(async (tx) => {
      const before = await this.mappings.findById(id, tx)
      if (before === null) {
        throw new NotFoundError('attribute target mapping', id)
      }

      const after = await this.mappings.update(tx, id, parsed)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'attribute_target_mapping:update',
        resourceType: 'attribute_target_mapping',
        resourceId: id,
        before: snapshotMapping(before),
        after: snapshotMapping(after),
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
