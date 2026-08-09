import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { BusinessRolesRepository } from '../src/business-roles/business-roles.repository'
import { businessRoles } from '../src/db/schema/business-roles'
import { jmlRules } from '../src/db/schema/jml-rules'
import { organizations } from '../src/db/schema/organizations'
import { JmlRulesRepository } from '../src/jml/jml-rules.repository'
import { withTestDatabase } from './support/pg'

const ctx = withTestDatabase()

/**
 * Milestone: organizations multi-tenancy, Task 5 — `organization_id` on
 * business roles and JML rules.
 *
 * REAL-DATABASE assertions throughout, which is the plan's standing
 * constraint for Tasks 2-5 and 10 and is doubly warranted here: this task is
 * a DATA MIGRATION, and a typecheck vouches for nothing about a backfill, a
 * NOT NULL that has to hold against pre-existing rows, or a unique index
 * whose key changed shape. Most of the file therefore inserts DIRECTLY with
 * Drizzle, bypassing the repositories on purpose — a repository-level
 * pre-check that happened to reject the same thing would make a green test
 * prove nothing about what a CSV import, a connector write-back or a second
 * API instance would actually be allowed to do.
 *
 * `withTestDatabase()` starts ONE container per test FILE and never
 * truncates between `it` blocks, so every fixture below carries a per-call
 * unique discriminator.
 */
function unique(): string {
  return randomUUID().slice(0, 8)
}

async function masterId(): Promise<string> {
  const [master] = await ctx.db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.isMaster, true))
  expect(master).toBeDefined()
  return master.id
}

/**
 * A real, non-master organization — the ONLY way this phase can express "a
 * second tenant", since the organizations write API is Task 12. `realm` is
 * mandatory for non-master rows (`organizations_realm_present`) and `slug`
 * must be lowercase (`organizations_slug_format`).
 */
async function createOrganizationRow(slug: string): Promise<string> {
  const [org] = await ctx.db
    .insert(organizations)
    .values({ slug, name: slug, realm: `${slug}-realm` })
    .returning()
  return org.id
}

/** A minimal, valid `jml_rules` row minus the column under test. */
function ruleValues(name: string) {
  return {
    name,
    trigger: 'user_created' as const,
    conditionField: 'jobTitle',
    conditionOperator: 'equals' as const,
    conditionValue: 'Engineer',
    action: 'set_attribute' as const,
    actionParams: { key: 'costCenter', value: 'CC-1' },
  }
}

describe('organization_id on business roles and JML rules', () => {
  it('refuses a business role and a JML rule with no organization', async () => {
    // Raw SQL rather than Drizzle: the point is what POSTGRES does when the
    // column is absent, and Drizzle's insert type would refuse to compile
    // this at all — which is a different (and weaker) guarantee.
    await expect(
      ctx.db.execute(sql`INSERT INTO business_roles (name) VALUES (${`orphan-${unique()}`})`),
    ).rejects.toThrow(/organization_id/)

    await expect(
      ctx.db.execute(sql`
        INSERT INTO jml_rules (name, trigger, condition_field, condition_operator, action)
        VALUES (${`orphan-${unique()}`}, 'user_created', 'jobTitle', 'equals', 'set_attribute')
      `),
    ).rejects.toThrow(/organization_id/)
  })

  it('refuses an organization that does not exist', async () => {
    const ghost = randomUUID()

    await expect(
      ctx.db.insert(businessRoles).values({ name: `ghost-${unique()}`, organizationId: ghost }),
    ).rejects.toThrow(/business_roles_organization_id_organizations_id_fk/)

    await expect(
      ctx.db.insert(jmlRules).values({ ...ruleValues(`ghost-${unique()}`), organizationId: ghost }),
    ).rejects.toThrow(/jml_rules_organization_id_organizations_id_fk/)
  })

  it('refuses to delete an organization that still owns a role or a rule', async () => {
    // ON DELETE RESTRICT, not CASCADE. Cascading would delete the formulas
    // while leaving every entitlement they had already granted in place,
    // with nothing left to explain or revoke them.
    const orgId = await createOrganizationRow(`restrict-${unique()}`)
    await ctx.db.insert(businessRoles).values({ name: `restrict-${unique()}`, organizationId: orgId })

    await expect(ctx.db.delete(organizations).where(eq(organizations.id, orgId))).rejects.toThrow(
      /business_roles_organization_id_organizations_id_fk/,
    )

    const ruleOrgId = await createOrganizationRow(`restrictr-${unique()}`)
    await ctx.db
      .insert(jmlRules)
      .values({ ...ruleValues(`restrict-${unique()}`), organizationId: ruleOrgId })

    await expect(ctx.db.delete(organizations).where(eq(organizations.id, ruleOrgId))).rejects.toThrow(
      /jml_rules_organization_id_organizations_id_fk/,
    )
  })

  it('scopes role-name uniqueness to the organization', async () => {
    // The whole point of the index change: a GLOBAL unique name would let
    // whichever tenant onboards "Engineering Standard Access" first deny it
    // to every other tenant forever, and the 409 doing the denying would be
    // an existence oracle across the tenant boundary.
    const name = `Shared Role ${unique()}`
    const master = await masterId()
    const other = await createOrganizationRow(`tenant-${unique()}`)

    await ctx.db.insert(businessRoles).values({ name, organizationId: master })

    await expect(ctx.db.insert(businessRoles).values({ name, organizationId: master })).rejects.toThrow(
      /business_roles_name_idx/,
    )

    // Same name, different tenant — allowed, and the assertion that actually
    // distinguishes a per-organization key from a global one.
    await expect(
      ctx.db.insert(businessRoles).values({ name, organizationId: other }),
    ).resolves.toBeDefined()
  })
})

describe('the repositories put new roles and rules in master', () => {
  it('BusinessRolesRepository.create derives master rather than requiring a caller to name it', async () => {
    const repo = new BusinessRolesRepository(ctx.db)
    const role = await repo.create({ name: `Derived ${unique()}`, description: null })
    expect(role.organizationId).toBe(await masterId())
  })

  it('JmlRulesRepository.create derives master too', async () => {
    const repo = new JmlRulesRepository(ctx.db)
    const rule = await repo.create({
      name: `Derived ${unique()}`,
      trigger: 'user_created',
      conditionField: 'jobTitle',
      conditionOperator: 'equals',
      conditionValue: 'Engineer',
      action: 'set_attribute',
      actionParams: { key: 'costCenter', value: 'CC-1' },
    })
    expect(rule.organizationId).toBe(await masterId())
  })
})

describe('evaluation is organization-scoped', () => {
  /**
   * The reason this task is more than a column. The reconciler runs on every
   * user write and the sweep job walks every user, so an unscoped
   * `listEnabledForEvaluation` would evaluate one tenant's formulas against
   * another tenant's people. For a GROUP grant the database would stop the
   * resulting write (`gum_user_organization_fk`, Task 4) — but a
   * TARGET-ACCOUNT grant has no such guard, because `user_target_accounts`
   * carries no organization. This filter is the only thing in front of that.
   */
  it('an enabled role in one organization is invisible to another', async () => {
    const repo = new BusinessRolesRepository(ctx.db)
    const role = await repo.create({ name: `Scoped ${unique()}`, description: null })
    await ctx.db.update(businessRoles).set({ enabled: true }).where(eq(businessRoles.id, role.id))

    const mine = await repo.listEnabledForEvaluation(await masterId())
    expect(mine.map((r) => r.id)).toContain(role.id)

    const theirs = await repo.listEnabledForEvaluation(await createOrganizationRow(`eval-${unique()}`))
    expect(theirs.map((r) => r.id)).not.toContain(role.id)
  })

  it('an enabled JML rule in one organization is invisible to another', async () => {
    // Same hazard on the JML side, and worse in kind: the two actions that
    // survived 0027 are `set_attribute` and `deactivate`, both taken
    // AGAINST A PERSON. `matchRules` cannot re-check the tenant — a
    // `JmlRule` carries no notion of the user it is matched against — so the
    // repository query is the only enforcement point there is.
    const repo = new JmlRulesRepository(ctx.db)
    const rule = await repo.create({
      name: `Scoped ${unique()}`,
      trigger: 'start_date_reached',
      conditionField: 'jobTitle',
      conditionOperator: 'equals',
      conditionValue: 'Engineer',
      action: 'set_attribute',
      actionParams: { key: 'costCenter', value: 'CC-1' },
    })
    await repo.markSimulated(rule.id)
    await repo.setEnabled(rule.id, true)

    const mine = await repo.listEnabledByTrigger(await masterId(), 'start_date_reached')
    expect(mine.map((r) => r.id)).toContain(rule.id)

    const theirs = await repo.listEnabledByTrigger(
      await createOrganizationRow(`evalr-${unique()}`),
      'start_date_reached',
    )
    expect(theirs.map((r) => r.id)).not.toContain(rule.id)
  })
})
