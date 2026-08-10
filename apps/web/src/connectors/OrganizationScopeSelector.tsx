import { useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { fetchOrganizationsPage, type Organization } from '../organizations/api'

/** A generous page — an operator's tenant roster is small relative to this, and the connector console has no need for its own pagination UI on top of this selector. */
const PAGE_LIMIT = 200

/**
 * Per-organization connector targets: an org selector for the connector
 * admin console. `connector_targets`' identity is (organization_id, target),
 * so every config, health, dead-letter and dry-run view on `/connectors` and
 * `/connectors/:target` is now scoped to ONE organization at a time — this
 * is the control that chooses which one.
 *
 * Requires `organization:read` to enumerate the roster at all — a caller
 * without it sees a fixed "Master" label and nothing else, exactly the
 * degrade `ConnectorTargetsController` itself falls back to server-side
 * (an omitted `?organizationId=` resolves to master), so the console never
 * shows a picker that cannot do anything.
 */
export function OrganizationScopeSelector({
  canListOrganizations,
  selectedOrganizationId,
  onChange,
}: {
  canListOrganizations: boolean
  /** `undefined` means master — the same "omitted means master" contract every connector-targets API call uses. */
  selectedOrganizationId: string | undefined
  onChange: (organizationId: string | undefined) => void
}) {
  const auth = useAuth()
  const accessToken = auth.user?.access_token

  const [organizations, setOrganizations] = useState<Organization[] | null>(null)

  useEffect(() => {
    if (accessToken === undefined || !canListOrganizations) return
    let cancelled = false
    fetchOrganizationsPage(accessToken, { limit: PAGE_LIMIT, offset: 0 })
      .then((page) => {
        if (!cancelled) setOrganizations(page.items)
      })
      .catch(() => {
        // A failed roster load degrades to "master only", the same
        // fail-safe posture as `!canListOrganizations` below — never blocks
        // the rest of the console on a roster it did not strictly need.
        if (!cancelled) setOrganizations(null)
      })
    return () => {
      cancelled = true
    }
  }, [accessToken, canListOrganizations])

  if (!canListOrganizations || organizations === null) {
    return (
      <div className="field connectors-page__org-scope">
        <span className="field__label">Organization</span>
        <span className="cell-muted" data-testid="connector-org-scope-fixed">
          Master
        </span>
      </div>
    )
  }

  return (
    <div className="field connectors-page__org-scope">
      <label className="field__label" htmlFor="connector-org-scope">
        Organization
      </label>
      <select
        id="connector-org-scope"
        className="select"
        value={selectedOrganizationId ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        data-testid="connector-org-scope-select"
      >
        {organizations.map((organization) => (
          <option key={organization.id} value={organization.isMaster ? '' : organization.id}>
            {organization.name}
            {organization.isMaster ? ' (master)' : ''}
          </option>
        ))}
      </select>
    </div>
  )
}
