import type { ConnectorHealthStatus } from './api'

/**
 * DESIGN.md: "word + optional shape, never colour alone. Active is
 * uncoloured." Applied here to a FIVE-state health model, not the usual
 * boolean — the task's own core requirement is that "configured but never
 * successfully synced" must not read as healthy, so `never_synced` gets its
 * OWN word and its own (warn) treatment, distinct from both `healthy`
 * (uncoloured, like "Active" elsewhere in this console) and `failing`
 * (danger, like "Sync failed"). `not_configured`/`disabled` are deliberate,
 * expected states — not exceptions — so they stay uncoloured too; the WORD
 * is what tells them apart from `healthy`, exactly as DESIGN.md requires
 * ("status is never conveyed by colour alone").
 */
const HEALTH_WORD: Record<ConnectorHealthStatus, string> = {
  not_configured: 'Not configured',
  disabled: 'Disabled',
  never_synced: 'Never synced',
  failing: 'Failing',
  healthy: 'Healthy',
}

const HEALTH_VARIANT: Record<ConnectorHealthStatus, 'neutral' | 'warn' | 'danger'> = {
  not_configured: 'neutral',
  disabled: 'neutral',
  never_synced: 'warn',
  failing: 'danger',
  healthy: 'neutral',
}

export function HealthBadge({ status }: { status: ConnectorHealthStatus }) {
  const variant = HEALTH_VARIANT[status]
  return (
    <span className={`badge badge--${variant}`} data-health-status={status}>
      {variant !== 'neutral' && <span className="badge__dot" aria-hidden="true" />}
      {HEALTH_WORD[status]}
    </span>
  )
}

export function EnabledBadge({ enabled }: { enabled: boolean }) {
  return (
    <span className={`badge badge--${enabled ? 'neutral' : 'warn'}`} data-enabled={enabled}>
      {!enabled && <span className="badge__dot" aria-hidden="true" />}
      {enabled ? 'Enabled' : 'Disabled'}
    </span>
  )
}
