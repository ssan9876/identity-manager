import { Field, fieldDescribedBy } from '../forms/Field'
import type { AttributeDefinition } from './api'

/**
 * Every editable attribute value is edited as a STRING in these forms
 * (native inputs only deal in strings/booleans/checked-state), coerced to
 * the right JS type only at submit time. Moved here, unchanged, from
 * self-service/SelfServicePage.tsx (Milestone 6) — the admin create/edit
 * user form (Milestone 8, Task 3) needs the IDENTICAL coercion for the
 * IDENTICAL five `dataType`s, and task-3-brief.md says to reuse the
 * self-service page's approach "rather than reinventing it." SelfServicePage
 * now imports this instead of defining its own copy.
 */
export function coerceAttributeValue(definition: AttributeDefinition, raw: string): unknown {
  // AN EMPTY INPUT IS AN ABSENT VALUE, FOR EVERY dataType.
  //
  // This used to be the `number` branch's private trick, and every other type
  // returned `''` — which the API refuses for any attribute whose schema is
  // narrower than "a string". `buildAttributeSchema` makes an optional field
  // `field.optional()`, and `.optional()` admits `undefined`, never `''`. So
  // an OPTIONAL `enum`, `date`, or `string` carrying a `format` made the whole
  // record unsavable while its field was left blank:
  //
  //   enum   -> Invalid enum value. Expected 'a' | 'b', received ''
  //   date   -> must be a valid ISO calendar date (YYYY-MM-DD)
  //   email  -> Invalid email
  //
  // A plain `string` and a `number` were the only two that worked, which is
  // why this survived: those are the two types the seeded definitions use.
  // The failure lands on PERSON and GROUP writes — `POST /users`,
  // `PATCH /users/:id`, `POST /groups` — not on the attribute itself, so it
  // reads as "this person cannot be saved" with no hint that an unrelated,
  // optional, EMPTY field is the cause.
  //
  // `boolean` stays outside the check on purpose: its control is a
  // `<select>`/checkbox that always submits `'true'` or `'false'`, never the
  // empty string, so there is no empty state to map.
  //
  // Callers already drop `undefined` keys (SelfServicePage, and the create/
  // edit user and group forms), so this makes the other four behave exactly
  // as `number` already did rather than inventing a new convention. Note what
  // that means on the two write paths, because they differ: an admin form
  // REPLACES the whole attributes bag, so an omitted key genuinely clears the
  // value; `PATCH /self` MERGES onto the stored bag, so an omitted key leaves
  // the previous value untouched. Self-service therefore still cannot clear
  // an attribute it once set — a pre-existing limitation of the merge, true
  // for `number` since Milestone 6 and now uniformly true, not something this
  // change introduces. Clearing from `/self` needs an explicit null the merge
  // understands, which is an API change, not a coercion change.
  if (raw === '' && definition.dataType !== 'boolean') return undefined

  switch (definition.dataType) {
    case 'number':
      return Number(raw)
    case 'boolean':
      return raw === 'true'
    default:
      return raw
  }
}

/** The string form of whatever value a definition's key currently holds — used to seed a form's initial state from a fetched record's `attributes` object. `undefined`/`null` (never set, or explicitly cleared) become `''`, matching what every input below treats as "empty". */
export function attributeValueToString(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

/** One definition list -> one string-valued form-state object, seeded from `currentValues` (a record's raw `attributes`, or `{}` for a brand new record). Shared by the create and edit user forms so both build their initial attribute state the same way self-service's own `initialAttributeValues` already does for `/self`. */
export function initialAttributeStringValues(
  definitions: AttributeDefinition[],
  currentValues: Record<string, unknown>,
): Record<string, string> {
  const values: Record<string, string> = {}
  for (const definition of definitions) {
    values[definition.key] = attributeValueToString(currentValues[definition.key])
  }
  return values
}

/** Renders the right control for one attribute definition's `dataType` — moved from SelfServicePage, unchanged in behaviour, extended with the `aria-invalid`/`aria-describedby` wiring the self-service page never needed (it has no per-field error text; the admin create/edit form does, per docs/design-system.md's Forms contract). */
export function AttributeInput({
  id,
  definition,
  value,
  onChange,
  onBlur,
  invalid,
  describedBy,
}: {
  id: string
  definition: AttributeDefinition
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  invalid?: boolean
  describedBy?: string
}) {
  const common = { id, onBlur, 'aria-invalid': invalid || undefined, 'aria-describedby': describedBy }

  if (definition.dataType === 'boolean') {
    return (
      <input
        {...common}
        type="checkbox"
        checked={value === 'true'}
        onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
      />
    )
  }
  if (definition.dataType === 'date') {
    return <input {...common} className="input" type="date" value={value} onChange={(e) => onChange(e.target.value)} />
  }
  if (definition.dataType === 'number') {
    return <input {...common} className="input" type="number" value={value} onChange={(e) => onChange(e.target.value)} />
  }
  if (definition.dataType === 'enum') {
    const options = definition.validationRules.options ?? []
    return (
      <select {...common} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    )
  }
  return <input {...common} className="input" type="text" value={value} onChange={(e) => onChange(e.target.value)} />
}

/**
 * One complete attribute field: `Field`'s label/error chrome wrapped around
 * `AttributeInput`. The admin create/edit user form (Milestone 8, Task 3)
 * renders its whole custom-attributes section as a `.map()` over the active
 * catalog through this one component — SelfServicePage predates `Field` and
 * keeps its own plainer `<div><label/>...</div>` markup rather than being
 * retrofitted here (task-2-report.md: out of an unrelated task's scope,
 * already shipped and tested), so this composed row is new to this task,
 * not a relocation of existing self-service markup the way `AttributeInput`/
 * `coerceAttributeValue` above are.
 */
export function AttributeFieldRow({
  idPrefix,
  definition,
  value,
  onChange,
  onBlur,
  error,
}: {
  idPrefix: string
  definition: AttributeDefinition
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  error?: string | null
}) {
  const id = `${idPrefix}-${definition.key}`
  return (
    <Field id={id} label={definition.label} required={definition.required} error={error}>
      <AttributeInput
        id={id}
        definition={definition}
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        invalid={Boolean(error)}
        describedBy={fieldDescribedBy(id, error)}
      />
    </Field>
  )
}
