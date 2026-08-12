import { createHash } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { and, asc, eq, gt, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { AuditWriter, type DbHandle } from '../audit/audit.writer'
import { DB_CLIENT } from '../common/db.token'
import { ConflictError, NotFoundError, ValidationError } from '../common/errors'
import { attributeDefinitions } from '../db/schema/attribute-definitions'
import * as schema from '../db/schema/index'
import { users } from '../db/schema/users'
import {
  type BlastRadiusEvaluation,
  evaluateBlastRadius,
} from '../outbox/target-reconciliation.job'
import { type AttributeDataType, convertValue } from './attribute-conversion'
// TYPE-ONLY, and it has to stay that way. The catalogue of this resource's
// audit actions lives beside the other writers of it
// (attribute-definitions.controller.ts) so there is one list to read, but
// Task 10 wires that controller to THIS job as a value import — a value
// import in this direction would close the cycle. `import type` is erased
// entirely, so it cannot.
import type { AuditAction } from './attribute-definitions.controller'
import {
  assertValidationRulesMatchDataType,
  parseValidationRules,
} from './attribute-validation-rules'

/**
 * WHERE THE BLAST-RADIUS NUMBERS COME FROM — a decision Task 8 owed an
 * answer to, recorded here rather than left implicit.
 *
 * `connector_targets` carries `blast_radius_threshold`/`blast_radius_floor`
 * columns (defaults 20 and 5, admin-tunable per target).
 * `attribute_definitions` carries neither, and this task deliberately does
 * NOT add them. Constants, not columns, because a column here would be a
 * per-definition knob that WEAKENS a safety rail:
 *
 *  - It would have to be writable to be worth having, which means adding it
 *    to `SafeFieldPatch` — the one type in this feature that is defined by
 *    what it EXCLUDES (see its doc comment). A patch that raised a
 *    definition's threshold to 100 would be a "safe field" edit that
 *    silently disarms the guard on the very migration it is about to
 *    authorise, and PATCH is not where an operator expects to find the
 *    override.
 *  - There is already an explicit, AUDITED override for an oversized
 *    migration: Task 9's `force`, which records who overrode what. A tunable
 *    column is a second override that leaves no such trace.
 *  - The connector defaults are this codebase's settled calibration of "how
 *    much of a population is too much to move in one unattended step" (see
 *    `blastRadiusFloor`'s own doc comment in db/schema/connector-targets.ts
 *    for why a percentage alone misfires at small scale). A `dataType`
 *    migration is the same class of event as a target reconciliation — one
 *    operator action rewriting many principals at once — so it inherits the
 *    same calibration rather than inventing a second one.
 *
 * Named exports, not literals buried in the call, so Task 9's tests and the
 * console can state the actual numbers instead of re-typing them.
 */
export const ATTRIBUTE_MIGRATION_THRESHOLD_PERCENT = 20
export const ATTRIBUTE_MIGRATION_FLOOR = 5

/**
 * How many unconvertible values the report spells out before it stops
 * collecting. The list comes from the DATABASE and is otherwise unbounded —
 * a `string` → `number` migration on a free-text attribute can name the
 * whole directory — and this report is rendered in a browser and, in Task 9,
 * carried into a refusal message.
 *
 * Fifty is enough for an operator to see the SHAPE of the problem (which
 * values, which reasons) and start fixing it. What matters for the refusal
 * itself is only whether the list is empty: Task 9 refuses an unconvertible
 * migration outright, force or no force, so no decision depends on the exact
 * total.
 */
export const MAX_UNCONVERTIBLE_SAMPLE = 50

/** Internal page size for the population walk — not a client-facing limit; nothing a caller passes can change it. */
const PAGE_SIZE = 200

/**
 * The same `audit_log.resource_type` the controller's own writes use — a
 * migration is one more thing that happened to this definition, and an
 * auditor asking "what has been done to salary_band?" must get all of it from
 * one `WHERE resource_type = 'attribute_definition' AND resource_id = $1`.
 *
 * A literal rather than an import of the controller's `RESOURCE_TYPE`, for
 * the reason the `AuditAction` import above gives: only the TYPE can cross
 * that edge without closing a runtime cycle once Task 10 lands.
 */
const RESOURCE_TYPE = 'attribute_definition'

/**
 * The change being previewed. Both fields are optional and at least one must
 * be present, because these are exactly the two fields
 * `AttributeDefinitionsRepository.updateSafeFields` refuses to touch: they
 * are the fields whose edit moves stored user data, which is what this job
 * exists to preview before it happens.
 */
export interface AttributeMigrationChange {
  dataType?: AttributeDataType
  appliesTo?: 'user' | 'group'
}

/**
 * One stored value this migration cannot carry across, and the reason
 * `convertValue` gave.
 *
 * NOTE FOR WHOEVER ADDS GROUP-HELD VALUES: `userId` is the plan's own field
 * name and it is user-shaped on purpose — a group-scoped definition's values
 * live in `groups.attributes` and have no user id at all. Supporting them
 * means widening this shape (a discriminated holder, not a renamed
 * `userId`), which the commit half and the console both read, so it is a
 * deliberate change to make together rather than a field to quietly
 * overload. Until then `plan` refuses a group-scoped definition outright —
 * see its own comment.
 */
export interface UnconvertibleValue {
  userId: string
  value: unknown
  reason: string
}

export interface AttributeMigrationReport {
  /**
   * Every user HOLDING this attribute — not every user in the directory.
   *
   * A migration touching all twelve holders of a rare attribute is total for
   * that attribute and must read as 100%, not as 0.03% of the tenant. The
   * denominator is what makes the blast-radius percentage mean anything, and
   * the directory-sized denominator would make it mean nothing.
   */
  populationSize: number
  /** Holders whose stored value this migration would actually rewrite. Never counts an unconvertible one — that value is not going to change, it is going to block. */
  changedCount: number
  /** A BOUNDED sample — see `MAX_UNCONVERTIBLE_SAMPLE`. Empty means every held value survives the change. */
  unconvertible: UnconvertibleValue[]
  blastRadius: BlastRadiusEvaluation
  /**
   * WHAT THIS HASH COVERS, and why each part is in it — Task 8's second
   * recorded decision.
   *
   * A preview is an AUTHORISATION: Task 9's `commit` accepts one only when
   * the hash it is handed still matches the plan it re-derives. So the hash
   * has to be specific enough that it stops being valid the moment anything
   * it promised stops being true. It covers, in order:
   *
   *  1. the definition's ID — so a preview of one attribute can never
   *     authorise a migration of another, even when the two have identical
   *     populations;
   *  2. the exact change (target `dataType` and `appliesTo`) AND the base it
   *     applies to (the definition's current `dataType`, `appliesTo` and
   *     declared enum options) — "the exact change" is only well-defined
   *     against a base, and an ordinary `PATCH` of the options between
   *     preview and commit changes every conversion result without touching
   *     a single user row;
   *  3. the affected users — each holder's ID **and its current value**, in
   *     id order.
   *
   * Part 3 goes one step past the letter of the plan (which asks for the set
   * of affected user ids) because the ids alone do not deliver what the plan
   * asks that set FOR: "a preview taken before someone else edits a user
   * cannot authorise a commit afterwards". Editing a holder's VALUE leaves
   * the id set identical, and the value is the thing this migration
   * overwrites — an id-only hash would happily authorise a commit that
   * converts, and destroys, a value nobody previewed.
   */
  previewHash: string
}

/**
 * One holder's converted value, kept out of the report and carried for
 * Task 9's commit: the report is what an operator reads, this is what the
 * UPDATE writes. Deliberately built by the SAME walk that produces the
 * report, so a commit can never apply a conversion the preview did not
 * count.
 */
export interface PlannedAttributeChange {
  userId: string
  before: unknown
  after: string | number | boolean
}

/**
 * What `commit` is asked to do, over and above naming the change.
 *
 * `force` OVERRIDES THE BLAST-RADIUS REFUSAL AND NOTHING ELSE. "This many
 * rows is more than I expected" is a judgement an operator can legitimately
 * overrule — they may know the migration is meant to be total. "This value
 * cannot survive the conversion" is not a judgement at all, and overruling it
 * would mean deciding to destroy the value; the same goes for the refusals
 * that exist to keep values out of the audit log or out of an orphaned scope.
 * Every one of those is checked WITHOUT consulting `force`.
 */
export interface AttributeMigrationCommitOptions {
  force?: boolean
  actorUserId: string
}

interface AttributeMigrationPlan {
  report: AttributeMigrationReport
  changes: PlannedAttributeChange[]
  /** The resolved destination — what `change` means once merged with the definition it applies to. Internal, so that `commit` does not re-derive (and so cannot disagree with) what the walk actually planned against. */
  target: { dataType: AttributeDataType; appliesTo: 'user' | 'group'; options: string[] | undefined }
}

/**
 * The narrowest handle this job's population walk needs: anything that can
 * `select`. Both the pooled client and a live transaction satisfy it, which
 * is what lets Task 9 run the identical walk inside the transaction that
 * writes, while `preview` runs it on the pool without holding one open.
 */
type ReadHandle = Pick<NodePgDatabase<typeof schema>, 'select'>

/**
 * Milestone 8, Task 8 — preview a `dataType`/`appliesTo` change to an
 * attribute definition.
 *
 * These two fields are split off from the ordinary PATCH path on purpose
 * (`SafeFieldPatch` excludes both BY CONSTRUCTION): changing either rewrites
 * values already stored in `users.attributes`, in place, with no copy left
 * behind. That is not an edit to a definition, it is a directory-wide data
 * migration wearing an edit's clothing, and this job is the two-phase
 * treatment it needs — PREVIEW here, COMMIT in Task 9.
 *
 * PREVIEW WRITES NOTHING. Not "writes nothing unless", not "writes only the
 * report": the walk is `SELECT`-only from end to end, and its own test
 * asserts the `users` table is byte-identical afterwards. An operator has to
 * be able to ask this question about production without the asking being the
 * change.
 *
 * NOT SCOPED TO AN ORGANIZATION, deliberately, and unlike
 * `TargetReconciliationJob`, which runs per tenant. `attribute_definitions`
 * has no tenant column — one global definition feeds every tenant, which is
 * the same reasoning `AttributeDefinitionsRepository.assertNoFormulaDependsOn`
 * spells out for its own refusal. A preview that counted only one
 * organization's holders would under-report the blast radius of a change
 * that lands on all of them.
 *
 * EVERY STATUS. Holders are selected by "does this user carry this key",
 * with no filter on `status` — a deactivated leaver's stored values are
 * rewritten by the same UPDATE as everybody else's, so they are part of the
 * population whether or not anyone can log in as them. Same conclusion
 * `ALL_USER_STATUSES` reaches for the reconciliation jobs, reached here by
 * simply never adding the filter.
 */
@Injectable()
export class AttributeMigrationJob {
  constructor(
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
  ) {}

  async preview(
    definitionId: string,
    change: AttributeMigrationChange,
  ): Promise<AttributeMigrationReport> {
    const { report } = await this.plan(this.db, definitionId, change)
    return report
  }

  /**
   * Milestone 8, Task 9 — APPLY the change `preview` reported, in one
   * transaction, or apply none of it.
   *
   * THE PREVIEW HASH IS THE AUTHORISATION, and the check is not a formality:
   * the plan is RE-DERIVED here, inside the writing transaction, and the hash
   * compared against that re-derivation rather than against anything the
   * caller carried in. A hash that no longer matches means the definition,
   * the change, or one of the values this migration is about to overwrite has
   * moved since a human read the report — so the report they approved is not
   * the migration they would get, and the only safe answer is to make them
   * look again.
   *
   * THE ORDER OF THE REFUSALS is deliberate. First the two that no
   * authorisation can cure (a sensitive definition, a scope move), because
   * neither depends on the population and both should refuse before this job
   * pulls values it must not hold; then the hash, because everything after it
   * is a statement about a plan the caller has to be authorised for at all;
   * then the data refusals; then the blast radius, which is last because it
   * is the only one `force` may answer.
   *
   * WHAT `force` MAY AND MAY NOT DO — see `AttributeMigrationCommitOptions`.
   * Note that `force` is checked in exactly ONE place in this method. It is
   * not passed down, not consulted by a helper, and cannot widen anything
   * else by accident.
   *
   * THE ROW LOCK is taken on the definition before anything is read, for the
   * reason `AttributeDefinitionsRepository.findByIdForUpdate` gives about its
   * own PATCH path: a concurrent `PATCH` of this definition's enum options or
   * default is a legal safe-field edit that changes what this migration
   * MEANS, and under READ COMMITTED it could otherwise commit between the
   * re-derivation and the write.
   */
  async commit(
    definitionId: string,
    change: AttributeMigrationChange,
    previewHash: string,
    opts: AttributeMigrationCommitOptions,
  ): Promise<AttributeMigrationReport> {
    return this.db.transaction(async (tx) => {
      const [definition] = await tx
        .select()
        .from(attributeDefinitions)
        .where(eq(attributeDefinitions.id, definitionId))
        .for('update')
        .limit(1)
      if (definition === undefined) throw new NotFoundError('attribute definition', definitionId)

      assertNotSensitive(definition)
      assertScopeStays(definition, change)

      const { report, changes, target } = await this.plan(tx, definitionId, change)

      if (report.previewHash !== previewHash) {
        throw new ConflictError(
          'the preview hash does not authorise this migration: the definition, the change, or a ' +
            'value this migration would overwrite has moved since that preview was taken. Take a ' +
            'fresh preview, read it, and commit that one — the hash is what keeps the report an ' +
            'operator approved and the migration that actually runs the same event.',
        )
      }

      if (report.unconvertible.length > 0) {
        throw new ValidationError([
          `${report.unconvertible.length} of ${report.populationSize} stored values cannot be ` +
            'converted, so this migration would destroy them. Fix or clear them first; force ' +
            'does not override this, because refusing is the only thing standing between an ' +
            'unreadable value and no value at all:',
          ...report.unconvertible.map((entry) => `user ${entry.userId}: ${entry.reason}`),
        ])
      }

      const defaultValue = convertDefaultValue(definition, target)
      assertRulesSurviveDataType(definition, target)

      if (report.blastRadius.tripped && opts.force !== true) {
        throw new ValidationError([
          `this migration would rewrite ${report.blastRadius.changedCount} of ` +
            `${report.blastRadius.populationSize} stored values, past both the ` +
            `${report.blastRadius.thresholdPercent}% threshold and the floor of ` +
            `${report.blastRadius.floor}. Re-issue it with force to override — the override is ` +
            'recorded in the audit row.',
        ])
      }

      for (const planned of changes) {
        await this.applyOne(tx, definition.key, planned)
      }

      await tx
        .update(attributeDefinitions)
        .set({
          dataType: target.dataType,
          appliesTo: target.appliesTo,
          defaultValue,
          updatedAt: new Date(),
        })
        .where(eq(attributeDefinitions.id, definitionId))

      // THE ROW THAT MAKES THIS REVERSIBLE. A dataType migration overwrites
      // values IN PLACE and leaves no copy anywhere else in this system, so
      // `before.values` is the ONLY record of what every affected user held —
      // paired with `after.values`, it is a replayable undo. It carries the
      // holders this migration actually CHANGED, which is exactly the set an
      // undo has to touch.
      //
      // Values in `audit_log` is precisely what finding SEC-M1 is about,
      // which is why `assertNotSensitive` runs first and why it is not
      // forceable: this row is written only for a definition whose values the
      // audit log is already allowed to see (it sees them on every ordinary
      // user create/update), never for one whose values it has been told to
      // withhold.
      await this.auditWriter.record(tx, {
        actorUserId: opts.actorUserId,
        action: 'attribute_definition:migrate' satisfies AuditAction,
        resourceType: RESOURCE_TYPE,
        resourceId: definitionId,
        before: {
          definition: {
            id: definition.id,
            key: definition.key,
            dataType: definition.dataType,
            appliesTo: definition.appliesTo,
            defaultValue: definition.defaultValue,
          },
          values: changes.map((planned) => ({ userId: planned.userId, value: planned.before })),
        },
        after: {
          definition: {
            id: definition.id,
            key: definition.key,
            dataType: target.dataType,
            appliesTo: target.appliesTo,
            defaultValue,
          },
          values: changes.map((planned) => ({ userId: planned.userId, value: planned.after })),
          populationSize: report.populationSize,
          changedCount: report.changedCount,
          // An overridden migration and an ordinary one are not the same
          // event. Task 8 declined to add a tunable threshold column partly
          // because this — an override that names itself in the log — already
          // exists; that argument is only true if it is actually recorded.
          forced: opts.force === true && report.blastRadius.tripped,
          previewHash,
        },
      })

      return report
    })
  }

  /**
   * One holder's value, rewritten in place — and REFUSED if the value moved
   * out from under the plan.
   *
   * The `WHERE` carries the before-value, so this UPDATE only lands on a row
   * that still holds exactly what the walk planned against. The walk is a
   * plain `SELECT` (it is shared with `preview`, which must not lock the
   * directory), so under READ COMMITTED a concurrent self-service edit can
   * commit between the walk and this statement — and without the guard the
   * migration would convert, and destroy, the value it never saw. No match
   * means no update, which aborts the whole transaction rather than skipping
   * a row: a partially applied migration whose audit row claims otherwise is
   * worse than a refusal.
   *
   * `jsonb_set` rather than writing the whole bag back: every OTHER key in
   * that user's attributes belongs to a definition this migration has nothing
   * to do with, and rewriting the bag wholesale would silently revert a
   * concurrent edit to any of them.
   */
  private async applyOne(
    tx: DbHandle,
    key: string,
    planned: PlannedAttributeChange,
  ): Promise<void> {
    const before = JSON.stringify(planned.before) ?? 'null'
    const after = JSON.stringify(planned.after)

    const updated = await tx
      .update(users)
      .set({
        attributes: sql`jsonb_set(${users.attributes}, ARRAY[${key}::text], ${after}::jsonb, false)`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(users.id, planned.userId),
          sql`${users.attributes} -> ${key}::text IS NOT DISTINCT FROM ${before}::jsonb`,
        ),
      )
      .returning({ id: users.id })

    if (updated.length === 0) {
      throw new ConflictError(
        `user ${planned.userId} no longer holds the value this migration planned to convert for ` +
          `"${key}" — it changed while the migration was running. Nothing has been applied; take ` +
          'a fresh preview.',
      )
    }
  }

  /**
   * The whole computation, on any read handle — the pool for `preview`, the
   * live transaction for Task 9's `commit`, so the commit re-derives the
   * plan under its own snapshot rather than trusting a report computed
   * outside it.
   */
  private async plan(
    handle: ReadHandle,
    definitionId: string,
    change: AttributeMigrationChange,
  ): Promise<AttributeMigrationPlan> {
    // Refused before any database work: an empty change has no preview to
    // take, and letting it through would mint a `previewHash` that Task 9
    // would then honour as authorisation for a commit that names a real
    // change.
    if (change.dataType === undefined && change.appliesTo === undefined) {
      throw new ValidationError([
        'a migration must change dataType, appliesTo, or both — this change names neither',
      ])
    }

    const [definition] = await handle
      .select()
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.id, definitionId))
      .limit(1)
    if (definition === undefined) throw new NotFoundError('attribute definition', definitionId)

    // FAIL CLOSED on a group-scoped definition. This walk reads
    // `users.attributes` and the report names `userId`s, so a definition
    // whose values live in `groups.attributes` has no population here at
    // all — and "0 holders, nothing to convert" is precisely the report an
    // operator reads as "safe to commit" before a migration rewrites every
    // group's value unseen. Refusing is the only honest answer until the
    // report shape can carry a group holder; see this file's own note to
    // whoever adds it.
    if (definition.appliesTo === 'group') {
      throw new ValidationError([
        `attribute definition "${definition.key}" applies to groups, and migrating group-held ` +
          'values is not supported — this job previews values stored on users only',
      ])
    }

    const fromDataType = definition.dataType
    const toDataType = change.dataType ?? definition.dataType
    const toAppliesTo = change.appliesTo ?? definition.appliesTo
    // Converting TO an enum is checked against the definition's OWN declared
    // options — the change carries a dataType, never a new vocabulary — so a
    // definition with no options declared refuses every value with
    // `convertValue`'s own "the target definition declares no allowed values".
    // That is a readable refusal list, not a silent empty migration.
    const options = readEnumOptions(definition.validationRules)

    // The scope change is a change to EVERY holder, whatever the values are:
    // after it, this definition no longer governs anything stored on a user,
    // so every value it currently governs is affected. Counting it as zero
    // because the bytes happen to survive would hide the whole migration
    // from the guard.
    const scopeMoves = toAppliesTo !== definition.appliesTo

    const hash = createHash('sha256')
    hash.update(
      `${JSON.stringify({
        definitionId: definition.id,
        // The BASE as well as the delta. "The exact change" is only
        // well-defined against the state it applies to: an admin who edits
        // this definition's enum options (a legal `SafeFieldPatch`) between
        // preview and commit changes what every conversion produces without
        // touching a single user row, and nothing else in this hash would
        // notice.
        from: { dataType: definition.dataType, appliesTo: definition.appliesTo, options },
        to: { dataType: toDataType, appliesTo: toAppliesTo },
      })}\n`,
    )

    const unconvertible: UnconvertibleValue[] = []
    const changes: PlannedAttributeChange[] = []
    let populationSize = 0
    let changedCount = 0

    for await (const holder of this.walkHolders(handle, definition.key)) {
      populationSize += 1

      // Streamed into the hash IN ID ORDER as the walk goes, rather than
      // collected and hashed at the end: the population is directory-sized
      // in the worst case and nothing else here needs it in memory.
      hash.update(`${holder.userId}\u0000${JSON.stringify(holder.value) ?? 'undefined'}\n`)

      const conversion = convertValue(holder.value, fromDataType, toDataType, options)
      if (!conversion.ok) {
        if (unconvertible.length < MAX_UNCONVERTIBLE_SAMPLE) {
          unconvertible.push({
            userId: holder.userId,
            value: holder.value,
            reason: conversion.reason,
          })
        }
        continue
      }

      if (!scopeMoves && conversion.value === holder.value) continue

      changedCount += 1
      changes.push({ userId: holder.userId, before: holder.value, after: conversion.value })
    }

    return {
      report: {
        populationSize,
        changedCount,
        unconvertible,
        blastRadius: evaluateBlastRadius(
          changedCount,
          populationSize,
          ATTRIBUTE_MIGRATION_THRESHOLD_PERCENT,
          ATTRIBUTE_MIGRATION_FLOOR,
        ),
        previewHash: hash.digest('hex'),
      },
      changes,
      target: { dataType: toDataType, appliesTo: toAppliesTo, options },
    }
  }

  /**
   * Every user carrying `key` in `attributes`, in id order, a page at a time.
   *
   * Keyset pagination (`id > lastId`) rather than OFFSET: the walk can span
   * the whole directory, and OFFSET re-reads and re-sorts everything it has
   * already skipped. Id order is also what makes the streamed hash
   * deterministic — two previews of the same population must feed the digest
   * the same bytes in the same order.
   *
   * `jsonb_exists(attributes, key)` rather than the `?` operator it backs:
   * `?` is a placeholder character in more than one layer between here and
   * Postgres, and the function form has no such ambiguity. Key PRESENCE is
   * the test, not a non-null value — a holder whose value is JSON `null`
   * holds the attribute, and `convertValue` has a refusal reason for exactly
   * that value.
   */
  private async *walkHolders(
    handle: ReadHandle,
    key: string,
  ): AsyncGenerator<{ userId: string; value: unknown }> {
    let lastId: string | null = null

    for (;;) {
      const holds = sql`jsonb_exists(${users.attributes}, ${key})`
      const page = await handle
        .select({ id: users.id, attributes: users.attributes })
        .from(users)
        .where(lastId === null ? holds : and(holds, gt(users.id, lastId)))
        .orderBy(asc(users.id))
        .limit(PAGE_SIZE)

      for (const row of page) {
        // `Object.hasOwn`, never a bare index: `attributes` is jsonb this
        // system did not necessarily write, and this file is on the read
        // side of the same prototype-chain defence attribute-key.ts enforces
        // on the write side.
        const attributes = row.attributes ?? {}
        yield {
          userId: row.id,
          value: Object.hasOwn(attributes, key) ? attributes[key] : undefined,
        }
      }

      if (page.length < PAGE_SIZE) return
      lastId = page[page.length - 1].id
    }
  }
}

/**
 * The definition's declared enum vocabulary, or `undefined`.
 *
 * Read defensively: `validation_rules` is jsonb, and every row on a deployed
 * host predates this feature's write path (that is the problem the feature
 * exists to remove), so `options` can legally be anything at all. A
 * malformed value is treated as ABSENT rather than coerced, which makes
 * `convertValue` refuse every value with a reason an operator can act on
 * instead of silently accepting whatever survived a cast.
 */
/** The definition row as `commit` reads it back — narrowed to the fields the refusals below need, so they cannot quietly start depending on more. */
type CommittableDefinition = Pick<
  typeof attributeDefinitions.$inferSelect,
  'key' | 'dataType' | 'appliesTo' | 'sensitive' | 'defaultValue' | 'validationRules'
>

/**
 * A `sensitive` definition is NOT migrated. The tension this task had to
 * settle, settled in favour of destroying nothing.
 *
 * Task 9 requires the affected users' prior values in the audit row, because
 * a `dataType` migration overwrites them in place and that row is the only
 * thing that makes it reversible. `sensitive` is the flag that says this
 * attribute's values must never be copied into `audit_log` — finding SEC-M1,
 * whose whole point is that the table's UPDATE/DELETE/TRUNCATE are blocked by
 * both privilege and trigger, so a value written there is written forever.
 * The two requirements are in direct conflict, and there were three ways out:
 *
 *  1. write the values anyway — reintroduces SEC-M1 permanently, through the
 *     one door `sensitive` exists to close, for the attributes most likely to
 *     matter;
 *  2. migrate but redact the row — the migration still overwrites every
 *     value, and the record that could have undone it says `[redacted]`. That
 *     makes the MOST sensitive data in the directory the ONLY data with an
 *     irreversible migration path;
 *  3. refuse.
 *
 * Refusing is the only one of the three that destroys nothing, and the
 * capability is not actually lost: `sensitive` is a safe field, so an admin
 * who wants this migration turns it off with a `PATCH` — which is itself
 * recorded, under its own action `attribute_definition:sensitive_changed`,
 * exactly so that "why did salary_band go dark on the 4th?" is answerable —
 * migrates, and turns it back on. THE COST is real and worth stating: during
 * that window the attribute's values land in ordinary user audit rows as
 * well as this migration's, so the operator has traded a permanent leak for a
 * bounded one they had to ask for twice, in the open.
 *
 * Not forceable. `force` is the blast-radius override; see
 * `AttributeMigrationCommitOptions`.
 */
function assertNotSensitive(definition: CommittableDefinition): void {
  if (!definition.sensitive) return

  throw new ValidationError([
    `attribute definition "${definition.key}" is marked sensitive, and a migration is only ` +
      'reversible because its audit row carries every affected user’s prior value — which is ' +
      'exactly what this flag forbids writing to audit_log (finding SEC-M1), a table whose rows ' +
      'can never be edited or removed. Recording a redacted row instead would overwrite those ' +
      'values with no way back at all. To migrate this attribute, turn sensitive off first ' +
      '(PATCH, itself recorded as attribute_definition:sensitive_changed), migrate, then turn it ' +
      'back on. force does not override this — it overrides the blast-radius refusal alone.',
  ])
}

/**
 * A migration may change `dataType`. It may NOT move the definition between
 * user and group scope.
 *
 * `appliesTo` decides which table's attribute bag a definition's values live
 * in. This job converts values in `users.attributes`, so a commit that also
 * moved the definition to group scope would leave every value it had just
 * rewritten sitting where the definition no longer reads — converted,
 * overwritten, and orphaned in one statement. That is the same asymmetry
 * `plan` refuses from the other side (a group-scoped definition has no
 * population here at all); this is the door on the other end of the same
 * corridor.
 *
 * `preview` still reports a scope change, and deliberately so: the report is
 * how an operator finds out how many values such a change would strand.
 * Nothing is lost by refusing it only at the point where it would be written.
 */
function assertScopeStays(
  definition: CommittableDefinition,
  change: AttributeMigrationChange,
): void {
  const toAppliesTo = change.appliesTo ?? definition.appliesTo
  if (toAppliesTo === definition.appliesTo) return

  throw new ValidationError([
    `migrating "${definition.key}" from ${definition.appliesTo} to ${toAppliesTo} scope is not ` +
      'supported: appliesTo decides which table holds this definition’s values, so every value ' +
      'this migration converted in users.attributes would be orphaned where nothing reads it. ' +
      'Create a definition in the scope you want and migrate onto it instead.',
  ])
}

/**
 * The definition's OWN stored default, carried across by the same rule as
 * every user's value.
 *
 * A default is a value of its own attribute — every user who never sets one
 * inherits it — so leaving it behind as a `string` under `dataType: number`
 * produces a directory of inherited values that fail their own definition,
 * surfacing later as a 400 on an innocent PATCH of a user who never touched
 * the attribute (the failure mode
 * `assertDefaultValueMatchesDefinition` was written to prevent). It goes
 * through `convertValue`, not a second rule, and an unconvertible default
 * refuses the migration exactly as an unconvertible user value does.
 */
function convertDefaultValue(
  definition: CommittableDefinition,
  target: { dataType: AttributeDataType; options: string[] | undefined },
): unknown {
  if (definition.defaultValue === null || definition.defaultValue === undefined) {
    return definition.defaultValue ?? null
  }

  const converted = convertValue(
    definition.defaultValue,
    definition.dataType,
    target.dataType,
    target.options,
  )
  if (converted.ok) return converted.value

  throw new ValidationError([
    `defaultValue: this definition's own default cannot be carried across — ${converted.reason}. ` +
      'A default is a value of its own attribute, inherited by every user who never sets one, so ' +
      'it has to survive the conversion too. Clear or correct it (PATCH), then re-preview.',
  ])
}

/**
 * The definition's stored `validationRules` must mean something under the new
 * `dataType`.
 *
 * `assertValidationRulesMatchDataType`'s own doc comment names this job as
 * the one place `dataType` moves and says it "will need its own handling of
 * `validationRules` when it lands, not a carve-out here". This is that
 * handling, and it reuses that function rather than restating the pairing: a
 * `minLength` on an attribute that is about to become a number is a rule that
 * can never fire again, and leaving it behind means the next admin who edits
 * that definition is refused by a rule this migration wrote.
 *
 * REFUSED rather than silently dropped. Dropping a validation rule is
 * removing a constraint on user input, which is not a decision a data
 * migration gets to make on an admin's behalf; both fields it complains about
 * are safe fields, so the remedy is one `PATCH` away.
 */
function assertRulesSurviveDataType(
  definition: CommittableDefinition,
  target: { dataType: AttributeDataType },
): void {
  try {
    assertValidationRulesMatchDataType(
      parseValidationRules(definition.validationRules ?? undefined),
      target.dataType,
    )
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error
    throw new ValidationError([
      ...error.issues,
      `validationRules: PATCH "${definition.key}" to remove the rules that do not apply to ` +
        `dataType "${target.dataType}", then re-preview. A migration does not drop a validation ` +
        'rule on an admin’s behalf.',
    ])
  }
}

function readEnumOptions(validationRules: Record<string, unknown> | null): string[] | undefined {
  const raw = validationRules === null ? undefined : validationRules.options
  if (!Array.isArray(raw)) return undefined
  if (!raw.every((entry): entry is string => typeof entry === 'string')) return undefined
  return raw
}
