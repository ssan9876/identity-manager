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
  | 'sso_app:read'
  | 'sso_app:manage'
  // Milestone 17, Task 11. `business_role:read` is held by
  // user_admin/auditor/read_only; `business_role:manage` is super_admin's
  // alone AND the API additionally requires that grant to be GLOBAL
  // (`requireGlobalManageGrant` — a business role belongs to no org unit).
  // `GET /self/permissions` reports the ACTION, not its scope, so holding
  // this in the set is not a promise that a write will succeed; the API
  // still decides, and explains the refusal on its own terms.
  | 'business_role:read'
  | 'business_role:manage'
  // Recertification campaigns. `recert:read` mirrors business_role:read
  // (user_admin/auditor/read_only); `recert:manage` is super_admin's alone
  // and must additionally be GLOBAL. The reviewer queue and decide routes
  // are deliberately gated on IDENTITY rather than any action here —
  // reviewers are ordinary managers holding no role at all — so the
  // Recertification nav item is NOT permission-gated (see nav-items.tsx).
  | 'recert:read'
  | 'recert:manage'
  // Organizations milestone, Task 12. All three are super_admin's ALONE —
  // including the READ, which is the only read action in this catalog not
  // granted to the auditor or read_only roles: the tenant roster is the list
  // of every customer of the deployment, which is platform-operator
  // information rather than directory work. The API additionally requires
  // each grant to be GLOBAL (`requireGlobalGrant` — an organization belongs
  // to no org unit), and `GET /self/permissions` reports the ACTION and not
  // its scope, so holding one of these in the set is not a promise that a
  // write will succeed. The API still decides, and explains its refusal on
  // its own terms.
  | 'organization:read'
  | 'organization:create'
  | 'organization:update'
  // Attribute definitions write path (2026-08-10 SDD), Tasks 3 and 7.
  // `attribute:read` is ordinary directory work on the same terms as
  // `business_role:read`/`recert:read` — super_admin, user_admin, auditor and
  // read_only — and Task 7 moved `GET /attribute-definitions` onto it, a
  // deliberate NARROWING that removed help_desk (which reads people, not
  // schema). `attribute:manage` is super_admin's ALONE, and the API further
  // requires that grant to be GLOBAL (`requireGlobalManageGrant` — an
  // attribute definition belongs to no org unit and feeds every
  // organization's users AND their business-role formulas). As everywhere
  // else here, `GET /self/permissions` reports the ACTION and not its scope,
  // so holding `attribute:manage` in this set is not a promise that a write
  // will succeed — an org-unit-scoped super_admin holds the action and still
  // gets a 403. The API decides; the console renders the refusal.
  | 'attribute:read'
  | 'attribute:manage'
  // Joiner/mover/leaver rules. `jml:read` is ordinary directory work on
  // `attribute:read`'s exact terms — super_admin, user_admin, auditor and
  // read_only — because a JML rule is the only actor in this system that
  // changes accounts with no human in the loop, and someone who cannot read
  // the rules cannot explain a change they are looking at. `jml:manage` is
  // super_admin's ALONE and the API further requires it to be GLOBAL
  // (`requireGlobalManageGrant` — a rule names no org unit and runs against
  // every user the lifecycle pass walks). As everywhere else here,
  // `GET /self/permissions` reports the ACTION and not its scope, so holding
  // `jml:manage` is not a promise that a write will succeed.
  | 'jml:read'
  | 'jml:manage'

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
