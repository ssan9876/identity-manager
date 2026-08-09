import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RESERVED_CLIENT_IDS,
  clientIdProblem,
  redirectUriProblem,
  webOriginProblem,
} from '../src/sso-apps/sso-app-validation'

describe('redirect URI rails', () => {
  // An over-broad redirect URI is a token-theft primitive. Keycloak's own
  // admin console accepts every one of the rejected cases without complaint;
  // refusing them is the point of moving this into a reviewed system.
  it.each([
    ['*', 'a bare wildcard'],
    ['https://*', 'a wildcard host'],
    ['https://*.example.com/cb', 'a wildcard in the host'],
    ['http*://app.example.com/cb', 'a wildcard in the scheme'],
    ['not-a-url', 'an unparseable value'],
    ['javascript:alert(1)', 'a non-http scheme'],
  ])('rejects %s (%s)', (uri) => {
    expect(redirectUriProblem(uri)).not.toBeNull()
  })

  it.each([
    'https://app.example.com/callback',
    'https://app.example.com/*',
    'https://app.example.com/auth/*/done',
    'http://localhost:3000/callback',
  ])('accepts %s', (uri) => {
    expect(redirectUriProblem(uri)).toBeNull()
  })

  it('names the offending value in the reason, so the console can show it verbatim', () => {
    expect(redirectUriProblem('https://*')).toContain('https://*')
  })
})

describe('web origin rails', () => {
  it('accepts + — Keycloak’s "same as redirect URIs" marker', () => {
    // Safe because it derives from values already vetted above.
    expect(webOriginProblem('+')).toBeNull()
  })

  it('rejects * — the permit-everything marker', () => {
    expect(webOriginProblem('*')).not.toBeNull()
  })

  it('accepts a bare scheme+host origin', () => {
    expect(webOriginProblem('https://app.example.com')).toBeNull()
  })

  it('rejects an origin carrying a path', () => {
    expect(webOriginProblem('https://app.example.com/callback')).not.toBeNull()
  })
})

describe('reserved client ids', () => {
  it.each([...RESERVED_CLIENT_IDS])('rejects %s', (clientId) => {
    expect(clientIdProblem(clientId)).not.toBeNull()
  })

  it('rejects case variations — Keycloak clientId matching is not case-safe to rely on', () => {
    expect(clientIdProblem('IDM-Console')).not.toBeNull()
  })

  it('rejects an empty or whitespace-only id', () => {
    expect(clientIdProblem('')).not.toBeNull()
    expect(clientIdProblem('   ')).not.toBeNull()
  })

  it('accepts an ordinary application id', () => {
    expect(clientIdProblem('billing-portal')).toBeNull()
  })

  // The static source scan. `manage-clients` is realm-wide and cannot be
  // scoped to "clients this principal created", so this denylist is the only
  // thing standing between a compromised idm-sso-admin credential and
  // rewriting idm-console's own redirectUris. It is an application-level
  // guard and strictly weaker than a structural boundary — this test at
  // least proves the list still names every client keycloak-setup.sh creates.
  it('names every client keycloak-setup.sh creates', () => {
    const setup = readFileSync(join(__dirname, '../../../scripts/keycloak-setup.sh'), 'utf8')
    const created = [...setup.matchAll(/upsert_client\s+([a-z0-9-]+)/g)].map((m) => m[1])

    expect(created.length).toBeGreaterThan(0)
    for (const clientId of created) {
      expect(RESERVED_CLIENT_IDS).toContain(clientId)
    }
  })
})
