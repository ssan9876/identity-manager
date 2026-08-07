import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAuth } from 'react-oidc-context'
import { fetchAllOrgUnits, type OrgUnit } from './api'

export type OrgUnitsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; list: OrgUnit[]; byId: Map<string, OrgUnit> }

const OrgUnitsStateContext = createContext<OrgUnitsState>({ status: 'loading' })

/**
 * Fetches the caller's full org-unit set ONCE per session and shares it —
 * the People list's org-unit filter and the mono path shown on both the
 * People list and the Person detail page all need the SAME id -> path
 * lookup, and fetching it once here (rather than once per screen) is what
 * keeps navigating list -> detail -> list from re-fetching reference data
 * that essentially never changes mid-session.
 *
 * Every role bundle that grants `user:read` also grants `org_unit:read` in
 * today's static catalog (apps/api/src/authz/actions.ts's ROLE_PERMISSIONS)
 * — so in practice this never 403s for anyone who can reach the People
 * list at all — but a 403 is still handled as an ordinary error state
 * rather than assumed impossible, in case that catalog ever changes.
 */
export function OrgUnitsProvider({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const [state, setState] = useState<OrgUnitsState>({ status: 'loading' })

  useEffect(() => {
    if (accessToken === undefined) return
    let cancelled = false

    void fetchAllOrgUnits(accessToken)
      .then((list) => {
        if (cancelled) return
        setState({ status: 'ready', list, byId: new Map(list.map((unit) => [unit.id, unit])) })
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setState({
          status: 'error',
          message: cause instanceof Error ? cause.message : 'Could not load org units.',
        })
      })

    return () => {
      cancelled = true
    }
  }, [accessToken])

  return <OrgUnitsStateContext.Provider value={state}>{children}</OrgUnitsStateContext.Provider>
}

export function useOrgUnits(): OrgUnitsState {
  return useContext(OrgUnitsStateContext)
}

/** The mono-rendered path for an org unit id, or a sensible fallback while loading/on error/for an id that isn't found. */
export function useOrgUnitPath(orgUnitId: string | null | undefined): string | null {
  const state = useOrgUnits()
  return useMemo(() => {
    if (orgUnitId === null || orgUnitId === undefined) return null
    if (state.status !== 'ready') return null
    return state.byId.get(orgUnitId)?.path ?? orgUnitId
  }, [state, orgUnitId])
}
