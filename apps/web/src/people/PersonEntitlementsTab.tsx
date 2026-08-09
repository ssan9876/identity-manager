import { useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link } from 'react-router-dom'
import { ApiError } from '../api/client'
import { CONNECTOR_TARGET_LABEL } from '../connectors/api'
import { formatDateTime } from '../format'
import { fetchPeopleByIds, type Person } from './api'
import {
  fetchEntitlements,
  type EntitlementRow,
  type UserEntitlements,
} from './entitlements-api'
import './PersonEntitlementsTab.css'

/** One flattened row — a group and a target account are the same question ("what do they have, and why?") asked of two tables. */
interface Row extends EntitlementRow {
  key: string
  what: string
  kind: string
  /** Groups link to their own page; a target account has no record of its own. */
  href: string | null
}

function flatten(entitlements: UserEntitlements): Row[] {
  return [
    ...entitlements.groups.map((row) => ({
      ...row,
      key: `group:${row.groupId}`,
      what: row.groupName,
      kind: 'Group',
      href: `/groups/${row.groupId}`,
    })),
    ...entitlements.targets.map((row) => ({
      ...row,
      key: `target:${row.target}`,
      what: `${CONNECTOR_TARGET_LABEL[row.target]} account`,
      kind: 'Target account',
      href: null,
    })),
  ]
}

/**
 * The three-valued `justifiedBy`, rendered as three visibly different
 * things. This is the whole point of the column, and collapsing any two of
 * them would produce a screen that lies:
 *
 *  - a NON-EMPTY LIST -> the roles themselves, named and linked. The answer
 *    to "why does this person have this?" is a role, so the role is what is
 *    on screen.
 *  - `[]` -> "nothing justifies this right now", and what that MEANS depends
 *    on the row. On a `manual` row it is the normal, permanent state — a
 *    human granted it, the reconciler will never revoke it — so it reads as
 *    a plain statement of who granted it, not a warning. On a role-derived
 *    row the same `[]` is a genuine finding: the next reconcile will take it
 *    away, and it is marked as the exception it is.
 *  - `null` -> UNKNOWN. Not "no roles". The engine refused, so nobody can
 *    say — rendered in its own uncoloured, dashed shape with the word
 *    "Unknown", never as an empty cell and never as the `[]` treatment.
 */
function JustificationCell({ row, granter }: { row: Row; granter: Person | undefined }) {
  if (row.justifiedBy === null) {
    return (
      <span className="badge badge--unknown" data-justification="unknown">
        Unknown — not evaluated
      </span>
    )
  }

  if (row.justifiedBy.length === 0) {
    if (row.grantSource === 'manual') {
      return (
        <span className="entitlements__manual" data-justification="manual">
          No role behind it{granter !== undefined ? ` — granted by ${granter.displayName}` : ''}
        </span>
      )
    }
    return (
      <span className="badge badge--warn" data-justification="unjustified">
        <span className="badge__dot" aria-hidden="true" />
        Nothing justifies this
      </span>
    )
  }

  return (
    <ul className="entitlements__roles" data-justification="roles">
      {row.justifiedBy.map((role) => (
        <li key={role.roleId}>
          <Link to={`/business-roles/${role.roleId}`} className="row-link">
            {role.roleName}
          </Link>
        </li>
      ))}
    </ul>
  )
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 4 }).map((_, i) => (
        <tr key={i} aria-hidden="true">
          <td>
            <span className="skeleton" style={{ width: '10rem', height: '0.9rem' }} />
          </td>
          <td>
            <span className="skeleton" style={{ width: '6rem', height: '0.9rem' }} />
          </td>
          <td>
            <span className="skeleton" style={{ width: '8rem', height: '1.3rem' }} />
          </td>
          <td>
            <span className="skeleton" style={{ width: '9rem', height: '0.9rem' }} />
          </td>
          <td>
            <span className="skeleton" style={{ width: '11rem', height: '1.3rem' }} />
          </td>
        </tr>
      ))}
    </>
  )
}

/**
 * The person Entitlements tab — Milestone 17, Task 19. What they have, where
 * it came from, and — for role-derived rows — which roles justify it right
 * now.
 *
 * IT MUST NOT FAIL CLOSED. `GET /users/:id/entitlements` answers 200 with an
 * `unevaluable` marker and the rows still present when the role engine
 * refuses, precisely because this is the screen somebody opens BECAUSE
 * something is wrong. The rows are facts in Postgres either way; only the
 * explanation is withheld. So the banner sits ABOVE a full table, never
 * instead of one.
 */
export function PersonEntitlementsTab({ personId }: { personId: string }) {
  const auth = useAuth()
  const accessToken = auth.user?.access_token

  const [entitlements, setEntitlements] = useState<UserEntitlements | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)
  const [granters, setGranters] = useState<Map<string, Person>>(new Map())

  useEffect(() => {
    if (accessToken === undefined) return
    let cancelled = false
    setLoading(true)
    setError(null)

    void fetchEntitlements(accessToken, personId)
      .then((next) => {
        if (cancelled) return
        setEntitlements(next)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(
          cause instanceof ApiError
            ? `Could not load entitlements: ${cause.message}`
            : 'Could not load entitlements. Check your connection and try again.',
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [accessToken, personId, retryToken])

  const rows = entitlements === null ? [] : flatten(entitlements)

  // Who granted the by-hand rows. A name, not a uuid — a recertification
  // queue is read by a human deciding whether to keep the grant, and "granted
  // by 3f2a…" is not a fact anyone can act on. Resolution failing costs the
  // name and nothing else.
  const granterIds = Array.from(
    new Set(rows.map((row) => row.grantedBy).filter((v): v is string => v !== null)),
  ).join(',')

  useEffect(() => {
    if (accessToken === undefined || granterIds.length === 0) return
    let cancelled = false
    void fetchPeopleByIds(accessToken, granterIds.split(','))
      .then((page) => {
        if (cancelled) return
        setGranters(new Map(page.items.map((person) => [person.id, person])))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [accessToken, granterIds])

  if (error !== null) {
    return (
      <div className="error-panel" role="alert">
        <p className="error-panel__message">{error}</p>
        <button type="button" className="btn btn--secondary" onClick={() => setRetryToken((t) => t + 1)}>
          Try again
        </button>
      </div>
    )
  }

  const unevaluable = entitlements?.unevaluable ?? null

  return (
    <div className="entitlements">
      <p className="entitlements__intro">
        Everything this person holds, and what is keeping it there. A role-derived row lasts as long
        as a role justifies it; a row granted by hand is theirs until somebody takes it away — no
        role will.
      </p>

      {unevaluable !== null && (
        <div className="banner banner--warn" role="alert" data-testid="entitlements-unevaluable">
          <p>
            <strong>Justification unavailable.</strong> The role engine could not evaluate{' '}
            <strong>{unevaluable.roleName}</strong>, so nothing below can be attributed to a role —
            those rows read <em>Unknown</em>, which is not the same as &ldquo;no role justifies
            this&rdquo;.
          </p>
          <p className="entitlements__reason">
            {unevaluable.reason} <span className="mono">{unevaluable.roleId}</span>
          </p>
          <p>
            The memberships themselves are still listed and are still real. Until that role is
            fixed, reconciliation is refusing for this person, so nothing here is being added or
            revoked either.
          </p>
        </div>
      )}

      <div className="table-wrap">
        {!loading && rows.length === 0 ? (
          <div className="empty-state">
            <h3>They hold nothing yet</h3>
            <p>
              No group memberships and no target accounts. A published business role that describes
              them will grant on its next pass; anything else has to be given by hand.
            </p>
          </div>
        ) : (
          <table className="table" data-testid="entitlements-table">
            <thead>
              <tr>
                <th scope="col">Entitlement</th>
                <th scope="col">Kind</th>
                <th scope="col">Source</th>
                <th scope="col">Since</th>
                <th scope="col">Justified by</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonRows />
              ) : (
                rows.map((row) => {
                  const granter = row.grantedBy === null ? undefined : granters.get(row.grantedBy)
                  return (
                    <tr key={row.key} data-testid="entitlements-row">
                      <td>
                        {row.href === null ? (
                          row.what
                        ) : (
                          <Link to={row.href} className="row-link">
                            {row.what}
                          </Link>
                        )}
                      </td>
                      <td className="cell-muted">{row.kind}</td>
                      <td>
                        {/* Both sources are ordinary — neither is an
                            exception — so neither takes colour. The words
                            differ because the consequences do. */}
                        <span className="entitlements__source" data-grant-source={row.grantSource}>
                          {row.grantSource === 'manual' ? 'Granted by hand' : 'Role-derived'}
                        </span>
                      </td>
                      <td className="cell-muted">{formatDateTime(row.grantedAt)}</td>
                      <td>
                        <JustificationCell row={row} granter={granter} />
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
