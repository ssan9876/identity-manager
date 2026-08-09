import { useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { authorizedRequest } from '../api/client'

/** Mirrors `Action` from apps/api/src/authz/actions.ts. */
export type Action =
  | 'user:read'
  | 'user:create'
  | 'user:update'
  | 'user:activate'
  | 'user:deactivate'
  | 'group:read'
  | 'group:create'
  | 'group:update'
  | 'group:manage_members'
  | 'org_unit:read'
  | 'org_unit:create'
  | 'role:assign'
  | 'audit:read'
  | 'connector:read'
  | 'connector:manage'

/** Mirrors SelfPermissionsResponse from apps/api/src/self-service/self-service.controller.ts. */
export interface SelfPermissionsResponse {
  actions: Action[]
}

export function fetchSelfPermissions(accessToken: string): Promise<SelfPermissionsResponse> {
  return authorizedRequest<SelfPermissionsResponse>('/self/permissions', accessToken)
}

export type PermissionsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; actions: Set<Action> }

/**
 * The console's ONE source of truth for "what can the signed-in caller do,"
 * backing every permission-gated nav item (AppShell) and, later, every
 * gated action button. docs/product-brief.md: "The API is the authority. The UI hides
 * what you cannot do; it never decides it" — this hook exists to READ that
 * authority once per session, never to compute it.
 *
 * Fails CLOSED: a network/parse error resolves to `{status: 'error'}`,
 * which every caller in this codebase treats as "show nothing gated"
 * (see AppShell's `hasAction`) rather than falling back to "show
 * everything" — a broken permissions fetch must never look like an
 * over-privileged one. The server still enforces every action regardless
 * of what this hook reports; hiding is for clarity, not safety (task-2-
 * brief.md), so failing closed here costs nothing but a little UI
 * discoverability, never a real authorization bypass in either direction.
 */
export function useSelfPermissions(): PermissionsState {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const [state, setState] = useState<PermissionsState>({ status: 'loading' })

  useEffect(() => {
    if (accessToken === undefined) return
    let cancelled = false

    void fetchSelfPermissions(accessToken)
      .then((res) => {
        if (cancelled) return
        setState({ status: 'ready', actions: new Set(res.actions) })
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setState({
          status: 'error',
          message: cause instanceof Error ? cause.message : 'Could not load your permissions.',
        })
      })

    return () => {
      cancelled = true
    }
  }, [accessToken])

  return state
}
