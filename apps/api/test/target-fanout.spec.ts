import { describe, expect, it } from 'vitest'
import { ALL_CONNECTOR_TARGETS } from '../src/connectors/connector'
import { ALL_OUTBOX_AGGREGATE_TYPES } from '../src/outbox/outbox.writer'
import { targetsForAggregate } from '../src/outbox/target-fanout'

const EVERY_TARGET = [...ALL_CONNECTOR_TARGETS]

describe('targetsForAggregate', () => {
  it('sends an sso_app event to keycloak_sso and nowhere else', () => {
    // Active Directory, Entra and Google have no concept of an application.
    // Handing them one would dead-letter at best.
    expect(targetsForAggregate('sso_app', EVERY_TARGET)).toEqual(['keycloak_sso'])
  })

  it('sends an organization event to keycloak and nowhere else', () => {
    // Organizations milestone, Task 10. An organization IS a Keycloak realm;
    // no other target in the catalog has a realm concept. A STRICTER filter
    // than the sso_app branch, not the same one inverted.
    expect(targetsForAggregate('organization', EVERY_TARGET)).toEqual(['keycloak'])
  })

  /**
   * Active Directory is the only target with a native OU tree, so it is the
   * only one that can act on an org-unit event at all. Before the org-unit
   * connector existed these events went to every directory and SyncWorker
   * no-opped each one — harmless only for exactly as long as nothing acted
   * on them. Now that something does, sending one to Keycloak would enqueue
   * a row that fails, retries with backoff and dead-letters as noise.
   */
  it('sends an org-unit event to active_directory alone', () => {
    expect(targetsForAggregate('org_unit', EVERY_TARGET)).toEqual(['active_directory'])
  })

  it('sends an org-unit event nowhere when active_directory is not enabled', () => {
    expect(targetsForAggregate('org_unit', ['keycloak', 'echo'])).toEqual([])
  })

  it.each(['user', 'group', 'membership', 'org_unit'] as const)(
    'never sends a %s event to keycloak_sso',
    (aggregateType) => {
      expect(targetsForAggregate(aggregateType, EVERY_TARGET)).not.toContain('keycloak_sso')
    },
  )

  it('leaves the directory fan-out otherwise unchanged', () => {
    expect(targetsForAggregate('user', EVERY_TARGET)).toEqual(
      EVERY_TARGET.filter((t) => t !== 'keycloak_sso'),
    )
  })

  it('respects the enabled list — a disabled target gets nothing', () => {
    expect(targetsForAggregate('user', ['keycloak'])).toEqual(['keycloak'])
    expect(targetsForAggregate('sso_app', ['keycloak'])).toEqual([])
  })

  it('preserves the order it was given, so row order stays deterministic', () => {
    expect(targetsForAggregate('user', ['echo', 'keycloak', 'mail_server'])).toEqual([
      'echo',
      'keycloak',
      'mail_server',
    ])
  })

  it('gives an organization nothing when keycloak is not enabled', () => {
    expect(targetsForAggregate('organization', ['active_directory', 'mail_server'])).toEqual([])
  })

  it('classifies every aggregate type in the catalog', () => {
    // A future aggregate added to the pgEnum and forgotten here fails the
    // suite rather than silently fanning out to every directory.
    for (const aggregateType of ALL_OUTBOX_AGGREGATE_TYPES) {
      expect(() => targetsForAggregate(aggregateType, EVERY_TARGET)).not.toThrow()
    }
  })
})
