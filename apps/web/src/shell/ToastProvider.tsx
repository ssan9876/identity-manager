import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'

/** Mirrors the badge vocabulary (people/badges.tsx's STATUS_VARIANT/SYNC_VARIANT) so a toast and the badge it follows ("Deactivated" + "Sync pending") agree on what colour means, app-wide. */
export type ToastTone = 'neutral' | 'warn' | 'danger'

interface ToastRecord {
  id: number
  message: string
  tone: ToastTone
}

interface ToastContextValue {
  showToast: (message: string, tone?: ToastTone) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

// Long enough to read a real sentence (the deactivate toast reports two
// distinct facts — sign-in blocked and sync state — not just "Done") without
// requiring a click to dismiss; the explicit dismiss button covers anyone
// who wants it gone sooner, or needs longer (a screen-reader user tabbing
// there is not racing this timer, since the message was already announced
// via aria-live the moment it appeared).
const AUTO_DISMISS_MS = 7000

/**
 * DESIGN.md: "Toasts for the result of an action, especially the ones with
 * consequence ('Deactivated — 2 active sessions revoked')." Mounted once, in
 * App.tsx above <Routes>, so a toast SURVIVES the navigation an action often
 * triggers (create user redirects to the new record's detail page) instead
 * of being unmounted with whatever page queued it.
 *
 * One `aria-live="polite"` region for every toast, not a fresh region per
 * toast — a screen reader needs ONE stable live region to watch, matching
 * how every other status message in this console (nav's "Could not load
 * navigation", inline form errors) is announced. "polite", not "assertive":
 * a toast reports what already happened, it never needs to interrupt
 * whatever the caller is doing right now.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([])
  const nextId = useRef(0)

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const showToast = useCallback(
    (message: string, tone: ToastTone = 'neutral') => {
      const id = nextId.current
      nextId.current += 1
      setToasts((prev) => [...prev, { id, message, tone }])
      window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS)
    },
    [dismiss],
  )

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="toast-region" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast--${toast.tone}`} role="status" data-testid="toast">
            <p className="toast__message">{toast.message}</p>
            <button
              type="button"
              className="toast__dismiss"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss notification"
            >
              <span aria-hidden="true">&times;</span>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (ctx === null) {
    throw new Error('useToast must be used within a ToastProvider')
  }
  return ctx
}
