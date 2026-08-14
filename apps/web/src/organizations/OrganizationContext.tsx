import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAuth } from 'react-oidc-context'
import { useSelfPermissions } from '../shell/permissions'
import { fetchOrganizationsPage, type Organization } from './api'

/**
 * WHICH TENANT THIS CONSOLE IS CURRENTLY LOOKING AT.
 *
 * Every administrator here is a platform operator authenticating against the
 * master realm (design decision 3), so switching organizations is a change of
 * VIEW, never a change of identity: no re-authentication, no second token, no
 * tenant-facing route. What changes is the `organizationId` filter the
 * directory screens send.
 *
 * `null` means "every organization I can see", and is the default — a
 * single-tenant install must look and behave exactly as it did before this
 * existed, with no switcher rendered and no filter sent.
 *
 * The selection is deliberately NOT a route parameter. It applies across
 * People, Org units and Groups at once, and threading it through every path
 * would make every link in the console carry a tenant it does not otherwise
 * care about — and make a pasted link silently reinterpret itself under
 * whichever tenant the recipient happens to have selected.
 */
interface OrganizationsState {
  /** Organizations this actor may see. Empty until loaded, or when they hold no `organization:read`. */
  list: Organization[]
  /** `null` = unfiltered. Never an id that is not in `list`. */
  selectedId: string | null
  select: (organizationId: string | null) => void
  /** True once the roster has been fetched (or skipped, for an actor who cannot read it). */
  ready: boolean
}

const OrganizationsCtx = createContext<OrganizationsState>({
  list: [],
  selectedId: null,
  select: () => {},
  ready: false,
})

const STORAGE_KEY = 'idm.selectedOrganizationId'

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    // Private mode, or storage disabled. A switcher that cannot remember the
    // selection is a minor annoyance; one that throws on mount is a blank
    // console.
    return null
  }
}

export function OrganizationsProvider({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const permissions = useSelfPermissions()
  const canRead = permissions.status === 'ready' && permissions.actions.has('organization:read')

  const [list, setList] = useState<Organization[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(readStored)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (permissions.status !== 'ready') return
    // `organization:read` is super_admin's alone. An actor without it has one
    // tenant as far as they are concerned, so there is nothing to fetch and
    // nothing to switch between — and asking anyway would be a guaranteed 403
    // on every page load.
    if (!canRead || accessToken === undefined) {
      setReady(true)
      return
    }

    let cancelled = false
    void fetchOrganizationsPage(accessToken, { limit: 100, offset: 0 })
      .then((page) => {
        if (cancelled) return
        setList(page.items)
        // A stored id for an organization that no longer exists (deleted,
        // renamed away, or simply another deployment's) must not survive as a
        // filter that matches nothing — that renders an empty directory with
        // no visible cause.
        setSelectedId((current) =>
          current !== null && page.items.some((org) => org.id === current) ? current : null,
        )
      })
      .catch(() => {
        if (!cancelled) setList([])
      })
      .finally(() => {
        if (!cancelled) setReady(true)
      })

    return () => {
      cancelled = true
    }
  }, [accessToken, canRead, permissions.status])

  const select = useCallback((organizationId: string | null) => {
    setSelectedId(organizationId)
    try {
      if (organizationId === null) window.localStorage.removeItem(STORAGE_KEY)
      else window.localStorage.setItem(STORAGE_KEY, organizationId)
    } catch {
      // See readStored — the selection still applies for this session.
    }
  }, [])

  const value = useMemo<OrganizationsState>(
    () => ({ list, selectedId, select, ready }),
    [list, selectedId, select, ready],
  )

  return <OrganizationsCtx.Provider value={value}>{children}</OrganizationsCtx.Provider>
}

export function useOrganizations(): OrganizationsState {
  return useContext(OrganizationsCtx)
}

/**
 * The currently-selected tenant id, or `undefined` when unfiltered — shaped
 * for spreading straight into a list request's params, where `undefined`
 * means "omit this filter" and `null` would be sent as a literal.
 */
export function useSelectedOrganizationId(): string | undefined {
  return useContext(OrganizationsCtx).selectedId ?? undefined
}
