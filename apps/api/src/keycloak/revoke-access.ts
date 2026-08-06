import type { KeycloakAdminClient } from './keycloak-admin.client'

/**
 * Attempts to end Keycloak-side access for `username` RIGHT NOW:
 * `setEnabled(false)` (blocks future logins) followed by `revokeSessions`
 * (kills sessions/tokens already issued). Extracted out of
 * `UsersController.deactivate` (Milestone 4, Task 4 — see that method's own
 * doc comment for the full reasoning) so Milestone 7's two NEW deactivation
 * paths — `RuleApplier`'s `deactivate` action and `LifecycleJob`'s
 * date-driven deactivation — share the identical contract instead of each
 * growing its own copy. `UsersController` itself is left untouched: it
 * already has this same logic, already covered by revocation.spec.ts, and
 * there is nothing to gain by risking a regression there just to remove one
 * more small, stable, already-duplicated-once function.
 *
 * Callers are expected to invoke this AFTER their own local transaction has
 * committed, never before or instead of it — a Keycloak call must never run
 * ahead of, or gate, the local mutation it reflects. This function itself
 * never throws: a Keycloak outage (or a user who never finished their first
 * sync yet, surfacing as a Keycloak-side NotFoundError) must never fail a
 * deactivation that has already committed locally. The caller is expected to
 * have unconditionally enqueued a durability-fallback outbox event BEFORE
 * calling this, exactly like UsersController.deactivate does — this
 * synchronous attempt is a best-effort head start, not the only mechanism.
 */
export async function revokeKeycloakAccessBestEffort(
  keycloak: KeycloakAdminClient,
  username: string,
  logPrefix: string,
): Promise<void> {
  try {
    await keycloak.setEnabled(username, false)
    await keycloak.revokeSessions(username)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(
      `${logPrefix} synchronous Keycloak revocation failed for "${username}" — the outbox event will retry it: ${message}`,
    )
  }
}
