import { Inject, Injectable } from '@nestjs/common'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { NotFoundError } from '../common/errors'
import * as schema from '../db/schema/index'
import { BusinessRolesRepository } from './business-roles.repository'
import { RoleConflictsRepository, type RoleConflictRow } from './role-conflicts.repository'
import { explainRoleHold, type EvaluableRole } from './role-evaluator'

/** Same internal batch size as every other directory walk in this module. */
const PAGE_SIZE = 200

/**
 * Same posture as `SIMULATION_SAMPLE_LIMIT`: `violationCount` is always the
 * TRUE total; `violations` carries at most this many examples, with
 * `truncated` saying so rather than letting a silently-short list read as
 * the complete answer.
 */
const VIOLATION_SAMPLE_LIMIT = 500

/** One side of a violation: which role, and WHY the person is in it. */
export interface SodRoleSide {
  roleId: string
  roleName: string
  /** Whether the role's grants are currently live — a held-but-disabled role is still a policy violation, but an operator triages it differently. */
  enabled: boolean
  via: 'formula' | 'include_exception'
}

export interface StandingSodViolation {
  conflictId: string
  /** The conflict's own mandatory reason — why these two roles must not meet in one person. */
  conflictReason: string
  userId: string
  username: string
  roleA: SodRoleSide
  roleB: SodRoleSide
}

/** A conflict role the evaluator could not understand for at least one user — surfaced, never silently skipped. */
export interface SodUnevaluableRole {
  roleId: string
  roleName: string
  reason: string
}

export interface StandingSodReport {
  /** Enabled conflicts consulted. */
  conflictsChecked: number
  /** Every user visited, across every organization that has an enabled conflict. */
  scanned: number
  /** The TRUE total, regardless of `truncated`. */
  violationCount: number
  violations: StandingSodViolation[]
  truncated: boolean
  /** Deduplicated by role. Non-empty means some pairs could not be fully checked for some users. */
  unevaluable: SodUnevaluableRole[]
}

interface CheckableConflict {
  row: RoleConflictRow
  roleA: EvaluableRole & { enabled: boolean }
  roleB: EvaluableRole & { enabled: boolean }
}

/**
 * The DETECTIVE half of segregation of duties: which people, right now, hold
 * both roles of an enabled conflicting pair — because the conflict was
 * defined after both roles were already granted, because an
 * include-exception was written on one side, or because the directory's own
 * data moved someone into a second formula.
 *
 * It REPORTS. It never revokes, never writes, never opens a transaction —
 * an engine that quietly removes access is this codebase's explicitly
 * rejected failure mode, and a standing violation is precisely the situation
 * where a human must decide WHICH of the two holdings is the wrong one.
 * (The preventive half lives in the publish gate:
 * `BusinessRolesRepository.publishWithin` refuses a draft whose recorded
 * simulation found violations.)
 *
 * "Holds" is `explainRoleHold` — formula or live include-exception,
 * indifferent to the role's `enabled` kill switch (see that function's own
 * doc comment) — so this check and the publish-time one can never disagree
 * about what a violation is.
 *
 * An unevaluable role does not abort the walk and does not throw: unlike a
 * simulation (where a guessed diff must refuse), a standing report is most
 * useful PARTIAL-but-honest — the pairs it could check are real findings,
 * and the roles it could not are named in `unevaluable` for someone to fix.
 *
 * CONNECTION DISCIPLINE: every query runs on the handle the caller passed,
 * one at a time, exactly like `RoleReconciler.explainUser` — a read-only
 * walk on the pooled handle with no transaction open.
 */
@Injectable()
export class SodChecker {
  constructor(
    @Inject(BusinessRolesRepository) private readonly roles: BusinessRolesRepository,
    @Inject(RoleConflictsRepository) private readonly conflicts: RoleConflictsRepository,
  ) {}

  async listStandingViolations(
    db: NodePgDatabase<typeof schema>,
    now: Date,
  ): Promise<StandingSodReport> {
    const enabledConflicts = await this.conflicts.listEnabled(db)

    const violations: StandingSodViolation[] = []
    const unevaluable = new Map<string, SodUnevaluableRole>()
    let violationCount = 0
    let scanned = 0
    let truncated = false

    if (enabledConflicts.length === 0) {
      return { conflictsChecked: 0, scanned, violationCount, violations, truncated, unevaluable: [] }
    }

    // Each involved role's DEFINITION, loaded once for the whole walk. Loaded
    // regardless of the role's enabled flag — see the class doc comment.
    const roleIds = [...new Set(enabledConflicts.flatMap((c) => [c.roleAId, c.roleBId]))]
    const rolesById = new Map<string, EvaluableRole & { enabled: boolean }>()
    for (const roleId of roleIds) {
      const role = await this.roles.findById(roleId, db)
      // FK-restricted, so a miss means the row vanished mid-read. Loud, not guessed.
      if (role === null) throw new NotFoundError('business role', roleId)
      rolesById.set(roleId, {
        id: role.id,
        name: role.name,
        enabled: role.enabled,
        conditions: role.conditions,
        grants: role.grants,
        exceptions: role.exceptions,
      })
    }

    // A conflict joins two roles of ITS OWN organization (composite FKs), so
    // grouping by the conflict's organization is also grouping by the roles'.
    const byOrganization = new Map<string, CheckableConflict[]>()
    for (const row of enabledConflicts) {
      const roleA = rolesById.get(row.roleAId)
      const roleB = rolesById.get(row.roleBId)
      if (roleA === undefined || roleB === undefined) throw new NotFoundError('business role', row.roleAId)
      const list = byOrganization.get(row.organizationId) ?? []
      list.push({ row, roleA, roleB })
      byOrganization.set(row.organizationId, list)
    }

    for (const [organizationId, checkable] of byOrganization) {
      let offset = 0
      for (;;) {
        const page = await this.roles.listEvaluableUsers(db, { limit: PAGE_SIZE, offset }, organizationId)
        if (page.length === 0) break

        for (const user of page) {
          scanned += 1

          for (const { row, roleA, roleB } of checkable) {
            const holdA = explainRoleHold(roleA, user, now)
            if (!holdA.known) {
              unevaluable.set(roleA.id, { roleId: roleA.id, roleName: roleA.name, reason: holdA.reason })
              continue
            }
            if (!holdA.held) continue

            const holdB = explainRoleHold(roleB, user, now)
            if (!holdB.known) {
              unevaluable.set(roleB.id, { roleId: roleB.id, roleName: roleB.name, reason: holdB.reason })
              continue
            }
            if (!holdB.held) continue

            violationCount += 1
            if (violations.length < VIOLATION_SAMPLE_LIMIT) {
              violations.push({
                conflictId: row.id,
                conflictReason: row.reason,
                userId: user.id,
                username: user.username,
                roleA: { roleId: roleA.id, roleName: roleA.name, enabled: roleA.enabled, via: holdA.via },
                roleB: { roleId: roleB.id, roleName: roleB.name, enabled: roleB.enabled, via: holdB.via },
              })
            } else {
              truncated = true
            }
          }
        }

        if (page.length < PAGE_SIZE) break
        offset += PAGE_SIZE
      }
    }

    return {
      conflictsChecked: enabledConflicts.length,
      scanned,
      violationCount,
      violations,
      truncated,
      unevaluable: [...unevaluable.values()],
    }
  }
}
