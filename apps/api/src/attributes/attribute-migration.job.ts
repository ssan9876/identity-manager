import { createHash } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { and, asc, eq, gt, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import { NotFoundError, ValidationError } from '../common/errors'
import { attributeDefinitions } from '../db/schema/attribute-definitions'
import * as schema from '../db/schema/index'
import { users } from '../db/schema/users'
import {
  type BlastRadiusEvaluation,
  evaluateBlastRadius,
} from '../outbox/target-reconciliation.job'
import { type AttributeDataType, convertValue } from './attribute-conversion'

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

interface AttributeMigrationPlan {
  report: AttributeMigrationReport
  changes: PlannedAttributeChange[]
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
  constructor(@Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>) {}

  async preview(
    definitionId: string,
    change: AttributeMigrationChange,
  ): Promise<AttributeMigrationReport> {
    const { report } = await this.plan(this.db, definitionId, change)
    return report
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
function readEnumOptions(validationRules: Record<string, unknown> | null): string[] | undefined {
  const raw = validationRules === null ? undefined : validationRules.options
  if (!Array.isArray(raw)) return undefined
  if (!raw.every((entry): entry is string => typeof entry === 'string')) return undefined
  return raw
}
