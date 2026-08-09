import { Inject, Injectable } from '@nestjs/common'
import { KeycloakAdminClient } from './keycloak-admin.client'

/**
 * DI token carrying `KeycloakFactoryConfig` into the factory — same reason
 * KEYCLOAK_ADMIN_CONFIG exists next door (a plain TS interface erases at
 * runtime, so it cannot be a constructor-injected token on its own).
 */
export const KEYCLOAK_FACTORY_CONFIG = Symbol('KEYCLOAK_FACTORY_CONFIG')

export interface KeycloakFactoryConfig {
  /** `<serverRoot>/realms/<realm>` — the master organization's issuer, i.e. `env.keycloakIssuer`. */
  issuer: string
  /** The realm-scoped admin credential this system has always used, for the master realm only. */
  clientId: string
  clientSecret: string
  /**
   * The master-realm service account that can create and administer OTHER
   * realms (Task 8's KEYCLOAK_PROVISION_CLIENT_ID/_SECRET). Null when this
   * deployment cannot create realms — see `hasProvisioningCredentials`.
   *
   * A SECRET: never log it, never include it in an error message, never let
   * it reach an API response or an audit row. Nothing in this file
   * interpolates `provisionClientSecret` into a string; the one error
   * message below deliberately names the ENVIRONMENT VARIABLES an operator
   * must set, which is the actionable, non-sensitive half — the same split
   * `MissingSecretError` makes in connectors/secrets.ts.
   */
  provisionClientId: string | null
  provisionClientSecret: string | null
  /** Passed straight through to each client — see `KeycloakAdminClientConfig.requestTimeoutMs`. */
  requestTimeoutMs?: number
}

/**
 * One `KeycloakAdminClient` per realm, memoized (Organizations, Task 9).
 *
 * Memoized rather than constructed per call because each client owns a token
 * cache: a fresh instance per operation would re-run the client-credentials
 * grant on every single admin call, turning one round trip into two against
 * every realm. Keyed by realm rather than shared, because one token is valid
 * for exactly one realm's admin API.
 *
 * Two credentials, chosen by realm:
 *
 *  - The MASTER organization's realm resolves to the realm-scoped credential
 *    this system has always used (`KEYCLOAK_ADMIN_CLIENT_ID`). Nothing about
 *    the existing single-tenant path changes, including its token cache
 *    behaviour — see Task 6's `master-organization.ts`, which pins that realm
 *    at startup.
 *  - Every other realm resolves to the master-realm provisioning credential,
 *    because a realm-scoped service account can only ever administer its own
 *    realm: its roles are `realm-management` client roles INSIDE that realm,
 *    and `/admin/realms/<other>` is not reachable with a token minted there.
 *
 * The non-master client therefore authenticates against `master`'s token
 * endpoint while pointing its admin base URL at the tenant realm — the split
 * `KeycloakAdminClientConfig.adminRealm` exists to express.
 */
@Injectable()
export class KeycloakAdminClientFactory {
  private readonly clients = new Map<string, KeycloakAdminClient>()
  private readonly masterRealm: string
  private readonly root: string

  /**
   * A TRUE ECMAScript private field, deliberately, not `private readonly
   * config`: TS's `private` is erased at runtime and the property stays
   * enumerable, so `JSON.stringify(factory)` would print BOTH client secrets
   * this object holds. `#config` is invisible to `JSON.stringify`,
   * `Object.keys`, `util.inspect`'s default output and every structured
   * logger built on them — the "never logged, never echoed, never in an
   * audit row" rule enforced by construction rather than by remembering.
   * Its sibling assertion lives in keycloak-admin-client.factory.spec.ts.
   */
  readonly #config: KeycloakFactoryConfig

  constructor(@Inject(KEYCLOAK_FACTORY_CONFIG) config: KeycloakFactoryConfig) {
    this.#config = config
    // Same parse as KeycloakAdminClient's own constructor, and deliberately
    // so: one env var (`KEYCLOAK_ISSUER`) remains the single source of both
    // the server root and the master realm name, rather than adding a
    // separate root/realm var that could drift out of sync with it.
    const url = new URL(config.issuer)
    const match = /^(.*)\/realms\/([^/]+)$/.exec(`${url.origin}${url.pathname}`)
    if (match === null) {
      throw new Error(`issuer must contain /realms/<name>: ${config.issuer}`)
    }
    this.root = match[1]
    this.masterRealm = match[2]
  }

  /**
   * `http://host:port` — everything before `/realms/...`. Realm CREATION
   * (`POST /admin/realms`, Task 11) is a SERVER-level endpoint with no realm
   * in its path, so its caller needs this rather than a per-realm client.
   */
  serverRoot(): string {
    return this.root
  }

  /** The realm named by `KEYCLOAK_ISSUER` — the one served by the realm-scoped credential. */
  masterRealmName(): string {
    return this.masterRealm
  }

  /**
   * Whether this deployment can administer realms other than its own.
   *
   * Requires BOTH halves: a half-configured pair is treated as unconfigured
   * rather than attempted, so the failure is an actionable "set these two
   * variables" at the point of use instead of a 401 from Keycloak's token
   * endpoint with an empty `client_secret`. `POST /organizations` reads this
   * to answer NOT_CONFIGURED (503) before writing a row that could never
   * provision.
   */
  hasProvisioningCredentials(): boolean {
    return this.#config.provisionClientId !== null && this.#config.provisionClientSecret !== null
  }

  /**
   * The admin client for `realm`, created on first use and reused after.
   *
   * Throws — rather than returning a client that would fail on its first
   * call — when a non-master realm is requested and no provisioning
   * credentials are configured. The error names the two environment
   * variables and NOT their values; there is nothing sensitive to leak here
   * precisely because the values are absent, and the same message shape is
   * safe when they are present.
   */
  forRealm(realm: string): KeycloakAdminClient {
    const cached = this.clients.get(realm)
    if (cached !== undefined) {
      return cached
    }

    const isMaster = realm === this.masterRealm
    if (!isMaster && !this.hasProvisioningCredentials()) {
      throw new Error(
        `cannot administer realm "${realm}": no provisioning credentials are configured ` +
          '(set KEYCLOAK_PROVISION_CLIENT_ID and KEYCLOAK_PROVISION_CLIENT_SECRET)',
      )
    }

    const client = new KeycloakAdminClient({
      // A master-realm service account authenticates against the MASTER
      // realm's token endpoint, then calls /admin/realms/<realm>/... for
      // whichever realm it is administering — hence `adminRealm` below.
      issuer: isMaster ? this.#config.issuer : `${this.root}/realms/master`,
      clientId: isMaster ? this.#config.clientId : (this.#config.provisionClientId as string),
      clientSecret: isMaster
        ? this.#config.clientSecret
        : (this.#config.provisionClientSecret as string),
      // Explicit for master too, though it equals the issuer's own realm:
      // stating it makes the master/tenant symmetry visible at the one place
      // the decision is made.
      adminRealm: realm,
      requestTimeoutMs: this.#config.requestTimeoutMs,
    })
    this.clients.set(realm, client)
    return client
  }
}
