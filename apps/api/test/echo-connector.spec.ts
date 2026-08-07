import { afterAll, describe, expect, it } from 'vitest'
import type { DesiredUser } from '../src/connectors/connector'
import { EchoConnector } from '../src/connectors/echo.connector'
import { MissingSecretError } from '../src/connectors/secrets'

const SECRET_NAME = 'ECHO_CONNECTOR_TEST_SECRET'

afterAll(() => {
  delete process.env[SECRET_NAME]
})

function desiredUser(overrides: Partial<DesiredUser> = {}): DesiredUser {
  return {
    username: 'echo-user@example.com',
    email: 'echo-user@example.com',
    firstName: 'Echo',
    lastName: 'User',
    enabled: true,
    attributes: { department: ['Engineering'] },
    groups: ['Engineering'],
    ...overrides,
  }
}

/** A connector configured with a secret name whose env var IS set — the "everything works" baseline every other test starts from. */
function configuredConnector(secretValue = 'real-secret-value'): EchoConnector {
  process.env[SECRET_NAME] = secretValue
  return new EchoConnector().configure({ credentialSecretName: SECRET_NAME })
}

describe('EchoConnector (Milestone 10, Task 2)', () => {
  // =========================================================================
  // "the echo target receives exactly the desired state for a create, an
  // update and a disable" — Task 2's own named test.
  // =========================================================================
  describe('records exactly what it was asked to do', () => {
    it('a CREATE (first apply for a username) is recorded verbatim and assigned a fresh external id', async () => {
      const connector = configuredConnector()
      const desired = desiredUser()

      const { externalId } = await connector.apply(desired)

      expect(externalId).toMatch(/^echo-/)
      expect(connector.calls).toHaveLength(1)
      expect(connector.calls[0]).toEqual({
        method: 'apply',
        desired,
        externalId,
        at: expect.any(Date),
      })
    })

    it('an UPDATE (second apply for the SAME username) reuses the SAME external id and records the new desired state verbatim', async () => {
      const connector = configuredConnector()
      const first = await connector.apply(desiredUser({ firstName: 'Before' }))

      const updatedDesired = desiredUser({ firstName: 'After', groups: ['Engineering', 'Leads'] })
      const second = await connector.apply(updatedDesired)

      expect(second.externalId).toBe(first.externalId)
      expect(connector.calls).toHaveLength(2)
      expect(connector.calls[1]?.desired).toEqual(updatedDesired)
      expect(connector.calls[1]?.externalId).toBe(first.externalId)
    })

    it('two DIFFERENT usernames get two DIFFERENT external ids', async () => {
      const connector = configuredConnector()
      const a = await connector.apply(desiredUser({ username: 'a@example.com' }))
      const b = await connector.apply(desiredUser({ username: 'b@example.com' }))
      expect(a.externalId).not.toBe(b.externalId)
    })

    it('a DISABLE is recorded with exactly the given external id and no desired state', async () => {
      const connector = configuredConnector()
      const { externalId } = await connector.apply(desiredUser())

      await connector.disable(externalId)

      const disableCall = connector.calls.at(-1)
      expect(disableCall).toEqual({ method: 'disable', externalId, at: expect.any(Date) })
      expect(disableCall).not.toHaveProperty('desired')
    })

    it('plan() reports create before any apply, and update afterward, writing nothing', async () => {
      const connector = configuredConnector()
      const desired = desiredUser()

      const beforePlan = await connector.plan(desired)
      expect(beforePlan).toEqual([
        expect.objectContaining({ kind: 'create' }),
      ])
      // A plan writes nothing — no id minted, no username tracked yet.
      const stillFresh = await connector.plan(desired)
      expect(stillFresh).toEqual(beforePlan)

      await connector.apply(desired)
      const afterApply = await connector.plan(desired)
      expect(afterApply).toEqual([expect.objectContaining({ kind: 'update' })])
    })
  })

  // =========================================================================
  // "A target whose secret is missing from the environment fails health()
  // cleanly with an actionable message and never partially applies."
  // =========================================================================
  describe('missing secret — clean health failure, never partially applies', () => {
    it('health() reports ok:false with an actionable, secret-VALUE-free message when the env var is unset', async () => {
      delete process.env[SECRET_NAME]
      const connector = new EchoConnector().configure({ credentialSecretName: SECRET_NAME })

      const health = await connector.health()

      expect(health.ok).toBe(false)
      expect(health.detail).toContain(SECRET_NAME) // actionable: names WHICH var
      expect(health.detail.length).toBeGreaterThan(0)
    })

    it('health() reports ok:true once the secret is present', async () => {
      const connector = configuredConnector()
      const health = await connector.health()
      expect(health).toEqual({ ok: true, detail: expect.any(String) })
    })

    it('health() reports ok:false with an actionable message when connector_targets.config never named a secret at all', async () => {
      const connector = new EchoConnector().configure({}) // no credentialSecretName key
      const health = await connector.health()
      expect(health.ok).toBe(false)
      expect(health.detail).toContain('credentialSecretName')
    })

    it('apply() throws MissingSecretError and records NOTHING when the secret is missing', async () => {
      delete process.env[SECRET_NAME]
      const connector = new EchoConnector().configure({ credentialSecretName: SECRET_NAME })

      await expect(connector.apply(desiredUser())).rejects.toThrow(MissingSecretError)

      expect(connector.calls).toHaveLength(0)
    })

    it('disable() throws and records nothing when the secret is missing', async () => {
      delete process.env[SECRET_NAME]
      const connector = new EchoConnector().configure({ credentialSecretName: SECRET_NAME })

      await expect(connector.disable('echo-123')).rejects.toThrow(MissingSecretError)

      expect(connector.calls).toHaveLength(0)
    })

    it('plan() throws and never mints an id when the secret is missing', async () => {
      delete process.env[SECRET_NAME]
      const connector = new EchoConnector().configure({ credentialSecretName: SECRET_NAME })

      await expect(connector.plan(desiredUser())).rejects.toThrow(MissingSecretError)
      expect(connector.calls).toHaveLength(0)
    })

    it('a failed apply (missing secret) followed by a successful one still treats the username as a fresh CREATE — nothing from the failed attempt survived', async () => {
      const connector = new EchoConnector().configure({ credentialSecretName: SECRET_NAME })
      const desired = desiredUser()

      delete process.env[SECRET_NAME]
      await expect(connector.apply(desired)).rejects.toThrow(MissingSecretError)

      process.env[SECRET_NAME] = 'now-present'
      const { externalId } = await connector.apply(desired)

      expect(connector.calls).toHaveLength(1) // only the SUCCESSFUL attempt recorded
      expect(externalId).toMatch(/^echo-1$/) // the FIRST id ever minted by this connector — proves the failed attempt did not advance the sequence or pre-register the username
    })
  })
})
