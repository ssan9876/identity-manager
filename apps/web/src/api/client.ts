import { apiBaseUrl } from '../auth/oidc-config'

/**
 * Shared fetch plumbing for every authenticated API call in this console.
 * Extracted from self-service/api.ts (Milestone 6) so the admin console
 * screens added from Milestone 8 onward reuse the SAME error shape and
 * request helper rather than growing a second, divergence-prone copy —
 * self-service/api.ts now re-exports `ApiError` from here instead of
 * defining its own, so `cause instanceof ApiError` checks anywhere that
 * imports it from either module still compare against the identical class.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    public readonly issues: string[] | undefined,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function authorizedRequest<T>(
  path: string,
  accessToken: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${accessToken}`,
    },
  })

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { message?: string; code?: string; issues?: string[] }
      | null
    throw new ApiError(
      res.status,
      body?.code,
      body?.issues,
      body?.message ?? `request to ${path} failed with status ${res.status}`,
    )
  }

  return res.json() as Promise<T>
}

/** Builds a query string from a params object, skipping undefined/empty values. Never includes a bare "?" when there is nothing to send. */
export function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const qs = search.toString()
  return qs.length > 0 ? `?${qs}` : ''
}
