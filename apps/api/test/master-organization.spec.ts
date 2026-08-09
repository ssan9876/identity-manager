import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { organizations } from '../src/db/schema/organizations'
import { adoptMasterRealm, realmFromIssuer } from '../src/organizations/master-organization'
import { withTestDatabase } from './support/pg'

const ctx = withTestDatabase()

/**
 * Milestone: organizations multi-tenancy, Task 6 — master adoption at
 * startup.
 *
 * Against a REAL database, not a stubbed `db`: what is under test is a
 * read-then-conditionally-write against a row created by a MIGRATION, so a
 * fake would be asserting against this test's own idea of what 0025 left
 * behind rather than against what it actually left behind.
 *
 * `withTestDatabase()` starts one container per FILE and never truncates
 * between `it` blocks, and there is exactly ONE master row in it
 * (`organizations_master_unique`) which every case here shares. The blocks
 * are therefore written to be order-independent in the only way available:
 * each one resets `realm` to its post-migration value (NULL) first, so a
 * prior block's successful adoption cannot decide this block's outcome.
 */
const ISSUER = 'http://localhost:8080/realms/identity-manager'

async function resetMasterRealm(): Promise<void> {
  await ctx.db
    .update(organizations)
    .set({ realm: null })
    .where(eq(organizations.isMaster, true))
}

async function masterRealm(): Promise<string | null> {
  const [row] = await ctx.db.select().from(organizations).where(eq(organizations.isMaster, true))
  return row.realm
}

describe('realmFromIssuer', () => {
  it('takes the realm out of an issuer URL', () => {
    expect(realmFromIssuer(ISSUER)).toBe('identity-manager')
  })

  it('rejects a URL with no realm segment', () => {
    expect(() => realmFromIssuer('http://localhost:8080/')).toThrow(/\/realms\//)
  })

  it('ignores a query string and a fragment', () => {
    // Parsed from origin + pathname, never the raw string — otherwise a
    // stray `?` or `#` would silently become part of the realm name and
    // bind master to a realm that does not exist.
    expect(realmFromIssuer('https://sso.example.com/realms/acme?x=y#z')).toBe('acme')
  })
})

describe('adoptMasterRealm', () => {
  it('fills in the realm on first run', async () => {
    await resetMasterRealm()
    expect(await masterRealm()).toBeNull()

    await adoptMasterRealm(ctx.db, ISSUER)

    expect(await masterRealm()).toBe('identity-manager')
  })

  it('is idempotent', async () => {
    await resetMasterRealm()
    await adoptMasterRealm(ctx.db, ISSUER)

    // The second call must be a no-op, not a second write: this runs on
    // EVERY process start, including every instance of a rolling deploy.
    await expect(adoptMasterRealm(ctx.db, ISSUER)).resolves.toBeUndefined()
    expect(await masterRealm()).toBe('identity-manager')
  })

  it('refuses to start when the issuer names a different realm', async () => {
    await resetMasterRealm()
    await adoptMasterRealm(ctx.db, ISSUER)

    await expect(
      adoptMasterRealm(ctx.db, 'http://localhost:8080/realms/something-else'),
    ).rejects.toThrow(/would re-point/)

    // And it left the row alone. A refusal that had already written would
    // be worse than no check at all.
    expect(await masterRealm()).toBe('identity-manager')
  })

  it('refuses an issuer with no realm segment before touching the row', async () => {
    await resetMasterRealm()

    await expect(adoptMasterRealm(ctx.db, 'http://localhost:8080/')).rejects.toThrow(/\/realms\//)

    expect(await masterRealm()).toBeNull()
  })
})
