import { authorizedRequest } from '../api/client'

export type SsoAppProtocol = 'openid-connect' | 'saml'
export type SamlNameIdFormat = 'email' | 'persistent' | 'username'

/**
 * Mirrors `SsoApp` (apps/api/src/sso-apps/sso-apps.repository.ts). The
 * `saml*` fields are null on every OIDC application; for a SAML application
 * `clientId` holds the SP's ENTITY ID (Keycloak keys a SAML client by entity
 * id in the same field).
 */
export interface SsoApp {
  id: string
  clientId: string
  name: string
  description: string
  protocol: SsoAppProtocol
  publicClient: boolean
  redirectUris: string[]
  webOrigins: string[]
  groupsClaim: boolean
  enabled: boolean
  samlAcsUrls: string[] | null
  samlSpCertificate: string | null
  samlSignAssertions: boolean | null
  samlNameIdFormat: SamlNameIdFormat | null
  createdAt: string
  updatedAt: string
}

/** Mirrors `createBodySchema`. `clientId` is settable ONLY here. */
export interface CreateSsoAppInput {
  clientId: string
  name: string
  description: string
  publicClient: boolean
  redirectUris: string[]
  webOrigins: string[]
  groupsClaim: boolean
}

/**
 * Mirrors `createSamlBodySchema`. `protocol` is the discriminator the API
 * parses the body with; `entityId` is settable only here (it is the
 * clientId, and just as immutable).
 */
export interface CreateSamlSsoAppInput {
  protocol: 'saml'
  entityId: string
  name: string
  description: string
  acsUrls: string[]
  spCertificate?: string
  signAssertions: boolean
  nameIdFormat: SamlNameIdFormat
  groupsClaim: boolean
}

/**
 * Mirrors `patchBodySchema` — deliberately without `clientId`, `publicClient`
 * or `enabled`. The API rejects all three by NAME rather than ignoring them,
 * so a form must not offer them; sending one is a 400, not a silent no-op.
 */
export type UpdateSsoAppInput = Partial<Omit<CreateSsoAppInput, 'clientId' | 'publicClient'>>

/**
 * Mirrors `patchSamlBodySchema` — the API picks it by the ROW's protocol, so
 * a SAML field sent to an OIDC application (or vice versa) is a 400 naming
 * the field. `spCertificate: null` removes the stored certificate.
 */
export interface UpdateSamlSsoAppInput {
  name?: string
  description?: string
  acsUrls?: string[]
  spCertificate?: string | null
  signAssertions?: boolean
  nameIdFormat?: SamlNameIdFormat
  groupsClaim?: boolean
}

export function fetchSsoApps(accessToken: string): Promise<SsoApp[]> {
  return authorizedRequest<SsoApp[]>('/sso-apps', accessToken)
}

export function fetchSsoApp(accessToken: string, id: string): Promise<SsoApp> {
  return authorizedRequest<SsoApp>(`/sso-apps/${id}`, accessToken)
}

export function createSsoApp(
  accessToken: string,
  input: CreateSsoAppInput | CreateSamlSsoAppInput,
): Promise<SsoApp> {
  return authorizedRequest<SsoApp>('/sso-apps', accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function updateSsoApp(
  accessToken: string,
  id: string,
  patch: UpdateSsoAppInput | UpdateSamlSsoAppInput,
): Promise<SsoApp> {
  return authorizedRequest<SsoApp>(`/sso-apps/${id}`, accessToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

/** Verb routes, not a PATCH field — each is separately audited. */
export function setSsoAppEnabled(
  accessToken: string,
  id: string,
  enabled: boolean,
): Promise<SsoApp> {
  return authorizedRequest<SsoApp>(`/sso-apps/${id}/${enabled ? 'enable' : 'disable'}`, accessToken, {
    method: 'POST',
  })
}

/**
 * Mints a NEW secret, invalidating the previous one. The value exists in this
 * response and nowhere else — it is not stored, so there is no endpoint that
 * can return it again and no reveal affordance anywhere in the console.
 */
export function mintClientSecret(accessToken: string, id: string): Promise<{ secret: string }> {
  return authorizedRequest<{ secret: string }>(`/sso-apps/${id}/client-secret`, accessToken, {
    method: 'POST',
  })
}

/**
 * Splits a textarea into one entry per non-empty line. Used for redirect URIs
 * and web origins: the API validates each entry and returns a reason naming
 * the offending value, which the form renders verbatim rather than
 * reinterpreting.
 */
export function linesToList(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}
