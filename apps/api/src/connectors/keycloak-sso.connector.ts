import { Injectable } from '@nestjs/common'
import {
  KeycloakAdminClient,
  type KeycloakClientRepresentation,
} from '../keycloak/keycloak-admin.client'
import type { ConnectorHealth, ConnectorOperation, DesiredSsoApp, SsoConnector } from './connector'
import { resolveSecret } from './secrets'

/**
 * The subset of `KeycloakAdminClient` this connector needs.
 *
 * Narrowed deliberately: the test fake implements six methods instead of the
 * client's full user/group surface, so it stays honest about what an SSO
 * application actually touches, and a change to user syncing cannot silently
 * alter what this connector is tested against.
 */
export interface SsoAdminApi {
  findClientByClientId(clientId: string): Promise<KeycloakClientRepresentation | null>
  getClient(uuid: string): Promise<KeycloakClientRepresentation>
  createClient(rep: KeycloakClientRepresentation): Promise<string>
  updateClient(uuid: string, rep: KeycloakClientRepresentation): Promise<void>
  assertGroupMembershipMapper(uuid: string): Promise<void>
  mintClientSecret(uuid: string): Promise<string>
  health(): Promise<ConnectorHealth>
}

/** The fields this system masters. Everything else on the client is left alone. */
const MANAGED_KEYS = [
  'clientId',
  'name',
  'description',
  'protocol',
  'publicClient',
  'enabled',
  'standardFlowEnabled',
  'redirectUris',
  'webOrigins',
  'attributes',
] as const

/**
 * Asserts an Identity Manager `sso_apps` row into Keycloak as an OIDC client.
 *
 * READ-MODIFY-WRITE, never blind overwrite. Keycloak's client update takes a
 * FULL ClientRepresentation, so this reads the current one and overlays only
 * the fields Identity Manager manages, leaving `defaultClientScopes`,
 * attributes an admin set by hand, and anything a future Keycloak version
 * adds, untouched. Same discipline as `setEnabledPreservingOtherBits` for
 * Active Directory's `userAccountControl`.
 *
 * NOT YET VERIFIED EMPIRICALLY against Keycloak 26 — the plan's Task 5 Step 1
 * called for confirming what a partial PUT does to absent fields, and Docker
 * was unavailable. Read-modify-write is the safe choice under either answer
 * (if a partial PUT preserves absent fields it simply writes the same values
 * back), so the behaviour here is correct regardless; what remains unproven is
 * only whether the weaker approach would ALSO have worked.
 */
export class KeycloakSsoConnector implements SsoConnector {
  constructor(private readonly admin: SsoAdminApi) {}

  async planApp(desired: DesiredSsoApp): Promise<ConnectorOperation[]> {
    const existing = await this.findExisting(desired)
    if (existing === null) {
      return [
        {
          kind: 'create',
          description: `create Keycloak client "${desired.clientId}" (enabled=${desired.enabled})`,
        },
      ]
    }

    const ops: ConnectorOperation[] = []
    const merged = this.merge(existing, desired)

    const changed = MANAGED_KEYS.filter(
      (key) => JSON.stringify(merged[key]) !== JSON.stringify(existing[key]),
    )

    if (changed.length > 0) {
      ops.push({
        // A change that turns the application off is reported as a disable so
        // the dry run reads as what it is, rather than a generic "update".
        kind: existing.enabled !== false && desired.enabled === false ? 'disable' : 'update',
        description: `update Keycloak client "${desired.clientId}" (${changed.join(', ')})`,
      })
    }

    if (desired.groupsClaim) {
      ops.push({
        kind: 'update',
        description: `assert the "groups" mapper on "${desired.clientId}"`,
      })
    }

    return ops
  }

  async applyApp(desired: DesiredSsoApp): Promise<{ externalId: string }> {
    const existing = await this.findExisting(desired)

    if (existing === null || existing.id === undefined) {
      const uuid = await this.admin.createClient(this.merge({ clientId: desired.clientId }, desired))
      if (desired.groupsClaim) {
        await this.admin.assertGroupMembershipMapper(uuid)
      }
      return { externalId: uuid }
    }

    await this.admin.updateClient(existing.id, this.merge(existing, desired))
    if (desired.groupsClaim) {
      await this.admin.assertGroupMembershipMapper(existing.id)
    }
    return { externalId: existing.id }
  }

  async health(): Promise<ConnectorHealth> {
    return this.admin.health()
  }

  /**
   * Correlates on the stored Keycloak UUID first, falling back to `clientId`
   * only for an application that has never synced.
   *
   * A Keycloak admin CAN rename `clientId` directly. Correlating on it would
   * turn that rename into an orphaned client plus a second, empty one on the
   * next sync — the failure mode docs/09 calls "not a cosmetic bug". Going
   * through the UUID instead means a rename is simply corrected back to what
   * this system masters, on the same client.
   */
  private async findExisting(desired: DesiredSsoApp): Promise<KeycloakClientRepresentation | null> {
    if (desired.existingExternalId !== undefined) {
      return this.admin.getClient(desired.existingExternalId)
    }
    return this.admin.findClientByClientId(desired.clientId)
  }

  private merge(
    current: KeycloakClientRepresentation,
    desired: DesiredSsoApp,
  ): KeycloakClientRepresentation {
    return {
      ...current,
      clientId: desired.clientId,
      name: desired.name,
      description: desired.description,
      protocol: desired.protocol,
      publicClient: desired.publicClient,
      enabled: desired.enabled,
      standardFlowEnabled: true,
      redirectUris: [...desired.redirectUris],
      webOrigins: [...desired.webOrigins],
      attributes: {
        ...(current.attributes ?? {}),
        // Forced, and not exposed as an editable field anywhere. A public
        // client without PKCE is an authorization-code interception hole;
        // making it unrepresentable is cheaper than making it a checkbox
        // someone can get wrong.
        ...(desired.publicClient ? { 'pkce.code.challenge.method': 'S256' } : {}),
      },
    }
  }
}

function requiredString(config: Record<string, unknown>, key: string): string {
  const value = config[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`keycloak_sso config: "${key}" is required`)
  }
  return value.trim()
}

/**
 * Builds a `KeycloakSsoConnector` bound to the `idm-sso-admin` credential.
 *
 * A SEPARATE `KeycloakAdminClient` instance from the one the sync worker
 * holds, deliberately. `idm-sync-service` keeps its exactly-four
 * realm-management roles; only this credential holds `manage-clients`. Same
 * process, but the user and group sync path structurally cannot mint or alter
 * a client — the shape of the two-database-role split, applied to Keycloak.
 *
 * The secret is resolved through `resolveSecret`, so it inherits the
 * `^CONNECTOR_` guard, the sentinel leak test and the
 * MissingSecretError/ForbiddenSecretNameError distinction with no new secret
 * machinery.
 */
@Injectable()
export class KeycloakSsoConnectorFactory {
  configure(config: Record<string, unknown>): KeycloakSsoConnector {
    const baseUrl = requiredString(config, 'baseUrl').replace(/\/+$/, '')
    const realm = requiredString(config, 'realm')
    const clientId = requiredString(config, 'clientId')
    const clientSecret = resolveSecret(requiredString(config, 'credentialSecretName'))

    const admin = new KeycloakAdminClient({
      // KeycloakAdminClient derives both the token URL and the admin REST
      // base from this one value — see its constructor.
      issuer: `${baseUrl}/realms/${realm}`,
      clientId,
      clientSecret,
    })

    // No cast: KeycloakAdminClient must structurally satisfy SsoAdminApi, so
    // that dropping or renaming one of those six methods is a compile error
    // here rather than a runtime failure on the first application sync.
    return new KeycloakSsoConnector(admin)
  }
}
