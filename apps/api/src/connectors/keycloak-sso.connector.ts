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
  assertSamlGroupAttributeMapper(uuid: string): Promise<void>
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
 * Asserts an Identity Manager `sso_apps` row into Keycloak as an OIDC or
 * SAML client, per the row's immutable `protocol`.
 *
 * READ-MODIFY-WRITE, never blind overwrite. Keycloak's client update takes a
 * FULL ClientRepresentation, so this reads the current one and overlays only
 * the fields Identity Manager manages, leaving `defaultClientScopes`,
 * attributes an admin set by hand, and anything a future Keycloak version
 * adds, untouched. Same discipline as `setEnabledPreservingOtherBits` for
 * Active Directory's `userAccountControl`.
 *
 * VERIFIED EMPIRICALLY against Keycloak 26.4 on 2026-08-13, on the lab host,
 * by creating a client and re-reading it after a partial `PUT`:
 *
 *   - A TOP-LEVEL field omitted from the payload is PRESERVED. `description`
 *     and `redirectUris` both survived a PUT carrying only `clientId` and
 *     `enabled`, and `enabled` — the one field sent — changed.
 *   - The `attributes` MAP also merges. A key omitted from the map keeps its
 *     stored value; only an explicit `""` or `null` clears it.
 *
 * So read-modify-write was never load-bearing for correctness here, and the
 * weaker approach would also have worked — but the second half of that answer
 * mattered a great deal: `mergeSaml` used to remove a stale certificate with
 * `delete`, which under a MERGING map removed it from the request and never
 * from Keycloak. See that method for the fix.
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
        description:
          desired.protocol === 'saml'
            ? `assert the "groups" attribute-statement mapper on "${desired.clientId}"`
            : `assert the "groups" mapper on "${desired.clientId}"`,
      })
    }

    return ops
  }

  async applyApp(desired: DesiredSsoApp): Promise<{ externalId: string }> {
    const existing = await this.findExisting(desired)

    if (existing === null || existing.id === undefined) {
      const uuid = await this.admin.createClient(this.merge({ clientId: desired.clientId }, desired))
      await this.assertGroupsMapper(uuid, desired)
      return { externalId: uuid }
    }

    await this.admin.updateClient(existing.id, this.merge(existing, desired))
    await this.assertGroupsMapper(existing.id, desired)
    return { externalId: existing.id }
  }

  /**
   * One flag, two realisations: the OIDC `groups` claim mapper or the SAML
   * `groups` attribute-statement mapper, per protocol. Both admin methods
   * are check-then-create, so asserting twice is a no-op — the convergence
   * property `applyApp` promises holds through the mapper too.
   */
  private async assertGroupsMapper(uuid: string, desired: DesiredSsoApp): Promise<void> {
    if (!desired.groupsClaim) {
      return
    }
    if (desired.protocol === 'saml') {
      await this.admin.assertSamlGroupAttributeMapper(uuid)
    } else {
      await this.admin.assertGroupMembershipMapper(uuid)
    }
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
    if (desired.protocol === 'saml') {
      return this.mergeSaml(current, desired)
    }
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

  /**
   * The SAML overlay. Same read-modify-write discipline as OIDC — only the
   * keys this system masters are written; a hand-set attribute survives.
   *
   * Keycloak 26 keeps a SAML client's settings in the `attributes` map:
   *
   *  - `saml_assertion_consumer_url_post` — the primary ACS endpoint (POST
   *    binding). Every ACS URL additionally lands in `redirectUris`, which
   *    is how Keycloak scopes the set of ACS destinations it will accept.
   *  - `saml.assertion.signature` / `saml.server.signature` — sign the
   *    individual assertions / the response document. The document is
   *    ALWAYS signed; assertion signing follows the app's flag.
   *  - `saml_name_id_format` — 'email' | 'persistent' | 'username', stored
   *    by Keycloak as these exact strings.
   *  - `saml.client.signature` + `saml.signing.certificate` — ON exactly
   *    when the SP supplied a certificate: requiring signatures without a
   *    verification key would brick the client, and holding a key without
   *    requiring signatures silently verifies nothing. Coupling them makes
   *    the inconsistent states unrepresentable. The stored value is the PEM
   *    stripped to base64 DER, which is the shape Keycloak keeps. When the
   *    certificate is REMOVED, the stale attribute is CLEARED with an
   *    explicit empty string rather than dropped from the payload — a
   *    lingering key on a client that no longer requires signatures is exactly
   *    the confusing half-state read-modify-write can otherwise preserve
   *    forever, and dropping the key achieves precisely nothing because
   *    Keycloak merges this map.
   *
   * Asserting the same desired state twice writes byte-identical attributes,
   * preserving the convergence property planApp's diff depends on.
   */
  private mergeSaml(
    current: KeycloakClientRepresentation,
    desired: DesiredSsoApp,
  ): KeycloakClientRepresentation {
    const acsUrls = desired.samlAcsUrls ?? []
    const certificate =
      desired.samlSpCertificate === null || desired.samlSpCertificate === undefined
        ? null
        : stripPemToBase64(desired.samlSpCertificate)

    const attributes: Record<string, string> = {
      ...(current.attributes ?? {}),
      saml_assertion_consumer_url_post: acsUrls[0] ?? '',
      'saml.assertion.signature': desired.samlSignAssertions === true ? 'true' : 'false',
      'saml.server.signature': 'true',
      saml_name_id_format: desired.samlNameIdFormat ?? 'email',
      'saml.client.signature': certificate === null ? 'false' : 'true',
      ...(certificate === null ? {} : { 'saml.signing.certificate': certificate }),
    }
    if (certificate === null) {
      // AN EXPLICIT EMPTY STRING, NOT `delete` — and only for a key that is
      // actually there.
      //
      // Keycloak MERGES the attributes map on update: a key absent from the
      // payload keeps whatever is already stored. `delete` therefore removed
      // the certificate from the REQUEST and left it in Keycloak forever — the
      // exact half-state the block below promises to prevent, and the fake in
      // the spec agreed with the code because it stores whatever it is handed.
      // Measured against Keycloak 26.4 on 2026-08-13: omitting a key preserves
      // it; sending `""` or `null` clears the value, which reads back as null.
      //
      // Guarded on the key already existing so a client that never had a
      // certificate does not acquire an empty one just for passing through
      // here. Converges either way: once cleared, the stored value reads back
      // null, the key is still present, and the next assert writes the same
      // empty string.
      if (attributes['saml.signing.certificate'] !== undefined) {
        attributes['saml.signing.certificate'] = ''
      }
    }

    return {
      ...current,
      clientId: desired.clientId,
      name: desired.name,
      description: desired.description,
      protocol: 'saml',
      // A SAML SP has no "public client" auth model; the local row is
      // created with false and this keeps a hand-edit from surviving.
      publicClient: false,
      enabled: desired.enabled,
      standardFlowEnabled: true,
      redirectUris: [...acsUrls],
      webOrigins: [],
      attributes,
    }
  }
}

/**
 * PEM to the single-line base64 DER Keycloak stores in
 * `saml.signing.certificate`. The PEM shape was already vetted by
 * `pemCertificateProblem` before the value could reach the database, so this
 * is a pure reformat, not a validation.
 */
function stripPemToBase64(pem: string): string {
  return pem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '')
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
    // No cast anywhere: KeycloakAdminClient must structurally satisfy
    // SsoAdminApi, so dropping or renaming one of those six methods is a
    // compile error here rather than a runtime failure on the first sync.
    return new KeycloakSsoConnector(this.configureAdmin(config))
  }

  /**
   * The raw admin API for this target, for the ONE operation that is not
   * desired-state reconciliation: minting a client secret.
   *
   * Deliberately not a fourth method on `SsoConnector`. That interface
   * describes asserting desired state — plan it, apply it, report health.
   * Minting is imperative and one-shot: it invalidates the previous secret,
   * it is triggered by an administrator rather than by an outbox event, and
   * its result must reach exactly one HTTP response and nothing else. Folding
   * it into the reconciliation interface would imply the sync worker could
   * call it, which must never happen.
   */
  configureAdmin(config: Record<string, unknown>): SsoAdminApi {
    const baseUrl = requiredString(config, 'baseUrl').replace(/\/+$/, '')
    const realm = requiredString(config, 'realm')
    const clientId = requiredString(config, 'clientId')
    const clientSecret = resolveSecret(requiredString(config, 'credentialSecretName'))

    return new KeycloakAdminClient({
      // KeycloakAdminClient derives both the token URL and the admin REST
      // base from this one value — see its constructor.
      issuer: `${baseUrl}/realms/${realm}`,
      clientId,
      clientSecret,
    })
  }
}
