import type { DesiredUser } from '../src/connectors/connector'
import { MailServerConnector } from '../src/connectors/mail-server.connector'

/**
 * Proves the payload this connector BUILDS is one the mail server ACCEPTS.
 *
 * Unit tests assert what we send; the counterpart's own suite asserts what it
 * accepts. Neither can see a DISAGREEMENT between the two, and a stub we write
 * ourselves can be wrong in exactly the way the connector is wrong. This makes
 * one real round trip and asserts it succeeds — which, because the
 * counterpart's schema is closed (`extra="forbid"`) and its own suite already
 * proves its behaviour, covers essentially all contract drift for a fraction
 * of the cost of reproducing that suite here.
 *
 * Requires a reachable mail server (the tunnel up — see
 * docs/11-operations.md), plus:
 *
 *   MAIL_SERVER_BASE_URL     e.g. http://10.8.0.2/api/v1
 *   CONNECTOR_MAIL_SERVER_TOKEN  issued there, returned exactly once
 *   MAIL_SMOKE_EMAIL         an address in a domain ALREADY hosted there —
 *                            the mail server never auto-creates domains
 */
async function main(): Promise<void> {
  const baseUrl = process.env.MAIL_SERVER_BASE_URL
  const smokeEmail = process.env.MAIL_SMOKE_EMAIL

  if (
    baseUrl === undefined ||
    baseUrl.length === 0 ||
    smokeEmail === undefined ||
    smokeEmail.length === 0
  ) {
    console.error(
      '[smoke:mail] set MAIL_SERVER_BASE_URL and MAIL_SMOKE_EMAIL (an address in a domain hosted there)',
    )
    process.exit(1)
  }

  const connector = new MailServerConnector().configure({
    baseUrl,
    tokenSecretName: 'CONNECTOR_MAIL_SERVER_TOKEN',
  })

  const health = await connector.health()
  if (!health.ok) {
    console.error(`[smoke:mail] health check failed: ${health.detail}`)
    process.exit(1)
  }
  console.log(`[smoke:mail] health ok — ${health.detail}`)

  // A FIXED uuid, so re-running converges the SAME identity rather than
  // accumulating smoke-test mailboxes on the target.
  const desired: DesiredUser = {
    userId: '00000000-0000-4000-8000-000000000001',
    username: 'idm-smoke',
    email: smokeEmail,
    firstName: 'IdM',
    lastName: 'Smoke',
    // Created SUSPENDED, never active: a smoke run must not leave a live,
    // deliverable mailbox behind. `suspended` also exercises the status
    // mapping the counterpart cares most about — it must NOT stamp
    // `deactivated_at`, because suspension is not offboarding.
    enabled: false,
    status: 'suspended',
    attributes: { mail_enabled: ['true'] },
    groups: [],
  }

  const { externalId } = await connector.apply(desired)
  console.log(`[smoke:mail] upsert accepted — external id ${externalId}`)

  // Idempotence is the property the counterpart's reconciliation depends on:
  // re-pushing identical desired state must be a no-op there, not a second
  // identity.
  await connector.apply(desired)
  console.log('[smoke:mail] re-push accepted — contract holds')
}

main().catch((error: unknown) => {
  console.error(`[smoke:mail] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
