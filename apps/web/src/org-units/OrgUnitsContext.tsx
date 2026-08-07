import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useAuth } from 'react-oidc-context'
import { fetchAllOrgUnits, type OrgUnit } from './api'

export type OrgUnitsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; list: OrgUnit[]; byId: Map<string, OrgUnit> }

interface OrgUnitsContextValue {
  state: OrgUnitsState
  /**
   * Merges a just-created org unit into the cached set immediately —
   * Milestone 8, Task 3's "create child" action needs the new node to
   * appear in the tree (and become selectable) without a full re-fetch of
   * every org unit the caller can see. Idempotent: merging a unit whose id
   * is already present (e.g. a background refetch elsewhere already picked
   * it up) is a no-op rather than a duplicate list entry. A no-op while the
   * set has not loaded yet (`status !== 'ready'`) — there is nothing to
   * merge INTO — is not expected to happen in practice, since nothing that
   * can create an org unit renders before this context has resolved.
   */
  addOrgUnit: (unit: OrgUnit) => void
}

const OrgUnitsCtx = createContext<OrgUnitsContextValue>({
  state: { status: 'loading' },
  addOrgUnit: () => {},
})

/**
 * Fetches the caller's full org-unit set ONCE per session and shares it —
 * the People list's org-unit filter, the mono path shown across People and
 * Org units screens, and the Org units tree (Task 3) all need the SAME
 * id -> path lookup, and fetching it once here (rather than once per
 * screen) is what keeps navigating between them from re-fetching reference
 * data that essentially never changes mid-session on its own (the one
 * exception — a unit THIS session just created — is handled by
 * `addOrgUnit` above, a local merge, not a re-fetch).
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

  const addOrgUnit = useCallback((unit: OrgUnit) => {
    setState((prev) => {
      if (prev.status !== 'ready' || prev.byId.has(unit.id)) return prev
      return { status: 'ready', list: [...prev.list, unit], byId: new Map(prev.byId).set(unit.id, unit) }
    })
  }, [])

  const value = useMemo<OrgUnitsContextValue>(() => ({ state, addOrgUnit }), [state, addOrgUnit])

  return <OrgUnitsCtx.Provider value={value}>{children}</OrgUnitsCtx.Provider>
}

export function useOrgUnits(): OrgUnitsState {
  return useContext(OrgUnitsCtx).state
}

export function useAddOrgUnit(): (unit: OrgUnit) => void {
  return useContext(OrgUnitsCtx).addOrgUnit
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
