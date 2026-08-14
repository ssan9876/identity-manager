import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
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
import { ForbiddenError, NotFoundError } from '../common/errors'
import { parseBody } from '../common/http/parse-body'
import { parseId } from '../common/http/parse-id'
import * as schema from '../db/schema/index'
import { UsersRepository } from '../users/users.repository'
import { type JmlRule, JmlRulesRepository } from './jml-rules.repository'
import { setAttributeActionParamsSchema } from './rule-applier'
import {
  KNOWN_ACTION_NAMES,
  KNOWN_TRIGGER_NAMES,
  type JmlActionType,
  type JmlConditionOperator,
  type JmlTrigger,
  type SimulatedEffect,
  simulate,
} from './rule-engine'

/**
 * How many users one simulation walks before it stops counting.
 *
 * A preview has to be bounded. `simulate` is pure and cheap per user, but
 * this route loads every one of them into memory first, and an unbounded
 * select over the user table on an operator's button press is the same denial
 * of service the ReDoS gate was about, reached from the other direction.
 * 2000 is high enough to be a real answer for a lab or a mid-size directory,
 * and low enough to stay one fast query.
 *
 * When the directory is larger than this the report SAYS so — `truncated:
 * true` — rather than quietly describing the effect on the first 2000 users
 * as though it were the whole picture. A preview that understates its own
 * blast radius is worse than no preview at all.
 */
const SIMULATION_SCAN_LIMIT = 2000

/** How many individual effects come back for display. The counts are exact regardless. */
const SIMULATION_SAMPLE_LIMIT = 100

const createBodySchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    trigger: z.enum(KNOWN_TRIGGER_NAMES as readonly [JmlTrigger, ...JmlTrigger[]]),
    conditionField: z.string().trim().min(1).max(255),
    conditionOperator: z.enum(['equals', 'not_equals', 'in']),
    // `unknown` by design: `equals`/`not_equals` compare against a scalar and
    // `in` against an array, and the column is jsonb. Narrowed by the refines
    // below rather than by the type, so the message can name which operator
    // wanted what.
    conditionValue: z.unknown(),
    actionParams: z.record(z.unknown()).optional(),
    action: z.enum(KNOWN_ACTION_NAMES as readonly [JmlActionType, ...JmlActionType[]]),
  })
  .strict()
  .refine((body) => body.conditionOperator !== 'in' || Array.isArray(body.conditionValue), {
    message: "the 'in' operator needs an array of values",
    path: ['conditionValue'],
  })
  .refine((body) => body.conditionOperator === 'in' || !Array.isArray(body.conditionValue), {
    message: "only the 'in' operator takes an array",
    path: ['conditionValue'],
  })
  .refine(
    (body) =>
      body.action !== 'set_attribute' ||
      setAttributeActionParamsSchema.safeParse(body.actionParams ?? {}).success,
    {
      // The SAME schema `RuleApplier.applySetAttribute` runs at apply time.
      // Refused here so a rule that could only ever be skipped is never
      // written at all, instead of looking live in every listing and quietly
      // doing nothing forever.
      message: 'a set_attribute rule needs { key, value } and nothing else',
      path: ['actionParams'],
    },
  )
  .refine((body) => body.action !== 'deactivate' || body.actionParams === undefined, {
    message: 'a deactivate rule takes no actionParams',
    path: ['actionParams'],
  })

const acknowledgeBodySchema = z.object({ wouldApplyCount: z.number().int().min(0) }).strict()

export interface JmlSimulationReport {
  ruleId: string
  /** How many users were actually walked. */
  scanned: number
  /** True when the directory is bigger than `scanned` — the counts are then a floor, not a total. */
  truncated: boolean
  wouldApplyCount: number
  /** A capped sample of the users this rule WOULD act on, for display. */
  effects: SimulatedEffect[]
}

/**
 * Joiner/mover/leaver rules over HTTP — the console's half of Milestone 7.
 *
 * Until this controller existed there was NO HTTP surface for JML rules at
 * all. `JmlRulesRepository` was reachable only from `lifecycle-cli.ts`, which
 * means the one actor in this system that deactivates real accounts with no
 * human in the loop, on a schedule, was invisible to every administrator who
 * did not also have a shell on the API host — and silently editable by every
 * administrator who did, with no audit row naming them.
 *
 * That was deliberate rather than forgotten. `JmlRulesRepository`'s own doc
 * comment records why HTTP CRUD was withheld: it "would require closing the
 * still-open ReDoS gate on attribute_definitions.validation_rules.pattern".
 * A JML condition is compared against attribute values, so an HTTP path to
 * rules was an HTTP path to that regex compiler. That gate is now CLOSED —
 * `attribute-formats.ts` replaced caller-supplied regex with a closed
 * vocabulary of named formats, and `new RegExp` no longer appears anywhere in
 * `src/`, asserted by a static source scan in `test/attribute-validator.spec.ts`.
 * The stated precondition is met, so the surface opens here.
 *
 * Authorization mirrors business roles and recertification exactly: reads on
 * `jml:read` at any scope, every mutation on `jml:manage` held GLOBALLY,
 * because a rule names no org unit and `matchRules` runs it against every
 * user the lifecycle pass walks — there is nothing for a scoped grant to
 * narrow to.
 *
 * The simulation gate is NOT re-implemented here. `JmlRulesRepository.setEnabled`
 * enforces it as a single conditional UPDATE re-checking `simulated_at IS NOT
 * NULL` against the row's committed value, so this controller cannot weaken
 * the gate by forgetting to check it, and a concurrent enable cannot race a
 * simulation. This controller's job is to make that gate REACHABLE, and to
 * write down who walked through it.
 */
@Controller('jml-rules')
@UseGuards(JwtGuard, PermissionGuard)
export class JmlRulesController {
  constructor(
    private readonly rules: JmlRulesRepository,
    private readonly users: UsersRepository,
    private readonly engine: PermissionEngine,
    private readonly auditWriter: AuditWriter,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /** Every rule, enabled or not — the console's index. */
  @Get()
  @RequirePermission('jml:read')
  async list(): Promise<JmlRule[]> {
    return this.rules.list()
  }

  @Get(':id')
  @RequirePermission('jml:read')
  async findOne(@Param('id') rawId: string): Promise<JmlRule> {
    return this.requireRule(parseId(rawId))
  }

  /**
   * Create a rule. It always lands `enabled: false`, `simulatedAt: null` —
   * `CreateJmlRuleInput` has no way to express anything else, which is what
   * makes "no rule is ever born live" true by construction rather than by
   * this controller remembering to arrange it.
   */
  @Post()
  @RequirePermission('jml:manage')
  async create(@Body() body: unknown, @Req() request: AuthorizedRequest): Promise<JmlRule> {
    await this.requireGlobalManageGrant(request)
    const parsed = parseBody(createBodySchema, body)

    return this.db.transaction(async (tx) => {
      const rule = await this.rules.create(
        {
          name: parsed.name,
          trigger: parsed.trigger,
          conditionField: parsed.conditionField,
          conditionOperator: parsed.conditionOperator as JmlConditionOperator,
          conditionValue: parsed.conditionValue ?? null,
          action: parsed.action,
          actionParams: parsed.actionParams,
        },
        tx,
      )

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'jml_rule:create',
        resourceType: 'jml_rule',
        resourceId: rule.id,
        before: null,
        after: snapshotRule(rule),
      })

      return rule
    })
  }

  /**
   * Preview what this rule would do, writing nothing to `jml_rules`, `users`
   * or the outbox. `simulate` takes no database handle at all, so that holds
   * however this route calls it.
   *
   * Deliberately does NOT mark the rule simulated. `markSimulated` is a
   * separate, explicit act — "call it once a caller has reviewed simulate's
   * preview and is satisfied with it", in the repository's own words — and
   * collapsing the two would mean merely REQUESTING a preview unlocks
   * `enable`, with nobody having read the output. The gate would still be
   * there and would have stopped meaning anything.
   */
  @Post(':id/simulate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('jml:manage')
  async simulateRule(
    @Param('id') rawId: string,
    @Req() request: AuthorizedRequest,
  ): Promise<JmlSimulationReport> {
    await this.requireGlobalManageGrant(request)
    const rule = await this.requireRule(parseId(rawId))

    // One row past the cap is how `truncated` is decided: cheaper than a
    // second COUNT(*), and exact.
    const users = await this.users.list({ limit: SIMULATION_SCAN_LIMIT + 1, offset: 0 })
    const truncated = users.length > SIMULATION_SCAN_LIMIT
    const scanned = truncated ? SIMULATION_SCAN_LIMIT : users.length

    const effects = simulate(rule, users.slice(0, scanned))
    const applying = effects.filter((effect) => effect.wouldApply)

    return {
      ruleId: rule.id,
      scanned,
      truncated,
      wouldApplyCount: applying.length,
      effects: applying.slice(0, SIMULATION_SAMPLE_LIMIT),
    }
  }

  /**
   * Record that a human reviewed a preview — the gate `setEnabled` checks.
   *
   * This is the audit row that matters most in this controller: it is the one
   * place a person takes responsibility for what the rule was shown to do.
   * `reviewedWouldApplyCount` is the caller's own claim about the preview
   * they read, carried into the record so that "they enabled it having been
   * told it would touch 400 people" is answerable afterwards.
   */
  @Post(':id/acknowledge-simulation')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('jml:manage')
  async acknowledgeSimulation(
    @Param('id') rawId: string,
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ): Promise<JmlRule> {
    await this.requireGlobalManageGrant(request)
    const id = parseId(rawId)
    const before = await this.requireRule(id)
    const parsed = parseBody(acknowledgeBodySchema, body)

    return this.db.transaction(async (tx) => {
      const rule = await this.rules.markSimulated(id, tx)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'jml_rule:acknowledge_simulation',
        resourceType: 'jml_rule',
        resourceId: id,
        before: snapshotRule(before),
        after: { ...snapshotRule(rule), reviewedWouldApplyCount: parsed.wouldApplyCount },
      })

      return rule
    })
  }

  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('jml:manage')
  async enable(@Param('id') rawId: string, @Req() request: AuthorizedRequest): Promise<JmlRule> {
    return this.applyEnabled(rawId, true, request)
  }

  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('jml:manage')
  async disable(@Param('id') rawId: string, @Req() request: AuthorizedRequest): Promise<JmlRule> {
    return this.applyEnabled(rawId, false, request)
  }

  private async applyEnabled(
    rawId: string,
    enabled: boolean,
    request: AuthorizedRequest,
  ): Promise<JmlRule> {
    await this.requireGlobalManageGrant(request)
    const id = parseId(rawId)
    const before = await this.requireRule(id)

    return this.db.transaction(async (tx) => {
      // THE gate lives in here, not above: a conditional UPDATE re-checking
      // `simulated_at IS NOT NULL` against the committed row, which throws a
      // ConflictError naming the reason when it matches nothing.
      const rule = await this.rules.setEnabled(id, enabled, tx)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: enabled ? 'jml_rule:enable' : 'jml_rule:disable',
        resourceType: 'jml_rule',
        resourceId: id,
        before: snapshotRule(before),
        after: snapshotRule(rule),
      })

      return rule
    })
  }

  private async requireRule(id: string): Promise<JmlRule> {
    const rule = await this.rules.findById(id)
    if (rule === null) throw new NotFoundError('jml rule', id)
    return rule
  }

  /**
   * The same global-grant rule business roles, recertification campaigns and
   * SSO applications apply, for the identical reason: a JML rule has no
   * containing org unit, so a scoped grant has nothing to narrow.
   */
  private async requireGlobalManageGrant(request: AuthorizedRequest): Promise<void> {
    const scopePaths = await this.engine.scopePathsFor(request.actor, 'jml:manage')
    if (scopePaths !== null) {
      throw new ForbiddenError(
        'managing a lifecycle rule requires a global grant of jml:manage — a rule names no org ' +
          'unit and runs against every user the lifecycle pass walks, so a scoped grant has ' +
          'nothing to narrow it to',
      )
    }
  }
}

/** What goes in the audit row: the whole rule. It is small, and every field of it decides behaviour. */
function snapshotRule(rule: JmlRule): Record<string, unknown> {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    trigger: rule.trigger,
    conditionField: rule.conditionField,
    conditionOperator: rule.conditionOperator,
    conditionValue: rule.conditionValue,
    action: rule.action,
    actionParams: rule.actionParams,
    simulatedAt: rule.simulatedAt === null ? null : rule.simulatedAt.toISOString(),
  }
}
