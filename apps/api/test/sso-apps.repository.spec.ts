import { beforeEach, describe, expect, it } from 'vitest'
import { SsoAppsRepository, type SsoAppInput } from '../src/sso-apps/sso-apps.repository'
import { withTestDatabase } from './support/pg'

const BASE_INPUT: SsoAppInput = {
  clientId: 'billing-portal',
  name: 'Billing Portal',
  description: 'Customer billing self-service',
  protocol: 'openid-connect',
  publicClient: false,
  redirectUris: ['https://billing.example.com/callback'],
  webOrigins: ['https://billing.example.com'],
  groupsClaim: true,
}

describe('SsoAppsRepository', () => {
  const ctx = withTestDatabase()
  let repo: SsoAppsRepository

  beforeEach(async () => {
    // external_sso_app_identities cascades from sso_apps, but delete it
    // explicitly so a failure here is about THIS table rather than a
    // surprising cascade.
    await ctx.pool.query('DELETE FROM external_sso_app_identities')
    await ctx.pool.query('DELETE FROM sso_apps')
    repo = new SsoAppsRepository(ctx.db)
  })

  it('creates an application and reads it back', async () => {
    const created = await ctx.db.transaction((tx) => repo.create(BASE_INPUT, tx))

    expect(created.clientId).toBe('billing-portal')
    expect(created.enabled).toBe(true)
    expect(created.groupsClaim).toBe(true)
    expect(created.redirectUris).toEqual(['https://billing.example.com/callback'])
    // The SAML columns exist on every row and are null for OIDC.
    expect(created.protocol).toBe('openid-connect')
    expect(created.samlAcsUrls).toBeNull()
    expect(created.samlSpCertificate).toBeNull()
    expect(created.samlSignAssertions).toBeNull()
    expect(created.samlNameIdFormat).toBeNull()

    const found = await repo.findById(created.id)
    expect(found?.name).toBe('Billing Portal')
  })

  it('round-trips a SAML application, entity id in the clientId column', async () => {
    const created = await ctx.db.transaction((tx) =>
      repo.create(
        {
          clientId: 'https://hr.example.com/saml/metadata',
          name: 'HR Suite',
          description: '',
          protocol: 'saml',
          publicClient: false,
          redirectUris: [],
          webOrigins: [],
          groupsClaim: true,
          samlAcsUrls: ['https://hr.example.com/saml/acs'],
          samlSpCertificate: null,
          samlSignAssertions: true,
          samlNameIdFormat: 'persistent',
        },
        tx,
      ),
    )

    const found = await repo.findById(created.id)
    expect(found?.protocol).toBe('saml')
    expect(found?.clientId).toBe('https://hr.example.com/saml/metadata')
    expect(found?.samlAcsUrls).toEqual(['https://hr.example.com/saml/acs'])
    expect(found?.samlSignAssertions).toBe(true)
    expect(found?.samlNameIdFormat).toBe('persistent')
    expect(found?.publicClient).toBe(false)
  })

  it('rejects a duplicate client_id at the DATABASE level', async () => {
    // Not merely in the controller: clientId is what every downstream
    // application trusts, so uniqueness is enforced where a race cannot
    // slip past it.
    await ctx.db.transaction((tx) => repo.create(BASE_INPUT, tx))

    await expect(
      ctx.db.transaction((tx) => repo.create({ ...BASE_INPUT, name: 'Second' }, tx)),
    ).rejects.toThrow()
  })

  it('finds by clientId', async () => {
    await ctx.db.transaction((tx) => repo.create(BASE_INPUT, tx))
    const found = await repo.findByClientId('billing-portal')
    expect(found?.name).toBe('Billing Portal')
    expect(await repo.findByClientId('no-such-app')).toBeNull()
  })

  it('lists applications ordered by clientId', async () => {
    await ctx.db.transaction(async (tx) => {
      await repo.create({ ...BASE_INPUT, clientId: 'zeta-app' }, tx)
      await repo.create({ ...BASE_INPUT, clientId: 'alpha-app' }, tx)
    })

    const all = await repo.list()
    expect(all.map((a) => a.clientId)).toEqual(['alpha-app', 'zeta-app'])
  })

  it('setEnabled flips enabled without touching anything else', async () => {
    const created = await ctx.db.transaction((tx) => repo.create(BASE_INPUT, tx))

    await ctx.db.transaction((tx) => repo.setEnabled(created.id, false, tx))

    const found = await repo.findById(created.id)
    expect(found?.enabled).toBe(false)
    expect(found?.name).toBe('Billing Portal')
    expect(found?.redirectUris).toEqual(['https://billing.example.com/callback'])
  })

  it('update rewrites only the patched fields', async () => {
    const created = await ctx.db.transaction((tx) => repo.create(BASE_INPUT, tx))

    await ctx.db.transaction((tx) =>
      repo.update(created.id, { name: 'Renamed', redirectUris: ['https://new.example.com/cb'] }, tx),
    )

    const found = await repo.findById(created.id)
    expect(found?.name).toBe('Renamed')
    expect(found?.redirectUris).toEqual(['https://new.example.com/cb'])
    // Untouched by the patch.
    expect(found?.clientId).toBe('billing-portal')
    expect(found?.description).toBe('Customer billing self-service')
    expect(found?.webOrigins).toEqual(['https://billing.example.com'])
  })

  it('findExternalId is null before the first sync', async () => {
    // This is what makes minting a secret a 409 rather than a 404: the
    // application exists here, there is just no Keycloak client yet.
    const created = await ctx.db.transaction((tx) => repo.create(BASE_INPUT, tx))
    expect(await repo.findExternalId(created.id)).toBeNull()
  })

  it('findExternalId returns the Keycloak UUID once correlated', async () => {
    const created = await ctx.db.transaction((tx) => repo.create(BASE_INPUT, tx))
    await ctx.pool.query(
      `INSERT INTO external_sso_app_identities (app_id, system, external_id, sync_state)
       VALUES ($1, 'keycloak_sso', $2, 'synced')`,
      [created.id, 'uuid-from-keycloak'],
    )

    expect(await repo.findExternalId(created.id)).toBe('uuid-from-keycloak')
  })

  it('stores an empty web origin list without collapsing it to null', async () => {
    const created = await ctx.db.transaction((tx) =>
      repo.create({ ...BASE_INPUT, clientId: 'no-origins', webOrigins: [] }, tx),
    )
    const found = await repo.findById(created.id)
    expect(found?.webOrigins).toEqual([])
  })
})
