import { describe, expect, it } from 'vitest'
import { ALL_CONNECTOR_TARGETS } from '../src/connectors/connector'
import { externalIdentitySystem } from '../src/db/schema/external-identities'
import { outboxTarget } from '../src/db/schema/outbox-events'

/**
 * The regression guard for the "catalog drift" security-audit finding.
 *
 * `ConnectorTarget` used to be a hand-rolled union, and five separate places
 * hand-copied its values as a runtime array (two `z.enum` route validators,
 * the console catalog, the dead-letter target filter, the reconcile CLI).
 * Adding `mail_server` left all five stale, and NOTHING caught it: a narrower
 * literal list is assignable to a wider union, so `tsc` is silent, and the
 * only completeness test in the tree compared the two pgEnums to EACH OTHER
 * and never to the TypeScript side. The result was a live outbound
 * integration that could not be listed, configured or DISABLED through the
 * API at all.
 *
 * These assertions close the loop the type system cannot: TS array <-> both
 * pgEnums, in both directions, so a value added to any one of the three and
 * missed in the others fails here.
 */
describe('connector target catalog', () => {
  it('matches the outbox_target pgEnum exactly, in both directions', () => {
    expect([...ALL_CONNECTOR_TARGETS].sort()).toEqual([...outboxTarget.enumValues].sort())
  })

  it('matches the external_identity_system pgEnum exactly, in both directions', () => {
    // SyncWorker writes `external_identities.system` straight from
    // `event.target` with no mapping table, so these two must stay
    // one-for-one or a successful sync fails to correlate.
    expect([...ALL_CONNECTOR_TARGETS].sort()).toEqual([...externalIdentitySystem.enumValues].sort())
  })

  it('has no duplicates', () => {
    expect(new Set(ALL_CONNECTOR_TARGETS).size).toBe(ALL_CONNECTOR_TARGETS.length)
  })

  it('includes mail_server — the target whose absence this guard was written for', () => {
    expect(ALL_CONNECTOR_TARGETS).toContain('mail_server')
  })
})
