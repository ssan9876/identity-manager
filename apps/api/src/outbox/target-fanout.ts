import type { ConnectorTarget } from '../connectors/connector'
import type { OutboxAggregateType } from './outbox.writer'

/**
 * Which targets a mutation of this aggregate type reaches. The single source
 * of truth for fan-out — `OutboxWriter.record` consults nothing else.
 *
 * Before this existed, `record` wrote one row per enabled target
 * unconditionally. That was correct while every aggregate described a person
 * or a grouping of people and every target was a directory. `sso_app` breaks
 * both halves at once: an application means nothing to Active Directory,
 * Entra or Google, and `keycloak_sso` has no idea what a user is. Without the
 * filter, registering one application would enqueue rows for every enabled
 * directory, each of which would fail, retry with backoff, and eventually
 * dead-letter — noise an operator would have to learn to ignore.
 *
 * Deliberately a PURE function over an explicitly-passed enabled list rather
 * than a database read of its own. That is what makes the "every aggregate is
 * classified" assertion in test/target-fanout.spec.ts cheap enough to be
 * worth having: it can iterate the whole pgEnum with no container, so a
 * future aggregate added and left unclassified fails the suite instead of
 * quietly defaulting to the directory branch.
 *
 * Order is preserved from the caller's list — `record` reads
 * `connector_targets` with an explicit ORDER BY, and keeping that order makes
 * the inserted row order deterministic for tests that assert on it.
 */
export function targetsForAggregate(
  aggregateType: OutboxAggregateType,
  enabledTargets: readonly ConnectorTarget[],
): ConnectorTarget[] {
  if (aggregateType === 'sso_app') {
    return enabledTargets.filter((target) => target === 'keycloak_sso')
  }
  return enabledTargets.filter((target) => target !== 'keycloak_sso')
}
