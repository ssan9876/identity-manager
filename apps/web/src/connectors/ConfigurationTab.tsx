import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from 'react-oidc-context'
import { ApiError } from '../api/client'
import { Field } from '../forms/Field'
import { useToast } from '../shell/ToastProvider'
import { CONNECTOR_TARGET_LABEL, updateConnectorTarget, type ConnectorTarget, type ConnectorTargetSummary } from './api'
import { TARGET_CONFIG_FIELDS, type ConfigFieldSpec } from './config-fields'

function buildInitialValues(fields: ConfigFieldSpec[], config: Record<string, unknown>): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {}
  for (const field of fields) {
    const raw = config[field.key]
    result[field.key] = field.type === 'boolean' ? raw === true : typeof raw === 'string' ? raw : ''
  }
  return result
}

/**
 * The Configuration tab of `/connectors/:target` — "Configure targets:
 * enable/disable, non-secret config, blast-radius threshold/floor" (this
 * task's own BUILD section, first bullet). ONE form, ONE save — enabled,
 * every target-specific config field (config-fields.ts's own static
 * schema), and the blast-radius pair all commit together via a single
 * `PATCH /connector-targets/:target`.
 *
 * THE NON-NEGOTIABLE THIS TAB EXISTS TO HONOUR: every `secret-name` field
 * renders as a PLAIN TEXT input, never masked, with an explicit statement of
 * where the value actually comes from — see the banner below and each such
 * field's own hint. A masked input would visually promise this console
 * stores a credential; it never does (decision 4) — see config-fields.ts's
 * own doc comment for the fuller reasoning.
 */
export function ConfigurationTab({
  target,
  summary,
  canManage,
  organizationId,
  onSaved,
}: {
  target: ConnectorTarget
  summary: ConnectorTargetSummary
  canManage: boolean
  /** Per-organization connector targets: which organization's row this save writes to. `undefined` means master. */
  organizationId?: string
  onSaved: (next: ConnectorTargetSummary) => void
}) {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const { showToast } = useToast()
  const fields = TARGET_CONFIG_FIELDS[target]

  const [enabled, setEnabled] = useState(summary.enabled)
  const [configValues, setConfigValues] = useState<Record<string, string | boolean>>(() =>
    buildInitialValues(fields, summary.config),
  )
  const [threshold, setThreshold] = useState(String(summary.blastRadiusThreshold))
  const [floor, setFloor] = useState(String(summary.blastRadiusFloor))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Re-sync the draft whenever a FRESH summary arrives for this same target
  // (e.g. this same save completing, or the health panel above refreshing
  // after a reconcile) — never mid-edit, since this effect is keyed on the
  // summary object's own identity, which only changes on a genuine reload.
  useEffect(() => {
    setEnabled(summary.enabled)
    setConfigValues(buildInitialValues(fields, summary.config))
    setThreshold(String(summary.blastRadiusThreshold))
    setFloor(String(summary.blastRadiusFloor))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary])

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (accessToken === undefined) return

    const thresholdNum = Number(threshold)
    const floorNum = Number(floor)
    if (!Number.isInteger(thresholdNum) || thresholdNum < 1 || thresholdNum > 100) {
      setError('Blast-radius threshold must be a whole number between 1 and 100.')
      return
    }
    if (!Number.isInteger(floorNum) || floorNum < 0) {
      setError('Blast-radius floor must be zero or a positive whole number.')
      return
    }

    const configPatch: Record<string, string | boolean | null> = {}
    for (const field of fields) {
      const value = configValues[field.key]
      if (field.type === 'boolean') {
        configPatch[field.key] = Boolean(value)
      } else {
        const trimmed = typeof value === 'string' ? value.trim() : ''
        configPatch[field.key] = trimmed === '' ? null : trimmed
      }
    }

    setSubmitting(true)
    setError(null)
    try {
      const next = await updateConnectorTarget(
        accessToken,
        target,
        {
          enabled,
          config: configPatch,
          blastRadiusThreshold: thresholdNum,
          blastRadiusFloor: floorNum,
        },
        organizationId,
      )
      showToast(`Saved configuration for ${CONNECTOR_TARGET_LABEL[target]}.`)
      onSaved(next)
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : 'Could not save this configuration. Check your connection and try again.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="connector-config-form" onSubmit={(e) => void handleSubmit(e)}>
      <p className="connector-config-form__secret-note" role="note" data-testid="secret-architecture-note">
        <strong>Secret values are never stored in this console.</strong> A field asking for a credential names an
        environment variable on the server — the value is read from the environment at sync time, never fetched,
        shown, or held here.
      </p>

      <div className="field">
        <label className="connector-config-form__checkbox-label">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!canManage}
            onChange={(e) => setEnabled(e.target.checked)}
            data-testid="target-enabled-checkbox"
          />
          Enabled
        </label>
        <p className="field__hint">
          When off, ordinary directory changes never fan out to this target. Dry runs and a manual reconcile from
          the Dry run tab still work regardless.
        </p>
      </div>

      {target === 'keycloak' && (
        <p className="cell-muted connector-config-form__keycloak-note">
          Keycloak&rsquo;s own credentials come from the server&rsquo;s{' '}
          <span className="mono">KEYCLOAK_ADMIN_CLIENT_ID</span> / <span className="mono">KEYCLOAK_ADMIN_CLIENT_SECRET</span>{' '}
          environment variables and are not editable here.
        </p>
      )}

      {fields.map((field) =>
        field.type === 'boolean' ? (
          <div className="field" key={field.key}>
            <label className="connector-config-form__checkbox-label">
              <input
                type="checkbox"
                checked={Boolean(configValues[field.key])}
                disabled={!canManage}
                onChange={(e) => setConfigValues((prev) => ({ ...prev, [field.key]: e.target.checked }))}
                data-testid={`config-field-${field.key}`}
              />
              {field.label}
            </label>
            {field.hint !== undefined && <p className="field__hint">{field.hint}</p>}
          </div>
        ) : (
          <Field
            key={field.key}
            id={`config-${field.key}`}
            label={field.label}
            required={field.required}
            hint={
              field.type === 'secret-name'
                ? 'The value is read from the server’s environment at sync time — this field only names which variable.'
                : field.hint
            }
          >
            <input
              id={`config-${field.key}`}
              type="text"
              className="input"
              value={typeof configValues[field.key] === 'string' ? (configValues[field.key] as string) : ''}
              placeholder={field.placeholder}
              disabled={!canManage}
              onChange={(e) => setConfigValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
              data-testid={`config-field-${field.key}`}
            />
          </Field>
        ),
      )}

      <div className="connector-config-form__blast-radius">
        <h3 className="text-title">Blast-radius guard</h3>
        <p className="cell-muted">
          A reconcile run that would change more than this percentage <strong>and</strong> more than this absolute
          count halts and reports instead of applying anything.
        </p>
        <div className="connector-config-form__blast-radius-fields">
          <Field id="blast-radius-threshold" label="Threshold (%)" required>
            <input
              id="blast-radius-threshold"
              type="number"
              min={1}
              max={100}
              className="input"
              value={threshold}
              disabled={!canManage}
              onChange={(e) => setThreshold(e.target.value)}
              data-testid="blast-radius-threshold"
            />
          </Field>
          <Field id="blast-radius-floor" label="Floor (absolute count)" required>
            <input
              id="blast-radius-floor"
              type="number"
              min={0}
              className="input"
              value={floor}
              disabled={!canManage}
              onChange={(e) => setFloor(e.target.value)}
              data-testid="blast-radius-floor"
            />
          </Field>
        </div>
      </div>

      {error !== null && (
        <p className="error-panel__message" role="alert" data-testid="config-form-error">
          {error}
        </p>
      )}

      {canManage && (
        <button
          type="submit"
          className="btn btn--primary"
          disabled={submitting}
          data-loading={submitting ? 'true' : undefined}
          data-testid="config-form-submit"
        >
          <span className="btn__label">Save configuration</span>
          <span className="btn__spinner" aria-hidden="true" />
        </button>
      )}
    </form>
  )
}
