import { Inject, Injectable } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import { ConflictError, NotFoundError } from '../common/errors'
import {
  businessRoleConditions,
  businessRoleExceptions,
  businessRoleGrants,
  businessRoles,
} from '../db/schema/business-roles'
import * as schema from '../db/schema/index'
import { hashDefinition, parseDefinition } from './draft'
import type { EvaluableRole } from './role-evaluator'

@Injectable()
export class BusinessRolesRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>) {}

  async create(input: { name: string; description: string | null }) {
    const [row] = await this.db.insert(businessRoles).values(input).returning()
    return row
  }

  /**
   * Writing a draft clears the simulation record as well as failing the hash
   * comparison at publish time. Two mechanisms, deliberately: the cleared
   * record is what the console reads to show "draft pending simulation", and
   * the hash comparison is what makes the gate correct even if some future
   * caller forgets to clear.
   */
  async saveDraft(id: string, definition: unknown): Promise<void> {
    const parsed = parseDefinition(definition)
    const updated = await this.db
      .update(businessRoles)
      .set({
        // A fresh object literal here (rather than the `parsed` variable
        // itself) satisfies the column's `Record<string, unknown>` type
        // structurally — `RoleDefinition` is a named interface with no index
        // signature, so passing the variable directly would need a cast.
        draftDefinition: { conditions: parsed.conditions, grants: parsed.grants },
        simulatedAt: null,
        simulatedDraftHash: null,
        updatedAt: new Date(),
      })
      .where(eq(businessRoles.id, id))
      .returning({ id: businessRoles.id })

    if (updated.length === 0) throw new NotFoundError('business role', id)
  }

  async recordSimulation(id: string, hash: string): Promise<void> {
    await this.db
      .update(businessRoles)
      .set({ simulatedAt: new Date(), simulatedDraftHash: hash })
      .where(eq(businessRoles.id, id))
  }

  /**
   * THE gate. Refuses unless a simulation ran against this exact draft, then
   * replaces the published child rows and clears the draft in ONE transaction
   * — a half-published role would be a formula with someone else's grants.
   */
  async publish(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [role] = await tx.select().from(businessRoles).where(eq(businessRoles.id, id)).for('update')
      if (!role) throw new NotFoundError('business role', id)
      if (role.draftDefinition === null) throw new ConflictError('there is no draft to publish')

      const definition = parseDefinition(role.draftDefinition)
      if (role.simulatedDraftHash === null || role.simulatedDraftHash !== hashDefinition(definition)) {
        throw new ConflictError('this draft has not been simulated — simulate it before publishing')
      }

      await tx.delete(businessRoleConditions).where(eq(businessRoleConditions.businessRoleId, id))
      await tx.delete(businessRoleGrants).where(eq(businessRoleGrants.businessRoleId, id))

      if (definition.conditions.length > 0) {
        await tx.insert(businessRoleConditions).values(
          definition.conditions.map((c) => ({ businessRoleId: id, field: c.field, operator: c.operator, value: c.value })),
        )
      }
      if (definition.grants.length > 0) {
        await tx.insert(businessRoleGrants).values(
          definition.grants.map((g) => ({ businessRoleId: id, kind: g.kind, groupId: g.groupId, target: g.target })),
        )
      }

      await tx
        .update(businessRoles)
        .set({ draftDefinition: null, simulatedDraftHash: null, updatedAt: new Date() })
        .where(eq(businessRoles.id, id))
    })
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.db.update(businessRoles).set({ enabled, updatedAt: new Date() }).where(eq(businessRoles.id, id))
  }

  /** Every enabled role, shaped for the evaluator. The reconciler's hot read. */
  async listEnabledForEvaluation(): Promise<EvaluableRole[]> {
    const roles = await this.db.select().from(businessRoles).where(eq(businessRoles.enabled, true))
    return Promise.all(roles.map((role) => this.loadDefinition(role.id, role.name)))
  }

  async findById(id: string) {
    const [role] = await this.db.select().from(businessRoles).where(eq(businessRoles.id, id))
    if (!role) return null
    const definition = await this.loadDefinition(role.id, role.name)
    return { ...role, conditions: definition.conditions, grants: definition.grants, exceptions: definition.exceptions }
  }

  private async loadDefinition(id: string, name: string): Promise<EvaluableRole> {
    const [conditions, grants, exceptions] = await Promise.all([
      this.db.select().from(businessRoleConditions).where(eq(businessRoleConditions.businessRoleId, id)),
      this.db.select().from(businessRoleGrants).where(eq(businessRoleGrants.businessRoleId, id)),
      this.db.select().from(businessRoleExceptions).where(eq(businessRoleExceptions.businessRoleId, id)),
    ])

    return {
      id,
      name,
      conditions: conditions.map((c) => ({ field: c.field, operator: c.operator, value: c.value })),
      grants: grants.map((g) => ({ kind: g.kind, groupId: g.groupId, target: g.target })),
      exceptions: exceptions.map((e) => ({ userId: e.userId, mode: e.mode, expiresAt: e.expiresAt })),
    }
  }
}
