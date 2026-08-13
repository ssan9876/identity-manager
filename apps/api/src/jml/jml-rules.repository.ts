import { Inject, Injectable, Optional } from '@nestjs/common'
import { and, eq, isNotNull } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import { NotFoundError, ValidationError } from '../common/errors'
import * as schema from '../db/schema/index'
import { jmlRules } from '../db/schema/jml-rules'
import { OrganizationsRepository } from '../organizations/organizations.repository'
import type { JmlActionType, JmlConditionOperator, JmlTrigger } from './rule-engine'

/**
 * The row shape read back from `jml_rules`. `trigger`/`conditionOperator`/
 * `action` are typed as plain `string` here — WIDER than the
 * `JmlTrigger`/`JmlConditionOperator`/`JmlActionType` unions `CreateJmlRuleInput`
 * accepts below — on purpose: Drizzle would happily infer the narrow literal
 * union for a SELECT off a pgEnum column, but that is a compile-time fiction
 * only. A row this process reads back can carry an enum label added by a
 * migration this exact running version has never seen (see
 * db/schema/jml-rules.ts's file doc comment), so every consumer of a `JmlRule`
 * (rule-engine.ts, rule-applier.ts) is FORCED to defensively re-check before
 * treating one of these three fields as its narrow type, rather than being
 * able to trust a type the compiler cannot actually guarantee.
 */
export interface JmlRule {
  id: string
  name: string
  /**
   * The tenant this rule belongs to (organizations milestone, Task 5).
   * Exposed on the read shape because `listEnabledByTrigger` takes it as a
   * REQUIRED argument — a caller holding a rule must be able to see which
   * organization it came from without a second query.
   */
  organizationId: string
  enabled: boolean
  trigger: string
  conditionField: string
  conditionOperator: string
  conditionValue: unknown
  action: string
  actionParams: Record<string, unknown>
  simulatedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/**
 * `enabled` is deliberately absent from this input type — every rule is
 * created `enabled: false` (the column default) and `simulatedAt: null`
 * (never simulated). There is no way to construct a pre-enabled rule through
 * this repository; `setEnabled` below is the ONLY path to `enabled: true`,
 * and it enforces the simulation gate unconditionally.
 */
export interface CreateJmlRuleInput {
  name: string
  trigger: JmlTrigger
  conditionField: string
  conditionOperator: JmlConditionOperator
  conditionValue: unknown
  action: JmlActionType
  actionParams?: Record<string, unknown>
}

/**
 * Storage and lifecycle management for `jml_rules` — Milestone 7, Task 5/6.
 * Rules are seeded/managed exclusively through this repository this
 * milestone; there is deliberately no HTTP CRUD (see the milestone plan:
 * that would require closing the still-open ReDoS gate on
 * `attribute_definitions.validation_rules.pattern`, which is out of scope
 * here and carried forward into the security audit instead).
 */
@Injectable()
export class JmlRulesRepository {
  constructor(
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
    // OPTIONAL with a raw fallback — the same shape OrgUnitsRepository,
    // GroupsRepository and BusinessRolesRepository use for this dependency.
    @Optional()
    @Inject(OrganizationsRepository)
    private readonly organizations: OrganizationsRepository = new OrganizationsRepository(db),
  ) {}

  async create(
    input: CreateJmlRuleInput,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<JmlRule> {
    // Milestone: organizations multi-tenancy, Task 5. `organization_id` is
    // NOT NULL; rules are seeded through this repository only (there is no
    // HTTP CRUD) and nothing can yet name a target organization, so a new
    // rule falls back to master exactly as OrgUnitsRepository.createRoot
    // does. Resolved on the caller's handle, never a second pooled
    // connection (finding C1).
    const master = await this.organizations.findMaster(db)
    const [row] = await db
      .insert(jmlRules)
      .values({
        organizationId: master.id,
        name: input.name,
        trigger: input.trigger,
        conditionField: input.conditionField,
        conditionOperator: input.conditionOperator,
        conditionValue: input.conditionValue ?? null,
        action: input.action,
        actionParams: input.actionParams ?? {},
      })
      .returning()

    return row as JmlRule
  }

  async findById(id: string, db: NodePgDatabase<typeof schema> = this.db): Promise<JmlRule | null> {
    const [row] = await db.select().from(jmlRules).where(eq(jmlRules.id, id)).limit(1)
    return (row as JmlRule | undefined) ?? null
  }

  async list(db: NodePgDatabase<typeof schema> = this.db): Promise<JmlRule[]> {
    const rows = await db.select().from(jmlRules)
    return rows as JmlRule[]
  }

  /**
   * Enabled rules for exactly this trigger — what RuleEngine.matchRules and
   * LifecycleJob both read to decide which rules are even in play for a
   * given user/trigger pass. Filtering by `enabled` here is an optimisation
   * only, never the sole enforcement point: `matchRules` independently
   * re-checks `enabled` itself (defense in depth — see its own doc comment),
   * so this method returning a stale or overly-broad set is never a
   * correctness hazard, only a wasted evaluation.
   *
   * The ORGANIZATION filter is a different matter and is NOT an
   * optimisation: `matchRules` does not — and cannot — re-check it, because
   * a `JmlRule` carries no notion of the user it is being matched against.
   * A rule leaking across the tenant boundary here would let one tenant's
   * admin `deactivate` another tenant's staff. It is therefore the LEADING,
   * REQUIRED parameter, so that omitting it is a compile error rather than
   * a silent widening (Milestone: organizations multi-tenancy, Task 5).
   */
  async listEnabledByTrigger(
    organizationId: string,
    trigger: JmlTrigger,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<JmlRule[]> {
    const rows = await db
      .select()
      .from(jmlRules)
      .where(
        and(
          eq(jmlRules.organizationId, organizationId),
          eq(jmlRules.enabled, true),
          eq(jmlRules.trigger, trigger),
        ),
      )
    return rows as JmlRule[]
  }

  /**
   * Records that a simulation was run for this rule — the ONLY write this
   * repository ever makes to `simulated_at`, and the ONLY fact `setEnabled`
   * below trusts when deciding whether a rule may be enabled. Deliberately
   * separate from the pure `simulate(rule, users)` function in
   * rule-engine.ts: that function touches no table at all, not even this
   * one, so "simulate writes nothing" holds regardless of how many times it
   * runs. THIS method is the explicit, separate act of recording that a
   * simulation actually happened — call it once a caller has reviewed
   * `simulate`'s preview and is satisfied with it. Idempotent: simulating an
   * already-simulated rule again just refreshes the timestamp, never errors.
   */
  async markSimulated(id: string, db: NodePgDatabase<typeof schema> = this.db): Promise<JmlRule> {
    const [row] = await db
      .update(jmlRules)
      .set({ simulatedAt: new Date(), updatedAt: new Date() })
      .where(eq(jmlRules.id, id))
      .returning()

    if (!row) {
      throw new NotFoundError('jml rule', id)
    }
    return row as JmlRule
  }

  /**
   * THE enable gate (Milestone 7, Task 6), enforced HERE — in the
   * repository, not by convention, and not by trusting a caller to have
   * checked first. Turning a rule ON is a single conditional UPDATE whose
   * WHERE clause re-checks `simulated_at IS NOT NULL` against the row's
   * CURRENT committed value — the same atomic
   * check-and-write-in-one-statement shape `UsersRepository.changeStatus`
   * uses for its own transition guard (see that method's doc comment): there
   * is no separate read-then-write window for a concurrent `markSimulated`
   * to race against.
   *
   * Turning a rule OFF (`enabled: false`) is always allowed, unconditionally
   * — the gate only ever applies to the false -> true direction. There is
   * nothing unsafe about disabling a rule regardless of its simulation
   * history.
   */
  async setEnabled(
    id: string,
    enabled: boolean,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<JmlRule> {
    if (!enabled) {
      const [row] = await db
        .update(jmlRules)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(jmlRules.id, id))
        .returning()

      if (!row) {
        throw new NotFoundError('jml rule', id)
      }
      return row as JmlRule
    }

    const [row] = await db
      .update(jmlRules)
      .set({ enabled: true, updatedAt: new Date() })
      .where(and(eq(jmlRules.id, id), isNotNull(jmlRules.simulatedAt)))
      .returning()

    if (row) {
      return row as JmlRule
    }

    // Zero rows matched — this read is advisory only, purely to report an
    // accurate reason; the atomic UPDATE above already made the real
    // decision. Same pattern as UsersRepository.changeStatus's own
    // error-determination step.
    const current = await this.findById(id, db)
    if (current === null) {
      throw new NotFoundError('jml rule', id)
    }

    throw new ValidationError([
      `enabled: rule "${current.name}" has not been simulated yet — preview it, then record that the preview was reviewed, before enabling it`,
    ])
  }
}
