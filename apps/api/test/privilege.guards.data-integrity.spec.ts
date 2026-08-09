import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { describe, expect, it } from 'vitest'
import { PrivilegeGuards } from '../src/authz/privilege.guards'
import type { Actor } from '../src/authz/permission.engine'
import { DataIntegrityError, DomainError } from '../src/common/errors'
import type * as schema from '../src/db/schema/index'

/**
 * Finding AUTHZ-L-4 (docs/archive/audits/audit-authz.md, carried as an
 * Item-10 residual in carried-findings-verification.md):
 * `assertCanModifyPrincipal` throws when a target principal holds a
 * `role_key` that is a legal value of the Postgres enum but absent from this
 * build's static `ROLE_RANK` catalog. It always failed closed; what it did
 * not do was say so in any way an operator could act on — a plain `Error`
 * falls through `DomainExceptionFilter` (`@Catch(DomainError)`) to Nest's
 * default handler and becomes a bodyless 500, on a principal who is by then
 * permanently unmodifiable through the API.
 *
 * WHY THIS SUITE IS STUBBED AND NOT CONTAINER-BACKED, unlike its sibling
 * `privilege.guards.spec.ts`. The state under test cannot be reached through
 * the schema: `role_assignments.role_key` is an enum, so no INSERT can put an
 * unrecognised value there. The audit reproduced it by running `ALTER TYPE
 * role_key ADD VALUE 'ghost'` against a live database — an irreversible DDL
 * change (Postgres cannot drop an enum label) that would leak into every
 * other test sharing that container, for a fault whose entire surface is one
 * `reduce` over rows the method has already read. Stubbing the read is the
 * honest boundary: this suite owns "what happens to a row that says
 * 'ghost'", and privilege.guards.spec.ts owns everything that needs a real
 * database.
 *
 * The stub mimics exactly the shape the method uses —
 * `db.select({...}).from(...).where(...)` awaited as a promise of rows — and
 * nothing else, so it cannot accidentally satisfy a different query if this
 * method is rewritten.
 */
function dbReturning(roleKeys: readonly string[]): NodePgDatabase<typeof schema> {
  return {
    select: () => ({
      from: () => ({
        where: async () => roleKeys.map((roleKey) => ({ roleKey })),
      }),
    }),
  } as unknown as NodePgDatabase<typeof schema>
}

const ACTOR: Actor = {
  userId: 'actor-1',
  username: 'actor',
  orgUnitId: 'org-1',
  // Global super_admin: the HIGHEST rank there is. Deliberate — it makes the
  // rank comparison at the end of the method one this actor would win
  // against any real role, so a test that reaches that comparison passes.
  // The throw therefore cannot be mistaken for an ordinary "outranked"
  // refusal; it can only come from the unrecognised key.
  assignments: [{ roleKey: 'super_admin', scopeOrgUnitId: null, scopePath: null }],
}

describe('PrivilegeGuards.assertCanModifyPrincipal — unrecognised role_key (AUTHZ-L-4)', () => {
  it('refuses, rather than reading the unknown key as "holds no privilege"', async () => {
    const guards = new PrivilegeGuards(dbReturning(['ghost']))

    await expect(guards.assertCanModifyPrincipal(ACTOR, 'target-1')).rejects.toThrow()
  })

  it('throws a DomainError, so the response is mapped rather than a bodyless 500', async () => {
    const guards = new PrivilegeGuards(dbReturning(['ghost']))

    // The regression assertion. Pre-fix this was a plain `Error`, which is
    // NOT a DomainError, which is exactly why DomainExceptionFilter did not
    // touch it and the caller got a 500 with no body at all.
    await expect(guards.assertCanModifyPrincipal(ACTOR, 'target-1')).rejects.toBeInstanceOf(
      DomainError,
    )
    await expect(guards.assertCanModifyPrincipal(ACTOR, 'target-1')).rejects.toBeInstanceOf(
      DataIntegrityError,
    )
  })

  it('names the offending key, so the fault is triageable', async () => {
    const guards = new PrivilegeGuards(dbReturning(['ghost']))

    await expect(guards.assertCanModifyPrincipal(ACTOR, 'target-1')).rejects.toThrow(/ghost/)
  })

  it('refuses on an inherited Object.prototype name too, not only an invented one', async () => {
    // Finding I-1 round 2's shape, re-asserted from this angle: `'constructor'
    // in ROLE_RANK` is true on an ordinary object even though it is not an
    // OWN property. `Object.hasOwn` is what makes this throw rather than
    // silently reading a Function into Math.max and producing NaN.
    const guards = new PrivilegeGuards(dbReturning(['constructor']))

    await expect(guards.assertCanModifyPrincipal(ACTOR, 'target-1')).rejects.toBeInstanceOf(
      DataIntegrityError,
    )
  })

  it('still permits an ordinary recognised assignment — the guard did not become fail-always', async () => {
    const guards = new PrivilegeGuards(dbReturning(['read_only']))

    await expect(guards.assertCanModifyPrincipal(ACTOR, 'target-1')).resolves.toBeUndefined()
  })

  it('refuses a target holding a recognised key ALONGSIDE an unrecognised one', async () => {
    // The dangerous ordering: a real, low-ranked role first, so a reduce that
    // merely skipped the unknown entry would compute a satisfiable rank and
    // let the write through.
    const guards = new PrivilegeGuards(dbReturning(['read_only', 'ghost']))

    await expect(guards.assertCanModifyPrincipal(ACTOR, 'target-1')).rejects.toBeInstanceOf(
      DataIntegrityError,
    )
  })
})
