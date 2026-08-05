import { describe, expect, it } from 'vitest'
import { loadEnv } from '../src/config/env'

const valid = {
  DATABASE_URL: 'postgres://idm:pw@localhost:5432/identity_manager',
  KEYCLOAK_ISSUER: 'http://localhost:8080/realms/identity-manager',
  KEYCLOAK_AUDIENCE: 'idm-api',
  PORT: '3000',
}

describe('loadEnv', () => {
  it('parses a valid environment', () => {
    expect(loadEnv(valid)).toEqual({
      databaseUrl: valid.DATABASE_URL,
      keycloakIssuer: valid.KEYCLOAK_ISSUER,
      keycloakAudience: 'idm-api',
      port: 3000,
    })
  })

  it('defaults the port when absent', () => {
    const { PORT, ...withoutPort } = valid
    expect(loadEnv(withoutPort).port).toBe(3000)
  })

  it('throws a descriptive error when DATABASE_URL is missing', () => {
    const { DATABASE_URL, ...broken } = valid
    expect(() => loadEnv(broken)).toThrow(/DATABASE_URL/)
  })

  it('rejects a non-URL issuer', () => {
    expect(() => loadEnv({ ...valid, KEYCLOAK_ISSUER: 'not-a-url' })).toThrow(
      /KEYCLOAK_ISSUER/,
    )
  })

  it('strips trailing slashes from keycloakIssuer', () => {
    expect(
      loadEnv({
        ...valid,
        KEYCLOAK_ISSUER: 'http://localhost:8080/realms/identity-manager/',
      }).keycloakIssuer,
    ).toBe('http://localhost:8080/realms/identity-manager')
  })
})
