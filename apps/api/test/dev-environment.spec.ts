import { describe, expect, it } from 'vitest'

const DISCOVERY =
  'http://localhost:8080/realms/identity-manager/.well-known/openid-configuration'

describe('dev environment', () => {
  it('serves the identity-manager realm discovery document', async () => {
    const res = await fetch(DISCOVERY)
    expect(res.status).toBe(200)

    const doc = (await res.json()) as { issuer: string; jwks_uri: string }
    expect(doc.issuer).toBe('http://localhost:8080/realms/identity-manager')
    expect(doc.jwks_uri).toContain('/protocol/openid-connect/certs')
  })
})
