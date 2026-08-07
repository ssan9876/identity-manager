import { authorizedRequest, buildQuery } from '../api/client'
import type { Page } from '../org-units/api'

/** Mirrors `DeadLetterEvent` (apps/api/src/outbox/outbox.repository.ts). `payload` is whatever the mutation that enqueued this event recorded — see DeadLettersTab.tsx for how each aggregate type's shape is read. */
export interface DeadLetterEvent {
  id: number
  aggregateType: 'user' | 'group' | 'membership'
  aggregateId: string
  eventType: string
  payload: Record<string, unknown>
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
}

/** `GET /outbox/dead-letters` — gated on `audit:read`, same permission as the audit log itself (OutboxController's own doc comment: "the same category of information audit_log already exists to expose"). Read-only: there is no retry/resolve route here — see that file's doc comment for why (ReconciliationJob's job, run out-of-band). */
export function fetchDeadLetters(accessToken: string, params: DeadLetterListParams): Promise<Page<DeadLetterEvent>> {
  return authorizedRequest<Page<DeadLetterEvent>>(
    `/outbox/dead-letters${buildQuery({ limit: params.limit, offset: params.offset })}`,
    accessToken,
  )
}
