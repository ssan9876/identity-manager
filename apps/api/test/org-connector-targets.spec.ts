import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { ConnectorRegistry } from '../src/connectors/connector-registry'
import { ConnectorTargetsRepository } from '../src/connectors/connector-targets.repository'
import { KeycloakAdminClient } from '../src/keycloak/keycloak-admin.client'
import { orgUnits } from '../src/db/schema/org-units'
import { organizations } from '../src/db/schema/organizations'
import { users } from '../src/db/schema/users'
import { OrganizationsRepository } from '../src/organizations/organizations.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { withTestDatabase } from './support/pg'

/**
 * Per-organization connector targets: `connector_targets`' identity is
 * (organization_id, target), so each organization owns its OWN catalog of
 * configured targets.
 *
 * THE ONE PROPERTY THIS FILE EXISTS TO PIN DOWN: an organization with no row
 * for a target is NOT configured for it — absence never falls back to
 * another organization's row, at the repository, at the registry, or at
 * fan-out. The fallback it forbids is not hypothetical: with the master
 * organization's Active Directory configured, a tenant event fanning out to
 * it would create real accounts, with real addresses, in somebody else's
 * estate. The fan-out tests below assert that row's ABSENCE directly.
 */
describe('per-organization connector targets', () => {
  const ctx = withTestDatabase()

  // The echo connector resolves this env var by name when a config names it
  // — set for the whole file so master's config is genuinely resolvable and
  // the tenant's missing config is the ONLY difference under test.
  const SECRET_NAME = 'CONNECTOR_ORG_CT_TEST_SECRET'
  process.env[SECRET_NAME] = 'org-ct-test-secret-value'
  afterAll(() => {
    delete process.env[SECRET_NAME]
  })

  function unreachableKeycloak(): KeycloakAdminClient {
    return new KeycloakAdminClient({
      issuer: 'http://127.0.0.1:1/realms/unreachable',
      clientId: 'irrelevant',
      clientSecret: 'irrelevant',
    })
  }

  async function masterOrgId(): Promise<string> {
    const master = await new OrganizationsRepository(ctx.db).findMaster()
    return master.id
  }

  let seq = 0

  /** A TENANT organization — plus its root org unit, so it can hold users. */
  async function insertTenant(): Promise<{ organizationId: string; rootOrgUnitId: string }> {
    seq += 1
    const slug = `oct-tenant-${seq}`
    const [organization] = await ctx.db
      .insert(organizations)
      .values({ slug, name: `Org CT Tenant ${seq}`, realm: slug })
      .returning()
    const [root] = await ctx.db
      .insert(orgUnits)
      .values({ name: `Org CT Tenant Root ${seq}`, path: `oct_tenant_root_${seq}`, organizationId: organization!.id })
      .returning()
    return { organizationId: organization!.id, rootOrgUnitId: root!.id }
  }

  async function insertUserIn(organizationId: string, orgUnitId: string): Promise<string> {
    seq += 1
    const [user] = await ctx.db
      .insert(users)
      .values({
        status: 'active',
        organizationId,
        primaryEmail: `oct-${seq}@example.com`,
        username: `oct-${seq}`,
        firstName: 'Org',
        lastName: `CT ${seq}`,
        displayName: `Org CT ${seq}`,
        orgUnitId,
      })
      .returning()
    return user!.id
  }

  async function masterRootOrgUnitId(): Promise<string> {
    seq += 1
    const [root] = await ctx.db
      .insert(orgUnits)
      .values({ name: `Org CT Master Root ${seq}`, path: `oct_master_root_${seq}`, organizationId: await masterOrgId() })
      .returning()
    return root!.id
  }

  async function targetsFor(aggregateId: string): Promise<string[]> {
    const { rows } = await ctx.pool.query<{ target: string }>(
      `SELECT target FROM outbox_events WHERE aggregate_type = 'user' AND aggregate_id = $1`,
      [aggregateId],
    )
    return rows.map((row) => row.target).sort()
  }

  describe('migration 0033 — the rekey itself', () => {
    it('backfilled the seeded keycloak row to the MASTER organization', async () => {
      const { rows } = await ctx.pool.query<{ organization_id: string }>(
        `SELECT organization_id FROM connector_targets WHERE target = 'keycloak'`,
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].organization_id).toBe(await masterOrgId())
    })

    it('an INSERT naming no organization lands in MASTER (the master_organization_id() default), never fails', async () => {
      await ctx.pool.query(`INSERT INTO connector_targets (target, enabled) VALUES ('echo', false)`)
      try {
        const { rows } = await ctx.pool.query<{ organization_id: string }>(
          `SELECT organization_id FROM connector_targets WHERE target = 'echo'`,
        )
        expect(rows).toHaveLength(1)
        expect(rows[0].organization_id).toBe(await masterOrgId())
      } finally {
        await ctx.pool.query(`DELETE FROM connector_targets WHERE target = 'echo'`)
      }
    })

    it('two organizations can hold the SAME target name — and the same organization cannot hold it twice', async () => {
      const { organizationId } = await insertTenant()
      const master = await masterOrgId()
      await ctx.pool.query(
        `INSERT INTO connector_targets (organization_id, target, enabled) VALUES ($1, 'echo', true)`,
        [organizationId],
      )
      try {
        // Same target name, different organization: a SECOND row, fine.
        await ctx.pool.query(
          `INSERT INTO connector_targets (organization_id, target, enabled) VALUES ($1, 'echo', true)`,
          [master],
        )
        // Same (organization, target) twice: the composite PK refuses.
        await expect(
          ctx.pool.query(
            `INSERT INTO connector_targets (organization_id, target, enabled) VALUES ($1, 'echo', true)`,
            [organizationId],
          ),
        ).rejects.toThrow(/connector_targets_pkey/)
      } finally {
        await ctx.pool.query(`DELETE FROM connector_targets WHERE target = 'echo'`)
      }
    })

    it('refuses a row for an organization that does not exist (FK to organizations)', async () => {
      await expect(
        ctx.pool.query(
          `INSERT INTO connector_targets (organization_id, target, enabled) VALUES ($1, 'echo', true)`,
          [randomUUID()],
        ),
      ).rejects.toThrow(/connector_targets_organization_id_organizations_id_fk/)
    })
  })

  describe('ConnectorTargetsRepository — resolution by (organization, target)', () => {
    it('each organization reads its own row; absence for one org is not_configured even when another org HAS the row', async () => {
      const repository = new ConnectorTargetsRepository(ctx.db)
      const master = await masterOrgId()
      const { organizationId: tenant } = await insertTenant()

      await ctx.db.transaction(async (tx) => {
        await repository.upsert(tx, master, 'echo', {
          enabled: true,
          config: { credentialSecretName: SECRET_NAME, flavour: 'master' },
        })
      })
      try {
        const masterRow = await repository.findOne(master, 'echo')
        expect(masterRow.configured).toBe(true)
        expect(masterRow.config.flavour).toBe('master')

        // THE no-fallback assertion, repository level: the tenant has no
        // 'echo' row, and master's existing one must not leak across.
        const tenantRow = await repository.findOne(tenant, 'echo')
        expect(tenantRow.configured).toBe(false)
        expect(tenantRow.enabled).toBe(false)
        expect(tenantRow.config).toEqual({})

        // And the tenant's own row, once written, is independent of master's.
        await ctx.db.transaction(async (tx) => {
          await repository.upsert(tx, tenant, 'echo', { enabled: false, config: { flavour: 'tenant' } })
        })
        const tenantRowAfter = await repository.findOne(tenant, 'echo')
        expect(tenantRowAfter.config).toEqual({ flavour: 'tenant' })
        const masterRowAfter = await repository.findOne(master, 'echo')
        expect(masterRowAfter.config.flavour).toBe('master')
        expect(masterRowAfter.enabled).toBe(true)
      } finally {
        await ctx.pool.query(`DELETE FROM connector_targets WHERE target = 'echo'`)
      }
    })
  })

  describe('ConnectorRegistry — per-organization config resolution', () => {
    it("resolves each organization's OWN config, and an unconfigured organization fails cleanly instead of borrowing another org's secret", async () => {
      const registry = new ConnectorRegistry(unreachableKeycloak())
      const repository = new ConnectorTargetsRepository(ctx.db)
      const master = await masterOrgId()
      const { organizationId: tenant } = await insertTenant()

      await ctx.db.transaction(async (tx) => {
        await repository.upsert(tx, master, 'echo', {
          enabled: true,
          config: { credentialSecretName: SECRET_NAME },
        })
      })
      try {
        // Master's catalog names a real, resolvable secret: healthy.
        const masterConnector = await ctx.db.transaction((tx) => registry.resolve('echo', tx, master))
        const masterHealth = await masterConnector.health()
        expect(masterHealth.ok).toBe(true)

        // The tenant has NO echo row. If resolution fell back to master's
        // config this health check would succeed — the secret is set in the
        // environment and master's row names it. It must instead fail with
        // the same clean "no secret configured" shape a globally
        // unconfigured target always produced.
        const tenantConnector = await ctx.db.transaction((tx) => registry.resolve('echo', tx, tenant))
        const tenantHealth = await tenantConnector.health()
        expect(tenantHealth.ok).toBe(false)
        expect(tenantHealth.detail).not.toContain('org-ct-test-secret-value')
      } finally {
        await ctx.pool.query(`DELETE FROM connector_targets WHERE target = 'echo'`)
      }
    })
  })

  describe('OutboxWriter.record — fan-out is governed by the AGGREGATE organization own catalog', () => {
    it("a tenant user's mutation does NOT fan out to a target only MASTER has enabled — the cross-estate account-creation bug", async () => {
      const writer = new OutboxWriter()
      const { organizationId: tenant, rootOrgUnitId } = await insertTenant()
      const tenantUserId = await insertUserIn(tenant, rootOrgUnitId)
      const masterUserId = await insertUserIn(await masterOrgId(), await masterRootOrgUnitId())

      // Master runs a real Active Directory; the tenant has ONLY keycloak.
      await ctx.pool.query(
        `INSERT INTO connector_targets (target, enabled) VALUES ('active_directory', true)
         ON CONFLICT (organization_id, target) DO UPDATE SET enabled = true`,
      )
      await ctx.pool.query(
        `INSERT INTO connector_targets (organization_id, target, enabled) VALUES ($1, 'keycloak', true)`,
        [tenant],
      )
      try {
        await ctx.db.transaction(async (tx) => {
          await writer.record(tx, {
            aggregateType: 'user',
            aggregateId: tenantUserId,
            eventType: 'created',
            payload: {},
          })
          await writer.record(tx, {
            aggregateType: 'user',
            aggregateId: masterUserId,
            eventType: 'created',
            payload: {},
          })
        })

        // The master user reaches master's whole catalog...
        expect(await targetsFor(masterUserId)).toEqual(['active_directory', 'keycloak'])
        // ...and the tenant user reaches ONLY the tenant's own catalog.
        // NO active_directory row exists for them AT ALL — not pending, not
        // failed, absent — because master's AD row is not the tenant's, and
        // fanning the tenant into it would create accounts in somebody
        // else's directory.
        expect(await targetsFor(tenantUserId)).toEqual(['keycloak'])
      } finally {
        await ctx.pool.query(`DELETE FROM connector_targets WHERE target = 'active_directory'`)
        await ctx.pool.query(`DELETE FROM connector_targets WHERE organization_id = $1`, [tenant])
      }
    })

    it("a target enabled by the TENANT alone reaches the tenant's users and nobody else's", async () => {
      const writer = new OutboxWriter()
      const { organizationId: tenant, rootOrgUnitId } = await insertTenant()
      const tenantUserId = await insertUserIn(tenant, rootOrgUnitId)
      const masterUserId = await insertUserIn(await masterOrgId(), await masterRootOrgUnitId())

      await ctx.pool.query(
        `INSERT INTO connector_targets (organization_id, target, enabled) VALUES ($1, 'keycloak', true), ($1, 'echo', true)`,
        [tenant],
      )
      try {
        await ctx.db.transaction(async (tx) => {
          await writer.record(tx, {
            aggregateType: 'user',
            aggregateId: tenantUserId,
            eventType: 'updated',
            payload: {},
          })
          await writer.record(tx, {
            aggregateType: 'user',
            aggregateId: masterUserId,
            eventType: 'updated',
            payload: {},
          })
        })

        expect(await targetsFor(tenantUserId)).toEqual(['echo', 'keycloak'])
        // Master's catalog has no echo row — the tenant's does not leak
        // back into master any more than master's leaks into the tenant.
        expect(await targetsFor(masterUserId)).toEqual(['keycloak'])
      } finally {
        await ctx.pool.query(`DELETE FROM connector_targets WHERE organization_id = $1`, [tenant])
      }
    })

    it('an organization with NOTHING enabled fans out to nothing at all', async () => {
      const writer = new OutboxWriter()
      const { organizationId: tenant, rootOrgUnitId } = await insertTenant()
      const tenantUserId = await insertUserIn(tenant, rootOrgUnitId)

      // No connector_targets rows exist for this tenant — POST /organizations
      // would normally seed keycloak, but this fixture deliberately does not.
      await ctx.db.transaction(async (tx) => {
        await writer.record(tx, {
          aggregateType: 'user',
          aggregateId: tenantUserId,
          eventType: 'updated',
          payload: {},
        })
      })

      expect(await targetsFor(tenantUserId)).toEqual([])
    })
  })
})
