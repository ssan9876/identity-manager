import { describe, expect, it } from 'vitest'
import { loadEnv } from '../src/config/env'

const valid = {
  DATABASE_URL: 'postgres://idm:pw@localhost:5432/identity_manager',
  KEYCLOAK_ISSUER: 'http://localhost:8080/realms/identity-manager',
  KEYCLOAK_AUDIENCE: 'idm-api',
  KEYCLOAK_ADMIN_CLIENT_ID: 'idm-sync-service',
  KEYCLOAK_ADMIN_CLIENT_SECRET: 'idm_sync_dev_secret_change_me',
  PORT: '3000',
}

describe('loadEnv', () => {
  it('parses a valid environment', () => {
    expect(loadEnv(valid)).toEqual({
      databaseUrl: valid.DATABASE_URL,
      keycloakIssuer: valid.KEYCLOAK_ISSUER,
      keycloakAudience: 'idm-api',
      keycloakAdminClientId: 'idm-sync-service',
      keycloakAdminClientSecret: 'idm_sync_dev_secret_change_me',
      port: 3000,
      syncWorkerEnabled: true,
    })
  })

  it('defaults the port when absent', () => {
    const { PORT, ...withoutPort } = valid
    expect(loadEnv(withoutPort).port).toBe(3000)
  })

  // Milestone 4, Task 4: the SyncWorker on/off switch. Defaults ON (see
  // env.ts's own doc comment on SYNC_WORKER_ENABLED for why) and must be
  // spellable as an explicit "false" — the exact case a naive
  // `z.coerce.boolean()` gets wrong (every non-empty string, including the
  // text "false", coerces to `true`).
  describe('SYNC_WORKER_ENABLED', () => {
    it('defaults to true when absent', () => {
      expect(loadEnv(valid).syncWorkerEnabled).toBe(true)
    })

    it('is true when explicitly "true"', () => {
      expect(loadEnv({ ...valid, SYNC_WORKER_ENABLED: 'true' }).syncWorkerEnabled).toBe(true)
    })

    it('is false when explicitly "false"', () => {
      expect(loadEnv({ ...valid, SYNC_WORKER_ENABLED: 'false' }).syncWorkerEnabled).toBe(false)
    })

    it('rejects an unrecognized value rather than silently defaulting', () => {
      expect(() => loadEnv({ ...valid, SYNC_WORKER_ENABLED: 'yes' })).toThrow(
        /SYNC_WORKER_ENABLED/,
      )
    })
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

  it('throws a descriptive error when KEYCLOAK_ADMIN_CLIENT_ID is missing', () => {
    const { KEYCLOAK_ADMIN_CLIENT_ID, ...broken } = valid
    expect(() => loadEnv(broken)).toThrow(/KEYCLOAK_ADMIN_CLIENT_ID/)
  })

  it('throws a descriptive error when KEYCLOAK_ADMIN_CLIENT_SECRET is missing', () => {
    const { KEYCLOAK_ADMIN_CLIENT_SECRET, ...broken } = valid
    expect(() => loadEnv(broken)).toThrow(/KEYCLOAK_ADMIN_CLIENT_SECRET/)
  })
})
