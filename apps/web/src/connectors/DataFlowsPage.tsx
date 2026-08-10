import { useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { ApiError } from '../api/client'
import { formatDateTime } from '../format'
import { HR_SOURCE_KIND_LABEL } from '../hr/api'
import { useSelfPermissions } from '../shell/permissions'
import { CONNECTOR_TARGET_LABEL } from './api'
import './DataFlows.css'
import { fetchDataFlows, type DataFlowMap, type DataFlowOutbound } from './data-flows-api'
import { OrganizationScopeSelector } from './OrganizationScopeSelector'

/**
 * "What of ours goes where" — the whole estate on one screen: the HR feeds
 * this system pulls FROM on the left, this system in the middle, and every
 * target it pushes TO on the right, each edge labelled with the attributes
 * that actually ride it.
 *
 * WHY THIS SCREEN EXISTS. The Connectors page answers "is Entra healthy" and
 * the attribute mapping editor answers "where does costCentre go". Neither
 * answers the question an auditor, a DPO or a new engineer actually asks
 * first, which is "what leaves this system, and to whom" — and answering it
 * previously meant cross-referencing two screens per target, thirteen times.
 *
 * Deliberately NOT a health dashboard: no live reachability check is made
 * here (see the controller's own doc comment). A dormant edge and a broken
 * one look the same on this page ON PURPOSE — "is it working right now" is
 * the Connectors page's question, and duplicating it would make the map
 * unavailable exactly when part of the estate is down.
 *
 * docs/design-system.md: status is never conveyed by colour alone. Every
 * state below carries a WORD; colour only reinforces it. All colour comes
 * from tokens (check-css-tokens is a gate).
 */

/** A dormant edge is not an error — it is the normal state of a target nobody has configured. Three words, not two, so "configured but off" reads differently from "never set up". */
function edgeState(edge: DataFlowOutbound): { word: string; variant: 'live' | 'idle' | 'off' } {
  if (!edge.configured) return { word: 'Not configured', variant: 'off' }
  if (!edge.enabled) return { word: 'Disabled', variant: 'off' }
  if (edge.lastSuccessfulSyncAt === null) return { word: 'Enabled, never synced', variant: 'idle' }
  return { word: 'Live', variant: 'live' }
}

function OutboundCard({ edge }: { edge: DataFlowOutbound }) {
  const state = edgeState(edge)
  const enabledAttributes = edge.attributes.filter((attribute) => attribute.enabled)
  const disabledAttributes = edge.attributes.filter((attribute) => !attribute.enabled)

  return (
    <li className="flow-card" data-state={state.variant}>
      <div className="flow-card__head">
        <span className="flow-card__name">{CONNECTOR_TARGET_LABEL[edge.target]}</span>
        <span className={`badge badge--${state.variant === 'live' ? 'neutral' : state.variant === 'idle' ? 'warn' : 'neutral'}`}>
          {state.variant === 'idle' && <span className="badge__dot" aria-hidden="true" />}
          {state.word}
        </span>
      </div>

      <dl className="flow-card__meta">
        <div>
          <dt>Population</dt>
          <dd>
            {!edge.carriesUsers
              ? 'Applications, not people'
              : edge.provisioningMode === 'entitled_only'
                ? 'Only entitled users'
                : 'All users'}
          </dd>
        </div>
        <div>
          <dt>Last successful sync</dt>
          <dd>{edge.lastSuccessfulSyncAt === null ? 'Never' : formatDateTime(edge.lastSuccessfulSyncAt)}</dd>
        </div>
      </dl>

      {edge.carriesUsers && (
        <div className="flow-card__attributes">
          {enabledAttributes.length === 0 ? (
            <p className="flow-card__empty">
              No attribute mappings — this target receives the core identity fields only.
            </p>
          ) : (
            <ul className="flow-chips">
              {enabledAttributes.map((attribute) => (
                <li key={`${attribute.localKey}-${attribute.remoteName}`} className="flow-chip">
                  <span className="flow-chip__local">{attribute.label ?? attribute.localKey}</span>
                  <span className="flow-chip__arrow" aria-label="maps to">
                    →
                  </span>
                  <span className="flow-chip__remote">{attribute.remoteName}</span>
                </li>
              ))}
            </ul>
          )}

          {/* Shown rather than hidden: "this used to flow and no longer does"
              is exactly what this screen is for, and on a partial-update
              target the sync actively CLEARS such a name downstream. */}
          {disabledAttributes.length > 0 && (
            <details className="flow-card__disabled">
              <summary>
                {disabledAttributes.length} mapping{disabledAttributes.length === 1 ? '' : 's'} turned off
              </summary>
              <ul className="flow-chips">
                {disabledAttributes.map((attribute) => (
                  <li key={`${attribute.localKey}-${attribute.remoteName}`} className="flow-chip flow-chip--off">
                    <span className="flow-chip__local">{attribute.label ?? attribute.localKey}</span>
                    <span className="flow-chip__arrow" aria-hidden="true">
                      →
                    </span>
                    <span className="flow-chip__remote">{attribute.remoteName}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </li>
  )
}

export default function DataFlowsPage() {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const permissions = useSelfPermissions()

  const canRead = permissions.status === 'ready' && permissions.actions.has('connector:read')
  const canListOrganizations = permissions.status === 'ready' && permissions.actions.has('organization:read')

  const [organizationId, setOrganizationId] = useState<string | undefined>(undefined)
  const [map, setMap] = useState<DataFlowMap | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** Dormant targets are collapsed by default: on a fresh install eleven of thirteen are unconfigured, and showing them all first would bury the two that matter. */
  const [showDormant, setShowDormant] = useState(false)

  useEffect(() => {
    if (accessToken === undefined) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)

    fetchDataFlows(accessToken, organizationId)
      .then((res) => {
        if (!cancelled) setMap(res)
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setLoadError(cause instanceof ApiError ? cause.message : 'Could not load the data-flow map. Try again.')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [accessToken, organizationId])

  if (permissions.status === 'ready' && !canRead) {
    return (
      <div className="page">
        <header className="page-header">
          <div className="page-header__text">
            <h1>Data flows</h1>
          </div>
        </header>
        <p className="cell-muted">
          You don&rsquo;t have access to data flows — this area needs the connector-read permission.
        </p>
      </div>
    )
  }

  const active = map?.outbound.filter((edge) => edge.configured && edge.enabled) ?? []
  const dormant = map?.outbound.filter((edge) => !edge.configured || !edge.enabled) ?? []

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header__text">
          <h1>Data flows</h1>
          <p className="page-header__lede">
            Where identity data comes from, and everywhere it goes. Read-only — configure sources under HR sources and
            targets under Connectors.
          </p>
        </div>
        <OrganizationScopeSelector
          canListOrganizations={canListOrganizations}
          selectedOrganizationId={organizationId}
          onChange={setOrganizationId}
        />
      </header>

      {loadError !== null && (
        <p className="cell-muted" role="alert">
          {loadError}
        </p>
      )}

      {loading && map === null ? (
        <p className="cell-muted">Loading the map…</p>
      ) : map === null ? null : (
        <div className="flow-map">
          {/* ---------------------------------------------------- inbound */}
          <section className="flow-column" aria-labelledby="flow-inbound-heading">
            <h2 id="flow-inbound-heading" className="flow-column__heading">
              Sources
            </h2>
            {map.inbound.length === 0 ? (
              <p className="cell-muted">
                No HR sources configured. People are created through the API, the console or a pushed import.
              </p>
            ) : (
              <ul className="flow-list">
                {map.inbound.map((source) => (
                  <li key={source.id} className="flow-card" data-state={source.enabled ? 'live' : 'off'}>
                    <div className="flow-card__head">
                      <span className="flow-card__name">{source.name}</span>
                      <span className="badge badge--neutral">{source.enabled ? 'Enabled' : 'Disabled'}</span>
                    </div>
                    <dl className="flow-card__meta">
                      <div>
                        <dt>Kind</dt>
                        <dd>{HR_SOURCE_KIND_LABEL[source.kind]}</dd>
                      </div>
                      <div>
                        <dt>Upstream</dt>
                        <dd>{source.host}</dd>
                      </div>
                      <div>
                        <dt>Last run</dt>
                        <dd>
                          {source.lastRunFinishedAt === null
                            ? 'Never'
                            : `${formatDateTime(source.lastRunFinishedAt)}${
                                source.lastRunOutcome === null ? '' : ` — ${source.lastRunOutcome.replace(/_/g, ' ')}`
                              }`}
                        </dd>
                      </div>
                    </dl>
                    <div className="flow-card__attributes">
                      <ul className="flow-chips">
                        {source.populatesColumns.map((column) => (
                          <li key={column} className="flow-chip">
                            <span className="flow-chip__remote">{column}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ------------------------------------------------------ centre */}
          <section className="flow-column flow-column--hub" aria-labelledby="flow-hub-heading">
            <h2 id="flow-hub-heading" className="flow-column__heading">
              Identity Manager
            </h2>
            <div className="flow-hub">
              <p className="flow-hub__name">{map.organizationName}</p>
              <p className="flow-hub__detail">
                The system of record. Everything on the left writes into it; everything on the right is written from it.
              </p>
            </div>
          </section>

          {/* --------------------------------------------------- outbound */}
          <section className="flow-column" aria-labelledby="flow-outbound-heading">
            <h2 id="flow-outbound-heading" className="flow-column__heading">
              Targets
            </h2>
            {active.length === 0 ? (
              <p className="cell-muted">No targets are enabled. Nothing leaves this system.</p>
            ) : (
              <ul className="flow-list">
                {active.map((edge) => (
                  <OutboundCard key={edge.target} edge={edge} />
                ))}
              </ul>
            )}

            {dormant.length > 0 && (
              <div className="flow-dormant">
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => setShowDormant((previous) => !previous)}
                  aria-expanded={showDormant}
                >
                  {showDormant ? 'Hide' : 'Show'} {dormant.length} target{dormant.length === 1 ? '' : 's'} not currently
                  receiving data
                </button>
                {showDormant && (
                  <ul className="flow-list">
                    {dormant.map((edge) => (
                      <OutboundCard key={edge.target} edge={edge} />
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
