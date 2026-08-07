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

    it('plan() reports create before any apply, and update after a subsequent genuine change, writing nothing either time', async () => {
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
      // Milestone 10, Task 4: plan() now diffs against the last APPLIED
      // state (see plan()'s own doc comment), so re-planning the IDENTICAL
      // desired state just applied reports no operations at all — see the
      // dedicated "diffs against the last applied state" block below for
      // that exact case. Here, a GENUINE change since the apply above is
      // what still reports 'update'.
      const afterApply = await connector.plan(desiredUser({ firstName: 'Changed' }))
      expect(afterApply).toEqual([expect.objectContaining({ kind: 'update' })])
    })

    // =========================================================================
    // Milestone 10, Task 4 — plan() must do a GENUINE diff, not unconditionally
    // report "update": `TargetReconciliationJob` counts a non-empty plan() as
    // a mutation toward its blast-radius threshold, and relies on an empty
    // plan() to prove a converged re-run is a no-op. See plan()'s own doc
    // comment (echo.connector.ts) for why Task 2's original "always update"
    // behaviour was not enough for that.
    // =========================================================================
    describe('plan() diffs against the last APPLIED state (Milestone 10, Task 4)', () => {
      it('reports NOTHING once the exact same desired state has already been applied — genuinely idempotent', async () => {
        const connector = configuredConnector()
        const desired = desiredUser()

        await connector.apply(desired)
        const plan = await connector.plan(desired)

        expect(plan).toEqual([])
      })

      it('reports an update when a profile field changed since the last apply', async () => {
        const connector = configuredConnector()
        await connector.apply(desiredUser({ firstName: 'Before' }))

        const plan = await connector.plan(desiredUser({ firstName: 'After' }))

        expect(plan).toEqual([expect.objectContaining({ kind: 'update' })])
      })

      it('reports an update (not disable) when enabled flips true -> ... true (no-op) vs a genuine disable when it flips to false', async () => {
        const connector = configuredConnector()
        await connector.apply(desiredUser({ enabled: true }))

        const unchanged = await connector.plan(desiredUser({ enabled: true }))
        expect(unchanged).toEqual([])

        const disablePlan = await connector.plan(desiredUser({ enabled: false }))
        expect(disablePlan).toEqual([expect.objectContaining({ kind: 'disable' })])
      })

      it('reports an update when group membership changed since the last apply', async () => {
        const connector = configuredConnector()
        await connector.apply(desiredUser({ groups: ['Engineering'] }))

        const unchanged = await connector.plan(desiredUser({ groups: ['Engineering'] }))
        expect(unchanged).toEqual([])

        const changed = await connector.plan(desiredUser({ groups: ['Engineering', 'Leads'] }))
        expect(changed).toEqual([expect.objectContaining({ kind: 'update' })])
      })

      it('a plan() call never itself updates what a LATER plan() diffs against — only apply() does', async () => {
        const connector = configuredConnector()
        await connector.apply(desiredUser({ firstName: 'Original' }))

        // Planning a change does not apply it.
        await connector.plan(desiredUser({ firstName: 'Hypothetical' }))

        // A plan for the ORIGINAL state still shows nothing changed —
        // proving the hypothetical plan() call above left no trace.
        const stillUnchanged = await connector.plan(desiredUser({ firstName: 'Original' }))
        expect(stillUnchanged).toEqual([])
      })
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
