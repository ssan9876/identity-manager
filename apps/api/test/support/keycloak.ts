import path from 'node:path'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'

export interface TestKeycloak {
  issuer: string
  tokenFor: (username: string, password: string) => Promise<string>
  stop: () => Promise<void>
}

const REALM = 'identity-manager'

// Resolved from the working directory (apps/api) rather than `__dirname`,
// which Vitest's SWC/ESM transform does not define.
const REALM_IMPORT_DIR = path.resolve(process.cwd(), '../../keycloak/realm-import')

/**
 * Real Keycloak, imported with the project realm. The design depends on actual
 * Keycloak token behaviour, so mocking the JWKS would only validate our
 * assumptions about Keycloak rather than Keycloak itself.
 */
export async function startKeycloak(): Promise<TestKeycloak> {
  const container: StartedTestContainer = await new GenericContainer(
    'quay.io/keycloak/keycloak:26.0',
  )
    .withCommand(['start-dev', '--import-realm'])
    .withEnvironment({
      KC_BOOTSTRAP_ADMIN_USERNAME: 'admin',
      KC_BOOTSTRAP_ADMIN_PASSWORD: 'admin_dev_password',
    })
    .withCopyDirectoriesToContainer([
      { source: REALM_IMPORT_DIR, target: '/opt/keycloak/data/import' },
    ])
    .withExposedPorts(8080)
    .withWaitStrategy(
      Wait.forHttp(
        `/realms/${REALM}/.well-known/openid-configuration`,
        8080,
      ).withStartupTimeout(180_000),
    )
    .start()

  const issuer = `http://${container.getHost()}:${container.getMappedPort(8080)}/realms/${REALM}`

  return {
    issuer,

    async tokenFor(username: string, password: string): Promise<string> {
      const res = await fetch(`${issuer}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: 'idm-test-client',
          scope: 'openid profile email',
          username,
          password,
        }),
      })

      if (!res.ok) {
        throw new Error(`token request failed: ${res.status} ${await res.text()}`)
      }

      return ((await res.json()) as { access_token: string }).access_token
    },

    async stop(): Promise<void> {
      await container.stop()
    },
  }
}
