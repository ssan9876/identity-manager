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
import { fetchAllGroups, type Group } from './api'

export type GroupsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; list: Group[]; byId: Map<string, Group> }

interface GroupsContextValue {
  state: GroupsState
  /** Merges a just-created group into the cached set immediately — same idempotent-merge contract as OrgUnitsContext's `addOrgUnit` (see its own doc comment): a no-op if the id is already present, or if the set has not loaded yet. */
  addGroup: (group: Group) => void
  /** Merges a just-edited group's new fields into the cached set, so a name/description change is reflected everywhere this cache is read from (the Nested-groups tab's child list, the "add child group" picker) without a full re-fetch. A no-op for an id not present — there is nothing to update. */
  updateGroupInCache: (group: Group) => void
}

const GroupsCtx = createContext<GroupsContextValue>({
  state: { status: 'loading' },
  addGroup: () => {},
  updateGroupInCache: () => {},
})

/**
 * Fetches the caller's full group set ONCE per session and shares it — the
 * Group detail page's Nested-groups tab needs to resolve a group's direct
 * child-group ids (`GET /:id/members`'s `.groups`, bare ids) to full
 * records, and the "add child group" picker needs the full candidate list
 * to choose from; both read from this ONE cache rather than each fetching
 * (and re-fetching, on every navigation) their own copy. Mirrors
 * OrgUnitsContext exactly, including WHY "fetch everything once" is the
 * right call here specifically — see that file's own doc comment.
 *
 * Every role bundle that grants `group:read` is EVERY role in today's
 * static catalog (apps/api/src/authz/actions.ts's ROLE_PERMISSIONS — even
 * `read_only` holds it) — so in practice this never 403s for anyone who
 * reached the shell at all — but, exactly like OrgUnitsProvider, a 403 is
 * still handled as an ordinary error state rather than assumed impossible.
 */
export function GroupsProvider({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const [state, setState] = useState<GroupsState>({ status: 'loading' })

  useEffect(() => {
    if (accessToken === undefined) return
    let cancelled = false

    void fetchAllGroups(accessToken)
      .then((list) => {
        if (cancelled) return
        setState({ status: 'ready', list, byId: new Map(list.map((group) => [group.id, group])) })
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setState({
          status: 'error',
          message: cause instanceof Error ? cause.message : 'Could not load groups.',
        })
      })

    return () => {
      cancelled = true
    }
  }, [accessToken])

  const addGroup = useCallback((group: Group) => {
    setState((prev) => {
      if (prev.status !== 'ready' || prev.byId.has(group.id)) return prev
      return { status: 'ready', list: [...prev.list, group], byId: new Map(prev.byId).set(group.id, group) }
    })
  }, [])

  const updateGroupInCache = useCallback((group: Group) => {
    setState((prev) => {
      if (prev.status !== 'ready' || !prev.byId.has(group.id)) return prev
      return {
        status: 'ready',
        list: prev.list.map((existing) => (existing.id === group.id ? group : existing)),
        byId: new Map(prev.byId).set(group.id, group),
      }
    })
  }, [])

  const value = useMemo<GroupsContextValue>(
    () => ({ state, addGroup, updateGroupInCache }),
    [state, addGroup, updateGroupInCache],
  )

  return <GroupsCtx.Provider value={value}>{children}</GroupsCtx.Provider>
}

export function useGroups(): GroupsState {
  return useContext(GroupsCtx).state
}

export function useAddGroup(): (group: Group) => void {
  return useContext(GroupsCtx).addGroup
}

export function useUpdateGroupInCache(): (group: Group) => void {
  return useContext(GroupsCtx).updateGroupInCache
}
