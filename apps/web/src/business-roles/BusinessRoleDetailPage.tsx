import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link, useParams } from 'react-router-dom'
import { ApiError } from '../api/client'
import { formatDateTime } from '../format'
import { ConfirmDialog } from '../shell/ConfirmDialog'
import { useSelfPermissions } from '../shell/permissions'
import { useToast } from '../shell/ToastProvider'
import { BusinessRoleExceptionsTab } from './BusinessRoleExceptionsTab'
import { DefinitionEditor } from './DefinitionEditor'
import { SimulatePanel } from './SimulatePanel'
import { BusinessRoleStatusBadge, DRAFT_HEADLINE, DraftStateBadge } from './badges'
import {
  draftStateOf,
  fetchBusinessRole,
  fetchBusinessRoleMembers,
  publishBusinessRole,
  saveBusinessRoleDraft,
  setBusinessRoleEnabled,
  setBusinessRoleRequestable,
  simulateBusinessRole,
  type BusinessRoleDetail,
  type BusinessRoleMembersReport,
  type RoleDefinition,
  type SimulationReport,
} from './api'
import './BusinessRoleDetailPage.css'

type TabKey = 'definition' | 'exceptions' | 'members'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'definition', label: 'Definition' },
  { key: 'exceptions', label: 'Exceptions' },
  { key: 'members', label: 'Members' },
]

/** Structural equality over a definition, so "dirty" means the formula genuinely differs — not that a React state object was replaced. */
function sameDefinition(a: RoleDefinition, b: RoleDefinition): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** What the editor should open on: the pending draft if there is one, otherwise a copy of what is published. Editing starts from the truth on screen. */
function seedDefinition(role: BusinessRoleDetail): RoleDefinition {
  return role.draftDefinition ?? { conditions: role.conditions, grants: role.grants }
}

/**
 * `/business-roles/:id` — Milestone 17, Tasks 17 and 18.
 *
 * THE GATE IS THE PAGE. Everything here is arranged around one sequence:
 * draft (changes nobody's access) -> simulate (commits nothing, but is
 * recorded) -> publish (moves real memberships). The header states which of
 * the three states this role is in, in words, and the primary action is
 * whichever step comes next — never a Publish button sitting available
 * beside a diff that no longer matches the draft.
 *
 * The API enforces all of this regardless (`publishWithin` compares the
 * recorded simulation hash against the draft's own hash inside the publishing
 * transaction, under a row lock). What this page adds is that an admin should
 * not have to discover the rule by being refused.
 */
export default function BusinessRoleDetailPage() {
  const { id } = useParams<{ id: string }>()
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const permissions = useSelfPermissions()
  const { showToast } = useToast()

  const canRead = permissions.status === 'ready' && permissions.actions.has('business_role:read')
  /**
   * `business_role:manage` is super_admin's alone AND the API additionally
   * requires the grant to be GLOBAL (`requireGlobalManageGrant` — a business
   * role belongs to no org unit, so there is nothing for a scoped grant to
   * narrow to). `GET /self/permissions` reports the action, not its scope, so
   * an org-unit-scoped super admin will see these controls and be refused by
   * the API with a message that explains exactly that. Hiding is for clarity;
   * the API is still the authority (docs/product-brief.md).
   */
  const canManage = permissions.status === 'ready' && permissions.actions.has('business_role:manage')

  const [role, setRole] = useState<BusinessRoleDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  const [draft, setDraft] = useState<RoleDefinition | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const [report, setReport] = useState<SimulationReport | null>(null)
  const [simulating, setSimulating] = useState(false)
  const [simulateError, setSimulateError] = useState<string | null>(null)

  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)

  const [disableOpen, setDisableOpen] = useState(false)
  const [enabling, setEnabling] = useState(false)
  const [togglingRequestable, setTogglingRequestable] = useState(false)

  const [activeTab, setActiveTab] = useState<TabKey>('definition')

  /**
   * Membership, fetched only when the tab is opened. It is a full walk of the
   * tenant's users on the server, so it is not something to run on every
   * page load for the benefit of the two tabs that don't show it.
   */
  const [members, setMembers] = useState<BusinessRoleMembersReport | null>(null)
  const [membersLoading, setMembersLoading] = useState(false)
  const [membersError, setMembersError] = useState<string | null>(null)
  const tabRefs = useRef<Record<TabKey, HTMLButtonElement | null>>({
    definition: null,
    exceptions: null,
    members: null,
  })

  const reload = useCallback(() => setReloadToken((t) => t + 1), [])

  useEffect(() => {
    if (accessToken === undefined || id === undefined) return
    if (permissions.status !== 'ready' || !canRead) {
      if (permissions.status === 'ready') setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setLoadError(null)

    void fetchBusinessRole(accessToken, id)
      .then((next) => {
        if (cancelled) return
        setRole(next)
        setDraft(seedDefinition(next))
        // A fresh read is a fresh truth: any simulation held in this
        // component belongs to a draft that may no longer be the one on the
        // server. Cleared rather than carried forward — a stale diff beside
        // a live Publish button is the exact thing this screen must never
        // show.
        setReport(null)
        setSimulateError(null)
        setPublishError(null)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setLoadError(
          cause instanceof ApiError
            ? cause.status === 404
              ? 'That business role does not exist, or it has been removed.'
              : `Could not load this business role: ${cause.message}`
            : 'Could not load this business role. Check your connection and try again.',
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [accessToken, canRead, id, permissions.status, reloadToken])

  const savedDefinition = useMemo(() => (role === null ? null : seedDefinition(role)), [role])
  const dirty = role !== null && draft !== null && savedDefinition !== null && !sameDefinition(draft, savedDefinition)
  const draftState = role === null ? 'none' : draftStateOf(role)
  /* Publish is available on exactly one condition, and it is the API's own:
     a draft exists AND a simulation was recorded for it. Unsaved local edits
     block it too — publishing what is on the server while the editor shows
     something else would be the same lie from the other direction. */
  const canPublishNow = canManage && draftState === 'ready-to-publish' && !dirty

  async function handleSaveDraft() {
    if (accessToken === undefined || id === undefined || draft === null) return
    setSaving(true)
    setSaveError(null)
    try {
      const next = await saveBusinessRoleDraft(accessToken, id, draft)
      setRole(next)
      setDraft(seedDefinition(next))
      // The server just cleared simulated_at. The panel must clear with it —
      // Task 18's own rule: "the UI must never show a stale diff next to a
      // live Publish button."
      setReport(null)
      setPublishError(null)
      showToast('Draft saved — nobody’s access changed. Simulate it to see what publishing would do.')
    } catch (cause) {
      setSaveError(
        cause instanceof ApiError ? cause.message : 'Could not save the draft. Check your connection and try again.',
      )
    } finally {
      setSaving(false)
    }
  }

  async function handleSimulate() {
    if (accessToken === undefined || id === undefined) return
    setSimulating(true)
    setSimulateError(null)
    setPublishError(null)
    try {
      const next = await simulateBusinessRole(accessToken, id)
      setReport(next)
      // The simulation RECORDED itself server-side (simulated_at /
      // simulated_draft_hash), so the role row on screen is now stale in
      // exactly the field the publish gate reads. Re-read rather than patch
      // it locally: the recorded hash is the gate's own evidence and this
      // page should never hold a guess about it.
      const refreshed = await fetchBusinessRole(accessToken, id)
      setRole(refreshed)
      setDraft(seedDefinition(refreshed))
      setReport(next)
    } catch (cause) {
      setSimulateError(
        cause instanceof ApiError
          ? cause.status === 409
            ? `${cause.message}. Save a draft first — there is nothing to compare against what is published.`
            : cause.message
          : 'Could not run the simulation. Check your connection and try again.',
      )
    } finally {
      setSimulating(false)
    }
  }

  async function handlePublish() {
    if (accessToken === undefined || id === undefined || role === null) return
    const hadSimulation = role.simulatedAt !== null
    setPublishing(true)
    setPublishError(null)
    try {
      const published = await publishBusinessRole(accessToken, id)
      setRole(published)
      setDraft(seedDefinition(published))
      setReport(null)
      const moved = published.reconciliation.changed
      showToast(
        moved === 0
          ? 'Published — no one’s entitlements moved.'
          : `Published — ${moved} ${moved === 1 ? 'person’s' : 'people’s'} entitlements were reconciled.`,
      )
    } catch (cause) {
      /*
       * TWO different 409s reach here, and they mean different things to the
       * person reading them. The API cannot tell them apart — both come out
       * of `publishWithin` as "this draft has not been simulated" — but this
       * page can, because it knows whether the role it loaded already had a
       * recorded simulation. If it did, the draft changed underneath that
       * simulation (another admin saved one, or this session's own save
       * raced the read); if it did not, no simulation was ever run. Same
       * remedy, different story, and telling an admin "you never simulated
       * this" when they watched it simulate a minute ago is how a safety
       * rail loses its credibility.
       */
      if (cause instanceof ApiError && cause.status === 409) {
        if (cause.message.includes('segregation-of-duties')) {
          // The THIRD 409, and the one that is not a staleness story: the
          // simulation of this exact draft found SoD violations, and the
          // gate refused. The server message states the count and the
          // remedy; the SimulatePanel below is already showing exactly who
          // and why.
          setPublishError(cause.message)
        } else if (cause.message.includes('no draft')) {
          setPublishError('There are no pending changes to publish — this role is already published as it stands.')
        } else if (hadSimulation) {
          setPublishError(
            'The draft changed after it was simulated, so the diff you were shown no longer describes it. Simulate again before publishing.',
          )
        } else {
          setPublishError('This draft has not been simulated. Run a simulation first — publishing without one is refused.')
        }
        reload()
      } else {
        setPublishError(
          cause instanceof ApiError ? cause.message : 'Could not publish. Check your connection and try again.',
        )
      }
    } finally {
      setPublishing(false)
    }
  }

  /**
   * Publish this role into the self-service catalogue, or withdraw it.
   *
   * `PUT /business-roles/:id/requestable` has existed since the catalogue did,
   * and nothing called it — so a role could be enabled and granting, and still
   * be invisible to the people who might legitimately ask for it, with no way
   * to change that outside the database.
   *
   * Deliberately NOT folded into the enable/disable control beside it.
   * Withdrawing stops NEW requests and grants or revokes nothing; disabling
   * revokes. Presenting them as one switch would invite an admin reaching for
   * the smaller action to take the larger one.
   */
  async function handleToggleRequestable() {
    if (accessToken === undefined || id === undefined || role === null) return
    const next = !role.requestable
    setTogglingRequestable(true)
    try {
      const updated = await setBusinessRoleRequestable(accessToken, id, next)
      setRole((current) => (current === null ? current : { ...current, requestable: updated.requestable }))
      showToast(
        next
          ? `${updated.name} is in the request catalogue — people can ask for it; nobody has been granted anything.`
          : `${updated.name} is out of the request catalogue. Existing access is untouched; only new requests stop.`,
      )
    } catch (cause) {
      showToast(
        cause instanceof ApiError ? cause.message : 'Could not change the catalogue setting.',
        'danger',
      )
    } finally {
      setTogglingRequestable(false)
    }
  }

  async function handleEnable() {
    if (accessToken === undefined || id === undefined) return
    setEnabling(true)
    try {
      const result = await setBusinessRoleEnabled(accessToken, id, true)
      setRole(result)
      setDraft(seedDefinition(result))
      showToast(
        result.principalsGranted === 0
          ? 'Enabled — nobody matched, so no one gained anything yet.'
          : `Enabled — ${result.principalsGranted} ${result.principalsGranted === 1 ? 'person' : 'people'} gained what this role grants.`,
      )
    } catch (cause) {
      showToast(cause instanceof ApiError ? cause.message : 'Could not enable this role.', 'danger')
    } finally {
      setEnabling(false)
    }
  }

  /** Rejecting keeps ConfirmDialog open and shows the failure inline; resolving leaves closing to us (that component's own contract). */
  async function handleConfirmDisable() {
    if (accessToken === undefined || id === undefined) return
    const result = await setBusinessRoleEnabled(accessToken, id, false)
    setRole(result)
    setDraft(seedDefinition(result))
    setDisableOpen(false)
    const lost = result.principalsRevoked
    const grantCount = result.grants.length
    showToast(
      lost === 0
        ? `Disabled — nobody held ${result.name}, so nothing was revoked.`
        : `Disabled — ${lost} ${lost === 1 ? 'person' : 'people'} lost ${grantCount} ${grantCount === 1 ? 'grant' : 'grants'}.`,
      'danger',
    )
  }

  useEffect(() => {
    if (activeTab !== 'members' || accessToken === undefined || id === undefined) return
    let cancelled = false
    setMembersLoading(true)
    setMembersError(null)
    void fetchBusinessRoleMembers(accessToken, id)
      .then((report) => {
        if (!cancelled) setMembers(report)
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setMembersError(
            // Verbatim: the commonest refusal here is a condition the server
            // cannot evaluate, and its message names the condition.
            cause instanceof ApiError ? cause.message : 'Could not work out who holds this role.',
          )
        }
      })
      .finally(() => {
        if (!cancelled) setMembersLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeTab, accessToken, id, reloadToken])

  function activateTab(key: TabKey) {
    setActiveTab(key)
    tabRefs.current[key]?.focus()
  }

  function handleTabsKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const currentIndex = TABS.findIndex((t) => t.key === activeTab)
    let nextIndex = currentIndex
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % TABS.length
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + TABS.length) % TABS.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = TABS.length - 1
    else return
    event.preventDefault()
    activateTab(TABS[nextIndex].key)
  }

  if (permissions.status === 'ready' && !canRead) {
    return (
      <div className="br-detail">
        <p className="cell-muted" data-testid="business-role-permission-note">
          You don&rsquo;t hold the business_role:read permission, so you can&rsquo;t view this role.
        </p>
      </div>
    )
  }

  if (loading || role === null || draft === null) {
    return (
      <div className="br-detail">
        {loadError !== null ? (
          <div className="error-panel" role="alert">
            <p className="error-panel__message">{loadError}</p>
            <Link to="/business-roles" className="btn btn--secondary">
              Back to business roles
            </Link>
          </div>
        ) : (
          <div className="br-detail__skeletons" aria-hidden="true">
            <span className="skeleton" style={{ width: '18rem', height: '1.6rem', display: 'block' }} />
            <span className="skeleton" style={{ width: '32rem', height: '1rem', display: 'block' }} />
            <span className="skeleton" style={{ width: '100%', height: '12rem', display: 'block' }} />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="br-detail">
      <nav className="br-detail__breadcrumb" aria-label="Breadcrumb">
        <Link to="/business-roles">Business roles</Link>
      </nav>

      <div className="page-header">
        <div className="page-header__text">
          <h1 className="text-subject" data-testid="business-role-name">
            {role.name}
          </h1>
          <p className="page-header__subtitle">
            {role.description ?? 'No description. Say what this role is for — the next admin reading it will thank you.'}
          </p>
          <div className="br-detail__badges">
            <BusinessRoleStatusBadge enabled={role.enabled} />
            <DraftStateBadge role={role} />
          </div>
        </div>

        <div className="br-detail__actions">
          {canManage && (
            <>
              {draftState === 'pending-simulation' && (
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={simulating || dirty}
                  data-loading={simulating ? 'true' : undefined}
                  onClick={() => {
                    activateTab('definition')
                    void handleSimulate()
                  }}
                  data-testid="simulate-role"
                >
                  <span className="btn__label">Simulate</span>
                  <span className="btn__spinner" aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                className="btn btn--primary"
                disabled={!canPublishNow || publishing}
                data-loading={publishing ? 'true' : undefined}
                onClick={() => void handlePublish()}
                data-testid="publish-role"
              >
                <span className="btn__label">Publish</span>
                <span className="btn__spinner" aria-hidden="true" />
              </button>
              {role.enabled ? (
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={() => setDisableOpen(true)}
                  data-testid="disable-role"
                >
                  Disable
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn--secondary"
                  disabled={enabling}
                  data-loading={enabling ? 'true' : undefined}
                  onClick={() => void handleEnable()}
                  data-testid="enable-role"
                >
                  <span className="btn__label">Enable</span>
                  <span className="btn__spinner" aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                className="btn btn--secondary"
                disabled={togglingRequestable}
                data-loading={togglingRequestable ? 'true' : undefined}
                onClick={() => void handleToggleRequestable()}
                data-testid="toggle-requestable"
              >
                <span className="btn__label">
                  {role.requestable ? 'Remove from catalogue' : 'Add to request catalogue'}
                </span>
                <span className="btn__spinner" aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* The state line. Three states, three sentences, and — where the next
          step is not yet possible — the reason, so a disabled Publish button
          is never a mystery. */}
      <p className="br-detail__state" data-testid="business-role-state">
        <strong>{dirty ? 'Unsaved changes' : DRAFT_HEADLINE[draftState]}</strong>
        {dirty
          ? ' — the editor below differs from the saved draft. Save it, then simulate.'
          : draftState === 'pending-simulation'
            ? ' — publishing is blocked until this draft has been simulated.'
            : draftState === 'ready-to-publish'
              ? ` — simulated ${role.simulatedAt === null ? '' : formatDateTime(role.simulatedAt)}. Publishing applies it and reconciles everyone it touches.`
              : ' — the published formula below is what is granting access right now.'}
      </p>

      {publishError !== null && (
        <div className="banner banner--error" role="alert" data-testid="publish-error">
          {publishError}
        </div>
      )}

      {!role.enabled && (
        <div className="banner banner--warn" data-testid="disabled-banner">
          This role is disabled, so it is granting nothing. You can still draft, simulate and publish
          — none of that takes effect until it is enabled.
        </div>
      )}

      <ConfirmDialog
        open={disableOpen}
        title={`Disable ${role.name}?`}
        confirmLabel="Disable and revoke"
        tone="danger"
        onConfirm={handleConfirmDisable}
        onDismiss={() => setDisableOpen(false)}
        testId="disable-dialog"
      >
        <p data-testid="disable-consequence">
          Disabling is a revocation, not a pause. Everyone this role is currently granting loses{' '}
          {role.grants.length === 1 ? 'the grant' : `all ${role.grants.length} grants`} it makes,
          immediately — the sweep runs as part of this action.
        </p>
        <p>
          Anything those people hold from another role, or that was granted to them by hand, is
          untouched: this role only ever revokes what it made. You&rsquo;ll be told how many people
          were affected.
        </p>
      </ConfirmDialog>

      <div className="tabs" role="tablist" aria-label="Business role sections" onKeyDown={handleTabsKeyDown}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            ref={(el) => {
              tabRefs.current[tab.key] = el
            }}
            id={`br-tab-${tab.key}`}
            role="tab"
            type="button"
            aria-selected={activeTab === tab.key}
            aria-controls={`br-panel-${tab.key}`}
            tabIndex={activeTab === tab.key ? 0 : -1}
            className="tab"
            onClick={() => activateTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        id="br-panel-definition"
        role="tabpanel"
        aria-labelledby="br-tab-definition"
        hidden={activeTab !== 'definition'}
        tabIndex={0}
        className="tabpanel"
      >
        <p className="br-detail__section-hint br-detail__safety">
          Nothing on this tab changes anyone&rsquo;s access. You are editing a draft; it takes effect
          only when it is simulated and then published.
        </p>

        <DefinitionEditor definition={draft} editable={canManage} disabled={saving} onChange={setDraft} />

        {saveError !== null && (
          <p className="field__error" role="alert" data-testid="draft-save-error">
            {saveError}
          </p>
        )}

        {canManage && (
          <div className="br-detail__draft-actions">
            <button
              type="button"
              className="btn btn--secondary"
              disabled={!dirty || saving}
              onClick={() => setDraft(savedDefinition ?? draft)}
            >
              Discard changes
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!dirty || saving}
              data-loading={saving ? 'true' : undefined}
              onClick={() => void handleSaveDraft()}
              data-testid="save-draft"
            >
              <span className="btn__label">Save draft</span>
              <span className="btn__spinner" aria-hidden="true" />
            </button>
          </div>
        )}

        <div className="br-detail__simulate">
          <SimulatePanel
            report={report}
            running={simulating}
            error={simulateError}
            canSimulate={canManage}
            hasDraft={role.draftDefinition !== null}
            dirty={dirty}
            onSimulate={() => void handleSimulate()}
          />
        </div>
      </div>

      <div
        id="br-panel-exceptions"
        role="tabpanel"
        aria-labelledby="br-tab-exceptions"
        hidden={activeTab !== 'exceptions'}
        tabIndex={0}
        className="tabpanel"
      >
        <BusinessRoleExceptionsTab
          roleId={role.id}
          roleName={role.name}
          exceptions={role.exceptions}
          canManage={canManage}
          onChanged={reload}
        />
      </div>

      <div
        id="br-panel-members"
        role="tabpanel"
        aria-labelledby="br-tab-members"
        hidden={activeTab !== 'members'}
        tabIndex={0}
        className="tabpanel"
      >
        {membersError !== null ? (
          <div className="error-panel" role="alert">
            <p className="error-panel__message">{membersError}</p>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => setReloadToken((token) => token + 1)}
            >
              Try again
            </button>
          </div>
        ) : membersLoading && members === null ? (
          <span className="skeleton" style={{ height: '8rem', display: 'block' }} />
        ) : members === null ? null : members.total === 0 ? (
          <div className="empty-state" data-testid="members-empty">
            <h3>Nobody holds this role</h3>
            <p>
              {members.scanned} {members.scanned === 1 ? 'person was' : 'people were'} evaluated
              against the published definition and none of them matched. An unpublished role holds
              nobody by design — publish a definition on the Definition tab first.
            </p>
          </div>
        ) : (
          <>
            <p className="cell-muted" data-testid="members-summary">
              <strong>{members.total}</strong> of {members.scanned} people evaluated hold this role.
              Membership is worked out from the published definition each time you ask — nobody is
              stored as a member.
            </p>
            <table className="table" data-testid="members-table">
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Status</th>
                  <th scope="col">In the role because</th>
                </tr>
              </thead>
              <tbody>
                {members.members.map((member) => (
                  <tr key={member.userId} data-testid="member-row">
                    <td>
                      <Link to={`/people/${member.userId}`}>
                        {member.firstName !== null || member.lastName !== null
                          ? `${member.firstName ?? ''} ${member.lastName ?? ''}`.trim()
                          : (member.username ?? member.userId)}
                      </Link>
                      <div className="cell-muted mono">{member.username ?? member.userId}</div>
                    </td>
                    <td className="cell-muted">{member.status ?? '—'}</td>
                    <td>
                      {/*
                        Not decoration. Someone here by FORMULA is here because
                        of their own data — fix the formula, or fix the person.
                        Someone here by exception was put here by hand and has a
                        recorded reason worth revisiting.
                      */}
                      {member.via === 'formula' ? (
                        <span className="badge">Matches the formula</span>
                      ) : (
                        <span className="badge badge--warn" data-testid="member-via-exception">
                          Added by exception
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {members.truncated && (
              <p className="cell-muted">
                Showing the first {members.members.length}. The count above is exact.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
