import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { AttributeDefinitionsRepository } from '../src/attributes/attribute-definitions.repository'
import { AuditWriter } from '../src/audit/audit.writer'
import { BusinessRolesRepository } from '../src/business-roles/business-roles.repository'
import { hashDefinition, parseDefinition } from '../src/business-roles/draft'
import { ATTRIBUTE_PREFIX } from '../src/business-roles/role-evaluator'
import { RoleReconciliationJob } from '../src/business-roles/role-reconciliation.job'
import { RoleReconciler } from '../src/business-roles/role-reconciler'
import { ConflictError } from '../src/common/errors'
import { attributeDefinitions } from '../src/db/schema/attribute-definitions'
import { auditLog } from '../src/db/schema/audit-log'
import { businessRoleConditions } from '../src/db/schema/business-roles'
import { groupUserMembers } from '../src/db/schema/group-members'
import { groups } from '../src/db/schema/groups'
import { orgUnits } from '../src/db/schema/org-units'
import { users } from '../src/db/schema/users'
import { OrganizationsRepository } from '../src/organizations/organizations.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { UsersRepository } from '../src/users/users.repository'
import { type TestDatabase, withTestDatabase } from './support/pg'

const ctx = withTestDatabase()

function repo(): BusinessRolesRepository {
  return new BusinessRolesRepository(ctx.db)
}

const DEFINITION = {
  conditions: [{ field: 'jobTitle', operator: 'equals', value: 'Account Executive' }],
  grants: [{ kind: 'target_account', groupId: null, target: 'keycloak' }],
}

// ---------------------------------------------------------------------------
// Fixtures for RoleReconciler (Milestone 17, Task 8). No `test/helpers/`
// layer exists in this repo — built locally, same convention as `repo()`/
// `DEFINITION` immediately above.
// ---------------------------------------------------------------------------

function reconciler(): RoleReconciler {
  return new RoleReconciler(new BusinessRolesRepository(ctx.db), new AuditWriter(), new OutboxWriter())
}

/**
 * The `master` organization the organizations backfill migration creates.
 * `organization_id` is NOT NULL on org_units/users/groups, and the fixtures
 * below seed through raw inserts rather than the repositories that resolve
 * it themselves (OrgUnitsRepository.createRoot, GroupsRepository.create), so
 * they have to supply it. Every fixture row belongs to master: these tests
 * predate multi-tenancy and assert nothing about org isolation.
 */
async function masterOrgId(ctx: TestDatabase): Promise<string> {
  const master = await new OrganizationsRepository(ctx.db).findMaster()
  return master.id
}

let reconcilerFixtureSeq = 0

/**
 * An org unit, a user carrying `jobTitle`, a group, and ONE published,
 * enabled role granting that group to whoever's `jobTitle` equals a value
 * UNIQUE to this call (`Account Executive #<seq>`) — never the literal
 * string "Account Executive" shared across every call. `withTestDatabase()`
 * starts ONE container per test FILE, not per `it` (no truncation between
 * them), so every role a prior call to this function enabled is STILL
 * enabled and STILL visible to `listEnabledForEvaluation()` when a later
 * call's `reconcileUser` runs. A condition shared across calls would let an
 * older call's role match a newer call's user — this is what produced
 * "expected 1 row, got 5/6/7" when every seeded role checked the same
 * literal jobTitle. A per-call value makes that structurally impossible: no
 * two calls in one file run ever share a `seq`, so no two calls' users can
 * ever satisfy each other's condition.
 *
 * `options.jobTitle` keeps its existing meaning to callers — the sentinel
 * `'Account Executive'` means "seed a user THIS role matches", anything else
 * (e.g. `'Manager'`) means "seed a user it does not" — decided here, once,
 * by comparing against that literal, rather than writing the caller's raw
 * string onto either the condition or the row.
 */
async function seedRoleGrantingGroup(
  ctx: TestDatabase,
  options: { jobTitle: string },
): Promise<{ userId: string; groupId: string; roleId: string }> {
  reconcilerFixtureSeq += 1
  const seq = reconcilerFixtureSeq
  const matchingJobTitle = `Account Executive #${seq}`
  const actualJobTitle = options.jobTitle === 'Account Executive' ? matchingJobTitle : options.jobTitle
  const organizationId = await masterOrgId(ctx)

  const [unit] = await ctx.db
    .insert(orgUnits)
    .values({ name: `Reconciler Unit ${seq}`, path: `reconciler_root_${seq}`, organizationId })
    .returning()
  const [user] = await ctx.db
    .insert(users)
    .values({
      status: 'active',
      organizationId,
      primaryEmail: `reconciler-fixture-${seq}@example.com`,
      username: `reconciler-fixture-${seq}`,
      firstName: 'Fixture',
      lastName: `User ${seq}`,
      displayName: `Fixture User ${seq}`,
      jobTitle: actualJobTitle,
      orgUnitId: unit.id,
    })
    .returning()
  const [group] = await ctx.db.insert(groups).values({ name: `Reconciler Group ${seq}`, organizationId }).returning()

  const role = await repo().create({ name: `Reconciler Role ${seq}`, description: null })
  const definition = {
    conditions: [{ field: 'jobTitle', operator: 'equals', value: matchingJobTitle }],
    grants: [{ kind: 'group_membership', groupId: group.id, target: null }],
  }
  await repo().saveDraft(role.id, definition)
  await repo().recordSimulation(role.id, hashDefinition(parseDefinition(definition)), 0)
  await repo().publish(role.id)
  await repo().setEnabled(role.id, true)

  return { userId: user.id, groupId: group.id, roleId: role.id }
}

/**
 * One group wanted by TWO independently-published, independently-enabled
 * roles keyed on different fields — one on `jobTitle`, one on `location` —
 * so a test can break either role's condition without touching the other's.
 * The seeded user matches BOTH roles' conditions at creation time.
 *
 * Both conditions target values UNIQUE to this call (`Account Executive
 * #<seq>` / `London #<seq>`), for the identical reason `seedRoleGrantingGroup`
 * does: this file's tests share one un-truncated database, so a shared
 * literal would let this call's roles match every OTHER seeded user whose
 * jobTitle/location happens to equal it, and vice versa.
 */
async function seedTwoRolesOneGroup(ctx: TestDatabase): Promise<{ userId: string; groupId: string }> {
  reconcilerFixtureSeq += 1
  const seq = reconcilerFixtureSeq
  const matchingJobTitle = `Account Executive #${seq}`
  const matchingLocation = `London #${seq}`
  const organizationId = await masterOrgId(ctx)

  const [unit] = await ctx.db
    .insert(orgUnits)
    .values({ name: `Reconciler Unit ${seq}`, path: `reconciler_root_${seq}`, organizationId })
    .returning()
  const [user] = await ctx.db
    .insert(users)
    .values({
      status: 'active',
      organizationId,
      primaryEmail: `reconciler-fixture-${seq}@example.com`,
      username: `reconciler-fixture-${seq}`,
      firstName: 'Fixture',
      lastName: `User ${seq}`,
      displayName: `Fixture User ${seq}`,
      jobTitle: matchingJobTitle,
      location: matchingLocation,
      orgUnitId: unit.id,
    })
    .returning()
  const [group] = await ctx.db.insert(groups).values({ name: `Reconciler Group ${seq}`, organizationId }).returning()

  const roleA = await repo().create({ name: `Reconciler Role ${seq}a`, description: null })
  const definitionA = {
    conditions: [{ field: 'jobTitle', operator: 'equals', value: matchingJobTitle }],
    grants: [{ kind: 'group_membership', groupId: group.id, target: null }],
  }
  await repo().saveDraft(roleA.id, definitionA)
  await repo().recordSimulation(roleA.id, hashDefinition(parseDefinition(definitionA)), 0)
  await repo().publish(roleA.id)
  await repo().setEnabled(roleA.id, true)

  const roleB = await repo().create({ name: `Reconciler Role ${seq}b`, description: null })
  const definitionB = {
    conditions: [{ field: 'location', operator: 'equals', value: matchingLocation }],
    grants: [{ kind: 'group_membership', groupId: group.id, target: null }],
  }
  await repo().saveDraft(roleB.id, definitionB)
  await repo().recordSimulation(roleB.id, hashDefinition(parseDefinition(definitionB)), 0)
  await repo().publish(roleB.id)
  await repo().setEnabled(roleB.id, true)

  return { userId: user.id, groupId: group.id }
}

/** Every `group_user_members` row for this user, whatever its source. */
async function membershipsFor(ctx: TestDatabase, userId: string) {
  return ctx.db.select().from(groupUserMembers).where(eq(groupUserMembers.userId, userId))
}

/** Every audit row RoleReconciler itself wrote for this user. */
async function auditRowsFor(ctx: TestDatabase, userId: string) {
  return ctx.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.resourceType, 'user'),
        eq(auditLog.resourceId, userId),
        eq(auditLog.action, 'business_role.reconcile'),
      ),
    )
}

describe('draft canonicalisation (Milestone 17, Task 7)', () => {
  it('hashes equal definitions equally regardless of key or member order', () => {
    const a = parseDefinition({
      conditions: [
        { field: 'jobTitle', operator: 'equals', value: 'AE' },
        { field: 'location', operator: 'equals', value: 'London' },
      ],
      grants: [],
    })
    const b = parseDefinition({
      conditions: [
        { operator: 'equals', value: 'London', field: 'location' },
        { value: 'AE', field: 'jobTitle', operator: 'equals' },
      ],
      grants: [],
    })

    expect(hashDefinition(a)).toBe(hashDefinition(b))
  })

  it('hashes different definitions differently', () => {
    const a = parseDefinition({ conditions: [{ field: 'jobTitle', operator: 'equals', value: 'AE' }], grants: [] })
    const b = parseDefinition({ conditions: [{ field: 'jobTitle', operator: 'equals', value: 'SDR' }], grants: [] })

    expect(hashDefinition(a)).not.toBe(hashDefinition(b))
  })

  it('rejects an operator outside the closed set', () => {
    expect(() =>
      parseDefinition({ conditions: [{ field: 'jobTitle', operator: 'matches', value: 'x' }], grants: [] }),
    ).toThrow()
  })

  it('rejects a grant whose kind does not match its reference', () => {
    expect(() =>
      parseDefinition({ conditions: [], grants: [{ kind: 'group_membership', groupId: null, target: 'keycloak' }] }),
    ).toThrow()
  })
})

describe('the publish gate (Milestone 17, Task 7)', () => {
  it('a saved draft changes nothing about the published definition', async () => {
    const role = await repo().create({ name: 'Draft only', description: null })

    await repo().saveDraft(role.id, DEFINITION)

    const published = await repo().findById(role.id)
    expect(published?.conditions).toEqual([])
    expect(published?.grants).toEqual([])
    expect(published?.draftDefinition).not.toBeNull()
  })

  it('publish refuses when the draft was never simulated', async () => {
    const role = await repo().create({ name: 'Never simulated', description: null })
    await repo().saveDraft(role.id, DEFINITION)

    await expect(repo().publish(role.id)).rejects.toThrow(/simulat/i)
  })

  it('publish refuses when the draft changed after simulation', async () => {
    const role = await repo().create({ name: 'Edited after simulation', description: null })
    await repo().saveDraft(role.id, DEFINITION)
    await repo().recordSimulation(role.id, hashDefinition(parseDefinition(DEFINITION)), 0)

    // Simulate something harmless, then try to ship something sweeping.
    await repo().saveDraft(role.id, {
      conditions: [{ field: 'status', operator: 'equals', value: 'active' }],
      grants: [{ kind: 'target_account', groupId: null, target: 'keycloak' }],
    })

    await expect(repo().publish(role.id)).rejects.toThrow(/simulat/i)
  })

  it('publish copies the draft down and clears it', async () => {
    const role = await repo().create({ name: 'Publishable', description: null })
    await repo().saveDraft(role.id, DEFINITION)
    await repo().recordSimulation(role.id, hashDefinition(parseDefinition(DEFINITION)), 0)

    await repo().publish(role.id)

    const published = await repo().findById(role.id)
    expect(published?.conditions).toEqual([
      expect.objectContaining({ field: 'jobTitle', operator: 'equals', value: 'Account Executive' }),
    ])
    expect(published?.grants).toEqual([expect.objectContaining({ kind: 'target_account', target: 'keycloak' })])
    expect(published?.draftDefinition).toBeNull()
    expect(published?.simulatedDraftHash).toBeNull()
  })

  it('publish refuses when a recorded simulation hash does not match the current draft', async () => {
    const role = await repo().create({ name: 'Stale simulation hash', description: null })
    await repo().saveDraft(role.id, DEFINITION)
    // A hash for a DIFFERENT definition — the state a race between simulate and
    // saveDraft would leave behind. This is the only path that reaches publish's
    // hash comparison with a non-null stored hash, so it is the only thing that
    // proves the second mechanism is load-bearing.
    await repo().recordSimulation(role.id, hashDefinition(parseDefinition({
      conditions: [{ field: 'status', operator: 'equals', value: 'active' }],
      grants: [],
    })), 0)

    await expect(repo().publish(role.id)).rejects.toThrow(/simulat/i)
  })

  it('listEnabledForEvaluation returns only enabled roles, with their published definitions', async () => {
    const on = await repo().create({ name: 'Enabled role', description: null })
    await repo().saveDraft(on.id, DEFINITION)
    await repo().recordSimulation(on.id, hashDefinition(parseDefinition(DEFINITION)), 0)
    await repo().publish(on.id)
    await repo().setEnabled(on.id, true)

    const off = await repo().create({ name: 'Disabled role', description: null })
    await repo().saveDraft(off.id, DEFINITION)
    await repo().recordSimulation(off.id, hashDefinition(parseDefinition(DEFINITION)), 0)
    await repo().publish(off.id)

    // Scoped to the role's own organization since Task 5 of the
    // organizations milestone; `create` puts every role in master.
    const roles = await repo().listEnabledForEvaluation(on.organizationId)

    expect(roles.map((r) => r.id)).toEqual([on.id])
    expect(roles[0].grants).toEqual([expect.objectContaining({ target: 'keycloak' })])
  })
})

/**
 * Milestone 8 (attribute-definitions write path), Task 5b — the publish-side
 * half of the `selfEditable` invariant.
 *
 * Task 5 refuses `selfEditable` on an attribute a PUBLISHED formula already
 * names (`AttributeDefinitionsRepository.assertNoFormulaDependsOn`). That
 * guard reads `business_role_conditions`, which holds published rows only, so
 * two orderings walk straight past it: draft the condition first and mark the
 * attribute self-editable while nothing published names it, or mark it
 * self-editable first and publish a referencing role afterwards. Either way
 * the system ends up with a self-editable attribute deciding role membership
 * — the exact escalation route Task 5 exists to remove.
 *
 * Publication is the moment a condition becomes live, so the mirror check
 * belongs in `publishWithin`. Together the two refusals close the invariant
 * from both directions.
 *
 * Per-call unique attribute keys and role names for the reason the fixtures
 * above already give: `withTestDatabase()` starts ONE container per FILE with
 * no truncation between `it` blocks, so a shared literal would let one test's
 * role name another test's attribute.
 */
describe('the publish gate refuses a formula keyed on a self-editable attribute (Milestone 8, Task 5b)', () => {
  function uniqueKey(): string {
    return `attr_${randomUUID().replace(/-/g, '_')}`.slice(0, 40)
  }

  async function seedAttribute(over: {
    key: string
    selfEditable?: boolean
    appliesTo?: 'user' | 'group'
  }): Promise<{ id: string }> {
    const [row] = await ctx.db
      .insert(attributeDefinitions)
      .values({
        key: over.key,
        label: 'Seeded for the publish gate',
        dataType: 'string',
        appliesTo: over.appliesTo ?? 'user',
        selfEditable: over.selfEditable ?? false,
      })
      .returning({ id: attributeDefinitions.id })
    return row
  }

  function attributeRepo(): AttributeDefinitionsRepository {
    return new AttributeDefinitionsRepository(ctx.db)
  }

  function conditionOn(key: string): { conditions: unknown[]; grants: unknown[] } {
    return {
      conditions: [{ field: `${ATTRIBUTE_PREFIX}${key}`, operator: 'equals', value: 'yes' }],
      grants: [{ kind: 'target_account', groupId: null, target: 'keycloak' }],
    }
  }

  /** A role with `definition` drafted and simulated clean — one step short of publish. */
  async function drafted(name: string, definition: { conditions: unknown[]; grants: unknown[] }) {
    const role = await repo().create({ name: `${name} ${randomUUID()}`, description: null })
    await repo().saveDraft(role.id, definition)
    await repo().recordSimulation(role.id, hashDefinition(parseDefinition(definition)), 0)
    return role
  }

  it('refuses, naming the attribute key and the flag to clear', async () => {
    // Ordering 2 from the gap: the attribute is marked self-editable FIRST, so
    // Task 5's guard had nothing published to refuse on.
    const key = uniqueKey()
    await seedAttribute({ key, selfEditable: true })
    const role = await drafted('Keyed on self-editable', conditionOn(key))

    await expect(repo().publish(role.id)).rejects.toThrow(ConflictError)
    // The publisher holds business_role:manage but is blocked by state only an
    // attribute:manage holder can change, so the message has to name the key
    // AND the flag — otherwise they cannot act on it or even tell who to ask.
    await expect(repo().publish(role.id)).rejects.toThrow(new RegExp(key))
    await expect(repo().publish(role.id)).rejects.toThrow(/selfEditable/)
  })

  it('leaves the published definition untouched when it refuses', async () => {
    // The check sits BEFORE the child-row deletes, the posture the SoD refusal
    // a few lines above already argues for: a refused publish must not have
    // half-replaced the live formula.
    const key = uniqueKey()
    await seedAttribute({ key, selfEditable: true })
    const role = await repo().create({ name: `Refused mid-publish ${randomUUID()}`, description: null })
    await repo().saveDraft(role.id, DEFINITION)
    await repo().recordSimulation(role.id, hashDefinition(parseDefinition(DEFINITION)), 0)
    await repo().publish(role.id)

    const escalating = conditionOn(key)
    await repo().saveDraft(role.id, escalating)
    await repo().recordSimulation(role.id, hashDefinition(parseDefinition(escalating)), 0)
    await expect(repo().publish(role.id)).rejects.toThrow(ConflictError)

    const after = await repo().findById(role.id)
    expect(after?.conditions).toEqual([
      expect.objectContaining({ field: 'jobTitle', operator: 'equals', value: 'Account Executive' }),
    ])
    expect(after?.draftDefinition).not.toBeNull()
  })

  it('publishes a formula keyed on an admin-only attribute', async () => {
    const key = uniqueKey()
    await seedAttribute({ key, selfEditable: false })
    const role = await drafted('Keyed on admin-only', conditionOn(key))

    await repo().publish(role.id)

    const published = await repo().findById(role.id)
    expect(published?.conditions).toEqual([
      expect.objectContaining({ field: `${ATTRIBUTE_PREFIX}${key}`, operator: 'equals', value: 'yes' }),
    ])
  })

  it('publishes a formula that names no attribute at all', async () => {
    const role = await drafted('Names no attribute', DEFINITION)

    await repo().publish(role.id)

    expect((await repo().findById(role.id))?.draftDefinition).toBeNull()
  })

  it('publishes once the attribute has been made admin-only again, because the check reads live state', async () => {
    // Self-editability is not a property of the draft, so this cannot ride the
    // `simulated_*` columns: the same unchanged, already-simulated draft has to
    // go from refused to publishable on a change made outside it.
    const key = uniqueKey()
    await seedAttribute({ key, selfEditable: true })
    const role = await drafted('Self-editable then revoked', conditionOn(key))

    await expect(repo().publish(role.id)).rejects.toThrow(ConflictError)

    await ctx.db
      .update(attributeDefinitions)
      .set({ selfEditable: false })
      .where(eq(attributeDefinitions.key, key))

    await repo().publish(role.id)

    expect((await repo().findById(role.id))?.draftDefinition).toBeNull()
  })

  it('ignores a self-editable GROUP-scoped definition sharing the key', async () => {
    // A condition reads `EvaluableUser.attributes`, so a group-scoped
    // definition is never an input to any formula. `(key, applies_to)`
    // uniqueness means the same key legitimately names both rows, and refusing
    // on the group one would be pure over-refusal.
    const key = uniqueKey()
    await seedAttribute({ key, selfEditable: false, appliesTo: 'user' })
    await seedAttribute({ key, selfEditable: true, appliesTo: 'group' })
    const role = await drafted('Group-scoped namesake', conditionOn(key))

    await repo().publish(role.id)

    expect((await repo().findById(role.id))?.draftDefinition).toBeNull()
  })

  it('does not refuse on a longer key that merely starts with a self-editable one', async () => {
    // `attributes.cost_centre_band` is a different attribute from
    // `cost_centre` — the same prefix-versus-label trap Task 5's exact match
    // avoids, restated here because this side SLICES the prefix off rather
    // than concatenating it on.
    const base = uniqueKey()
    await seedAttribute({ key: base, selfEditable: true })
    await seedAttribute({ key: `${base}_band`, selfEditable: false })
    const role = await drafted('Longer namesake', conditionOn(`${base}_band`))

    await repo().publish(role.id)

    expect((await repo().findById(role.id))?.draftDefinition).toBeNull()
  })

  it('names every self-editable attribute the draft depends on, not just the first', async () => {
    const first = uniqueKey()
    const second = uniqueKey()
    await seedAttribute({ key: first, selfEditable: true })
    await seedAttribute({ key: second, selfEditable: true })
    const role = await drafted('Two self-editable keys', {
      conditions: [
        { field: `${ATTRIBUTE_PREFIX}${first}`, operator: 'equals', value: 'yes' },
        { field: `${ATTRIBUTE_PREFIX}${second}`, operator: 'equals', value: 'yes' },
      ],
      grants: [],
    })

    await expect(repo().publish(role.id)).rejects.toThrow(new RegExp(first))
    await expect(repo().publish(role.id)).rejects.toThrow(new RegExp(second))
  })

  it('refuses after the draft-first ordering: condition drafted, THEN the attribute made self-editable', async () => {
    // THE ordering this task exists for, walked end to end across BOTH
    // repositories. Task 5's guard reads `business_role_conditions`, so while
    // the condition is only a draft it sees nothing and correctly permits the
    // patch; the refusal has to come from the publish side or not at all.
    // Neither half is exercised by seeding `self_editable = true` up front,
    // which is why this test drives `AttributeDefinitionsRepository` for real.
    const key = uniqueKey()
    const { id: definitionId } = await seedAttribute({ key, selfEditable: false })
    const role = await drafted('Draft-first ordering', conditionOn(key))

    // Permitted, and that is correct: nothing published names this attribute.
    const patched = await ctx.db.transaction((tx) =>
      attributeRepo().updateSafeFields(tx, definitionId, { selfEditable: true }),
    )
    expect(patched.selfEditable).toBe(true)

    await expect(repo().publish(role.id)).rejects.toThrow(ConflictError)
    await expect(repo().publish(role.id)).rejects.toThrow(new RegExp(key))
  })

  it('publishes a condition on a bare `attributes.` with no key after it', async () => {
    // `field.slice(ATTRIBUTE_PREFIX.length)` yields '' here, which is not an
    // attribute name — `extractField` (role-evaluator.ts) treats a bare
    // `attributes.` as an unknown field rather than an attribute named ''.
    // The gate drops it before it can reach the lock or the `key IN (...)`
    // predicate. Pins the boundary: no throw, no refusal, publish proceeds.
    const role = await drafted('Bare attributes prefix', {
      conditions: [{ field: ATTRIBUTE_PREFIX, operator: 'equals', value: 'yes' }],
      grants: [],
    })

    await repo().publish(role.id)

    expect((await repo().findById(role.id))?.draftDefinition).toBeNull()
  })

  it('refuses a selfEditable patch racing an in-flight publish (write skew, existing row)', async () => {
    // Both halves of the invariant can pass on their own connection and still
    // land the escalation: nothing sets an isolation level, so both run READ
    // COMMITTED, and before Task 5b's fix round the two lock sets were
    // DISJOINT — publish locked `business_roles` and read
    // `attribute_definitions` unlocked, while `updateSafeFields` locked the
    // `attribute_definitions` row and read `business_role_conditions`
    // unlocked. Neither blocked the other. This test held both transactions
    // open at once and observed the role published with `self_editable = true`.
    //
    // What closes it is publish taking `FOR UPDATE` on the definition rows its
    // draft names — including the ones currently `false`, which is why
    // `selfEditable` is filtered in memory rather than in the WHERE.
    const key = uniqueKey()
    const { id: definitionId } = await seedAttribute({ key, selfEditable: false })
    const role = await drafted('Racing patch', conditionOn(key))

    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let pastTheGate!: () => void
    const reachedHold = new Promise<void>((resolve) => {
      pastTheGate = resolve
    })

    // `publishWithin` on a transaction this test controls, so the publish can
    // be parked AFTER its gate and BEFORE its commit — the exact window.
    const publishing = ctx.db.transaction(async (tx) => {
      await repo().publishWithin(tx, role.id)
      pastTheGate()
      await held
    })
    await reachedHold

    const patching = ctx.db
      .transaction((tx) => attributeRepo().updateSafeFields(tx, definitionId, { selfEditable: true }))
      .then(() => 'granted' as const)
      .catch((error: Error) => error)

    // The lock makes the ordering deterministic on its own; this wait is what
    // keeps the test NON-VACUOUS. Remove the lock and the patch commits inside
    // it, which is what the assertions below then catch.
    await new Promise((resolve) => setTimeout(resolve, 400))
    release()
    await publishing

    expect(await patching).toBeInstanceOf(ConflictError)

    const [after] = await ctx.db
      .select({ selfEditable: attributeDefinitions.selfEditable })
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.id, definitionId))
    expect(after.selfEditable).toBe(false)
  })

  it('refuses a create racing an in-flight publish (write skew, absent row)', async () => {
    // The same race one step earlier, where `FOR UPDATE` cannot help: the
    // definition does not exist when publish runs its gate, so there is no row
    // for either side to lock. `attributeKeyLock` (advisory, keyed on the
    // attribute key) is what covers an absent row.
    //
    // `create` runs inside a transaction because that is the advisory lock's
    // precondition — on a pooled handle the lock is released at the end of its
    // own statement and serialises nothing. It is no longer possible to get
    // that wrong: `create` takes `DbHandle`, so the pooled handle is a compile
    // error rather than a call that quietly protects nothing.
    const key = uniqueKey()
    const role = await drafted('Racing create', conditionOn(key))

    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let pastTheGate!: () => void
    const reachedHold = new Promise<void>((resolve) => {
      pastTheGate = resolve
    })

    const publishing = ctx.db.transaction(async (tx) => {
      await repo().publishWithin(tx, role.id)
      pastTheGate()
      await held
    })
    await reachedHold

    const creating = ctx.db
      .transaction((tx) =>
        attributeRepo().create(tx, {
          key,
          label: 'Raced into existence',
          dataType: 'string',
          appliesTo: 'user',
          selfEditable: true,
        }),
      )
      .then(() => 'granted' as const)
      .catch((error: Error) => error)

    await new Promise((resolve) => setTimeout(resolve, 400))
    release()
    await publishing

    expect(await creating).toBeInstanceOf(ConflictError)

    const rows = await ctx.db
      .select({ selfEditable: attributeDefinitions.selfEditable })
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.key, key))
    expect(rows).toEqual([])
  })
})

describe('RoleReconciler (Milestone 17, Task 8)', () => {
  it('grants a matching role\'s group, marked business_role', async () => {
    const { userId, groupId, roleId } = await seedRoleGrantingGroup(ctx, { jobTitle: 'Account Executive' })

    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    const rows = await membershipsFor(ctx, userId)
    expect(rows).toEqual([expect.objectContaining({ groupId, grantSource: 'business_role' })])
    expect(roleId).toBeDefined()
  })

  it('revokes its own row when the person stops matching', async () => {
    const { userId } = await seedRoleGrantingGroup(ctx, { jobTitle: 'Account Executive' })
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    await ctx.db.update(users).set({ jobTitle: 'Manager' }).where(eq(users.id, userId))
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    expect(await membershipsFor(ctx, userId)).toEqual([])
  })

  it('NEVER revokes a manual row, even when no role justifies it', async () => {
    const { userId, groupId } = await seedRoleGrantingGroup(ctx, { jobTitle: 'Manager' })
    // organizationId is derived from the GROUP, exactly as
    // GroupsRepository.addUser and RoleReconciler do (Task 4 of the
    // organizations milestone) — the edge belongs to the group's tenant.
    await ctx.db.insert(groupUserMembers).values({
      groupId,
      userId,
      grantSource: 'manual',
      organizationId: sql`(SELECT organization_id FROM groups WHERE id = ${groupId})`,
    })

    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    expect(await membershipsFor(ctx, userId)).toEqual([
      expect.objectContaining({ groupId, grantSource: 'manual' }),
    ])
  })

  it('leaves a manual row alone even when a role also wants it, and the row survives the role ceasing to match', async () => {
    const { userId, groupId } = await seedRoleGrantingGroup(ctx, { jobTitle: 'Account Executive' })
    // organizationId is derived from the GROUP, exactly as
    // GroupsRepository.addUser and RoleReconciler do (Task 4 of the
    // organizations milestone) — the edge belongs to the group's tenant.
    await ctx.db.insert(groupUserMembers).values({
      groupId,
      userId,
      grantSource: 'manual',
      organizationId: sql`(SELECT organization_id FROM groups WHERE id = ${groupId})`,
    })

    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))
    await ctx.db.update(users).set({ jobTitle: 'Manager' }).where(eq(users.id, userId))
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    expect(await membershipsFor(ctx, userId)).toEqual([
      expect.objectContaining({ groupId, grantSource: 'manual' }),
    ])
  })

  it('re-adds a role-derived row that was removed by hand', async () => {
    const { userId, groupId } = await seedRoleGrantingGroup(ctx, { jobTitle: 'Account Executive' })
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    await ctx.db.delete(groupUserMembers).where(and(eq(groupUserMembers.userId, userId), eq(groupUserMembers.groupId, groupId)))
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    expect(await membershipsFor(ctx, userId)).toEqual([
      expect.objectContaining({ groupId, grantSource: 'business_role' }),
    ])
  })

  it('two roles justifying one group produce exactly one row, surviving one of them ceasing to match', async () => {
    const { userId, groupId } = await seedTwoRolesOneGroup(ctx)
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    expect(await membershipsFor(ctx, userId)).toHaveLength(1)

    // Break the first role's condition only.
    await ctx.db.update(users).set({ jobTitle: 'Manager' }).where(eq(users.id, userId))
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    expect(await membershipsFor(ctx, userId)).toEqual([
      expect.objectContaining({ groupId, grantSource: 'business_role' }),
    ])
  })

  it('disabling a role revokes its rows', async () => {
    const { userId, roleId } = await seedRoleGrantingGroup(ctx, { jobTitle: 'Account Executive' })
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    await new BusinessRolesRepository(ctx.db).setEnabled(roleId, false)
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    expect(await membershipsFor(ctx, userId)).toEqual([])
  })

  it('REFUSES to act when any enabled role is unevaluable — nothing granted, nothing revoked', async () => {
    const { userId, groupId, roleId } = await seedRoleGrantingGroup(ctx, { jobTitle: 'Account Executive' })
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    // A condition row naming a field the running code does not know, as a
    // migration newer than this binary would produce.
    await ctx.db.insert(businessRoleConditions).values({
      businessRoleId: roleId,
      field: 'managerId',
      operator: 'equals',
      value: 'anyone',
    })

    const outcome = await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    expect(outcome.status).toBe('refused')
    // The pre-existing grant is untouched: not revoked, not re-granted.
    expect(await membershipsFor(ctx, userId)).toEqual([
      expect.objectContaining({ groupId, grantSource: 'business_role' }),
    ])

    // Defuse the landmine before yielding to whatever test runs next in this
    // FILE (no truncation between `it`s — see withTestDatabase). Left
    // enabled, this role's unevaluable `managerId` condition would make
    // `evaluateRoles` — and therefore every later `reconcileUser` call, for
    // EVERY user, not just this one — refuse forever, per its own "one
    // unevaluable role makes the whole evaluation unevaluable" rule.
    await new BusinessRolesRepository(ctx.db).setEnabled(roleId, false)
  })

  it('writes exactly one audit row for a pass that changed something, and none for a no-op', async () => {
    const { userId } = await seedRoleGrantingGroup(ctx, { jobTitle: 'Account Executive' })

    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))
    const afterFirst = await auditRowsFor(ctx, userId)
    expect(afterFirst).toHaveLength(1)

    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))
    expect(await auditRowsFor(ctx, userId)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Fixtures for RoleReconciliationJob (Milestone 17, Task 10). Same local
// convention as the Task 8 fixtures above, and the same non-negotiable rule:
// every seeded value that a role condition can match carries a per-call
// `seq` discriminator. `withTestDatabase()` starts ONE container per test
// FILE and never truncates between `it`s, so a shared literal would let one
// call's role match another call's user — the exact mistake that once
// produced a "5 of 19 failing" reconciler.
// ---------------------------------------------------------------------------

function job(): RoleReconciliationJob {
  return new RoleReconciliationJob(
    reconciler(),
    new UsersRepository(ctx.db),
    new BusinessRolesRepository(ctx.db),
    ctx.db,
  )
}

/**
 * A DEACTIVATED person who already holds a `business_role`-sourced row for a
 * group, and an enabled role that would grant them exactly that group if only
 * they were still active (`jobTitle = <unique>` AND `status = 'active'`).
 *
 * The pre-existing row is what makes the test meaningful. Asserting that a
 * deactivated person holds nothing proves nothing on its own — they would
 * hold nothing if the sweep had never looked at them at all. Because the row
 * is there BEFORE the sweep runs, and only a pass that actually VISITS this
 * user can revoke it, its absence afterwards is direct evidence the walk
 * covered a non-active status. That is a real leaver scenario, not a
 * contrived one: this is precisely the row a departed employee would keep
 * forever if the sweep walked only `status = 'active'`.
 */
async function seedDeactivatedUserInRoleGroup(
  ctx: TestDatabase,
): Promise<{ deactivatedUserId: string; groupId: string; roleId: string }> {
  reconcilerFixtureSeq += 1
  const seq = reconcilerFixtureSeq
  const matchingJobTitle = `Account Executive #${seq}`
  const organizationId = await masterOrgId(ctx)

  const [unit] = await ctx.db
    .insert(orgUnits)
    .values({ name: `Sweep Unit ${seq}`, path: `sweep_root_${seq}`, organizationId })
    .returning()
  const [user] = await ctx.db
    .insert(users)
    .values({
      status: 'deactivated',
      organizationId,
      primaryEmail: `sweep-leaver-${seq}@example.com`,
      username: `sweep-leaver-${seq}`,
      firstName: 'Sweep',
      lastName: `Leaver ${seq}`,
      displayName: `Sweep Leaver ${seq}`,
      jobTitle: matchingJobTitle,
      orgUnitId: unit.id,
    })
    .returning()
  const [group] = await ctx.db.insert(groups).values({ name: `Sweep Group ${seq}`, organizationId }).returning()

  const role = await repo().create({ name: `Sweep Role ${seq}`, description: null })
  const definition = {
    conditions: [
      { field: 'jobTitle', operator: 'equals', value: matchingJobTitle },
      { field: 'status', operator: 'equals', value: 'active' },
    ],
    grants: [{ kind: 'group_membership', groupId: group.id, target: null }],
  }
  await repo().saveDraft(role.id, definition)
  await repo().recordSimulation(role.id, hashDefinition(parseDefinition(definition)), 0)
  await repo().publish(role.id)
  await repo().setEnabled(role.id, true)

  // The row a sweep that skips non-active users would leave behind forever.
  await ctx.db.insert(groupUserMembers).values({
    groupId: group.id,
    userId: user.id,
    grantSource: 'business_role',
    organizationId: sql`(SELECT organization_id FROM groups WHERE id = ${group.id})`,
  })

  return { deactivatedUserId: user.id, groupId: group.id, roleId: role.id }
}

/**
 * An enabled, published role carrying a condition on a field the running
 * binary does not know — the shape a migration newer than this build would
 * leave behind. Inserted straight into `business_role_conditions` AFTER
 * publish, exactly as the Task 8 refusal test does, because `parseDefinition`
 * would (correctly) reject it on the way in through the draft.
 *
 * This is a LANDMINE for every later test in this file: one unevaluable
 * enabled role makes `evaluateRoles` refuse for EVERY user, not just one. Any
 * test using it must disable the role before it returns.
 */
async function seedUnevaluableRole(ctx: TestDatabase): Promise<{ roleId: string }> {
  reconcilerFixtureSeq += 1
  const seq = reconcilerFixtureSeq

  const role = await repo().create({ name: `Unevaluable Role ${seq}`, description: null })
  const definition = {
    conditions: [{ field: 'jobTitle', operator: 'equals', value: `Nobody At All #${seq}` }],
    grants: [],
  }
  await repo().saveDraft(role.id, definition)
  await repo().recordSimulation(role.id, hashDefinition(parseDefinition(definition)), 0)
  await repo().publish(role.id)
  await repo().setEnabled(role.id, true)

  await ctx.db.insert(businessRoleConditions).values({
    businessRoleId: role.id,
    field: 'managerId',
    operator: 'equals',
    value: 'anyone',
  })

  return { roleId: role.id }
}

describe('RoleReconciliationJob (Milestone 17, Task 10)', () => {
  it('walks EVERY user status, not only active', async () => {
    // Mirrors ReconciliationJob and TargetReconciliationJob, which walk every
    // status for the same reason: a suspended person's DESIRED state is still
    // a fact the engine must be able to assert.
    const { deactivatedUserId, groupId } = await seedDeactivatedUserInRoleGroup(ctx)

    const result = await job().reconcileAll(new Date())

    expect(result.scanned).toBeGreaterThan(0)
    // The role conditions on status = 'active', so the deactivated person
    // must have been visited AND found not to qualify — which, because the
    // fixture pre-seeded a business_role row for them, means the row is gone.
    expect(await membershipsFor(ctx, deactivatedUserId)).toEqual([])
    expect(groupId).toBeDefined()
  })

  it('is idempotent — a second run changes nothing', async () => {
    await seedRoleGrantingGroup(ctx, { jobTitle: 'Account Executive' })

    const first = await job().reconcileAll(new Date())
    const second = await job().reconcileAll(new Date())

    expect(first.changed).toBeGreaterThan(0)
    expect(second.changed).toBe(0)
    // Nothing refused either way: a refusal would make `changed: 0` true for
    // an entirely uninteresting reason.
    expect(first.refused).toBe(0)
    expect(second.refused).toBe(0)
  })

  it('counts a refusal without aborting the whole sweep', async () => {
    const { userId, groupId } = await seedRoleGrantingGroup(ctx, { jobTitle: 'Account Executive' })
    // Settle this user's entitlements BEFORE the landmine goes in, so the
    // assertion below distinguishes "refused, therefore untouched" from
    // "never had anything anyway".
    await job().reconcileAll(new Date())
    const { roleId } = await seedUnevaluableRole(ctx)

    const result = await job().reconcileAll(new Date())

    expect(result.refused).toBeGreaterThan(0)
    expect(roleId).toBeDefined()

    // The sweep RAN to completion rather than throwing: every user was still
    // visited and counted...
    expect(result.scanned).toBeGreaterThan(result.refused - 1)
    expect(result.scanned).toBeGreaterThan(0)
    // ...it refused for everybody, naming the offending role and its reason
    // rather than silently swallowing it...
    expect(result.refusals).toHaveLength(result.refused)
    expect(result.refusals[0]).toEqual(
      expect.objectContaining({ roleId, roleName: expect.stringContaining('Unevaluable Role') }),
    )
    expect(result.refusals[0].reason).toBeTruthy()
    // ...and wrote NOTHING while refusing — the pre-existing grant survives,
    // neither revoked nor re-granted.
    expect(result.changed).toBe(0)
    expect(await membershipsFor(ctx, userId)).toEqual([
      expect.objectContaining({ groupId, grantSource: 'business_role' }),
    ])

    // Defuse the landmine before yielding to whatever test runs next in this
    // FILE — see the Task 8 refusal test's identical epilogue.
    await new BusinessRolesRepository(ctx.db).setEnabled(roleId, false)
  })

  it('reconcileRole walks every user too, and rejects an unknown role id', async () => {
    // The narrowing is in the LABEL, not the work (see reconcileRole's own
    // doc comment): a role-scoped sweep must scan exactly what a full sweep
    // scans, because `reconcileUser` evaluates every enabled role at once.
    const { roleId } = await seedRoleGrantingGroup(ctx, { jobTitle: 'Account Executive' })

    const all = await job().reconcileAll(new Date())
    const scoped = await job().reconcileRole(roleId, new Date())

    expect(scoped.scanned).toBe(all.scanned)
    expect(scoped.changed).toBe(0)

    await expect(job().reconcileRole('00000000-0000-0000-0000-000000000000', new Date())).rejects.toThrow()
  })

  /**
   * Regression guard for a read shape that had narrowed away a NOT NULL
   * column. `reason` is required on every exception write precisely because
   * an unexplained exception is what a later recertification campaign cannot
   * act on -- and `loadDefinition` used to map the row down to
   * `{ userId, mode, expiresAt }`, which made that mandatory justification
   * unreadable through `GET /business-roles/:id`, the only route that
   * returns exceptions at all. A field the system insists on collecting and
   * then cannot show is a field collected for nobody.
   *
   * Asserts BOTH halves: the written justification comes back, AND the row
   * is still structurally a `RoleException` (mode/expiresAt intact), because
   * the evaluator reads these same objects and widening them must not have
   * cost it anything.
   */
  it('an exception written with a reason reads back with it', async () => {
    const { roleId, userId } = await seedRoleGrantingGroup(ctx, { jobTitle: 'Account Executive' })
    const expiresAt = new Date('2027-01-01T09:00:00.000Z')

    const { row } = await repo().upsertException(ctx.db, {
      businessRoleId: roleId,
      userId,
      mode: 'exclude',
      reason: 'Contractor — access handled by the vendor agreement, not this role.',
      expiresAt,
      grantedBy: userId,
    })
    expect(row.reason).toBe('Contractor — access handled by the vendor agreement, not this role.')

    const role = await repo().findById(roleId)
    expect(role).not.toBeNull()
    expect(role?.exceptions).toEqual([
      expect.objectContaining({
        userId,
        mode: 'exclude',
        reason: 'Contractor — access handled by the vendor agreement, not this role.',
        grantedBy: userId,
        expiresAt,
      }),
    ])
    // `createdAt` is what lets the console say WHEN somebody decided this,
    // beside WHO — both halves of a reviewable exception.
    expect(role?.exceptions[0].createdAt).toBeInstanceOf(Date)

    // An enabled role left behind by the fixture is a landmine for whatever
    // test runs next in this un-truncated file — same epilogue as the
    // refusal tests above.
    await repo().setEnabled(roleId, false)
  })
})
