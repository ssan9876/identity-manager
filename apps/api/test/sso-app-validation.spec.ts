import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RESERVED_CLIENT_IDS,
  acsUrlProblem,
  clientIdProblem,
  entityIdProblem,
  pemCertificateProblem,
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
  // Scoped to `upsert_client`, which is the script's helper for clients in the
  // identity-manager realm. keycloak-setup.sh also creates `idm-provisioner`,
  // deliberately NOT through that helper: it lives in the MASTER realm, and
  // idm-sso-admin's manage-clients is realm-scoped to identity-manager, so no
  // SSO app registration can name it. Denylisting it would suggest a reach this
  // credential does not have. If a master-realm client ever does become
  // reachable from here, it belongs in RESERVED_CLIENT_IDS and in this scan.
  it('names every client keycloak-setup.sh creates in the application realm', () => {
    const setup = readFileSync(join(__dirname, '../../../scripts/keycloak-setup.sh'), 'utf8')
    const created = [...setup.matchAll(/upsert_client\s+([a-z0-9-]+)/g)].map((m) => m[1])

    expect(created.length).toBeGreaterThan(0)
    for (const clientId of created) {
      expect(RESERVED_CLIENT_IDS).toContain(clientId)
    }
  })
})

describe('SAML entity id rails', () => {
  it.each([
    'https://sp.example.com/saml/metadata',
    'http://sp.internal/metadata',
    'urn:example:sp:hr-suite',
  ])('accepts %s', (entityId) => {
    expect(entityIdProblem(entityId)).toBeNull()
  })

  it.each([
    ['', 'empty'],
    ['   ', 'whitespace only'],
    ['not a uri', 'not a URI'],
    ['https://sp.example.com/*', 'a wildcard'],
    ['mailto:sp@example.com', 'a non-http, non-urn scheme'],
  ])('rejects %s (%s)', (entityId) => {
    expect(entityIdProblem(entityId)).not.toBeNull()
  })

  it('rejects an entity id over the 1024-character SAML limit', () => {
    expect(entityIdProblem(`https://sp.example.com/${'a'.repeat(1024)}`)).not.toBeNull()
  })

  it('applies the reserved denylist — the entity id IS the Keycloak clientId', () => {
    // Entity id "idm-console" would register over the console's own client:
    // the same takeover clientIdProblem exists to stop, reachable through
    // the SAML door if this check were missing.
    for (const reserved of RESERVED_CLIENT_IDS) {
      expect(entityIdProblem(reserved)).not.toBeNull()
    }
    expect(entityIdProblem('IDM-Console')).not.toBeNull()
  })
})

describe('ACS URL rails', () => {
  // STRICTER than redirect URIs, by design: the ACS receives the signed
  // assertion itself, so a wrong destination is the credential delivered to
  // the attacker, and SAML has no wildcard semantics at all.
  it.each([
    'https://sp.example.com/saml/acs',
    'http://localhost:8080/saml/acs',
    'http://127.0.0.1:3000/acs',
  ])('accepts %s', (uri) => {
    expect(acsUrlProblem(uri)).toBeNull()
  })

  it.each([
    ['http://sp.example.com/acs', 'plain http on a non-localhost host'],
    ['https://sp.example.com/*', 'a wildcard — even in the path'],
    ['https://*.example.com/acs', 'a wildcard host'],
    ['not-a-url', 'an unparseable value'],
    ['ftp://sp.example.com/acs', 'a non-http scheme'],
  ])('rejects %s (%s)', (uri) => {
    expect(acsUrlProblem(uri)).not.toBeNull()
  })

  it('names the offending value verbatim', () => {
    expect(acsUrlProblem('http://sp.example.com/acs')).toContain('http://sp.example.com/acs')
  })
})

describe('SP certificate rails', () => {
  const pem =
    '-----BEGIN CERTIFICATE-----\nMIIBszCCARygAwIBAgIBATANBgkqhkiG9w0BAQsFADAA\n-----END CERTIFICATE-----'

  it('accepts a well-shaped PEM certificate', () => {
    expect(pemCertificateProblem(pem)).toBeNull()
  })

  it('accepts surrounding whitespace — certificates arrive by paste', () => {
    expect(pemCertificateProblem(`\n  ${pem}\n`)).toBeNull()
  })

  it('rejects a private key — the SP must never send us one', () => {
    const key = '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----'
    expect(pemCertificateProblem(key)).toMatch(/PRIVATE KEY/)
  })

  it('rejects a bare base64 body without PEM markers', () => {
    expect(pemCertificateProblem('MIIBszCCARygAwIBAgIBATANBgkqhkiG9w0BAQsFADAA')).not.toBeNull()
  })

  it('rejects a mangled body', () => {
    expect(
      pemCertificateProblem('-----BEGIN CERTIFICATE-----\nnot base64 !!\n-----END CERTIFICATE-----'),
    ).not.toBeNull()
  })
})
