import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link } from 'react-router-dom'
import { ApiError } from '../api/client'
import { BRAND } from '../brand'
import { Field, fieldDescribedBy } from '../forms/Field'
import { useSelfPermissions } from '../shell/permissions'
import { useToast } from '../shell/ToastProvider'
import {
  createOrganization,
  fetchOrganizationsPage,
  setOrganizationStatus,
  type Organization,
} from './api'
import { slugFromName } from './slug'
import { SYNC_LABEL_VARIANT, syncLabel } from './status'
import './Organizations.css'

const PAGE_LIMIT = 100

/**
 * Realm provisioning is asynchronous: the row lands immediately, the realm
 * follows once the sync worker drains the `organization` event, usually
 * within a second or two. Polling once at that horizon turns the common case
 * into "Provisioning flickers, then Active" with no refresh, without
 * installing a permanent timer on a page that is otherwise static.
 */
const PROVISIONING_RECHECK_MS = 3_000

function SyncBadge({ organization }: { organization: Organization }) {
  const label = syncLabel(organization)
  const variant = SYNC_LABEL_VARIANT[label]
  return (
    <span className={`badge badge--${variant}`} data-org-sync={label}>
      {variant !== 'neutral' && <span className="badge__dot" aria-hidden="true" />}
      {label}
    </span>
  )
}

/**
 * The organizations console — the tenant roster, a create form, and a
 * suspend/reactivate control per row. Organizations milestone, Task 15.
 *
 * THE TARGETS COLUMN LINKS OUT RATHER THAN GUESSING. `connector_targets` has
 * been keyed `(organization_id, target)` since migration 0033, and
 * `OutboxWriter.record` fans each organization out to whichever targets
 * ITS OWN catalogue enables (that method's own doc comment — this REPLACES
 * the former hard-coded "a tenant reaches Keycloak and nothing else" rule).
 * A tenant can therefore hold any combination of enabled targets, not just
 * Keycloak, and this page has no per-organization target data to summarise
 * even if it wanted to guess at one — `GET /organizations` returns the
 * `organizations` row alone. Rather than duplicate the connector-targets
 * read here (and drift again the moment a tenant's catalogue changes), the
 * column links straight through to `/connectors`, already scoped to that
 * organization via `?organizationId=`, which IS the live source of truth
 * for what is actually enabled.
 *
 * There is no per-organization detail page and no delete. A tenant has
 * exactly four facts (name, slug/realm, status, whether its realm exists),
 * all four fit in the row, and the only actions beyond the status toggle are
 * that link out to connector configuration — a bespoke organization detail
 * page would duplicate a screen that already exists.
 */
export default function OrganizationsPage() {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const perms = useSelfPermissions()
  const canRead = perms.status === 'ready' && perms.actions.has('organization:read')
  const canCreate = perms.status === 'ready' && perms.actions.has('organization:create')
  const canUpdate = perms.status === 'ready' && perms.actions.has('organization:update')
  const { showToast } = useToast()

  const [organizations, setOrganizations] = useState<Organization[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [formOpen, setFormOpen] = useState(false)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  // Once the admin edits the slug themselves, the name stops driving it —
  // otherwise typing the rest of the name would silently discard the value
  // they deliberately chose for something they can never rename.
  const [slugEdited, setSlugEdited] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(
    async (token: string): Promise<Organization[]> => {
      const page = await fetchOrganizationsPage(token, { limit: PAGE_LIMIT, offset: 0 })
      return page.items
    },
    [],
  )

  useEffect(() => {
    if (accessToken === undefined || !canRead) return
    let cancelled = false

    load(accessToken)
      .then((items) => {
        if (!cancelled) setOrganizations(items)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Could not load organizations')
      })

    return () => {
      cancelled = true
    }
  }, [accessToken, canRead, load])

  // One delayed re-read while anything is still provisioning — see
  // PROVISIONING_RECHECK_MS. Re-arms itself as long as the condition holds,
  // and stops the moment nothing is in flight, so a settled roster costs
  // nothing.
  useEffect(() => {
    if (accessToken === undefined || organizations === null) return
    const provisioning = organizations.some((org) => syncLabel(org) === 'Provisioning')
    if (!provisioning) return

    let cancelled = false
    const timer = setTimeout(() => {
      load(accessToken)
        .then((items) => {
          if (!cancelled) setOrganizations(items)
        })
        .catch(() => {
          // A failed background refresh is not worth a banner: the roster
          // already on screen is still accurate about everything except how
          // far provisioning has got, and the next attempt is 3 seconds away.
        })
    }, PROVISIONING_RECHECK_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [accessToken, organizations, load])

  function onNameChange(value: string) {
    setName(value)
    if (!slugEdited) setSlug(slugFromName(value))
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (accessToken === undefined || submitting) return
    setSubmitting(true)
    setFormError(null)
    try {
      const created = await createOrganization(accessToken, { slug, name })
      setOrganizations(await load(accessToken))
      setFormOpen(false)
      setName('')
      setSlug('')
      setSlugEdited(false)
      showToast(`${created.name} created — its realm is being provisioned.`)
    } catch (err: unknown) {
      // Shown verbatim: the API's refusals here are all specific and
      // actionable ("the slug ... is reserved", "already exists", and the
      // 503 naming the two environment variables an operator must set), and
      // paraphrasing them would lose exactly the part that says what to do.
      setFormError(err instanceof ApiError ? err.message : 'Could not create the organization')
    } finally {
      setSubmitting(false)
    }
  }

  async function onToggleStatus(organization: Organization) {
    if (accessToken === undefined) return
    const next = organization.status === 'active' ? 'suspended' : 'active'
    setBusyId(organization.id)
    try {
      await setOrganizationStatus(accessToken, organization.id, next)
      setOrganizations(await load(accessToken))
      showToast(
        next === 'suspended'
          ? `${organization.name} suspended — its realm is disabled, not deleted.`
          : `${organization.name} reactivated.`,
      )
    } catch (err: unknown) {
      showToast(
        err instanceof ApiError ? err.message : 'Could not change the organization status',
        'danger',
      )
    } finally {
      setBusyId(null)
    }
  }

  if (perms.status === 'ready' && !canRead) {
    return (
      <section className="page">
        <header className="page__header">
          <div>
            <h1>Organizations</h1>
          </div>
        </header>
        <p className="muted">
          You do not have permission to view organizations. Creating and suspending tenants
          is a platform-operator action.
        </p>
      </section>
    )
  }

  return (
    <section className="page">
      <header className="page__header">
        <div>
          <h1>Organizations</h1>
          <p className="page__subtitle">
            Each organization is a tenant with its own Keycloak realm. {BRAND.name} creates
            the realm; it never deletes one.
          </p>
        </div>
        {canCreate && !formOpen && (
          <button type="button" className="btn btn--primary" onClick={() => setFormOpen(true)}>
            New organization
          </button>
        )}
      </header>

      {error && (
        <p className="banner banner--error" role="alert">
          {error}
        </p>
      )}

      {formOpen && (
        <form className="org-form" onSubmit={(event) => void onSubmit(event)}>
          <Field id="org-name" label="Name" required>
            <input
              id="org-name"
              className="input"
              value={name}
              onChange={(event) => onNameChange(event.target.value)}
              autoFocus
            />
          </Field>
          <Field
            id="org-slug"
            label="Slug"
            required
            hint="Becomes the Keycloak realm name, permanently. Lower-case letters, digits and hyphens."
          >
            <input
              id="org-slug"
              className="input"
              value={slug}
              aria-describedby={fieldDescribedBy(
                'org-slug',
                null,
                'Becomes the Keycloak realm name, permanently.',
              )}
              onChange={(event) => {
                setSlugEdited(true)
                setSlug(event.target.value)
              }}
            />
          </Field>
          {formError && (
            <p className="banner banner--error" role="alert">
              {formError}
            </p>
          )}
          <div className="org-form__actions">
            <button type="submit" className="btn btn--primary" disabled={submitting}>
              Create
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                setFormOpen(false)
                setFormError(null)
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {organizations === null && !error && <p className="muted">Loading…</p>}

      {organizations !== null && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Slug</th>
                <th scope="col">Realm</th>
                <th scope="col">State</th>
                <th scope="col">Targets</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {organizations.map((org) => (
                <tr key={org.id}>
                  <td>
                    {org.name}
                    {org.isMaster && <span className="org-table__master"> · platform</span>}
                  </td>
                  <td>
                    <code>{org.slug}</code>
                  </td>
                  <td>{org.realm === null ? <span className="muted">—</span> : <code>{org.realm}</code>}</td>
                  <td>
                    <SyncBadge organization={org} />
                  </td>
                  <td>
                    {/* Links out rather than guessing — see this
                        component's own doc comment for why. */}
                    <Link
                      to={`/connectors${org.isMaster ? '' : `?organizationId=${org.id}`}`}
                      className="row-link"
                      data-testid={`org-targets-link-${org.id}`}
                    >
                      View targets
                    </Link>
                  </td>
                  <td>
                    {canUpdate && !org.isMaster && (
                      <button
                        type="button"
                        className="btn btn--sm btn--secondary"
                        disabled={busyId === org.id}
                        onClick={() => void onToggleStatus(org)}
                      >
                        {org.status === 'active' ? 'Suspend' : 'Reactivate'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
