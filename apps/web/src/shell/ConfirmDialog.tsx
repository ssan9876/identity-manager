import { useEffect, useRef, useState, type ReactNode } from 'react'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  /** The plain-language consequence statement — DESIGN.md/task-3-brief.md want what WILL happen stated plainly, not just "are you sure?". */
  children: ReactNode
  confirmLabel: string
  cancelLabel?: string
  tone?: 'danger' | 'primary'
  /** Performs the action. Rejecting keeps the dialog open and shows the failure inline; resolving does NOT close the dialog itself — the caller decides when (see this file's own doc comment). */
  onConfirm: () => Promise<void>
  onDismiss: () => void
  testId?: string
}

/**
 * DESIGN.md bans "modal as first thought," but calls out its one earned use
 * explicitly: "a destructive confirmation is one of the few places a modal
 * genuinely earns its keep." Native `<dialog>` + `showModal()`, the same
 * primitive AppShell.tsx's narrow-nav disclosure already uses (DESIGN.md:
 * "Dropdowns use the native popover/`<dialog>` API... never `position:
 * absolute`") — full focus trap and Escape handling for free, on every
 * evergreen browser, with no bespoke focus-management code.
 *
 * Ownership split, deliberately: this component owns its OWN in-flight
 * request lifecycle (`submitting`/`localError` below — DESIGN.md's "all
 * seven states" applies to this confirmation as much as any button), but
 * NOT the decision to close after success. `onConfirm` resolving leaves
 * `open` untouched; the CALLER flips it to `false` once it has done whatever
 * else a successful action implies (update local state, show a toast,
 * navigate). This is what lets the caller's toast text and post-action
 * state update happen from ONE place (its own `onConfirm` implementation)
 * without a race against this component's own close timing.
 *
 * The Cancel button — not Confirm — receives focus when this opens
 * (`autoFocus` would only affect the FIRST render, not every reopen, so this
 * is done imperatively). Deliberate: a destructive action must never be one
 * accidental Enter press away from the dialog opening.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'danger',
  onConfirm,
  onDismiss,
  testId,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const [submitting, setSubmitting] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return

    if (open && !dialog.open) {
      setSubmitting(false)
      setLocalError(null)
      dialog.showModal()
      cancelButtonRef.current?.focus()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  function requestDismiss() {
    if (submitting) return
    onDismiss()
  }

  async function handleConfirmClick() {
    setSubmitting(true)
    setLocalError(null)
    try {
      await onConfirm()
      // Success: the caller closes this (see file doc comment) — nothing to
      // do here. `submitting` is left true deliberately, so the button stays
      // disabled/loading through whatever brief instant passes before the
      // caller's own re-render flips `open` to false, rather than flashing
      // back to its idle state first.
    } catch (cause) {
      setSubmitting(false)
      // `instanceof Error`, not the narrower `instanceof ApiError` this used
      // to check: every existing caller only ever throws `ApiError` (a
      // subclass of `Error`) from `onConfirm`, so this is a pure widening
      // with no behavior change for them — `cause.message` is identical
      // either way. It exists so a caller with its OWN, friendlier mapping
      // from a raw API error to admin-facing text (e.g. PersonRolesTab's
      // `explainRoleAssignError` — Milestone 8, Task 4) can throw a plain
      // `Error` carrying that already-mapped message from `onConfirm` and
      // have IT shown here, rather than this dialog's generic fallback
      // discarding it.
      setLocalError(cause instanceof Error ? cause.message : 'Could not complete this action.')
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog"
      aria-labelledby="confirm-dialog-title"
      data-testid={testId}
      onCancel={(event) => {
        // Native Escape-to-dismiss. Blocked while a request is in flight —
        // an in-flight destructive action must not be abandonable mid-call
        // via the keyboard any more than via the Cancel button (see
        // requestDismiss above).
        if (submitting) {
          event.preventDefault()
          return
        }
        onDismiss()
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) requestDismiss()
      }}
    >
      <h2 id="confirm-dialog-title" className="text-title">
        {title}
      </h2>
      <div className="confirm-dialog__body">{children}</div>

      {localError !== null && (
        <p className="error-panel__message confirm-dialog__error" role="alert">
          {localError}
        </p>
      )}

      <div className="confirm-dialog__actions">
        <button
          ref={cancelButtonRef}
          type="button"
          className="btn btn--secondary"
          onClick={requestDismiss}
          disabled={submitting}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          className={`btn btn--${tone}`}
          onClick={() => void handleConfirmClick()}
          disabled={submitting}
          data-loading={submitting ? 'true' : undefined}
          data-testid={testId ? `${testId}-confirm` : undefined}
        >
          <span className="btn__label">{confirmLabel}</span>
          <span className="btn__spinner" aria-hidden="true" />
        </button>
      </div>
    </dialog>
  )
}
