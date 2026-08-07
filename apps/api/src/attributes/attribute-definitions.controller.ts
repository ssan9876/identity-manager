import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common'
import { z } from 'zod'
import { JwtGuard } from '../auth/jwt.guard'
import { PermissionGuard } from '../authz/permission.guard'
import { RequirePermission } from '../authz/require-permission.decorator'
import { ValidationError } from '../common/errors'
import { AttributeDefinitionsRepository } from './attribute-definitions.repository'
import type { AttributeDefinition } from './attribute-validator'

const appliesToSchema = z.enum(['user', 'group'])

/**
 * `GET /attribute-definitions?appliesTo=user|group` — Milestone 8, Task 3's
 * one new endpoint (the plan's architecture note: "adds no new endpoints
 * except where a screen genuinely needs one" — the same justification Task
 * 2 used for `GET /self/permissions`).
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
 * Read-only, same as every other route this milestone adds. The carried
 * "ReDoS gate stays closed only while `attribute_definitions` has no write
 * path" note (plan.md, Carried forward) is unaffected: this route cannot
 * write a `pattern` (or anything else), only read whichever definitions an
 * operator already configured directly against the database.
 *
 * Gated by `user:read` alone, regardless of the requested `appliesTo` —
 * deliberately NOT a per-`appliesTo` check (`group:read` for the group
 * branch), because in today's static role catalog (authz/actions.ts) no
 * role holds `group:read` without also holding `user:read` (every one of
 * `group:read`'s five holders is also a `user:read` holder, via
 * `READ_ONLY_ACTIONS` or an explicit pairing) — a second check would be
 * unreachable dead code, not real defence. Labels/types are also strictly
 * LESS revealing than data every `user:read`/`group:read` holder can
 * already see: `GET /users/:id` and `GET /groups/:id` both already return
 * the raw `attributes` value object today. If `ROLE_PERMISSIONS` is ever
 * changed to decouple the two actions, that is itself a deliberate,
 * reviewed change (see that catalog's own doc comment) and should revisit
 * this gate at the same time.
 */
@Controller('attribute-definitions')
@UseGuards(JwtGuard, PermissionGuard)
export class AttributeDefinitionsController {
  constructor(
    @Inject(AttributeDefinitionsRepository) private readonly definitions: AttributeDefinitionsRepository,
  ) {}

  @Get()
  @RequirePermission('user:read')
  async list(@Query('appliesTo') rawAppliesTo: unknown): Promise<AttributeDefinition[]> {
    const parsed = appliesToSchema.safeParse(rawAppliesTo)
    if (!parsed.success) {
      throw new ValidationError(["appliesTo: must be 'user' or 'group'"])
    }

    return this.definitions.listActive(parsed.data)
  }
}
