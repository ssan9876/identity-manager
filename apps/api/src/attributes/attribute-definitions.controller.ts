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
import * as schema from '../db/schema/index'
import { AttributeDefinitionsRepository } from './attribute-definitions.repository'
// A VALUE import, and the one direction this edge may run in: the job imports
// this file's `AuditAction` with `import type` precisely so that wiring the
// controller to the job here cannot close a runtime cycle. See that import's
// own comment before turning it into a value import.
import {
  AttributeMigrationJob,
  type AttributeMigrationReport,
} from './attribute-migration.job'
import { parseValidationRules } from './attribute-validation-rules'
import type { AttributeDefinition } from './attribute-validator'

const appliesToSchema = z.enum(['user', 'group'])
const dataTypeSchema = z.enum(['string', 'number', 'boolean', 'date', 'enum'])

// noNulChar — the same JSON-escaped-NUL defence every other admin-editable
// free-text field applies (docs/archive/audits/audit-injection.md): a
// `varchar` column cannot hold an embedded NUL, and without this the value
// only fails at the `pg` driver, as a raw non-DomainError exception and an
// unmapped 500. 255 is the column's own width.
const labelSchema = noNulChar(z.string().min(1).max(255))

/**
 * A default is a VALUE of the attribute it belongs to, and every `dataType`
 * this table models (`string`/`number`/`boolean`/`date`/`enum` — see
 * attribute-validator.ts's `buildFieldSchema`) is a SCALAR. The column is
 * `jsonb`, so without this an object or array would be stored happily and
 * then fail validation against its own definition on the first user write
 * that inherited it.
 *
 * Closing it to scalars here also removes the need for a deep NUL scan of
 * arbitrary nested JSON (the shape business-roles/draft.ts has to do for its
 * condition values): a scalar `string` is one `noNulChar` check, and nothing
 * else in this union can carry a string at all.
 *
 * `null` is accepted and MEANS something on the PATCH path — it clears a
 * default that was previously set. `undefined` (the field simply absent) is
 * "leave it alone"; `SafeFieldPatch` already distinguishes the two.
 */
const MAX_DEFAULT_VALUE_LENGTH = 1024
const defaultValueSchema = z.union([
  noNulChar(z.string().max(MAX_DEFAULT_VALUE_LENGTH)),
  z.number(),
  z.boolean(),
  z.null(),
])

// `sort_order` is a Postgres `integer`. Bounded here rather than letting the
// driver raise `22003` as an unmapped 500, and `.int()` because a fractional
// sort order is silently truncated, not rejected, on the way in.
const INT4_MIN = -2147483648
const INT4_MAX = 2147483647
const sortOrderSchema = z.number().int().min(INT4_MIN).max(INT4_MAX)

/**
 * `validationRules` is passed through as `unknown` ON PURPOSE, and handed to
 * `parseValidationRules` — Task 6's closed schema, the module that owns this
 * shape — rather than being re-declared here as a second zod schema. A
 * duplicate schema in the DTO is exactly how a write path ends up narrower
 * or wider than the gate it feeds, and `validationRules` is the column where
 * this project's ReDoS lived, so the one place that decides what it may
 * contain must stay one place. The repository re-parses (idempotently) and
 * additionally applies the cross-field `dataType` check, which the controller
 * cannot: that check needs the row's stored `dataType` on the PATCH path.
 */
const createBodySchema = z
  .object({
    key: z.string(),
    label: labelSchema,
    dataType: dataTypeSchema,
    appliesTo: appliesToSchema,
    required: z.boolean().optional(),
    defaultValue: defaultValueSchema.optional(),
    validationRules: z.unknown(),
    sortOrder: sortOrderSchema.optional(),
    isActive: z.boolean().optional(),
    selfEditable: z.boolean().optional(),
    sensitive: z.boolean().optional(),
  })
  .strict()

const patchBodySchema = z
  .object({
    label: labelSchema.optional(),
    required: z.boolean().optional(),
    defaultValue: defaultValueSchema.optional(),
    validationRules: z.unknown(),
    sortOrder: sortOrderSchema.optional(),
    isActive: z.boolean().optional(),
    selfEditable: z.boolean().optional(),
    sensitive: z.boolean().optional(),
  })
  .strict()

/**
 * The change a migration names — the SAME two fields `SafeFieldPatch`
 * excludes by construction and `IMMUTABLE_THROUGH_PATCH` refuses by name,
 * arriving here instead. Both optional; the job refuses a change that names
 * neither, and that refusal stays THERE rather than being restated as a
 * `.refine()` here, so the CLI and the console cannot be told a different
 * story from the route.
 */
const migrationChangeSchema = z.object({
  dataType: dataTypeSchema.optional(),
  appliesTo: appliesToSchema.optional(),
})

const previewBodySchema = migrationChangeSchema.strict()

/**
 * A commit is a preview plus its authorisation.
 *
 * `previewHash` IS REQUIRED, and that is the whole two-phase design in one
 * line of schema: a commit carrying no hash is a migration nobody previewed,
 * and making the field optional would hand every caller a way to rewrite
 * `users.attributes` directory-wide without a human ever reading the report.
 * Refused here, in the DTO, before the job is reached and before a single
 * user row is read.
 *
 * Bounded but NOT format-checked. The digest's shape belongs to the job that
 * mints it; a second regex here would be a second place that knows how the
 * hash is built, free to drift. A well-formed-but-stale hash and a garbage
 * one both reach `commit`, which answers with the one explanation that says
 * what to do next (`ConflictError` → 409). `.max` only keeps an unbounded
 * string out of the SHA comparison.
 *
 * `force` overrides the blast-radius refusal AND NOTHING ELSE — see
 * `AttributeMigrationCommitOptions`. It is passed straight through; this
 * controller does not interpret it.
 */
const MAX_PREVIEW_HASH_LENGTH = 256
const commitBodySchema = migrationChangeSchema
  .extend({
    previewHash: z.string().min(1).max(MAX_PREVIEW_HASH_LENGTH),
    force: z.boolean().optional(),
  })
  .strict()

/**
 * The three fields a PATCH may never carry, and what to do instead.
 *
 * `.strict()` above already rejects all three — they are simply not declared
 * — but it rejects them as "Unrecognized key", which tells an admin who just
 * tried to change an attribute's type precisely nothing. Named here and
 * checked FIRST, ahead of the generic scan, for the same reason
 * `parseValidationRules` singles out `pattern`: a caller who reached for one
 * of these deserves to be told where the capability actually lives.
 *
 * All three are absent from `SafeFieldPatch` BY CONSTRUCTION (Task 5), not by
 * this check — this is the message, not the enforcement.
 *
 * THE TWO MIGRATION MESSAGES NAME THE REAL PATHS, as of Milestone 8 Task 10.
 * Task 7 wrote them deliberately URL-free, because Tasks 8-10 had not chosen
 * a path yet and a stale URL inside a 400 is worse than none — and paid for
 * that by planting an obligation in `test/guard-coverage.spec.ts` ("names the
 * real preview/commit path in the dataType refusal once that route exists")
 * that fails the moment a route containing `preview` or `commit` is
 * registered under this controller's base path and this text does not name
 * it. If a path here is ever renamed, that test is what says so; do not
 * satisfy it by weakening the assertion.
 *
 * The old text also closed with "Until that lands, create a new definition
 * with the type you want", which the migration route makes ACTIVELY FALSE —
 * it would send an admin off to create a duplicate attribute and strand every
 * value already stored under the original key. The replacement says the
 * opposite, and why.
 */
export const IMMUTABLE_THROUGH_PATCH: Readonly<Record<string, string>> = {
  dataType:
    'dataType: cannot be changed through PATCH. Changing an attribute’s data type rewrites ' +
    'every value already stored under it in users.attributes, so it goes through the two-phase ' +
    'migration route instead: POST /attribute-definitions/:id/preview reports every value that ' +
    'would not survive the conversion, together with the blast radius and a preview hash, and ' +
    'POST /attribute-definitions/:id/commit applies exactly that previewed migration when handed ' +
    'that hash. Do not create a second definition with the type you want: the migration carries ' +
    'the stored values across and records the prior ones, so it is reversible, while a duplicate ' +
    'definition strands every existing value under the old key.',
  appliesTo:
    'appliesTo: cannot be changed through PATCH. A definition’s entity type decides which table’s ' +
    'attribute bag its values live in, so moving it strands every value already written, exactly ' +
    'as a dataType change rewrites them. POST /attribute-definitions/:id/preview will report how ' +
    'many values a scope move would strand, but the commit half refuses to apply one — create a ' +
    'definition in the scope you want and migrate onto that instead.',
  key:
    'key: an attribute definition’s key is immutable. Every value already written lives in ' +
    'users.attributes under this exact key, so renaming the definition orphans all of them, and ' +
    'a business-role formula naming attributes.<key> would silently stop matching. Create a new ' +
    'definition and migrate onto it.',
}

/**
 * Refuses an immutable field BY NAME before the body schema's generic
 * `.strict()` scan runs.
 *
 * `Object.hasOwn`, not `in` or a truthiness check, for the reason
 * `parseValidationRules` gives at its own `pattern` guard: an INHERITED
 * property (a `{"__proto__": {"dataType": "..."}}` payload) must not be able
 * to trip this, and a genuine own `dataType: undefined` must not be able to
 * slip past it.
 */
function assertNoImmutableField(body: unknown): void {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return

  const problems = Object.entries(IMMUTABLE_THROUGH_PATCH)
    .filter(([field]) => Object.hasOwn(body, field))
    .map(([, message]) => message)

  if (problems.length > 0) throw new ValidationError(problems)
}

const RESOURCE_TYPE = 'attribute_definition'

/**
 * Every audit action written against an `attribute_definition`, in ONE list.
 *
 * Exported because Milestone 8 Task 9's migration job writes one of them
 * (`:migrate`) from outside this file, and a second, private list over there
 * would be a catalogue free to drift from this one — an auditor reading
 * `action LIKE 'attribute_definition:%'` has to be able to learn the whole
 * vocabulary from a single place. The job imports it with `import type`
 * specifically, so that Task 10 wiring this controller TO that job does not
 * close a runtime import cycle; see that import's own comment.
 *
 * `:migrate` is the one action here that does not describe an edit to the
 * definition ROW alone — it also rewrites values in `users.attributes`, and
 * its `before` carries those values so the rewrite can be undone. That is
 * also why it is refused outright for a `sensitive` definition rather than
 * written redacted; the reasoning lives with the refusal, in
 * `assertNotSensitive`.
 */
export type AuditAction =
  | 'attribute_definition:create'
  | 'attribute_definition:update'
  | 'attribute_definition:sensitive_changed'
  | 'attribute_definition:deactivate'
  | 'attribute_definition:migrate'

/**
 * What goes into `audit_log.before`/`after` for a definition.
 *
 * Exactly the shape the repository hands back on BOTH sides of a patch
 * (`AttributeDefinition`), so there is no third shape to keep in sync and no
 * way for `before` and `after` to be built from different projections.
 *
 * `defaultValue` is NOT here, and its absence is deliberate rather than
 * incidental. A default is a VALUE of the attribute, and finding SEC-M1 is
 * precisely that attribute values were being copied verbatim into `audit_log`
 * — a table whose UPDATE/DELETE/TRUNCATE are blocked by both privilege and
 * trigger, so there is no retrofit once a value is in it. Writing the default
 * of an attribute whose whole point is that its values stay out of the audit
 * log would reintroduce that finding through the one door `sensitive` cannot
 * close, because the very row that turns `sensitive` on is written before the
 * flag could ever apply to it. Keeping every attribute VALUE out of this
 * snapshot removes the hazard instead of sequencing around it.
 *
 * `sortOrder` is out for a duller reason: it is not part of the repository's
 * public shape, and a purely cosmetic ordering field is not worth a second
 * snapshot projection.
 *
 * Both omissions mean neither field can ever make `genericChanged` true, so
 * `auditActionsFor` takes a separate `touchedUnsnapshotted` flag to keep them
 * WITNESSED — see its own doc comment, and the bundled-patch bug that flag
 * exists to close. The delta for such a change is not in the log; the fact
 * that it happened is.
 */
function snapshotDefinition(definition: AttributeDefinition): Record<string, unknown> {
  return {
    id: definition.id,
    key: definition.key,
    label: definition.label,
    dataType: definition.dataType,
    appliesTo: definition.appliesTo,
    required: definition.required,
    validationRules: definition.validationRules,
    isActive: definition.isActive,
    selfEditable: definition.selfEditable,
    sensitive: definition.sensitive,
  }
}

/** Fields whose change is ordinary editing — everything `sensitive` and `isActive` do not already account for. */
const GENERIC_FIELDS = ['label', 'required', 'selfEditable'] as const

/**
 * Which audit actions one PATCH earns, in the order they are written.
 *
 * `sensitive` and deactivation get their OWN actions rather than being folded
 * into `attribute_definition:update`, because neither is ordinary editing.
 * `sensitive` governs audit-log redaction — turning it on is the deployment
 * deciding the audit log may no longer see an attribute's values, which is
 * the single change an auditor most needs to be able to FIND later ("why did
 * salary_band go dark on the 4th?" is a `WHERE action =
 * 'attribute_definition:sensitive_changed'`, not a scan of every generic
 * update looking for a flipped boolean). Deactivation removes a field from
 * every form and every validation schema in the deployment.
 *
 * Keyed on an ACTUAL CHANGE, never on the caller having merely mentioned the
 * field: a patch restating `sensitive: true` on an already-sensitive
 * definition records no transition, because none happened. A log full of
 * transitions that never occurred is worse than no distinct action at all —
 * it makes the real one unfindable.
 *
 * Reactivation (`false -> true`) is deliberately NOT `:deactivate`, and not
 * its own action either: turning a field back on restores capability rather
 * than removing it, and it is legible in the generic row's own
 * `before`/`after`.
 *
 * `sensitive_changed` is written FIRST. Rows written inside one transaction
 * share a `created_at` to the microsecond, so the bigserial `audit_log.id` —
 * i.e. insertion order — is the only thing that orders them for a reader;
 * putting the visibility transition first means an auditor reading the
 * request's rows in order sees the change in what the log may record BEFORE
 * the rows that follow under the new regime.
 *
 * The fallback matters: a patch that changed nothing this snapshot can see
 * (an empty body) still produces one `attribute_definition:update` row.
 * Somebody with `attribute:manage` addressed this definition, and that is
 * worth recording even when the delta is empty.
 *
 * `touchedUnsnapshotted` — FIX ROUND 1, IMPORTANT 1, AND THE ONE SUBTLE
 * PARAMETER HERE. `sortOrder` and `defaultValue` are safe fields absent from
 * `snapshotDefinition` (see its doc comment for why `defaultValue` must stay
 * absent), so they can never set `genericChanged`. The first version of this
 * function therefore let them rely on the `actions.length === 0` fallback —
 * which A SPECIALISED ACTION SUPPRESSES. Reproduced: `PATCH {sensitive:
 * true, sortOrder: 42}` returned 200, wrote 42, and logged only
 * `sensitive_changed`; `42` appeared nowhere in the audit log. A single
 * request could change an inherited default while the log showed a
 * visibility toggle. Alone such a change was at least witnessed; BUNDLED it
 * was erased, which is strictly worse and is why only the bundled test
 * catches it.
 *
 * That flag keys on the field being MENTIONED, not on it having changed,
 * which is deliberately the OPPOSITE rule from the two specialised actions
 * above — and the asymmetry is the point, because the two failure modes are
 * opposite. Over-recording a specialised action fills the log with
 * transitions that never happened and makes the real one unfindable.
 * Under-recording the generic row destroys evidence that a change occurred
 * at all, permanently, in an append-only table. Where the snapshot cannot
 * tell us whether the value actually moved, erring toward recording is the
 * only safe direction.
 */
function auditActionsFor(
  before: AttributeDefinition,
  after: AttributeDefinition,
  touchedUnsnapshotted: boolean,
): AuditAction[] {
  const actions: AuditAction[] = []

  if (before.sensitive !== after.sensitive) actions.push('attribute_definition:sensitive_changed')
  if (before.isActive && !after.isActive) actions.push('attribute_definition:deactivate')

  const genericChanged =
    GENERIC_FIELDS.some((field) => before[field] !== after[field]) ||
    (!before.isActive && after.isActive) ||
    JSON.stringify(before.validationRules) !== JSON.stringify(after.validationRules)

  if (genericChanged || touchedUnsnapshotted || actions.length === 0) {
    actions.push('attribute_definition:update')
  }

  return actions
}

/**
 * `GET /attribute-definitions?appliesTo=user|group` — Milestone 8, Task 3's
 * one new endpoint — plus, from Milestone 8 Task 7, the write path over it:
 * `POST /attribute-definitions` and `PATCH /attribute-definitions/:id`.
 *
 * task-3-brief.md: the admin create/edit user form must be "driven by
 * attribute_definitions, mirroring the self-service page's approach."
 * `GET /self` already hands a CALLER their own self-editable subset
 * (`SelfServiceController.selfEditableAttributeDefinitions`), but there is
 * no admin equivalent exposing the FULL active catalog for a target entity
 * type — which an admin creating or editing SOMEONE ELSE needs:
 * `self_editable` constrains what a subject may change about themselves, it
 * is not a ceiling on admin authority, so an admin may need to render (and
 * set) a non-self-editable attribute that its own owner could never touch.
 *
 * THE READ MOVED FROM `user:read` TO `attribute:read` in Task 7, and that is
 * a deliberate NARROWING, recorded when the action was added (authz/
 * actions.ts): `help_desk` holds `user:read` and could therefore list
 * definitions; it does not hold `attribute:read` and can no longer reach
 * this route. Help desk reads people, not schema. The earlier gate's
 * reasoning — that `user:read` covered both `appliesTo` branches because no
 * role holds `group:read` without it — is superseded rather than refuted:
 * `attribute:read` is a single action covering the whole catalog, so there
 * is still exactly one check and still no unreachable per-branch second
 * check. `actions.spec.ts` pins the exact holder set of both actions, so
 * quietly granting `attribute:read` back to `help_desk` to make a failure go
 * away fails there instead.
 *
 * THE WRITES are `attribute:manage`, which is `super_admin`'s alone. A
 * definition is SCHEMA, not data, and two of its fields carry privilege
 * beyond an ordinary write — `sensitive` governs audit-log redaction and
 * `selfEditable` can hand a user the ability to decide their own
 * business-role membership. The escalation refusals themselves live in the
 * REPOSITORY (`assertNoFormulaDependsOn`, `validateAttributeKey`, the closed
 * `validationRules` schema), beside the writes they guard, so a caller
 * cannot reach around them by calling the repository directly; this
 * controller deliberately re-implements none of them and lets the
 * `DomainError` subclasses surface through `DomainExceptionFilter`.
 *
 * The carried "ReDoS gate stays closed only while `attribute_definitions`
 * has no write path" note (plan.md, Carried forward) is what Task 6 closed
 * and this task consumes: `validationRules` reaching this controller is
 * handed straight to that closed schema, and `pattern` is refused by name.
 */
@Controller('attribute-definitions')
@UseGuards(JwtGuard, PermissionGuard)
export class AttributeDefinitionsController {
  constructor(
    @Inject(AttributeDefinitionsRepository) private readonly definitions: AttributeDefinitionsRepository,
    @Inject(PermissionEngine) private readonly engine: PermissionEngine,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
    @Inject(AttributeMigrationJob) private readonly migrations: AttributeMigrationJob,
  ) {}

  /**
   * Writing a definition requires a GLOBAL grant of `attribute:manage`,
   * never merely a grant at SOME scope.
   *
   * `attribute_definitions` has no `org_unit_id` and no `organization_id` —
   * one definition feeds every user in the deployment AND every tenant's
   * business-role formulas, which is exactly why the repository's own
   * `assertNoFormulaDependsOn` refuses to filter its refusal by the actor's
   * organization. `PermissionGuard` satisfies `@RequirePermission` with
   * `assertCanAnywhere`, so without this check a `super_admin` scoped to one
   * org unit — who gets a 403 merely READING a user outside it — could add a
   * directory-wide attribute, mark one self-editable, or blind the audit log
   * for one. Same `scopePathsFor(actor, action) === null` idiom, and the same
   * security-audit finding, as the sibling
   * `AttributeTargetMappingsController.requireGlobalManageGrant` and
   * `OrgUnitsController.create`.
   */
  private async requireGlobalManageGrant(request: AuthorizedRequest): Promise<void> {
    const scopePaths = await this.engine.scopePathsFor(request.actor, 'attribute:manage')
    if (scopePaths !== null) {
      throw new ForbiddenError(
        'managing attribute definitions requires a global grant of attribute:manage — ' +
          'a definition is directory-wide schema with no org unit to narrow it to, and it feeds ' +
          'every organization’s users and business-role formulas, not one subtree',
      )
    }
  }

  @Get()
  @RequirePermission('attribute:read')
  async list(@Query('appliesTo') rawAppliesTo: unknown): Promise<AttributeDefinition[]> {
    const parsed = appliesToSchema.safeParse(rawAppliesTo)
    if (!parsed.success) {
      throw new ValidationError(["appliesTo: must be 'user' or 'group'"])
    }

    return this.definitions.listActive(parsed.data)
  }

  /**
   * Creates one definition.
   *
   * `db.transaction`, and `tx` passed down, because the repository's `create`
   * takes a `DbHandle` and MEANS it: with `selfEditable: true` it takes a
   * transaction-scoped advisory lock and then runs its escalation refusal as
   * a separate statement, so on the pooled handle the lock would be released
   * before the refusal it protects ever ran. The audit write rides the same
   * transaction, so the row and its record commit or roll back together —
   * there is no state in which the definition exists and nothing says who
   * made it.
   */
  @Post()
  @RequirePermission('attribute:manage')
  async create(@Body() body: unknown, @Req() request: AuthorizedRequest): Promise<AttributeDefinition> {
    await this.requireGlobalManageGrant(request)
    const parsed = parseBody(createBodySchema, body)

    return this.db.transaction(async (tx) => {
      const created = await this.definitions.create(tx, {
        key: parsed.key,
        label: parsed.label,
        dataType: parsed.dataType,
        appliesTo: parsed.appliesTo,
        required: parsed.required,
        defaultValue: parsed.defaultValue,
        validationRules: parseValidationRules(parsed.validationRules),
        sortOrder: parsed.sortOrder,
        isActive: parsed.isActive,
        selfEditable: parsed.selfEditable,
        sensitive: parsed.sensitive,
      })

      // No `sensitive_changed` row on create, even for `sensitive: true`:
      // nothing was made less visible, because there was no prior state and
      // no prior values. The create row's own `after` carries the flag, so
      // "was it born sensitive?" is answerable from it.
      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'attribute_definition:create' satisfies AuditAction,
        resourceType: RESOURCE_TYPE,
        resourceId: created.id,
        before: null,
        after: snapshotDefinition(created),
      })

      return created
    })
  }

  /**
   * Changes the fields that do not require rewriting stored values.
   * `dataType`, `appliesTo` and `key` are refused by name — see
   * `IMMUTABLE_THROUGH_PATCH`.
   *
   * THE ORDER OF THE THREE STATEMENTS BELOW IS THE POINT, and it is why the
   * `before` snapshot is not simply read back afterwards:
   *
   *   1. read the definition, LOCKED, and keep it;
   *   2. apply the patch;
   *   3. write the audit rows from (1) and (2).
   *
   * `updateSafeFields` returns only the AFTER state, so the obvious-looking
   * alternative — patch, then read the row for context — produces an audit
   * row whose `before` is a copy of its `after`. On a `label` change that is
   * merely useless. On `sensitive` it destroys the only record of the
   * transition: turning `sensitive` ON is the deployment deciding the audit
   * log may no longer see that attribute's values, and if the row recording
   * that change reads `sensitive: true -> true`, the change that blinds the
   * audit log has blinded its own record. `audit_log` is append-only at the
   * database level (privilege AND trigger), so there is no correcting it in
   * a follow-up — this has to be right the first time, in this order.
   *
   * The read at (1) takes `FOR UPDATE` (see the repository's own
   * `findByIdForUpdate` doc comment) rather than being an ordinary read, so
   * the state recorded as `before` is provably the state the UPDATE was
   * applied to and not one a concurrent patch superseded in between.
   */
  @Patch(':id')
  @RequirePermission('attribute:manage')
  async update(
    @Param('id') rawId: string,
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ): Promise<AttributeDefinition> {
    await this.requireGlobalManageGrant(request)
    const id = parseId(rawId)
    assertNoImmutableField(body)
    const parsed = parseBody(patchBodySchema, body)

    return this.db.transaction(async (tx) => {
      const before = await this.definitions.findByIdForUpdate(tx, id)
      if (before === null) throw new NotFoundError('attribute definition', id)

      const after = await this.definitions.updateSafeFields(tx, id, {
        label: parsed.label,
        required: parsed.required,
        defaultValue: parsed.defaultValue,
        validationRules: parseValidationRules(parsed.validationRules),
        sortOrder: parsed.sortOrder,
        isActive: parsed.isActive,
        selfEditable: parsed.selfEditable,
        sensitive: parsed.sensitive,
      })

      // Mentioned, not changed — `before`/`after` cannot report either field,
      // so this is the only signal there is. See `auditActionsFor`.
      const touchedUnsnapshotted =
        parsed.sortOrder !== undefined || parsed.defaultValue !== undefined

      for (const action of auditActionsFor(before, after, touchedUnsnapshotted)) {
        await this.auditWriter.record(tx, {
          actorUserId: request.actor.userId,
          action,
          resourceType: RESOURCE_TYPE,
          resourceId: id,
          before: snapshotDefinition(before),
          after: snapshotDefinition(after),
        })
      }

      return after
    })
  }

  /**
   * Milestone 8, Task 10 — the READ half of the migration route.
   * `AttributeMigrationJob.preview` walks every holder of this definition's
   * key and reports what a `dataType`/`appliesTo` change would do to their
   * stored values, WITHOUT writing anything.
   *
   * POST, not GET, for two reasons that both matter here. The change being
   * previewed is a structured body, not a query string — and more
   * importantly, a GET is the shape of a thing that is cached, logged with
   * its full URL, prefetched by a browser and retried by a proxy, none of
   * which should happen to a directory-wide walk over stored attribute
   * values. `@HttpCode(OK)` because 201 would claim something was created;
   * same pair, and the same reasoning, as `ImportsController.preview`.
   *
   * `attribute:manage`, NOT `attribute:read`, and that is deliberate. This
   * route returns a sample of real values out of `users.attributes` — it is
   * a read of PEOPLE'S DATA reached through a schema route, and it is the
   * first half of a write, so it is gated as the write it belongs to. Gating
   * it on `attribute:read` would hand `auditor` and `read_only` a
   * directory-wide attribute-value dump they hold no other route to.
   *
   * A GLOBAL grant, via `requireGlobalManageGrant`, for the reason that
   * method spells out — and the exposure is starker here than on
   * POST/PATCH: the walk crosses every org unit in the deployment, so an
   * org-unit-scoped `super_admin` would read values out of subtrees they get
   * a 403 merely listing.
   *
   * What this route may say about a `sensitive` definition is the job's
   * decision, not this controller's — see `REDACTED_SENSITIVE_VALUE`. The
   * redaction lives there so the CLI and the console cannot get a laxer
   * answer than this route does.
   */
  @Post(':id/preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('attribute:manage')
  async previewMigration(
    @Param('id') rawId: string,
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ): Promise<AttributeMigrationReport> {
    await this.requireGlobalManageGrant(request)
    const id = parseId(rawId)
    const parsed = parseBody(previewBodySchema, body)

    return this.migrations.preview(id, {
      dataType: parsed.dataType,
      appliesTo: parsed.appliesTo,
    })
  }

  /**
   * Milestone 8, Task 10 — the WRITE half. Applies exactly the migration a
   * preview reported, or none of it.
   *
   * NO TRANSACTION HERE, and no audit write here either, unlike `create` and
   * `update` above: `AttributeMigrationJob.commit` opens its own
   * transaction, takes the definition's row lock, RE-DERIVES the plan inside
   * it, and writes its own audit row from that same read. Wrapping it in a
   * second transaction from this controller would not add a guarantee — it
   * would move the lock acquisition away from the re-derivation it exists to
   * protect. This method's whole job is authorisation, validation and
   * attribution.
   *
   * `previewHash` comes off the DTO, which requires it — a commit with no
   * hash is refused as a 400 before this method's body runs. Everything
   * after that is the job's: a hash that no longer matches the re-derived
   * plan is a `ConflictError` (409), each data refusal is a
   * `ValidationError` (400), and all of them reach the client through
   * `DomainExceptionFilter` unmodified. This controller re-implements none
   * of them, and must not: a refusal restated here is a refusal free to
   * disagree with the one the CLI gets.
   */
  @Post(':id/commit')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('attribute:manage')
  async commitMigration(
    @Param('id') rawId: string,
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ): Promise<AttributeMigrationReport> {
    await this.requireGlobalManageGrant(request)
    const id = parseId(rawId)
    const parsed = parseBody(commitBodySchema, body)

    return this.migrations.commit(
      id,
      { dataType: parsed.dataType, appliesTo: parsed.appliesTo },
      parsed.previewHash,
      { force: parsed.force, actorUserId: request.actor.userId },
    )
  }
}
