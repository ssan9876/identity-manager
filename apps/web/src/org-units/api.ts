import { authorizedRequest, buildQuery } from '../api/client'

/** Mirrors `OrgUnit` from apps/api/src/org-units/org-units.repository.ts. */
export interface OrgUnit {
  id: string
  name: string
  parentId: string | null
  /** ltree path, e.g. "acme.sales.emea" — DESIGN.md: renders mono. */
  path: string
  createdAt: string
  updatedAt: string
}

export interface Page<T> {
  items: T[]
  total: number
  limit: number
  offset: number
}

const PAGE_LIMIT = 100
// Bounds the paging loop below at 10,000 org units even if something is
// badly wrong with `total` (e.g. it changes between pages) — this is
// reference data for a single organisation's directory (PRODUCT.md: "one
// to a handful" of admins managing "a single organisation"), not a
// collection that grows without bound, so this ceiling is generous, not
// tight, and exists purely so a pathological response can never spin this
// loop forever.
const MAX_PAGES = 100

export function fetchOrgUnitsPage(
  accessToken: string,
  options: { limit: number; offset: number },
): Promise<Page<OrgUnit>> {
  return authorizedRequest<Page<OrgUnit>>(
    `/org-units${buildQuery({ limit: options.limit, offset: options.offset })}`,
    accessToken,
  )
}

/**
 * Pages through every org unit the caller can see. Used to build the
 * id -> path lookup the People list/detail render (DESIGN.md: org unit
 * paths render mono) and to populate the People list's org-unit filter —
 * both need the FULL set, not one page, so this is the one place that
 * paging happens rather than each screen reimplementing it.
 */
export async function fetchAllOrgUnits(accessToken: string): Promise<OrgUnit[]> {
  const all: OrgUnit[] = []
  let offset = 0

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchOrgUnitsPage(accessToken, { limit: PAGE_LIMIT, offset })
    all.push(...res.items)
    offset += res.items.length
    if (res.items.length === 0 || offset >= res.total) break
  }

  return all
}

export function fetchOrgUnit(accessToken: string, id: string): Promise<OrgUnit> {
  return authorizedRequest<OrgUnit>(`/org-units/${id}`, accessToken)
}

/**
 * Mirrors `createOrgUnitBodySchema` on the API side exactly:
 * `parentId` omitted creates a ROOT (requires a GLOBAL `org_unit:create`
 * grant — `OrgUnitsController.create` 403s otherwise, a case
 * OrgUnitsPage surfaces per Task 3's scope-legibility requirement, not a
 * distinction this client type needs to encode itself).
 */
export interface CreateOrgUnitInput {
  name: string
  parentId?: string
}

export function createOrgUnit(accessToken: string, input: CreateOrgUnitInput): Promise<OrgUnit> {
  return authorizedRequest<OrgUnit>('/org-units', accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}
