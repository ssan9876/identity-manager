import { describe, expect, it } from 'vitest'
import { externalIdentitySystem } from '../src/db/schema/external-identities'
import { outboxTarget } from '../src/db/schema/outbox-events'

describe('mail_server target registration', () => {
  it('is a member of the outbox_target enum', () => {
    expect(outboxTarget.enumValues).toContain('mail_server')
  })

  it('is a member of the external_identity_system enum', () => {
    expect(externalIdentitySystem.enumValues).toContain('mail_server')
  })

  it('keeps the two enums one-for-one, so event.target is assignable as system', () => {
    expect([...outboxTarget.enumValues].sort()).toEqual([...externalIdentitySystem.enumValues].sort())
  })
})
