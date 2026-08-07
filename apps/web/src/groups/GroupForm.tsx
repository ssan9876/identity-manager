import { useState, type FormEvent } from 'react'
import { AttributeFieldRow } from '../attributes/AttributeField'
import type { AttributeDefinition } from '../attributes/api'
import { Field, fieldDescribedBy } from '../forms/Field'
import type { FieldErrorResult } from '../forms/api-field-errors'
import type { OrgUnit } from '../org-units/api'

export interface GroupCoreFormValues {
  name: string
  description: string
  /** `''` means Global (`orgUnitId` omitted from the request — see CreateGroupInput). Create-only: edit mode never renders this field at all, matching PersonForm's own orgUnitId exclusion in edit mode — `PATCH /groups/:id` does not accept it (GroupsRepository.UpdateGroupInput's own doc comment: a scope transfer is a materially different authorization question). */
  orgUnitId: string
}

export const EMPTY_GROUP_CORE_VALUES: GroupCoreFormValues = { name: '', description: '', orgUnitId: '' }

/** Every core field key `GroupForm` can render for `mode` — mirrors PersonForm's identical `CORE_FIELD_KEYS_BY_MODE` constant and reasoning: the single source of truth both this file's validation loop and each page's `mapApiErrorToFields(..., knownFields)` call build from. */
export const GROUP_CORE_FIELD_KEYS_BY_MODE: Record<'create' | 'edit', readonly (keyof GroupCoreFormValues)[]> = {
  create: ['name', 'description', 'orgUnitId'],
  edit: ['name', 'description'],
}

/** Client-side check, run on blur AND submit — DESIGN.md's "inline validation on blur, error text under the field naming the field". Deliberately loose (the server's own Zod schema is the authority for everything else — task-3-brief.md's same "not a duplicate of every server rule" reasoning PersonForm's identical helper documents). */
function validateCoreField(key: keyof GroupCoreFormValues, values: GroupCoreFormValues): string | null {
  if (key === 'name') {
    return values.name.trim() === '' ? 'Name is required.' : null
  }
  return null
}

function validateAttributeField(definition: AttributeDefinition, raw: string): string | null {
  if (definition.required && raw.trim() === '') {
    return `${definition.label} is required.`
  }
  return null
}

export interface GroupFormSubmitPayload {
  core: GroupCoreFormValues
  attributes: Record<string, string>
}

export interface GroupFormProps {
  mode: 'create' | 'edit'
  initialCore: GroupCoreFormValues
  initialAttributeValues: Record<string, string>
  attributeDefinitions: AttributeDefinition[]
  orgUnitOptions: OrgUnit[]
  orgUnitsLoading: boolean
  submitLabel: string
  onCancel: () => void
  /** Performs the write. Resolving `null` means success (the caller navigates/toasts); resolving a `FieldErrorResult` re-renders those errors inline, without losing whatever the admin already typed — identical ownership split to PersonForm's own `onSubmit` contract. */
  onSubmit: (payload: GroupFormSubmitPayload) => Promise<FieldErrorResult | null>
}

/**
 * The create AND edit group form — one component, not two near-duplicates,
 * the same shape as `PersonForm` (task-3-brief.md's own precedent, extended
 * to Groups per task-4-brief.md: "Groups list and detail; create and edit").
 * `mode` decides whether the Scope field renders at all (create only —
 * `PATCH /groups/:id` does not accept `orgUnitId`, so edit mode's markup
 * genuinely omits the input, not merely hides it). The custom-attributes
 * section (`appliesTo: 'group'`) is identical in both modes, through the
 * same `AttributeFieldRow` PersonForm already uses for `appliesTo: 'user'`.
 */
export function GroupForm({
  mode,
  initialCore,
  initialAttributeValues,
  attributeDefinitions,
  orgUnitOptions,
  orgUnitsLoading,
  submitLabel,
  onCancel,
  onSubmit,
}: GroupFormProps) {
  const [core, setCore] = useState<GroupCoreFormValues>(initialCore)
  const [attributes, setAttributes] = useState<Record<string, string>>(initialAttributeValues)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const showScopeField = GROUP_CORE_FIELD_KEYS_BY_MODE[mode].includes('orgUnitId')
  const orgUnitHint = orgUnitsLoading ? 'Loading org units…' : undefined

  function clearFieldError(key: string) {
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  function updateCore(key: keyof GroupCoreFormValues, value: string) {
    setCore((prev) => ({ ...prev, [key]: value }))
    clearFieldError(key)
  }

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

  function handleCoreBlur(key: keyof GroupCoreFormValues) {
    setOneFieldError(key, validateCoreField(key, core))
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
    for (const key of GROUP_CORE_FIELD_KEYS_BY_MODE[mode]) {
      const message = validateCoreField(key, core)
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
    <form className="group-form" onSubmit={(e) => void handleSubmit(e)} noValidate>
      <Field id="group-form-name" label="Name" required error={fieldErrors.name}>
        <input
          id="group-form-name"
          className="input"
          type="text"
          value={core.name}
          aria-invalid={Boolean(fieldErrors.name) || undefined}
          aria-describedby={fieldDescribedBy('group-form-name', fieldErrors.name)}
          onChange={(e) => updateCore('name', e.target.value)}
          onBlur={() => handleCoreBlur('name')}
        />
      </Field>

      <Field id="group-form-description" label="Description" error={fieldErrors.description}>
        <input
          id="group-form-description"
          className="input"
          type="text"
          value={core.description}
          aria-invalid={Boolean(fieldErrors.description) || undefined}
          aria-describedby={fieldDescribedBy('group-form-description', fieldErrors.description)}
          onChange={(e) => updateCore('description', e.target.value)}
          onBlur={() => handleCoreBlur('description')}
        />
      </Field>

      {showScopeField && (
        <Field
          id="group-form-orgUnitId"
          label="Scope"
          error={fieldErrors.orgUnitId}
          hint={orgUnitHint ?? 'A global group is visible and manageable by any admin with group permissions, regardless of org unit — creating one requires a global group:create grant.'}
        >
          <select
            id="group-form-orgUnitId"
            className="select"
            value={core.orgUnitId}
            disabled={orgUnitsLoading}
            aria-invalid={Boolean(fieldErrors.orgUnitId) || undefined}
            aria-describedby={fieldDescribedBy('group-form-orgUnitId', fieldErrors.orgUnitId, orgUnitHint)}
            onChange={(e) => updateCore('orgUnitId', e.target.value)}
            onBlur={() => handleCoreBlur('orgUnitId')}
          >
            <option value="">Global — visible everywhere</option>
            {orgUnitOptions.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.name} ({unit.path})
              </option>
            ))}
          </select>
        </Field>
      )}

      {attributeDefinitions.length > 0 && (
        <fieldset className="group-form__attributes">
          <legend className="text-title">Custom attributes</legend>
          {attributeDefinitions.map((definition) => (
            <AttributeFieldRow
              key={definition.key}
              idPrefix="group-form-attr"
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
        <p className="error-panel__message" role="alert" data-testid="group-form-error">
          {formError}
        </p>
      )}

      <div className="group-form__actions">
        <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn btn--primary"
          disabled={submitting}
          data-loading={submitting ? 'true' : undefined}
          data-testid="group-form-submit"
        >
          <span className="btn__label">{submitLabel}</span>
          <span className="btn__spinner" aria-hidden="true" />
        </button>
      </div>
    </form>
  )
}
