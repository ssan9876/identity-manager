import { useGroups } from '../groups/GroupsContext'
import { useOrgUnits } from '../org-units/OrgUnitsContext'
import { ALL_CONNECTOR_TARGETS, CONNECTOR_TARGET_LABEL, type ConnectorTarget } from '../connectors/api'
import {
  ATTRIBUTE_PREFIX,
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  FIELD_LABEL,
  OPERATOR_LABEL,
  type ConditionOperator,
  type RoleCondition,
  type RoleDefinition,
  type RoleGrant,
} from './api'

/** Exactly the four `user_status` values — mirrors people/api.ts's `UserStatus`. */
const STATUS_VALUES = ['pending', 'active', 'suspended', 'deactivated'] as const

const CUSTOM_FIELD = '__attribute__'

/**
 * The value an admin typed, and the JSON the API stores, are not the same
 * thing: `in` takes an ARRAY (role-evaluator.ts refuses a non-array with
 * `operator "in" requires an array value`, which would surface as an
 * unevaluable role rather than a validation error, since draft.ts leaves
 * `value` unconstrained on purpose). These two functions are the only place
 * that conversion happens.
 */
function valueToInput(value: unknown, operator: ConditionOperator): string {
  if (operator === 'in') {
    return Array.isArray(value) ? value.map((v) => String(v)).join(', ') : ''
  }
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function inputToValue(input: string, operator: ConditionOperator): unknown {
  if (operator === 'in') {
    return input
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
  }
  return input
}

/** True when this condition names a user attribute (`attributes.<key>`) rather than one of the four scalar fields. */
function isAttributeField(field: string): boolean {
  return field.startsWith(ATTRIBUTE_PREFIX)
}

interface ConditionRowProps {
  index: number
  condition: RoleCondition
  disabled: boolean
  onChange: (next: RoleCondition) => void
  onRemove: () => void
}

function ConditionRow({ index, condition, disabled, onChange, onRemove }: ConditionRowProps) {
  const orgUnits = useOrgUnits()
  const attribute = isAttributeField(condition.field)
  const fieldSelectValue = attribute ? CUSTOM_FIELD : condition.field
  const ids = {
    field: `condition-${index}-field`,
    key: `condition-${index}-key`,
    operator: `condition-${index}-operator`,
    value: `condition-${index}-value`,
  }

  function setField(next: string) {
    if (next === CUSTOM_FIELD) {
      onChange({ ...condition, field: ATTRIBUTE_PREFIX })
      return
    }
    // Switching to a different field can strand a value that only made sense
    // for the old one (an org-unit uuid on a job title). Cleared deliberately
    // — a stale value here is a formula that does not say what its author
    // thinks it says, which is the whole failure mode this feature guards.
    onChange({ ...condition, field: next, value: condition.operator === 'in' ? [] : '' })
  }

  function setOperator(next: ConditionOperator) {
    onChange({
      ...condition,
      operator: next,
      value: inputToValue(valueToInput(condition.value, condition.operator), next),
    })
  }

  const orgUnitOptions = orgUnits.status === 'ready' ? orgUnits.list : []

  /* Which value control this row gets is decided by the field/operator pair,
     because the evaluator itself is that specific: `in_org_subtree` takes an
     ltree PATH and applies only to orgUnitId, while `orgUnitId equals` takes
     a uuid. Offering one free-text box for both is how an admin writes a
     formula that silently matches nobody. */
  let valueControl
  if (condition.operator === 'in_org_subtree') {
    valueControl = (
      <select
        id={ids.value}
        className="select"
        disabled={disabled}
        value={typeof condition.value === 'string' ? condition.value : ''}
        onChange={(e) => onChange({ ...condition, value: e.target.value })}
      >
        <option value="">Choose an org unit…</option>
        {orgUnitOptions.map((unit) => (
          <option key={unit.id} value={unit.path}>
            {unit.path}
          </option>
        ))}
      </select>
    )
  } else if (condition.field === 'orgUnitId' && condition.operator !== 'in') {
    valueControl = (
      <select
        id={ids.value}
        className="select"
        disabled={disabled}
        value={typeof condition.value === 'string' ? condition.value : ''}
        onChange={(e) => onChange({ ...condition, value: e.target.value })}
      >
        <option value="">Choose an org unit…</option>
        {orgUnitOptions.map((unit) => (
          <option key={unit.id} value={unit.id}>
            {unit.path}
          </option>
        ))}
      </select>
    )
  } else if (condition.field === 'status' && condition.operator !== 'in') {
    valueControl = (
      <select
        id={ids.value}
        className="select"
        disabled={disabled}
        value={typeof condition.value === 'string' ? condition.value : ''}
        onChange={(e) => onChange({ ...condition, value: e.target.value })}
      >
        <option value="">Choose a status…</option>
        {STATUS_VALUES.map((status) => (
          <option key={status} value={status}>
            {status}
          </option>
        ))}
      </select>
    )
  } else {
    valueControl = (
      <input
        id={ids.value}
        className="input"
        disabled={disabled}
        value={valueToInput(condition.value, condition.operator)}
        placeholder={condition.operator === 'in' ? 'Comma-separated' : undefined}
        onChange={(e) => onChange({ ...condition, value: inputToValue(e.target.value, condition.operator) })}
      />
    )
  }

  return (
    <li className="rule-row" data-testid="condition-row">
      <div className="field rule-row__field">
        <label className="field__label" htmlFor={ids.field}>
          Field
        </label>
        <select
          id={ids.field}
          className="select"
          disabled={disabled}
          value={fieldSelectValue}
          onChange={(e) => setField(e.target.value)}
        >
          {CONDITION_FIELDS.map((field) => (
            <option key={field} value={field}>
              {FIELD_LABEL[field]}
            </option>
          ))}
          <option value={CUSTOM_FIELD}>Custom attribute…</option>
        </select>
      </div>

      {attribute && (
        <div className="field rule-row__field">
          <label className="field__label" htmlFor={ids.key}>
            Attribute key
          </label>
          <input
            id={ids.key}
            className="input"
            disabled={disabled}
            value={condition.field.slice(ATTRIBUTE_PREFIX.length)}
            onChange={(e) => onChange({ ...condition, field: `${ATTRIBUTE_PREFIX}${e.target.value}` })}
          />
        </div>
      )}

      <div className="field rule-row__field rule-row__field--narrow">
        <label className="field__label" htmlFor={ids.operator}>
          Operator
        </label>
        <select
          id={ids.operator}
          className="select"
          disabled={disabled}
          value={condition.operator}
          onChange={(e) => setOperator(e.target.value as ConditionOperator)}
        >
          {CONDITION_OPERATORS.map((operator) => (
            <option key={operator} value={operator}>
              {OPERATOR_LABEL[operator]}
            </option>
          ))}
        </select>
      </div>

      <div className="field rule-row__field">
        <label className="field__label" htmlFor={ids.value}>
          Value
        </label>
        {valueControl}
      </div>

      <button
        type="button"
        className="btn btn--ghost btn--sm rule-row__remove"
        disabled={disabled}
        onClick={onRemove}
        data-testid="remove-condition"
      >
        Remove
      </button>
    </li>
  )
}

interface GrantRowProps {
  index: number
  grant: RoleGrant
  disabled: boolean
  onChange: (next: RoleGrant) => void
  onRemove: () => void
}

function GrantRow({ index, grant, disabled, onChange, onRemove }: GrantRowProps) {
  const groups = useGroups()
  const ids = { kind: `grant-${index}-kind`, group: `grant-${index}-group`, target: `grant-${index}-target` }

  return (
    <li className="rule-row" data-testid="grant-row">
      <div className="field rule-row__field rule-row__field--narrow">
        <label className="field__label" htmlFor={ids.kind}>
          Grant
        </label>
        <select
          id={ids.kind}
          className="select"
          disabled={disabled}
          value={grant.kind}
          onChange={(e) =>
            onChange(
              e.target.value === 'group_membership'
                ? { kind: 'group_membership', groupId: '', target: null }
                : { kind: 'target_account', groupId: null, target: ALL_CONNECTOR_TARGETS[0] },
            )
          }
        >
          <option value="group_membership">Group membership</option>
          <option value="target_account">Target account</option>
        </select>
      </div>

      {grant.kind === 'group_membership' ? (
        <div className="field rule-row__field">
          <label className="field__label" htmlFor={ids.group}>
            Group
          </label>
          <select
            id={ids.group}
            className="select"
            disabled={disabled || groups.status !== 'ready'}
            value={grant.groupId ?? ''}
            onChange={(e) => onChange({ ...grant, groupId: e.target.value })}
          >
            <option value="">Choose a group…</option>
            {groups.status === 'ready' &&
              groups.list.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
          </select>
        </div>
      ) : (
        <div className="field rule-row__field">
          <label className="field__label" htmlFor={ids.target}>
            Target
          </label>
          <select
            id={ids.target}
            className="select"
            disabled={disabled}
            value={grant.target ?? ''}
            onChange={(e) => onChange({ ...grant, target: e.target.value as ConnectorTarget })}
          >
            {ALL_CONNECTOR_TARGETS.map((target) => (
              <option key={target} value={target}>
                {CONNECTOR_TARGET_LABEL[target]}
              </option>
            ))}
          </select>
        </div>
      )}

      <button
        type="button"
        className="btn btn--ghost btn--sm rule-row__remove"
        disabled={disabled}
        onClick={onRemove}
        data-testid="remove-grant"
      >
        Remove
      </button>
    </li>
  )
}

export interface DefinitionEditorProps {
  definition: RoleDefinition
  /** False for a caller holding only `business_role:read` — every control renders disabled rather than vanishing, so a read-only viewer still sees the formula. */
  editable: boolean
  disabled: boolean
  onChange: (next: RoleDefinition) => void
}

/**
 * The draft editor — Milestone 17, Task 17, Step 3.
 *
 * NOTHING HERE CHANGES ANYONE'S ACCESS. It edits a local copy; saving writes
 * `draft_definition` and clears the recorded simulation; publishing is a
 * separate, gated action. That is stated on the screen too, not just here.
 *
 * A zero-condition role matches NOBODY (`matchesConditions` returns early
 * rather than folding to a vacuous true), which is the opposite of what an
 * empty list looks like it should mean — so the empty state says so in
 * words instead of leaving it to be discovered by simulation.
 */
export function DefinitionEditor({ definition, editable, disabled, onChange }: DefinitionEditorProps) {
  const locked = disabled || !editable

  function setConditions(conditions: RoleCondition[]) {
    onChange({ ...definition, conditions })
  }

  function setGrants(grants: RoleGrant[]) {
    onChange({ ...definition, grants })
  }

  return (
    <div className="definition-editor">
      <section className="definition-editor__section" aria-labelledby="conditions-heading">
        <div className="definition-editor__section-head">
          <h3 id="conditions-heading" className="definition-editor__heading">
            Who this describes
          </h3>
          <p className="definition-editor__hint">
            Every condition must match. A role with no conditions describes nobody — that is
            deliberate, so an unfinished formula can never hand the whole directory its grants.
          </p>
        </div>

        {definition.conditions.length === 0 ? (
          <p className="cell-muted" data-testid="no-conditions">
            No conditions yet.
          </p>
        ) : (
          <ul className="rule-list">
            {definition.conditions.map((condition, index) => (
              <ConditionRow
                key={index}
                index={index}
                condition={condition}
                disabled={locked}
                onChange={(next) =>
                  setConditions(definition.conditions.map((c, i) => (i === index ? next : c)))
                }
                onRemove={() => setConditions(definition.conditions.filter((_, i) => i !== index))}
              />
            ))}
          </ul>
        )}

        {editable && (
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={disabled}
            onClick={() =>
              setConditions([...definition.conditions, { field: 'jobTitle', operator: 'equals', value: '' }])
            }
            data-testid="add-condition"
          >
            Add condition
          </button>
        )}
      </section>

      <section className="definition-editor__section" aria-labelledby="grants-heading">
        <div className="definition-editor__section-head">
          <h3 id="grants-heading" className="definition-editor__heading">
            What they get
          </h3>
          <p className="definition-editor__hint">
            Group memberships and target accounts this role holds open for everyone it describes.
            Anything granted by hand stays granted by hand — this role never revokes it.
          </p>
        </div>

        {definition.grants.length === 0 ? (
          <p className="cell-muted" data-testid="no-grants">
            No grants yet.
          </p>
        ) : (
          <ul className="rule-list">
            {definition.grants.map((grant, index) => (
              <GrantRow
                key={index}
                index={index}
                grant={grant}
                disabled={locked}
                onChange={(next) => setGrants(definition.grants.map((g, i) => (i === index ? next : g)))}
                onRemove={() => setGrants(definition.grants.filter((_, i) => i !== index))}
              />
            ))}
          </ul>
        )}

        {editable && (
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={disabled}
            onClick={() => setGrants([...definition.grants, { kind: 'group_membership', groupId: '', target: null }])}
            data-testid="add-grant"
          >
            Add grant
          </button>
        )}
      </section>
    </div>
  )
}
