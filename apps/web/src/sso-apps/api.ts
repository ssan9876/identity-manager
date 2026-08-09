import { authorizedRequest } from '../api/client'

/** Mirrors `SsoApp` (apps/api/src/sso-apps/sso-apps.repository.ts). */
export interface SsoApp {
  id: string
  clientId: string
  name: string
  description: string
  protocol: 'openid-connect'
  publicClient: boolean
  redirectUris: string[]
  webOrigins: string[]
  groupsClaim: boolean
  enabled: boolean
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
 * Mirrors `patchBodySchema` — deliberately without `clientId`, `publicClient`
 * or `enabled`. The API rejects all three by NAME rather than ignoring them,
 * so a form must not offer them; sending one is a 400, not a silent no-op.
 */
export type UpdateSsoAppInput = Partial<Omit<CreateSsoAppInput, 'clientId' | 'publicClient'>>

export function fetchSsoApps(accessToken: string): Promise<SsoApp[]> {
  return authorizedRequest<SsoApp[]>('/sso-apps', accessToken)
}

export function fetchSsoApp(accessToken: string, id: string): Promise<SsoApp> {
  return authorizedRequest<SsoApp>(`/sso-apps/${id}`, accessToken)
}

export function createSsoApp(accessToken: string, input: CreateSsoAppInput): Promise<SsoApp> {
  return authorizedRequest<SsoApp>('/sso-apps', accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function updateSsoApp(
  accessToken: string,
  id: string,
  patch: UpdateSsoAppInput,
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
