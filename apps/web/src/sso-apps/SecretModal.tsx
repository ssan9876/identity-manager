import { useEffect, useRef, useState } from 'react'

/**
 * Shows a freshly minted client secret ONCE.
 *
 * There is no reveal toggle and no masking anywhere in this component,
 * because there is nothing to reveal: the value was never stored, so no
 * endpoint can return it again. Masking it would be a lie about the
 * architecture — the same reasoning that keeps `credentialSecretName`
 * rendered as a plain text input rather than a password field.
 *
 * The copy button uses the async Clipboard API, which is unavailable over
 * plain HTTP on a non-localhost origin. On failure the value stays visible
 * and selectable rather than the dialog reporting success it did not have —
 * losing a secret that cannot be re-read is worse than an extra click.
 */
export function SecretModal({
  clientId,
  secret,
  onClose,
}: {
  clientId: string
  secret: string
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
      setCopyFailed(false)
    } catch {
      setCopied(false)
      setCopyFailed(true)
    }
  }

  return (
    <div className="secret-modal__backdrop" role="presentation">
      <div
        className="secret-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="secret-modal-title"
        data-testid="secret-modal"
      >
        <h2 id="secret-modal-title">Client secret for {clientId}</h2>

        <p className="secret-modal__warning">
          This will not be shown again. Copy it now and store it wherever {clientId} reads its
          configuration from.
        </p>

        <code className="secret-modal__value" data-testid="secret-value">
          {secret}
        </code>

        <div className="secret-modal__actions">
          <button type="button" className="btn" onClick={copy}>
            {copied ? 'Copied' : 'Copy secret'}
          </button>
          <button type="button" className="btn btn--primary" onClick={onClose} ref={closeRef}>
            Done
          </button>
        </div>

        {copyFailed && (
          <p className="secret-modal__copy-failed" role="alert">
            Could not copy automatically — select the value above and copy it manually.
          </p>
        )}

        <p className="secret-modal__note">
          Generating a new secret later replaces this one; the old value stops working
          immediately.
        </p>
      </div>
    </div>
  )
}
