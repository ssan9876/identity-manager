import { useState, type FormEvent } from 'react'
import { AttributeFieldRow } from '../attributes/AttributeField'
import type { AttributeDefinition } from '../attributes/api'
import { Field, fieldDescribedBy } from '../forms/Field'
import type { FieldErrorResult } from '../forms/api-field-errors'
import type { OrgUnit } from '../org-units/api'

export interface PersonCoreFormValues {
  primaryEmail: string
  username: string
  firstName: string
  lastName: string
  orgUnitId: string
  employeeId: string
  jobTitle: string
  managerId: string
  location: string
  startDate: string
  endDate: string
}

export const EMPTY_CORE_VALUES: PersonCoreFormValues = {
  primaryEmail: '',
  username: '',
  firstName: '',
  lastName: '',
  orgUnitId: '',
  employeeId: '',
  jobTitle: '',
  managerId: '',
  location: '',
  startDate: '',
  endDate: '',
}

/** Every core field key `PersonForm` can render for `mode` — the shared source of truth both this file's own validation loop and each page's `mapApiErrorToFields(..., knownFields)` call build from, so the two can never disagree about what counts as "a field this form owns". */
export const CORE_FIELD_KEYS_BY_MODE: Record<'create' | 'edit', readonly (keyof PersonCoreFormValues)[]> = {
  create: [
    'primaryEmail',
    'username',
    'firstName',
    'lastName',
    'orgUnitId',
    'jobTitle',
    'employeeId',
    'managerId',
    'location',
    'startDate',
    'endDate',
  ],
  edit: ['firstName', 'lastName', 'jobTitle', 'employeeId', 'managerId', 'location', 'startDate', 'endDate'],
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One field's client-side check, run on both blur (immediate feedback) and submit (a safety net for a value that was never blurred, e.g. browser autofill). Deliberately much looser than the server's own Zod schemas — this exists to catch the common, cheap-to-catch mistakes before a round trip, not to duplicate every server rule; the server's field-named 400 is still the authority for everything else (task-3-brief.md). */
function validateCoreField(
  key: keyof PersonCoreFormValues,
  mode: 'create' | 'edit',
  values: PersonCoreFormValues,
): string | null {
  if (!CORE_FIELD_KEYS_BY_MODE[mode].includes(key)) return null
  const raw = values[key]

  switch (key) {
    case 'primaryEmail':
      if (raw.trim() === '') return 'Email is required.'
      return EMAIL_RE.test(raw.trim()) ? null : 'Enter a valid email address.'
    case 'username':
      return raw.trim() === '' ? 'Username is required.' : null
    case 'orgUnitId':
      return raw === '' ? 'Choose an org unit.' : null
    case 'firstName':
      return raw.trim() === '' ? 'First name is required.' : null
    case 'lastName':
      return raw.trim() === '' ? 'Last name is required.' : null
    case 'managerId':
      return raw.trim() !== '' && !UUID_RE.test(raw.trim())
        ? 'Enter a valid system ID (UUID), or leave blank.'
        : null
    default:
      return null
  }
}

function validateAttributeField(definition: AttributeDefinition, raw: string): string | null {
  if (definition.required && raw.trim() === '') {
    return `${definition.label} is required.`
  }
  return null
}

interface CoreFieldConfig {
  key: Exclude<keyof PersonCoreFormValues, 'orgUnitId'>
  label: string
  type: 'text' | 'email' | 'date'
  hint?: string
}

const CORE_FIELD_CONFIG: CoreFieldConfig[] = [
  { key: 'primaryEmail', label: 'Email', type: 'email' },
  { key: 'username', label: 'Username', type: 'text' },
  { key: 'firstName', label: 'First name', type: 'text' },
  { key: 'lastName', label: 'Last name', type: 'text' },
  { key: 'jobTitle', label: 'Job title', type: 'text' },
  { key: 'employeeId', label: 'Employee ID', type: 'text' },
  {
    key: 'managerId',
    label: 'Manager',
    type: 'text',
    hint: "The manager's system ID — copy it from the mono ID on their own profile page.",
  },
  { key: 'location', label: 'Location', type: 'text' },
  { key: 'startDate', label: 'Start date', type: 'date' },
  { key: 'endDate', label: 'End date', type: 'date' },
]

export interface PersonFormSubmitPayload {
  core: PersonCoreFormValues
  attributes: Record<string, string>
}

export interface PersonFormProps {
  mode: 'create' | 'edit'
  initialCore: PersonCoreFormValues
  initialAttributeValues: Record<string, string>
  attributeDefinitions: AttributeDefinition[]
  orgUnitOptions: OrgUnit[]
  orgUnitsLoading: boolean
  submitLabel: string
  onCancel: () => void
  /** Performs the write. Resolving `null` means success (the caller navigates/toasts); resolving a `FieldErrorResult` re-renders those errors inline, in place, without losing whatever the admin already typed. */
  onSubmit: (payload: PersonFormSubmitPayload) => Promise<FieldErrorResult | null>
}

/**
 * The create AND edit user form — task-3-brief.md: "a form driven by
 * `attribute_definitions`... mirroring the self-service page's approach."
 * One component, not two near-duplicates: `mode` decides which core fields
 * render (`CORE_FIELD_KEYS_BY_MODE`) — create's extra identity/placement
 * fields (email, username, org unit) are not merely hidden but genuinely
 * ABSENT from edit mode's markup, matching `PATCH /users/:id`'s own
 * narrower accepted surface exactly (task-3-brief.md: "do not offer inputs
 * the server will reject"). The custom-attributes section below is
 * identical in both modes — every active `user`-scoped definition renders
 * through `AttributeFieldRow`, exactly the self-service page's own
 * attribute-driven approach, reused rather than reinvented (see
 * attributes/AttributeField.tsx).
 */
export function PersonForm({
  mode,
  initialCore,
  initialAttributeValues,
  attributeDefinitions,
  orgUnitOptions,
  orgUnitsLoading,
  submitLabel,
  onCancel,
  onSubmit,
}: PersonFormProps) {
  const [core, setCore] = useState<PersonCoreFormValues>(initialCore)
  const [attributes, setAttributes] = useState<Record<string, string>>(initialAttributeValues)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const visibleCoreKeys = new Set(CORE_FIELD_KEYS_BY_MODE[mode])
  const orgUnitHint = orgUnitsLoading ? 'Loading org units…' : undefined

  function clearFieldError(key: string) {
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  function updateCore(key: keyof PersonCoreFormValues, value: string) {
    setCore((prev) => ({ ...prev, [key]: value }))
    clearFieldError(key)
  }

  /** Sets or clears exactly one field's error in a single state update — deliberately not built on top of `clearFieldError` (calling one state setter from inside another's updater risks the outer call clobbering the inner one with a stale `prev`). */
  function setOneFieldError(key: string, message: string | null) {
    setFieldErrors((prev) => {
      if (message === null) {
        if (!(key in prev)) return prev
        const next = { ...prev }
        delete next[key]
        return next
      }
      return { ...prev, [key]: message }
    })
  }

  function handleCoreBlur(key: keyof PersonCoreFormValues) {
    setOneFieldError(key, validateCoreField(key, mode, core))
  }

  function updateAttribute(key: string, value: string) {
    setAttributes((prev) => ({ ...prev, [key]: value }))
    clearFieldError(key)
  }

  function handleAttributeBlur(definition: AttributeDefinition) {
    setOneFieldError(definition.key, validateAttributeField(definition, attributes[definition.key] ?? ''))
  }

  function runClientValidation(): Record<string, string> {
    const errors: Record<string, string> = {}
    for (const key of visibleCoreKeys) {
      const message = validateCoreField(key, mode, core)
      if (message) errors[key] = message
    }
    for (const definition of attributeDefinitions) {
      const message = validateAttributeField(definition, attributes[definition.key] ?? '')
      if (message) errors[definition.key] = message
    }
    return errors
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()

    const clientErrors = runClientValidation()
    if (Object.keys(clientErrors).length > 0) {
      setFieldErrors(clientErrors)
      setFormError(null)
      return
    }

    setSubmitting(true)
    setFormError(null)
    const result = await onSubmit({ core, attributes })
    setSubmitting(false)

    if (result !== null) {
      setFieldErrors(result.fieldErrors)
      setFormError(result.formError)
    }
  }

  return (
    <form className="person-form" onSubmit={(e) => void handleSubmit(e)} noValidate>
      {visibleCoreKeys.has('orgUnitId') && (
        <Field id="person-form-orgUnitId" label="Org unit" required error={fieldErrors.orgUnitId} hint={orgUnitHint}>
          <select
            id="person-form-orgUnitId"
            className="select"
            value={core.orgUnitId}
            disabled={orgUnitsLoading}
            aria-invalid={Boolean(fieldErrors.orgUnitId) || undefined}
            aria-describedby={fieldDescribedBy('person-form-orgUnitId', fieldErrors.orgUnitId, orgUnitHint)}
            onChange={(e) => updateCore('orgUnitId', e.target.value)}
            onBlur={() => handleCoreBlur('orgUnitId')}
          >
            <option value="">{orgUnitsLoading ? 'Loading…' : 'Select an org unit'}</option>
            {orgUnitOptions.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.name} ({unit.path})
              </option>
            ))}
          </select>
        </Field>
      )}

      {CORE_FIELD_CONFIG.filter((field) => visibleCoreKeys.has(field.key)).map((field) => {
        const id = `person-form-${field.key}`
        const error = fieldErrors[field.key]
        const required = field.key === 'primaryEmail' || field.key === 'username' || field.key === 'firstName' || field.key === 'lastName'
        return (
          <Field id={id} key={field.key} label={field.label} required={required} error={error} hint={field.hint}>
            <input
              id={id}
              className="input"
              type={field.type}
              value={core[field.key]}
              aria-invalid={Boolean(error) || undefined}
              aria-describedby={fieldDescribedBy(id, error, field.hint)}
              onChange={(e) => updateCore(field.key, e.target.value)}
              onBlur={() => handleCoreBlur(field.key)}
            />
          </Field>
        )
      })}

      {attributeDefinitions.length > 0 && (
        <fieldset className="person-form__attributes">
          <legend className="text-title">Custom attributes</legend>
          {attributeDefinitions.map((definition) => (
            <AttributeFieldRow
              key={definition.key}
              idPrefix="person-form-attr"
              definition={definition}
              value={attributes[definition.key] ?? ''}
              onChange={(value) => updateAttribute(definition.key, value)}
              onBlur={() => handleAttributeBlur(definition)}
              error={fieldErrors[definition.key]}
            />
          ))}
        </fieldset>
      )}

      {formError !== null && (
        <p className="error-panel__message" role="alert" data-testid="person-form-error">
          {formError}
        </p>
      )}

      <div className="person-form__actions">
        <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn btn--primary"
          disabled={submitting}
          data-loading={submitting ? 'true' : undefined}
          data-testid="person-form-submit"
        >
          <span className="btn__label">{submitLabel}</span>
          <span className="btn__spinner" aria-hidden="true" />
        </button>
      </div>
    </form>
  )
}
