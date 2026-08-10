import { authorizedRequest, buildQuery } from '../api/client'
import type { ConnectorTarget } from '../connectors/api'
import type { Page } from '../org-units/api'

/**
 * Mirrors `DeadLetterEvent` (apps/api/src/outbox/outbox.repository.ts).
 * `payload` is whatever the mutation that enqueued this event recorded — see
 * DeadLettersTab.tsx for how each aggregate type's shape is read.
 *
 * `target` reuses the ONE `ConnectorTarget` union from connectors/api.ts
 * rather than restating the list. It used to carry its own inline copy,
 * which was missing `mail_server` and therefore mistyped the exact rows this
 * view exists to show — see that union's own doc comment for the full
 * finding. It is emphatically NOT always `'keycloak'` in practice: a real
 * deployment enables several targets, and a dead letter from a non-Keycloak
 * one is the normal case here, not a future one.
 */
export interface DeadLetterEvent {
  id: number
  aggregateType: 'user' | 'group' | 'membership'
  aggregateId: string
  eventType: string
  payload: Record<string, unknown>
  target: ConnectorTarget
  attempts: number
  lastError: string | null
  createdAt: string
  nextAttemptAt: string
}

/** Mirrors `SyncWorkerConfig.maxAttempts`'s default (sync.worker.ts) — not configurable anywhere in app.module.ts's DI wiring today, so this default is what every deployment actually runs. Display only ("8 of 8 attempts") — every row this endpoint returns has, by definition, already reached this ceiling (OutboxRepository.markFailed's own call site). */
export const DEFAULT_MAX_ATTEMPTS = 8

export interface DeadLetterListParams {
  limit: number
  offset: number
  /** Milestone 14, Task 9 — narrows to one target's own dead letters, extending Milestone 8's unfiltered view. Omitted means every target, unchanged from before this task. */
  target?: DeadLetterEvent['target']
  /** Per-organization connector targets: narrows to dead letters whose AGGREGATE belongs to this organization. Omitted means every organization. */
  organizationId?: string
}

/** `GET /outbox/dead-letters` — gated on `audit:read`, same permission as the audit log itself (OutboxController's own doc comment: "the same category of information audit_log already exists to expose"). Read-only: there is no retry/resolve route here — see that file's doc comment for why (ReconciliationJob's job, run out-of-band). */
export function fetchDeadLetters(accessToken: string, params: DeadLetterListParams): Promise<Page<DeadLetterEvent>> {
  return authorizedRequest<Page<DeadLetterEvent>>(
    `/outbox/dead-letters${buildQuery({
      limit: params.limit,
      offset: params.offset,
      target: params.target,
      organizationId: params.organizationId,
    })}`,
    accessToken,
  )
}
