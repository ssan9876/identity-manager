import { useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link } from 'react-router-dom'
import { ApiError } from '../api/client'
import { DEFAULT_MAX_ATTEMPTS } from '../audit/outbox-api'
import { CONNECTOR_TARGET_LABEL } from '../connectors/api'
import { formatDateTime } from '../format'
import { SyncBadge } from './badges'
import { fetchPersonSync, type UserSyncDetail, type UserSyncTargetDetail } from './api'

/**
 * Why is this person's badge that colour (2026-08-08 sync-diagnostics spec).
 *
 * The per-user sibling of `DeadLettersTab` and deliberately shaped like it —
 * same table idiom, same skeleton/empty/error states, same
 * `DEFAULT_MAX_ATTEMPTS` vocabulary — because they answer the same question
 * at two scales, and a second visual language for "sync went wrong" would be
 * its own small lie about the system.
 *
 * It exists because the badge alone could not distinguish "Keycloak is
 * broken" from "the mail connector is broken" from "a group you are in is
 * broken", and the only other window into any of that was a global-
 * `audit:read`-gated list of dead letters that omitted anything still
 * retrying. A person could sit on `Sync failed` indefinitely with no
 * reachable explanation.
 */

/** An em dash for "nothing to show here", used rather than an empty cell so a blank never reads as a value. */
const NONE = '—'

function TargetRow({ row, redacted }: { row: UserSyncTargetDetail; redacted: boolean }) {
  const event = row.latestEvent

  // Only a still-retrying event has a meaningful next attempt. A dead letter
  // keeps its last computed `nextAttemptAt`, but nothing will ever act on it
  // — showing that timestamp would promise a retry that is not coming.
  const retryDue = event !== null && (event.status === 'pending' || event.status === 'processing')

  return (
    <tr data-testid="person-sync-row">
      <td data-testid="person-sync-target">{CONNECTOR_TARGET_LABEL[row.target]}</td>
      <td data-testid="person-sync-state">
        <SyncBadge state={row.state} />
      </td>
      <td className="mono cell-muted">{row.externalId ?? NONE}</td>
      <td>{row.lastSyncedAt === null ? NONE : formatDateTime(row.lastSyncedAt)}</td>
      <td data-testid="person-sync-attempts">
        {event === null ? NONE : `${event.attempts} of ${DEFAULT_MAX_ATTEMPTS}`}
      </td>
      <td>{retryDue ? formatDateTime(event.nextAttemptAt) : NONE}</td>
      <td data-testid="person-sync-error">
        {event?.lastError ??
          (redacted && row.state === 'failed' ? (
            <span className="person-sync__muted">Error detail requires the auditor role</span>
          ) : (
            NONE
          ))}
      </td>
    </tr>
  )
}

export function PersonSyncTab({ personId }: { personId: string }) {
  const auth = useAuth()
  const accessToken = auth.user?.access_token

  const [detail, setDetail] = useState<UserSyncDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (accessToken === undefined) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)

    fetchPersonSync(accessToken, personId)
      .then((res) => {
        if (!cancelled) setDetail(res)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setLoadError(
          cause instanceof ApiError
            ? `Could not load sync detail: ${cause.message}`
            : 'Could not load sync detail. Check your connection and try again.',
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [accessToken, personId])

  if (loadError !== null) {
    return <p className="form__error">{loadError}</p>
  }
  if (loading || detail === null) {
    return <p className="person-sync__muted">Loading sync detail…</p>
  }
  if (detail.targets.length === 0) {
    return (
      <p className="person-sync__muted">
        No connector targets are enabled, so nothing is being asserted anywhere yet.
      </p>
    )
  }

  return (
    <div className="person-sync">
      <p className="person-sync__intro">
        One row per enabled connector target. A dead letter does <strong>not</strong> retry automatically —
        resolve the underlying issue, then run the reconciliation job (<span className="mono">pnpm reconcile</span>)
        to repair it.
      </p>

      <div className="table-scroll">
        <table className="table" data-testid="person-sync-table">
          <thead>
            <tr>
              <th scope="col">Target</th>
              <th scope="col">State</th>
              <th scope="col">External ID</th>
              <th scope="col">Last synced</th>
              <th scope="col">Attempts</th>
              <th scope="col">Next retry</th>
              <th scope="col">Error</th>
            </tr>
          </thead>
          <tbody>
            {detail.targets.map((row) => (
              <TargetRow key={row.target} row={row} redacted={detail.errorDetailRedacted} />
            ))}
          </tbody>
        </table>
      </div>

      {detail.blockedByGroups.length === 0 ? null : (
        <section className="person-sync__blocked">
          <h3>Blocked by group</h3>
          <p className="person-sync__muted">
            These groups have an unsettled sync of their own. Until they settle, this person&rsquo;s badge
            reflects that — even when every one of their own targets above is healthy.
          </p>
          <ul>
            {detail.blockedByGroups.map((group) => (
              <li key={`${group.groupId}-${group.target}`} data-testid="person-sync-blocking-group">
                <Link to={`/groups/${group.groupId}`}>{group.groupName}</Link>{' '}
                <span className="person-sync__muted">
                  — {CONNECTOR_TARGET_LABEL[group.target]}, {group.status}, {group.attempts} of{' '}
                  {DEFAULT_MAX_ATTEMPTS} attempts
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
