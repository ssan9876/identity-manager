import { useOrganizations } from './OrganizationContext'
import './OrganizationSwitcher.css'

/**
 * The tenant selector, in the topbar beside the theme toggle.
 *
 * RENDERS NOTHING AT ALL unless there is genuinely a choice to make: an actor
 * without `organization:read` (everyone but super_admin) sees no control, and
 * neither does anyone on a single-tenant deployment. A switcher offering one
 * option is a control that cannot do anything, and it would appear on the
 * overwhelming majority of installs — where it would read as a feature that
 * is broken rather than one that is inapplicable.
 *
 * Switching is a change of VIEW, not of identity. Every administrator here
 * authenticates against the master realm as a platform operator, so there is
 * no re-authentication and no second token — what changes is the
 * `organizationId` filter the directory screens send. The label says
 * "Viewing" for exactly that reason: it is not a role, and it is not a
 * login.
 */
export function OrganizationSwitcher() {
  const { list, selectedId, select, ready } = useOrganizations()

  if (!ready || list.length < 2) return null

  return (
    <label className="org-switcher" data-testid="org-switcher">
      <span className="org-switcher__label">Viewing</span>
      <select
        className="org-switcher__select"
        value={selectedId ?? ''}
        onChange={(event) => select(event.target.value === '' ? null : event.target.value)}
        data-testid="org-switcher-select"
      >
        {/* The unfiltered view stays reachable and stays the default. A
            platform operator's ordinary job spans tenants; narrowing is the
            deliberate act, not the resting state. */}
        <option value="">All organizations</option>
        {list.map((organization) => (
          <option key={organization.id} value={organization.id}>
            {organization.name}
          </option>
        ))}
      </select>
    </label>
  )
}
