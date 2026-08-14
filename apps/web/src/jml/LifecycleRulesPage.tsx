import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useAuth } from 'react-oidc-context'
import { ApiError } from '../api/client'
import { useSelfPermissions } from '../shell/permissions'
import { useToast } from '../shell/ToastProvider'
import {
  ALL_TRIGGERS,
  CONDITION_FIELDS,
  acknowledgeJmlSimulation,
  createJmlRule,
  fetchJmlRules,
  setJmlRuleEnabled,
  simulateJmlRule,
  type JmlActionType,
  type JmlConditionOperator,
  type JmlRule,
  type JmlSimulationReport,
  type JmlTrigger,
} from './api'
import './LifecycleRulesPage.css'

const TRIGGER_LABEL: Record<JmlTrigger, string> = {
  user_created: 'A person is created (joiner)',
  user_attribute_changed: 'A person’s attribute changes (mover)',
  start_date_reached: 'A start date arrives',
  end_date_reached: 'An end date passes (leaver)',
}

const OPERATOR_LABEL: Record<JmlConditionOperator, string> = {
  equals: 'is',
  not_equals: 'is not',
  in: 'is one of',
}

const ACTION_LABEL: Record<JmlActionType, string> = {
  set_attribute: 'Set an attribute',
  deactivate: 'Deactivate the account',
}

interface FormState {
  name: string
  trigger: JmlTrigger
  conditionField: string
  conditionOperator: JmlConditionOperator
  conditionValue: string
  action: JmlActionType
  attributeKey: string
  attributeValue: string
}

function emptyForm(): FormState {
  return {
    name: '',
    trigger: 'end_date_reached',
    conditionField: 'status',
    conditionOperator: 'equals',
    conditionValue: '',
    action: 'deactivate',
    attributeKey: '',
    attributeValue: '',
  }
}

/** A one-line plain-English reading of a rule, for the list. */
function describeRule(rule: JmlRule): string {
  const value = Array.isArray(rule.conditionValue)
    ? rule.conditionValue.join(', ')
    : String(rule.conditionValue ?? '')
  const when = TRIGGER_LABEL[rule.trigger] ?? rule.trigger
  const operator = OPERATOR_LABEL[rule.conditionOperator] ?? rule.conditionOperator
  const act =
    rule.action === 'set_attribute'
      ? `set ${String(rule.actionParams.key ?? '?')} to ${String(rule.actionParams.value ?? '?')}`
      : 'deactivate the account'
  return `${when} — if ${rule.conditionField} ${operator} ${value}, ${act}.`
}

/**
 * Lifecycle rules — the console's view of the automation that changes accounts
 * with nobody watching.
 *
 * This page exists because until very recently these rules had no HTTP surface
 * at all: they lived behind `lifecycle-cli.ts`, so an administrator could not
 * see what automation was live, let alone turn it off, without a shell on the
 * API host.
 *
 * The order of controls here is the safety property, not a layout choice. A
 * rule is created disabled; the only way to a live rule is Preview → read the
 * impact → "I have reviewed this" → Enable. The API enforces that ordering
 * itself (`setEnabled` re-checks `simulated_at` in the UPDATE's own WHERE
 * clause), so this page cannot subvert the gate by rearranging buttons — but
 * it should not fight it either, and a Preview that quietly counted as a review
 * would defeat it while appearing to honour it.
 */
export default function LifecycleRulesPage() {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const permissions = useSelfPermissions()
  const { showToast } = useToast()

  const canRead = permissions.status === 'ready' && permissions.actions.has('jml:read')
  const canManage = permissions.status === 'ready' && permissions.actions.has('jml:manage')

  const [rules, setRules] = useState<JmlRule[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)

  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const [preview, setPreview] = useState<JmlSimulationReport | null>(null)
  const [previewingId, setPreviewingId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(() => {
    if (accessToken === undefined || !canRead) return
    setLoading(true)
    setLoadError(null)
    let cancelled = false
    void fetchJmlRules(accessToken)
      .then((list) => {
        if (!cancelled) setRules(list)
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setLoadError(
            cause instanceof ApiError ? cause.message : 'Could not load lifecycle rules.',
          )
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [accessToken, canRead])

  useEffect(() => load(), [load, retryToken])

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    if (accessToken === undefined) return
    setSubmitting(true)
    setFormError(null)
    try {
      // `in` takes a list; everything else takes one scalar. The API refuses
      // the mismatch by name, so this only has to send the right shape rather
      // than re-explain the rule.
      const conditionValue =
        form.conditionOperator === 'in'
          ? form.conditionValue
              .split(',')
              .map((part) => part.trim())
              .filter((part) => part.length > 0)
          : form.conditionValue

      await createJmlRule(accessToken, {
        name: form.name.trim(),
        trigger: form.trigger,
        conditionField: form.conditionField.trim(),
        conditionOperator: form.conditionOperator,
        conditionValue,
        action: form.action,
        ...(form.action === 'set_attribute'
          ? { actionParams: { key: form.attributeKey.trim(), value: form.attributeValue } }
          : {}),
      })

      setCreating(false)
      setForm(emptyForm())
      setRetryToken((token) => token + 1)
      showToast('Rule created. It is disabled until a preview has been reviewed.')
    } catch (cause) {
      // Verbatim: the API names the offending field — a set_attribute rule
      // without a key, an `in` without an array — and re-wording it here
      // would be a second, drifting copy of a rule it owns.
      setFormError(cause instanceof ApiError ? cause.message : 'Could not create this rule.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handlePreview(rule: JmlRule) {
    if (accessToken === undefined) return
    setPreviewingId(rule.id)
    setPreview(null)
    try {
      setPreview(await simulateJmlRule(accessToken, rule.id))
    } catch (cause) {
      showToast(
        cause instanceof ApiError ? cause.message : 'Could not preview this rule.',
        'danger',
      )
    } finally {
      setPreviewingId(null)
    }
  }

  /**
   * Acknowledge THEN enable — two calls, deliberately, because they are two
   * decisions. `wouldApplyCount` is the number the reviewer was actually
   * shown, not what a re-run would say now.
   */
  async function handleReviewAndEnable(report: JmlSimulationReport) {
    if (accessToken === undefined) return
    setBusyId(report.ruleId)
    try {
      await acknowledgeJmlSimulation(accessToken, report.ruleId, report.wouldApplyCount)
      await setJmlRuleEnabled(accessToken, report.ruleId, true)
      setPreview(null)
      setRetryToken((token) => token + 1)
      showToast('Rule enabled. It will run on the next lifecycle pass.')
    } catch (cause) {
      showToast(cause instanceof ApiError ? cause.message : 'Could not enable this rule.', 'danger')
    } finally {
      setBusyId(null)
    }
  }

  async function handleToggle(rule: JmlRule) {
    if (accessToken === undefined) return
    setBusyId(rule.id)
    try {
      await setJmlRuleEnabled(accessToken, rule.id, !rule.enabled)
      setRetryToken((token) => token + 1)
      showToast(rule.enabled ? 'Rule disabled.' : 'Rule enabled.')
    } catch (cause) {
      // The commonest refusal here is the simulation gate, and its message
      // says exactly what to do about it.
      showToast(cause instanceof ApiError ? cause.message : 'Could not change this rule.', 'danger')
    } finally {
      setBusyId(null)
    }
  }

  if (permissions.status === 'ready' && !canRead) {
    return (
      <section className="jml-page">
        <div className="empty-state">
          <p>
            You don&rsquo;t hold the jml:read permission, so lifecycle rules aren&rsquo;t visible to
            you.
          </p>
        </div>
      </section>
    )
  }

  return (
    <section className="jml-page">
      <div className="page-header">
        <div className="page-header__text">
          <h1 className="text-title">Lifecycle rules</h1>
          <p className="page-header__subtitle">
            Joiner, mover and leaver automation. These are the only changes this system makes to
            people&rsquo;s accounts with no human in the loop, so a rule is created switched off and
            stays off until someone has previewed what it would do and said so.
          </p>
        </div>
        {canManage && !creating && (
          <div className="jml-page__header-actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                setForm(emptyForm())
                setFormError(null)
                setCreating(true)
              }}
              data-testid="new-jml-rule"
            >
              New rule
            </button>
          </div>
        )}
      </div>

      {creating && (
        <form className="jml-page__form" onSubmit={handleCreate} data-testid="jml-rule-form">
          <h2 className="text-title jml-page__form-heading">New lifecycle rule</h2>

          <div className="jml-page__form-grid">
            <div className="field jml-page__form-wide">
              <label className="field__label" htmlFor="jml-name">
                Name
              </label>
              <input
                id="jml-name"
                className="input"
                value={form.name}
                maxLength={255}
                required
                disabled={submitting}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                data-testid="jml-name"
              />
              <p className="field__hint">
                What this rule is for, in the words you&rsquo;d use explaining it to whoever asks
                why an account changed.
              </p>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="jml-trigger">
                When
              </label>
              <select
                id="jml-trigger"
                className="select"
                value={form.trigger}
                disabled={submitting}
                onChange={(e) => setForm({ ...form, trigger: e.target.value as JmlTrigger })}
                data-testid="jml-trigger"
              >
                {ALL_TRIGGERS.map((trigger) => (
                  <option key={trigger} value={trigger}>
                    {TRIGGER_LABEL[trigger]}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="jml-field">
                And this field
              </label>
              <input
                id="jml-field"
                className="input mono"
                list="jml-field-options"
                value={form.conditionField}
                required
                disabled={submitting}
                onChange={(e) => setForm({ ...form, conditionField: e.target.value })}
                data-testid="jml-field"
              />
              <datalist id="jml-field-options">
                {CONDITION_FIELDS.map((field) => (
                  <option key={field} value={field} />
                ))}
              </datalist>
              <p className="field__hint">
                A built-in field, or <code>attributes.yourKey</code> for a custom one. A field the
                engine cannot resolve makes the rule match nobody — the preview below is how you
                find that out.
              </p>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="jml-operator">
                Comparison
              </label>
              <select
                id="jml-operator"
                className="select"
                value={form.conditionOperator}
                disabled={submitting}
                onChange={(e) =>
                  setForm({ ...form, conditionOperator: e.target.value as JmlConditionOperator })
                }
                data-testid="jml-operator"
              >
                {(['equals', 'not_equals', 'in'] as JmlConditionOperator[]).map((operator) => (
                  <option key={operator} value={operator}>
                    {OPERATOR_LABEL[operator]}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="jml-value">
                Value
              </label>
              <input
                id="jml-value"
                className="input"
                value={form.conditionValue}
                disabled={submitting}
                onChange={(e) => setForm({ ...form, conditionValue: e.target.value })}
                data-testid="jml-value"
              />
              {form.conditionOperator === 'in' && (
                <p className="field__hint">Comma-separated — the rule matches any one of them.</p>
              )}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="jml-action">
                Then
              </label>
              <select
                id="jml-action"
                className="select"
                value={form.action}
                disabled={submitting}
                onChange={(e) => setForm({ ...form, action: e.target.value as JmlActionType })}
                data-testid="jml-action"
              >
                {(['deactivate', 'set_attribute'] as JmlActionType[]).map((action) => (
                  <option key={action} value={action}>
                    {ACTION_LABEL[action]}
                  </option>
                ))}
              </select>
            </div>

            {form.action === 'set_attribute' && (
              <>
                <div className="field">
                  <label className="field__label" htmlFor="jml-attr-key">
                    Attribute key
                  </label>
                  <input
                    id="jml-attr-key"
                    className="input mono"
                    value={form.attributeKey}
                    required
                    disabled={submitting}
                    onChange={(e) => setForm({ ...form, attributeKey: e.target.value })}
                    data-testid="jml-attr-key"
                  />
                </div>
                <div className="field">
                  <label className="field__label" htmlFor="jml-attr-value">
                    Attribute value
                  </label>
                  <input
                    id="jml-attr-value"
                    className="input"
                    value={form.attributeValue}
                    disabled={submitting}
                    onChange={(e) => setForm({ ...form, attributeValue: e.target.value })}
                    data-testid="jml-attr-value"
                  />
                </div>
              </>
            )}
          </div>

          {formError !== null && (
            <p className="field__error" role="alert" data-testid="jml-form-error">
              {formError}
            </p>
          )}

          <div className="jml-page__form-actions">
            <button
              type="button"
              className="btn btn--secondary"
              disabled={submitting}
              onClick={() => setCreating(false)}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={submitting}
              data-loading={submitting ? 'true' : undefined}
              data-testid="jml-submit"
            >
              <span className="btn__label">Create rule</span>
              <span className="btn__spinner" aria-hidden="true" />
            </button>
          </div>
        </form>
      )}

      {loadError !== null && (
        <div className="error-panel" role="alert">
          <p className="error-panel__message">{loadError}</p>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => setRetryToken((token) => token + 1)}
          >
            Try again
          </button>
        </div>
      )}

      {loading && rules === null ? (
        <span className="skeleton" style={{ height: '8rem', display: 'block' }} />
      ) : rules !== null && rules.length === 0 ? (
        <div className="empty-state" data-testid="jml-empty">
          <p>
            No lifecycle rules. Nothing in this directory changes an account without a person
            deciding it.
          </p>
        </div>
      ) : (
        <table className="table" data-testid="jml-rules-table">
          <thead>
            <tr>
              <th scope="col">Rule</th>
              <th scope="col">State</th>
              <th scope="col">Reviewed</th>
              {canManage && (
                <th scope="col">
                  <span className="jml-page__sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {(rules ?? []).map((rule) => (
              <tr key={rule.id} data-testid="jml-rule-row">
                <td>
                  <div className="jml-page__name">{rule.name}</div>
                  <div className="cell-muted">{describeRule(rule)}</div>
                </td>
                <td>
                  <span
                    className={rule.enabled ? 'badge badge--success' : 'badge'}
                    data-testid="jml-rule-state"
                  >
                    {rule.enabled ? 'Live' : 'Off'}
                  </span>
                </td>
                <td className="cell-muted">
                  {rule.simulatedAt === null
                    ? 'Never previewed'
                    : new Date(rule.simulatedAt).toLocaleDateString()}
                </td>
                {canManage && (
                  <td className="jml-page__row-actions">
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      disabled={previewingId !== null || busyId !== null}
                      data-loading={previewingId === rule.id ? 'true' : undefined}
                      onClick={() => void handlePreview(rule)}
                      data-testid="jml-preview"
                    >
                      <span className="btn__label">Preview</span>
                      <span className="btn__spinner" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      disabled={busyId !== null}
                      data-loading={busyId === rule.id ? 'true' : undefined}
                      onClick={() => void handleToggle(rule)}
                      data-testid="jml-toggle"
                    >
                      <span className="btn__label">{rule.enabled ? 'Disable' : 'Enable'}</span>
                      <span className="btn__spinner" aria-hidden="true" />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {preview !== null && (
        <section className="jml-page__preview" data-testid="jml-preview-panel">
          <h2 className="text-title">What this rule would do</h2>
          <p className="jml-page__preview-count" data-testid="jml-preview-count">
            <strong>{preview.wouldApplyCount}</strong> of {preview.scanned} people scanned
            {preview.truncated ? ' (the directory is larger than the scan limit — this is a floor, not a total)' : ''}
            .
          </p>
          <p className="cell-muted">
            Nothing has changed. This preview writes nothing, and running it does not by itself
            allow the rule to go live.
          </p>

          {preview.effects.length === 0 ? (
            <p className="cell-muted" data-testid="jml-preview-empty">
              Nobody matches. A rule that matches nobody is usually a condition field the engine
              cannot resolve — check the spelling, and the <code>attributes.</code> prefix.
            </p>
          ) : (
            <ul className="jml-page__preview-list">
              {preview.effects.map((effect) => (
                <li key={effect.userId} className="mono">
                  {effect.username}
                </li>
              ))}
            </ul>
          )}
          {preview.wouldApplyCount > preview.effects.length && (
            <p className="cell-muted">
              Showing the first {preview.effects.length}. The count above is exact.
            </p>
          )}

          <div className="jml-page__form-actions">
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => setPreview(null)}
            >
              Close
            </button>
            {canManage && (
              <button
                type="button"
                className="btn btn--primary"
                disabled={busyId !== null}
                data-loading={busyId === preview.ruleId ? 'true' : undefined}
                onClick={() => void handleReviewAndEnable(preview)}
                data-testid="jml-review-enable"
              >
                <span className="btn__label">
                  I have reviewed this — enable the rule
                </span>
                <span className="btn__spinner" aria-hidden="true" />
              </button>
            )}
          </div>
        </section>
      )}
    </section>
  )
}
