import type { ReactNode } from 'react'

/**
 * The one label+input+error/hint wrapper every form in this console renders
 * a field with — docs/design-system.md's Forms contract verbatim: "labels above inputs,
 * inline validation on blur, error text under the field naming the field."
 * Presentational only: the caller is responsible for wiring its own
 * `id`/`aria-invalid`/`aria-describedby` onto the actual control it passes
 * as `children` (see `describedBy` below for the id half of that) —
 * deliberately not a `cloneElement`-based wrapper, so it works identically
 * whether `children` is a plain `<input>`, a `<select>`, or a composite
 * control like `AttributeInput`, with no fragile assumption about there
 * being exactly one cloneable child.
 */
export function Field({
  id,
  label,
  error,
  hint,
  required,
  children,
}: {
  id: string
  label: string
  error?: string | null
  hint?: string
  required?: boolean
  children: ReactNode
}) {
  return (
    <div className={`field${error ? ' field--error' : ''}`}>
      <label className="field__label" htmlFor={id}>
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      {children}
      {error ? (
        <p className="field__error" id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : (
        hint && (
          <p className="field__hint" id={`${id}-hint`}>
            {hint}
          </p>
        )
      )}
    </div>
  )
}

/** The id `Field` uses for its error/hint text — pass to the control's own `aria-describedby` so an assistive-tech user gets it. `undefined` when there is neither, so callers never wire up a dangling id. */
export function fieldDescribedBy(id: string, error?: string | null, hint?: string): string | undefined {
  if (error) return `${id}-error`
  if (hint) return `${id}-hint`
  return undefined
}
