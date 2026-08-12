import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useAuth } from 'react-oidc-context'
import { ApiError } from '../api/client'
import { useSelfPermissions } from '../shell/permissions'
import { useToast } from '../shell/ToastProvider'
import {
  ALL_ATTRIBUTE_FORMATS,
  ATTRIBUTE_FORMAT_LABEL,
  createAttributeDefinition,
  fetchAttributeDefinitions,
  updateAttributeDefinition,
  type AttributeDataType,
  type AttributeDefinition,
  type AttributeFormat,
  type AttributeValidationRules,
} from './api'
import { AttributeMigrationPanel } from './AttributeMigrationPanel'
import './AttributeDefinitionsPage.css'

type Scope = 'user' | 'group'

const SCOPES: { key: Scope; label: string }[] = [
  { key: 'user', label: 'Person attributes' },
  { key: 'group', label: 'Group attributes' },
]

const DATA_TYPES: AttributeDataType[] = ['string', 'number', 'boolean', 'date', 'enum']

const DATA_TYPE_LABEL: Record<AttributeDataType, string> = {
  string: 'Text',
  number: 'Number',
  boolean: 'Yes / no',
  date: 'Date',
  enum: 'Choice',
}

function AttributesIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h8" />
      <circle cx="14.5" cy="14.5" r="2" />
    </svg>
  )
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, i) => (
        <tr key={i} aria-hidden="true">
          <td>
            <span className="skeleton" style={{ width: '9rem', height: '0.9rem' }} />
          </td>
          <td>
            <span className="skeleton" style={{ width: '11rem', height: '0.9rem' }} />
          </td>
          <td>
            <span className="skeleton" style={{ width: '4.5rem', height: '0.9rem' }} />
          </td>
          <td>
            <span className="skeleton" style={{ width: '12rem', height: '1.3rem' }} />
          </td>
          <td>
            <span className="skeleton" style={{ width: '7rem', height: '1.3rem' }} />
          </td>
          <td>
            <span className="skeleton" style={{ width: '4.5rem', height: '1.3rem' }} />
          </td>
        </tr>
      ))}
    </>
  )
}

/**
 * The three facts about a definition that are worth a badge, and nothing
 * else — docs/design-system.md: "word + optional shape, never colour alone",
 * and the norm stays uncoloured.
 *
 * `Sensitive` and `Self-editable` are the two that carry privilege beyond an
 * ordinary field, which is exactly why `attribute:manage` is super_admin's
 * alone (authz/actions.ts spells this out): `sensitive` REDUCES what the
 * audit log may record about this attribute, and `selfEditable` lets an end
 * user edit their own value for it — while role-evaluator.ts supports an
 * open-ended `attributes.<key>` condition, so a self-editable attribute can
 * decide business-role membership and therefore entitlements. Both get
 * --warn. `Required` is ordinary schema, so it stays neutral.
 */
function DefinitionFlags({ definition }: { definition: AttributeDefinition }) {
  const flags: { word: string; variant: 'neutral' | 'warn' }[] = []
  if (definition.required) flags.push({ word: 'Required', variant: 'neutral' })
  if (definition.selfEditable) flags.push({ word: 'Self-editable', variant: 'warn' })
  if (definition.sensitive) flags.push({ word: 'Sensitive', variant: 'warn' })

  if (flags.length === 0) return <span className="cell-muted">—</span>

  return (
    <span className="attributes-page__flags">
      {flags.map((flag) => (
        <span key={flag.word} className={`badge badge--${flag.variant}`}>
          {flag.variant !== 'neutral' && <span className="badge__dot" aria-hidden="true" />}
          {flag.word}
        </span>
      ))}
    </span>
  )
}

/**
 * Active or not — the same treatment BusinessRoleStatusBadge gives the same
 * shape of fact, because consistency screen-to-screen is worth more here than
 * a bespoke vocabulary. `Active` is the norm and takes no colour at all
 * (docs/design-system.md), and `Inactive` earns --danger rather than --warn
 * because deactivating is not a pause: the attribute leaves every form and
 * every validation schema in the deployment the moment it is switched off,
 * which is why the API gives that transition its own audit action. The stored
 * values survive, and the row stays here to be switched back on.
 */
function StatusBadge({ isActive }: { isActive: boolean }) {
  return (
    <span
      className={`badge badge--${isActive ? 'neutral' : 'danger'}`}
      data-attribute-active={String(isActive)}
    >
      {!isActive && <span className="badge__dot" aria-hidden="true" />}
      {isActive ? 'Active' : 'Inactive'}
    </span>
  )
}

/** Renders `validationRules` as the short human sentence the table column has room for. */
function describeRules(rules: AttributeValidationRules): string {
  const parts: string[] = []
  if (rules.format !== undefined) parts.push(rules.format)
  if (rules.minLength !== undefined) parts.push(`min length ${rules.minLength}`)
  if (rules.maxLength !== undefined) parts.push(`max length ${rules.maxLength}`)
  if (rules.min !== undefined) parts.push(`min ${rules.min}`)
  if (rules.max !== undefined) parts.push(`max ${rules.max}`)
  if (rules.options !== undefined) parts.push(rules.options.join(' · '))
  return parts.length === 0 ? '—' : parts.join(', ')
}

/**
 * The editable half of a definition, as form state.
 *
 * Everything is a STRING here, including the numbers, because that is what
 * an `<input>` holds — the conversion to what the API's schema wants happens
 * once, in `buildRules`/`buildDefault`, rather than being smeared across
 * every change handler.
 */
interface FormState {
  key: string
  label: string
  dataType: AttributeDataType
  required: boolean
  selfEditable: boolean
  sensitive: boolean
  defaultValue: string
  clearDefault: boolean
  minLength: string
  maxLength: string
  format: AttributeFormat | ''
  min: string
  max: string
  options: string
}

function emptyForm(dataType: AttributeDataType = 'string'): FormState {
  return {
    key: '',
    label: '',
    dataType,
    required: false,
    selfEditable: false,
    sensitive: false,
    defaultValue: '',
    clearDefault: false,
    minLength: '',
    maxLength: '',
    format: '',
    min: '',
    max: '',
    options: '',
  }
}

/**
 * `defaultValue` is deliberately NOT seeded from the definition, because the
 * catalogue endpoint does not return it: Task 7 kept every attribute VALUE
 * out of the projection that feeds audit snapshots (finding SEC-M1), and
 * `defaultValue` is a value. The form says so rather than showing an empty
 * box that reads as "no default" — see the hint on the field.
 */
function formFor(definition: AttributeDefinition): FormState {
  const rules = definition.validationRules
  return {
    key: definition.key,
    label: definition.label,
    dataType: definition.dataType,
    required: definition.required,
    selfEditable: definition.selfEditable,
    sensitive: definition.sensitive,
    defaultValue: '',
    clearDefault: false,
    minLength: rules.minLength?.toString() ?? '',
    maxLength: rules.maxLength?.toString() ?? '',
    format: rules.format ?? '',
    min: rules.min?.toString() ?? '',
    max: rules.max?.toString() ?? '',
    options: rules.options?.join('\n') ?? '',
  }
}

/**
 * Only the rules that MEAN something for this dataType are sent.
 *
 * The API refuses a mismatched pair outright — `minLength` on a number is a
 * 400 saying a string length rule has no effect there — so filtering by
 * dataType here is not a second copy of that rule. It is the reason an admin
 * who switches the type dropdown mid-form does not submit leftovers from the
 * type they abandoned.
 *
 * ALWAYS AN OBJECT, NEVER `undefined`, and that distinction is load-bearing:
 * the API reads an absent `validationRules` as "leave whatever is stored
 * alone" and an empty one as "there are no rules". Returning `undefined`
 * when the form has been emptied would make this screen able to ADD a
 * constraint and never remove one — the boxes would clear, the save would
 * succeed, and the old rule would still be enforced.
 */
function buildRules(form: FormState): AttributeValidationRules {
  const rules: AttributeValidationRules = {}

  if (form.dataType === 'string') {
    if (form.minLength.trim() !== '') rules.minLength = Number(form.minLength)
    if (form.maxLength.trim() !== '') rules.maxLength = Number(form.maxLength)
    if (form.format !== '') rules.format = form.format
  }
  if (form.dataType === 'number') {
    if (form.min.trim() !== '') rules.min = Number(form.min)
    if (form.max.trim() !== '') rules.max = Number(form.max)
  }
  if (form.dataType === 'enum') {
    const options = form.options
      .split('\n')
      .map((option) => option.trim())
      .filter((option) => option.length > 0)
    if (options.length > 0) rules.options = options
  }

  return rules
}

/**
 * The typed default, or `undefined` for "say nothing about it".
 *
 * A number that will not parse is sent AS THE TYPED TEXT rather than as
 * `NaN` or silently dropped: the API compares a default against its own
 * definition and names the mismatch, and that refusal is more useful than
 * anything this function could invent. Same principle as everywhere else on
 * this page — the console renders refusals, it does not author them.
 */
function buildDefault(form: FormState): string | number | boolean | null | undefined {
  if (form.clearDefault) return null

  const raw = form.defaultValue.trim()
  if (raw === '') return undefined

  if (form.dataType === 'boolean') return raw === 'true'
  if (form.dataType === 'number') {
    const parsed = Number(raw)
    return Number.isNaN(parsed) ? raw : parsed
  }
  return raw
}

/**
 * `/attributes` — Milestone 8, Task 11. The catalogue of custom fields the
 * directory records about people and groups, and the two-phase route for
 * changing one's type.
 *
 * A TABLE, not a card grid (docs/design-system.md). Creation and editing are
 * INLINE disclosures above it rather than modals or separate routes, the
 * shape BusinessRolesPage established for the same reason: "modal as first
 * thought" is banned, and a definition is far too small to earn a page.
 *
 * TWO TABS, NOT TWO NAV ITEMS, for the reason ConnectorsListPage already
 * documents — and here there is a second, harder reason: `GET
 * /attribute-definitions` REQUIRES `appliesTo`, so "all attributes" is not a
 * request this API can serve. The tabs are the query parameter, made visible.
 *
 * DEACTIVATION IS REVERSIBLE FROM HERE, and that is why it is offered at
 * all. This list asks for `includeInactive`, so a definition switched off
 * still appears — greyed by its status badge, with the button that turns it
 * back on. The first version of this page had no deactivate button precisely
 * because the API could only list ACTIVE definitions, which would have made
 * the control a one-way door: press it and the row vanishes from the only
 * screen that could undo it. The route grew the parameter; the button
 * followed it, in that order.
 *
 * `format` IS A DROPDOWN, AND IT IS GUARDED. `validationRules.format` is a
 * closed vocabulary of ten names owned by
 * apps/api/src/attributes/attribute-formats.ts, and a hand-copied closed
 * vocabulary in apps/web is the "catalog drift" defect class that once left
 * a live connector target this console could not disable
 * (docs/12-security.md). The mirror lives in ./api.ts and
 * apps/web/scripts/check-attribute-formats.mjs fails the build the moment it
 * stops matching — the same answer, and the same shape of answer, as
 * check-connector-targets.mjs.
 */
export default function AttributeDefinitionsPage() {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const permissions = useSelfPermissions()
  const { showToast } = useToast()

  const canRead = permissions.status === 'ready' && permissions.actions.has('attribute:read')
  const canManage = permissions.status === 'ready' && permissions.actions.has('attribute:manage')

  const [scope, setScope] = useState<Scope>('user')
  const [definitions, setDefinitions] = useState<AttributeDefinition[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)

  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [migratingId, setMigratingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  const scopeRefs = useRef<Record<Scope, HTMLButtonElement | null>>({ user: null, group: null })
  const firstFieldRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (accessToken === undefined) return
    if (permissions.status !== 'ready') return
    if (!canRead) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setLoadError(null)

    void fetchAttributeDefinitions(accessToken, scope, { includeInactive: true })
      .then((list) => {
        if (!cancelled) setDefinitions(list)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setLoadError(
          cause instanceof ApiError
            ? `Could not load attributes: ${cause.message}`
            : 'Could not load attributes. Check your connection and try again.',
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [accessToken, canRead, permissions.status, retryToken, scope])

  useEffect(() => {
    if (creating || editingId !== null) firstFieldRef.current?.focus()
  }, [creating, editingId])

  function closeForms() {
    setCreating(false)
    setEditingId(null)
    setMigratingId(null)
    setFormError(null)
    setSubmitting(false)
  }

  function activateScope(next: Scope) {
    setScope(next)
    closeForms()
    scopeRefs.current[next]?.focus()
  }

  function handleScopeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = SCOPES.findIndex((entry) => entry.key === scope)
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % SCOPES.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + SCOPES.length) % SCOPES.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = SCOPES.length - 1
    else return
    event.preventDefault()
    activateScope(SCOPES[next].key)
  }

  function startCreate() {
    setForm(emptyForm())
    setFormError(null)
    setEditingId(null)
    setMigratingId(null)
    setCreating(true)
  }

  function startEdit(definition: AttributeDefinition) {
    setForm(formFor(definition))
    setFormError(null)
    setCreating(false)
    setMigratingId(null)
    setEditingId(definition.id)
  }

  function startMigration(definition: AttributeDefinition) {
    setCreating(false)
    setEditingId(null)
    setFormError(null)
    setMigratingId(definition.id)
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (accessToken === undefined) return

    const label = form.label.trim()
    if (label === '') {
      setFormError('Give the attribute a label — this is what people see beside the field.')
      firstFieldRef.current?.focus()
      return
    }

    setSubmitting(true)
    setFormError(null)

    try {
      if (editingId !== null) {
        const updated = await updateAttributeDefinition(accessToken, editingId, {
          label,
          required: form.required,
          selfEditable: form.selfEditable,
          sensitive: form.sensitive,
          defaultValue: buildDefault(form),
          validationRules: buildRules(form),
        })
        showToast(`Saved ${updated.key}.`)
      } else {
        const created = await createAttributeDefinition(accessToken, {
          key: form.key.trim(),
          label,
          dataType: form.dataType,
          appliesTo: scope,
          required: form.required,
          selfEditable: form.selfEditable,
          sensitive: form.sensitive,
          defaultValue: buildDefault(form),
          validationRules: buildRules(form),
        })
        showToast(`Created ${created.key}.`)
      }
      closeForms()
      setRetryToken((token) => token + 1)
    } catch (cause) {
      // The API's message, verbatim. It knows which field is wrong and why —
      // and on a `key` or `selfEditable` refusal it also knows things this
      // console cannot see, such as a published business-role formula that
      // depends on the attribute.
      setFormError(
        cause instanceof ApiError
          ? cause.message
          : 'Could not save the attribute. Check your connection and try again.',
      )
      setSubmitting(false)
    }
  }

  /**
   * Deactivate or reactivate, as an ordinary PATCH of `isActive`.
   *
   * No confirmation dialog, deliberately: this is reversible from this very
   * table — the list asks for inactive definitions too — and
   * docs/design-system.md bans "modal as first thought". What the action is
   * NOT is harmless, so the toast says what actually happened rather than
   * "Saved": deactivating removes the field from every form and every
   * validation schema in the deployment, while the values already stored
   * under it stay exactly where they are.
   */
  async function handleToggleActive(definition: AttributeDefinition) {
    if (accessToken === undefined) return
    setTogglingId(definition.id)
    try {
      await updateAttributeDefinition(accessToken, definition.id, {
        isActive: !definition.isActive,
      })
      showToast(
        definition.isActive
          ? `Deactivated ${definition.key} — it is off every form now. Stored values are untouched, and it can be switched back on here.`
          : `Reactivated ${definition.key} — it is back on every relevant form.`,
        definition.isActive ? 'warn' : 'neutral',
      )
      setRetryToken((token) => token + 1)
    } catch (cause) {
      showToast(
        cause instanceof ApiError
          ? cause.message
          : `Could not change ${definition.key}. Check your connection and try again.`,
        'danger',
      )
    } finally {
      setTogglingId(null)
    }
  }

  if (permissions.status === 'loading') {
    return (
      <div className="attributes-page" aria-hidden="true">
        <span className="skeleton" style={{ width: '10rem', height: '1.5rem' }} />
        <span
          className="skeleton"
          style={{ width: '100%', height: '10rem', marginTop: 'var(--space-5)' }}
        />
      </div>
    )
  }

  if (!canRead) {
    return (
      <div className="attributes-page">
        <h1 className="text-title">Attributes</h1>
        <p className="cell-muted" data-testid="attributes-permission-note">
          You don&rsquo;t hold the attribute:read permission, so the attribute catalogue isn&rsquo;t
          available to you. Ask a super admin if you need this.
        </p>
      </div>
    )
  }

  const migrating =
    migratingId === null ? null : (definitions?.find((entry) => entry.id === migratingId) ?? null)
  const isEmpty = !loading && definitions !== null && definitions.length === 0
  const editing = editingId !== null

  return (
    <div className="attributes-page">
      <div className="page-header">
        <div className="page-header__text">
          <h1 className="text-title">Attributes</h1>
          <p className="page-header__subtitle">
            The custom fields this directory records beyond name and email. A definition decides what
            a value may be, who may edit it, and whether the audit log is allowed to see it — and
            changing one&rsquo;s type rewrites every value already stored under it.
          </p>
        </div>
        {canManage && !creating && !editing && (
          <div className="attributes-page__header-actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={startCreate}
              data-testid="new-attribute"
            >
              New attribute
            </button>
          </div>
        )}
      </div>

      <div
        className="tabs"
        role="tablist"
        aria-label="Attribute scope"
        onKeyDown={handleScopeKeyDown}
      >
        {SCOPES.map((entry) => (
          <button
            key={entry.key}
            ref={(el) => {
              scopeRefs.current[entry.key] = el
            }}
            id={`attributes-tab-${entry.key}`}
            role="tab"
            type="button"
            aria-selected={scope === entry.key}
            aria-controls="attributes-panel"
            tabIndex={scope === entry.key ? 0 : -1}
            className="tab"
            onClick={() => activateScope(entry.key)}
            data-testid={`attributes-scope-${entry.key}`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div
        id="attributes-panel"
        role="tabpanel"
        aria-labelledby={`attributes-tab-${scope}`}
        tabIndex={0}
        className="tabpanel"
      >
        {(creating || editing) && canManage && (
          <form
            className="attributes-page__form"
            onSubmit={(e) => void handleSubmit(e)}
            data-testid="attribute-form"
          >
            <h2 className="attributes-page__form-heading">
              {editing ? 'Edit attribute' : `New ${scope === 'user' ? 'person' : 'group'} attribute`}
            </h2>

            <div className="attributes-page__form-grid">
              <div className="field">
                <label className="field__label" htmlFor="attribute-key">
                  Key
                </label>
                <input
                  ref={editing ? undefined : firstFieldRef}
                  id="attribute-key"
                  className="input mono"
                  value={form.key}
                  maxLength={64}
                  disabled={submitting || editing}
                  onChange={(e) => setForm({ ...form, key: e.target.value })}
                  data-testid="attribute-key"
                />
                <p className="field__hint">
                  {editing
                    ? 'A key cannot be renamed — every stored value is filed under it.'
                    : 'Letters, digits and underscores; this is what stored values are filed under, permanently.'}
                </p>
              </div>

              <div className="field">
                <label className="field__label" htmlFor="attribute-label">
                  Label
                </label>
                <input
                  ref={editing ? firstFieldRef : undefined}
                  id="attribute-label"
                  className="input"
                  value={form.label}
                  maxLength={255}
                  disabled={submitting}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                  data-testid="attribute-label"
                />
                <p className="field__hint">What people see beside the field.</p>
              </div>

              <div className="field">
                <label className="field__label" htmlFor="attribute-data-type">
                  Type
                </label>
                <select
                  id="attribute-data-type"
                  className="select"
                  value={form.dataType}
                  disabled={submitting || editing}
                  onChange={(e) =>
                    setForm({ ...form, dataType: e.target.value as AttributeDataType })
                  }
                  data-testid="attribute-data-type"
                >
                  {DATA_TYPES.map((dataType) => (
                    <option key={dataType} value={dataType}>
                      {DATA_TYPE_LABEL[dataType]}
                    </option>
                  ))}
                </select>
                {editing && (
                  <p className="field__hint">
                    Changing the type rewrites stored values, so it goes through Change type on the
                    row below.
                  </p>
                )}
              </div>

              {form.dataType === 'string' && (
                <>
                  <div className="field">
                    <label className="field__label" htmlFor="attribute-min-length">
                      Minimum length <span className="attributes-page__optional">optional</span>
                    </label>
                    <input
                      id="attribute-min-length"
                      className="input"
                      type="number"
                      min={0}
                      value={form.minLength}
                      disabled={submitting}
                      onChange={(e) => setForm({ ...form, minLength: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor="attribute-max-length">
                      Maximum length <span className="attributes-page__optional">optional</span>
                    </label>
                    <input
                      id="attribute-max-length"
                      className="input"
                      type="number"
                      min={0}
                      value={form.maxLength}
                      disabled={submitting}
                      onChange={(e) => setForm({ ...form, maxLength: e.target.value })}
                    />
                  </div>
                  <div className="field attributes-page__form-wide">
                    <label className="field__label" htmlFor="attribute-format">
                      Format <span className="attributes-page__optional">optional</span>
                    </label>
                    <select
                      id="attribute-format"
                      className="select"
                      value={form.format}
                      disabled={submitting}
                      onChange={(e) =>
                        setForm({ ...form, format: e.target.value as AttributeFormat | '' })
                      }
                      data-testid="attribute-format"
                    >
                      <option value="">No format constraint</option>
                      {ALL_ATTRIBUTE_FORMATS.map((format) => (
                        <option key={format} value={format}>
                          {ATTRIBUTE_FORMAT_LABEL[format]}
                        </option>
                      ))}
                    </select>
                    <p className="field__hint">
                      A named validator the API owns and applies on every write. Replaced the
                      admin-supplied regular expressions this column used to hold, which were
                      executable content run against user input.
                    </p>
                  </div>
                </>
              )}

              {form.dataType === 'number' && (
                <>
                  <div className="field">
                    <label className="field__label" htmlFor="attribute-min">
                      Minimum <span className="attributes-page__optional">optional</span>
                    </label>
                    <input
                      id="attribute-min"
                      className="input"
                      type="number"
                      value={form.min}
                      disabled={submitting}
                      onChange={(e) => setForm({ ...form, min: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor="attribute-max">
                      Maximum <span className="attributes-page__optional">optional</span>
                    </label>
                    <input
                      id="attribute-max"
                      className="input"
                      type="number"
                      value={form.max}
                      disabled={submitting}
                      onChange={(e) => setForm({ ...form, max: e.target.value })}
                    />
                  </div>
                </>
              )}

              {form.dataType === 'enum' && (
                <div className="field attributes-page__form-wide">
                  <label className="field__label" htmlFor="attribute-options">
                    Choices
                  </label>
                  <textarea
                    id="attribute-options"
                    className="input attributes-page__textarea"
                    rows={4}
                    value={form.options}
                    disabled={submitting}
                    onChange={(e) => setForm({ ...form, options: e.target.value })}
                    data-testid="attribute-options"
                  />
                  <p className="field__hint">
                    One per line. A choice attribute with no choices accepts nothing at all, so this
                    is effectively required.
                  </p>
                </div>
              )}

              <div className="field attributes-page__form-wide">
                <label className="field__label" htmlFor="attribute-default">
                  Default value <span className="attributes-page__optional">optional</span>
                </label>
                {form.dataType === 'boolean' ? (
                  <select
                    id="attribute-default"
                    className="select"
                    value={form.defaultValue}
                    disabled={submitting || form.clearDefault}
                    onChange={(e) => setForm({ ...form, defaultValue: e.target.value })}
                    data-testid="attribute-default"
                  >
                    <option value="">No default</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                ) : (
                  <input
                    id="attribute-default"
                    className="input"
                    type={form.dataType === 'number' ? 'number' : 'text'}
                    value={form.defaultValue}
                    disabled={submitting || form.clearDefault}
                    onChange={(e) => setForm({ ...form, defaultValue: e.target.value })}
                    data-testid="attribute-default"
                  />
                )}
                {editing ? (
                  <p className="field__hint">
                    This box starts empty even when a default is set: a default is a stored VALUE,
                    and the catalogue deliberately returns none of them. Leave it empty to keep
                    whatever is there, type something to replace it, or tick Clear below to remove
                    it.
                  </p>
                ) : (
                  <p className="field__hint">
                    Inherited by everyone who never sets this attribute, so it has to be a value this
                    definition would itself accept.
                  </p>
                )}
              </div>

              {editing && (
                <div className="field attributes-page__form-wide">
                  <label className="attributes-page__check" htmlFor="attribute-clear-default">
                    <input
                      id="attribute-clear-default"
                      type="checkbox"
                      checked={form.clearDefault}
                      disabled={submitting}
                      onChange={(e) =>
                        setForm({ ...form, clearDefault: e.target.checked, defaultValue: '' })
                      }
                      data-testid="attribute-clear-default"
                    />
                    <span>Clear the existing default</span>
                  </label>
                </div>
              )}

              <fieldset className="attributes-page__switches">
                <legend className="field__label">Behaviour</legend>
                <label className="attributes-page__check" htmlFor="attribute-required">
                  <input
                    id="attribute-required"
                    type="checkbox"
                    checked={form.required}
                    disabled={submitting}
                    onChange={(e) => setForm({ ...form, required: e.target.checked })}
                    data-testid="attribute-required"
                  />
                  <span>
                    <strong>Required</strong> — a value must be supplied.
                  </span>
                </label>
                <label className="attributes-page__check" htmlFor="attribute-self-editable">
                  <input
                    id="attribute-self-editable"
                    type="checkbox"
                    checked={form.selfEditable}
                    disabled={submitting}
                    onChange={(e) => setForm({ ...form, selfEditable: e.target.checked })}
                    data-testid="attribute-self-editable"
                  />
                  <span>
                    <strong>Self-editable</strong> — people may change their own value. Refused while
                    any published business-role formula reads this attribute, because that would let
                    someone grant themselves access.
                  </span>
                </label>
                <label className="attributes-page__check" htmlFor="attribute-sensitive">
                  <input
                    id="attribute-sensitive"
                    type="checkbox"
                    checked={form.sensitive}
                    disabled={submitting}
                    onChange={(e) => setForm({ ...form, sensitive: e.target.checked })}
                    data-testid="attribute-sensitive"
                  />
                  <span>
                    <strong>Sensitive</strong> — keep this attribute&rsquo;s values out of audit-log
                    snapshots. Turning it on reduces what the audit log can see, and a sensitive
                    attribute cannot have its type migrated until it is turned back off.
                  </span>
                </label>
              </fieldset>
            </div>

            {formError !== null && (
              <p className="field__error" role="alert" data-testid="attribute-form-error">
                {formError}
              </p>
            )}

            <div className="attributes-page__form-actions">
              <button
                type="button"
                className="btn btn--secondary"
                disabled={submitting}
                onClick={closeForms}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn--primary"
                disabled={submitting}
                data-loading={submitting ? 'true' : undefined}
                data-testid="attribute-form-submit"
              >
                <span className="btn__label">{editing ? 'Save' : 'Create'}</span>
                <span className="btn__spinner" aria-hidden="true" />
              </button>
            </div>
          </form>
        )}

        {migrating !== null && canManage && (
          <AttributeMigrationPanel
            definition={migrating}
            onCancel={closeForms}
            onDone={() => {
              closeForms()
              setRetryToken((token) => token + 1)
            }}
          />
        )}

        <div className="table-wrap">
          {loadError !== null ? (
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
          ) : isEmpty ? (
            <div className="empty-state">
              <span className="empty-state__mark" aria-hidden="true">
                <AttributesIcon />
              </span>
              <h3>
                No custom {scope === 'user' ? 'person' : 'group'} attributes yet
              </h3>
              <p>
                An attribute is a field this directory records that isn&rsquo;t built in — a cost
                centre, a desk number, a contract end date. Define one and it appears on every
                relevant form, validated the way you describe it here.
                {canManage ? '' : ' Ask a super admin to create one.'}
              </p>
              {canManage && !creating && (
                <button type="button" className="btn btn--primary" onClick={startCreate}>
                  New attribute
                </button>
              )}
            </div>
          ) : (
            <table className="table" data-testid="attributes-table">
              <thead>
                <tr>
                  <th scope="col">Key</th>
                  <th scope="col">Label</th>
                  <th scope="col">Type</th>
                  <th scope="col">Rules</th>
                  <th scope="col">Behaviour</th>
                  <th scope="col">Status</th>
                  {canManage && (
                    <th scope="col">
                      <span className="attributes-page__sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {loading || definitions === null ? (
                  <SkeletonRows />
                ) : (
                  definitions.map((definition) => (
                    <tr key={definition.id} data-testid="attributes-row">
                      <td className="mono">{definition.key}</td>
                      <td>{definition.label}</td>
                      <td className="cell-muted">{DATA_TYPE_LABEL[definition.dataType]}</td>
                      <td className="cell-muted">{describeRules(definition.validationRules)}</td>
                      <td>
                        <DefinitionFlags definition={definition} />
                      </td>
                      <td>
                        <StatusBadge isActive={definition.isActive} />
                      </td>
                      {canManage && (
                        <td className="attributes-page__row-actions">
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            onClick={() => startEdit(definition)}
                            data-testid="attribute-edit"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            onClick={() => startMigration(definition)}
                            data-testid="attribute-migrate"
                          >
                            Change type
                          </button>
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            disabled={togglingId === definition.id}
                            data-loading={togglingId === definition.id ? 'true' : undefined}
                            onClick={() => void handleToggleActive(definition)}
                            data-testid="attribute-toggle-active"
                          >
                            <span className="btn__label">
                              {definition.isActive ? 'Deactivate' : 'Reactivate'}
                            </span>
                            <span className="btn__spinner" aria-hidden="true" />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* Said out loud, because "where did my attribute go" is the question
            an active-only list would have produced and this one answers. */}
        {!loading && definitions !== null && definitions.length > 0 && (
          <p className="attributes-page__footnote">
            Inactive definitions are listed too. Deactivating removes an attribute from every form
            and validation schema without touching the values already stored under it.
          </p>
        )}
      </div>
    </div>
  )
}
