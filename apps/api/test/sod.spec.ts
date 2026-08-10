import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { BusinessRolesRepository } from '../src/business-roles/business-roles.repository'
import { hashDefinition, parseDefinition } from '../src/business-roles/draft'
import { RoleConflictsRepository, canonicalPair } from '../src/business-roles/role-conflicts.repository'
import { RoleReconciliationJob } from '../src/business-roles/role-reconciliation.job'
import { RoleReconciler } from '../src/business-roles/role-reconciler'
import { SodChecker } from '../src/business-roles/sod-checker'
import { ConflictError } from '../src/common/errors'
import { businessRoles, roleConflicts } from '../src/db/schema/business-roles'
import { businessRoleExceptions } from '../src/db/schema/business-roles'
import { groupUserMembers } from '../src/db/schema/group-members'
import { groups } from '../src/db/schema/groups'
import { orgUnits } from '../src/db/schema/org-units'
import { users } from '../src/db/schema/users'
import { organizations } from '../src/db/schema/organizations'
import { OrganizationsRepository } from '../src/organizations/organizations.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { UsersRepository } from '../src/users/users.repository'
import { type TestDatabase, withTestDatabase } from './support/pg'

const ctx = withTestDatabase()

const roles = () => new BusinessRolesRepository(ctx.db)
const conflicts = () => new RoleConflictsRepository(ctx.db)
const checker = () => new SodChecker(roles(), conflicts())
const job = () =>
  new RoleReconciliationJob(
    new RoleReconciler(roles(), new AuditWriter(), new OutboxWriter()),
    new UsersRepository(ctx.db),
    roles(),
    ctx.db,
  )

async function masterOrgId(ctx: TestDatabase): Promise<string> {
  return (await new OrganizationsRepository(ctx.db).findMaster()).id
}

let seq = 0

/**
 * FIXTURE ISOLATION, same reasoning as test/business-roles.spec.ts verbatim:
 * one container per FILE, no truncation between `it` blocks, so every
 * condition keys on a value unique to the call and every assertion over the
 * shared standing-violation report is CONTAINMENT, never an exact total —
 * one test's enabled conflict is still enabled when a later test's checker
 * runs.
 */
async function seedPair(options?: { secondMatches?: boolean }) {
  seq += 1
  const n = seq
  const organizationId = await masterOrgId(ctx)
  const jobTitle = `SoD Officer #${n}`

  const [unit] = await ctx.db
    .insert(orgUnits)
    .values({ name: `SoD Unit ${n}`, path: `sod_root_${n}`, organizationId })
    .returning()
  const [person] = await ctx.db
    .insert(users)
    .values({
      status: 'active',
      organizationId,
      primaryEmail: `sod-fixture-${n}@example.com`,
      username: `sod-fixture-${n}`,
      firstName: 'SoD',
      lastName: `Fixture ${n}`,
      displayName: `SoD Fixture ${n}`,
      jobTitle,
      orgUnitId: unit.id,
    })
    .returning()

  const [groupA] = await ctx.db.insert(groups).values({ name: `SoD Group A${n}`, organizationId }).returning()
  const [groupB] = await ctx.db.insert(groups).values({ name: `SoD Group B${n}`, organizationId }).returning()

  const publish = async (name: string, groupId: string, matches: boolean) => {
    const role = await roles().create({ name, description: null })
    const definition = {
      conditions: [{ field: 'jobTitle', operator: 'equals', value: matches ? jobTitle : `nobody #${n}` }],
      grants: [{ kind: 'group_membership', groupId, target: null }],
    }
    await roles().saveDraft(role.id, definition)
    await roles().recordSimulation(role.id, hashDefinition(parseDefinition(definition)), 0)
    await roles().publish(role.id)
    await roles().setEnabled(role.id, true)
    return role
  }

  const roleOne = await publish(`SoD Role One #${n}`, groupA.id, true)
  const roleTwo = await publish(`SoD Role Two #${n}`, groupB.id, options?.secondMatches ?? true)

  return { n, organizationId, jobTitle, person, groupA, groupB, roleOne, roleTwo }
}

describe('segregation of duties (role_conflicts, publish gate, standing check)', () => {
  // =======================================================================
  // The table: canonical unordered pair, no delete
  // =======================================================================

  it('stores the pair in canonical order regardless of the order given', async () => {
    const { roleOne, roleTwo } = await seedPair()
    const row = await conflicts().create({
      // Deliberately possibly-un-sorted: the repository canonicalises.
      roleAId: roleTwo.id,
      roleBId: roleOne.id,
      reason: 'one person must not hold both',
      organizationId: roleOne.organizationId,
      createdBy: null,
    })

    expect(row.roleAId < row.roleBId).toBe(true)
    expect([row.roleAId, row.roleBId].sort()).toEqual([roleOne.id, roleTwo.id].sort())
    expect(canonicalPair(roleTwo.id, roleOne.id)).toEqual({ roleAId: row.roleAId, roleBId: row.roleBId })
  })

  it('(A,B) and (B,A) are the SAME policy — the reversed pair is a 409, not a second row', async () => {
    const { roleOne, roleTwo, organizationId } = await seedPair()
    await conflicts().create({
      roleAId: roleOne.id,
      roleBId: roleTwo.id,
      reason: 'first statement of the policy',
      organizationId,
      createdBy: null,
    })

    await expect(
      conflicts().create({
        roleAId: roleTwo.id,
        roleBId: roleOne.id,
        reason: 'the same policy, reversed',
        organizationId,
        createdBy: null,
      }),
    ).rejects.toThrow(ConflictError)
  })

  it('the database itself refuses an un-canonical or self-referential pair (CHECK, not convention)', async () => {
    const { roleOne, roleTwo, organizationId } = await seedPair()
    const [greater, lesser] = roleOne.id > roleTwo.id ? [roleOne.id, roleTwo.id] : [roleTwo.id, roleOne.id]

    // A write that somehow bypassed canonicalPair: role_a > role_b.
    await expect(
      ctx.db.insert(roleConflicts).values({
        roleAId: greater,
        roleBId: lesser,
        reason: 'bypassed the repository',
        organizationId,
      }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'role_conflicts_canonical_pair' })

    // A role conflicting with itself is the same CHECK (strict <).
    await expect(
      ctx.db.insert(roleConflicts).values({
        roleAId: roleOne.id,
        roleBId: roleOne.id,
        reason: 'self-conflict',
        organizationId,
      }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'role_conflicts_canonical_pair' })
  })

  it('the composite FKs pin both roles to the CONFLICT’s own organization', async () => {
    const { roleOne, roleTwo } = await seedPair()
    const tenantSlug = `sod-tenant-${Date.now()}`
    const [otherOrg] = await ctx.db
      .insert(organizations)
      .values({ slug: tenantSlug, name: 'SoD Other Tenant', realm: tenantSlug })
      .returning()

    // Both roles are real, the organization is real — only the PAIRING is
    // wrong, which is exactly what a single-column FK cannot see (0029's
    // reasoning, applied here by 0034).
    await expect(
      ctx.db.insert(roleConflicts).values({
        roleAId: canonicalPair(roleOne.id, roleTwo.id).roleAId,
        roleBId: canonicalPair(roleOne.id, roleTwo.id).roleBId,
        reason: 'cross-tenant policy',
        organizationId: otherOrg.id,
      }),
    ).rejects.toMatchObject({ code: '23503' })
  })

  it('a conflict is retired, never deleted — and only ENABLED conflicts are consulted', async () => {
    const { roleOne, roleTwo, organizationId, person } = await seedPair()
    const row = await conflicts().create({
      roleAId: roleOne.id,
      roleBId: roleTwo.id,
      reason: 'to be retired',
      organizationId,
      createdBy: null,
    })

    const before = await checker().listStandingViolations(ctx.db, new Date())
    expect(before.violations.some((v) => v.conflictId === row.id && v.userId === person.id)).toBe(true)

    const retired = await conflicts().setEnabled(row.id, false)
    expect(retired.enabled).toBe(false)

    // Still listed (history survives retirement) ...
    const all = await conflicts().list()
    expect(all.some((c) => c.id === row.id)).toBe(true)
    // ... but no longer enforced.
    const after = await checker().listStandingViolations(ctx.db, new Date())
    expect(after.violations.some((v) => v.conflictId === row.id)).toBe(false)
  })

  // =======================================================================
  // The publish gate — PREVENTIVE, enforced in the repository
  // =======================================================================

  it('publish REFUSES when the recorded simulation of this exact draft found violations', async () => {
    const { n, jobTitle } = await seedPair()
    const role = await roles().create({ name: `SoD Gate Role #${n}`, description: null })
    const definition = {
      conditions: [{ field: 'jobTitle', operator: 'equals', value: jobTitle }],
      grants: [],
    }
    await roles().saveDraft(role.id, definition)
    await roles().recordSimulation(role.id, hashDefinition(parseDefinition(definition)), 2)

    await expect(roles().publish(role.id)).rejects.toThrow(/segregation-of-duties/)

    // Nothing was half-published: the draft survives, the child tables did
    // not change, and a clean re-simulation unlocks the gate.
    const [row] = await ctx.db.select().from(businessRoles).where(eq(businessRoles.id, role.id))
    expect(row.draftDefinition).not.toBeNull()

    await roles().recordSimulation(role.id, hashDefinition(parseDefinition(definition)), 0)
    await roles().publish(role.id)
  })

  it('a simulation that never counted SoD (pre-0034 NULL) is not good enough to publish on', async () => {
    const { n } = await seedPair()
    const role = await roles().create({ name: `SoD Legacy Role #${n}`, description: null })
    const definition = { conditions: [{ field: 'jobTitle', operator: 'equals', value: `x#${n}` }], grants: [] }
    await roles().saveDraft(role.id, definition)
    // A pre-0034 row: valid hash, no recorded count. Written raw because the
    // repository itself can no longer produce this state — that is the point.
    await ctx.db
      .update(businessRoles)
      .set({
        simulatedAt: new Date(),
        simulatedDraftHash: hashDefinition(parseDefinition(definition)),
        simulatedSodViolations: null,
      })
      .where(eq(businessRoles.id, role.id))

    await expect(roles().publish(role.id)).rejects.toThrow(/simulate it again/)
  })

  it('saving a new draft clears the recorded SoD count along with the hash', async () => {
    const { n } = await seedPair()
    const role = await roles().create({ name: `SoD Clear Role #${n}`, description: null })
    const definition = { conditions: [{ field: 'jobTitle', operator: 'equals', value: `y#${n}` }], grants: [] }
    await roles().saveDraft(role.id, definition)
    await roles().recordSimulation(role.id, hashDefinition(parseDefinition(definition)), 0)

    await roles().saveDraft(role.id, {
      conditions: [{ field: 'jobTitle', operator: 'equals', value: `z#${n}` }],
      grants: [],
    })
    const [row] = await ctx.db.select().from(businessRoles).where(eq(businessRoles.id, role.id))
    expect(row.simulatedDraftHash).toBeNull()
    expect(row.simulatedSodViolations).toBeNull()
  })

  // =======================================================================
  // The standing check — DETECTIVE, report-only
  // =======================================================================

  it('names who holds both roles and WHY each side is held (formula vs include-exception)', async () => {
    const { roleOne, roleTwo, organizationId, person } = await seedPair({ secondMatches: false })
    const row = await conflicts().create({
      roleAId: roleOne.id,
      roleBId: roleTwo.id,
      reason: 'formula meets exception',
      organizationId,
      createdBy: null,
    })

    // Not yet a violation: the person matches only role one's formula.
    const before = await checker().listStandingViolations(ctx.db, new Date())
    expect(before.violations.some((v) => v.conflictId === row.id)).toBe(false)

    // An include-exception on role two creates the pairing.
    await ctx.db.insert(businessRoleExceptions).values({
      businessRoleId: roleTwo.id,
      userId: person.id,
      mode: 'include',
      reason: 'temporary coverage',
    })

    const report = await checker().listStandingViolations(ctx.db, new Date())
    const violation = report.violations.find((v) => v.conflictId === row.id && v.userId === person.id)
    expect(violation).toBeDefined()
    expect(violation?.username).toBe(person.username)
    const sides = new Map([
      [violation?.roleA.roleId, violation?.roleA],
      [violation?.roleB.roleId, violation?.roleB],
    ])
    expect(sides.get(roleOne.id)?.via).toBe('formula')
    expect(sides.get(roleTwo.id)?.via).toBe('include_exception')
    expect(report.violationCount).toBeGreaterThanOrEqual(1)
  })

  it('an exclude-exception on one side dissolves the violation', async () => {
    const { roleOne, roleTwo, organizationId, person } = await seedPair()
    const row = await conflicts().create({
      roleAId: roleOne.id,
      roleBId: roleTwo.id,
      reason: 'dissolved by exclusion',
      organizationId,
      createdBy: null,
    })

    expect(
      (await checker().listStandingViolations(ctx.db, new Date())).violations.some(
        (v) => v.conflictId === row.id && v.userId === person.id,
      ),
    ).toBe(true)

    await ctx.db.insert(businessRoleExceptions).values({
      businessRoleId: roleTwo.id,
      userId: person.id,
      mode: 'exclude',
      reason: 'resolved the SoD finding by excluding this person',
    })

    expect(
      (await checker().listStandingViolations(ctx.db, new Date())).violations.some(
        (v) => v.conflictId === row.id && v.userId === person.id,
      ),
    ).toBe(false)
  })

  // =======================================================================
  // The reconciliation pass — surfaces, does NOT revoke
  // =======================================================================

  it('the sweep reports a standing violation and revokes NEITHER side', async () => {
    const { roleOne, roleTwo, organizationId, person, groupA, groupB } = await seedPair()

    // Materialise both grants first — the "both roles were already granted"
    // half of the scenario.
    const first = await job().reconcileAll(new Date())
    expect(first.refused).toBe(0)
    const held = await ctx.db.select().from(groupUserMembers).where(eq(groupUserMembers.userId, person.id))
    expect(held.map((m) => m.groupId).sort()).toEqual([groupA.id, groupB.id].sort())

    // THEN the conflict arrives — after the fact, the classic standing case.
    const row = await conflicts().create({
      roleAId: roleOne.id,
      roleBId: roleTwo.id,
      reason: 'defined after both roles were granted',
      organizationId,
      createdBy: null,
    })

    const report = await job().reconcileAll(new Date())

    // Surfaced as DATA in the report ...
    const violation = report.sod.violations.find((v) => v.conflictId === row.id && v.userId === person.id)
    expect(violation).toBeDefined()
    expect(report.sod.violationCount).toBeGreaterThanOrEqual(1)

    // ... and NOTHING was revoked: the person still holds both groups, from
    // both roles, exactly as before the sweep. An engine that quietly
    // removes access is this codebase's explicitly rejected failure mode.
    const after = await ctx.db.select().from(groupUserMembers).where(eq(groupUserMembers.userId, person.id))
    expect(after.map((m) => m.groupId).sort()).toEqual([groupA.id, groupB.id].sort())
  })
})
