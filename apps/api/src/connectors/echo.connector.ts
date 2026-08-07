import { Injectable } from '@nestjs/common'
import type {
  ConnectorHealth,
  ConnectorOperation,
  DesiredUser,
  DirectoryConnector,
} from './connector'
import { resolveSecret } from './secrets'

/** One call this connector was asked to make, recorded verbatim — "recording what it was asked to do" (Milestone 10, Task 2 contract). */
export interface EchoRecordedCall {
  method: 'plan' | 'apply' | 'disable'
  desired?: DesiredUser
  externalId?: string
  at: Date
}

const CREDENTIAL_SECRET_NAME_KEY = 'credentialSecretName'

/**
 * The in-repo target Milestone 10 ships with — "a full in-repo
 * implementation recording what it was asked to do. This proves the spine
 * end-to-end before any vendor protocol exists" (milestone plan, Task 2).
 * Not a test double: it is a genuine `outbox_target`/`connector_targets`
 * citizen (see `ConnectorTarget`'s own doc comment) that Milestone 14's
 * console E2E configures and drives through the real spine.
 *
 * REQUIRES a `credentialSecretName` in its `connector_targets.config`,
 * exactly like a real vendor connector requires a bind password / client
 * secret / service-account key — this is what makes it a faithful stand-in
 * for proving secret resolution end-to-end, not just the profile-sync
 * plumbing. `apply`/`disable`/`plan` all resolve it (proving the DISCIPLINE
 * of "resolve transiently, use, discard" even though this connector has no
 * real remote system to send it to — see `requireSecret` below) and NEVER
 * record the resolved VALUE anywhere, including in `calls` — only `desired`/
 * `externalId`, which by construction never carry a credential (see
 * `DirectoryConnector`'s own doc comment: "never sends a user credential").
 *
 * `calls` and the username -> externalId map are read directly by tests —
 * this class deliberately exposes its own recorded state rather than hiding
 * it behind a second observer object, since "prove what it received" is
 * this connector's entire reason to exist.
 *
 * `@Injectable()` and registered in AppModule (Milestone 10, Task 2) so
 * `ConnectorRegistry`'s own `EchoConnector` constructor parameter is
 * resolvable through real Nest DI — Nest reflects EVERY constructor
 * parameter's TYPE regardless of whether it also has a default value, so an
 * unregistered class parameter fails DI resolution even with `= new
 * EchoConnector()` written at the call site (confirmed the hard way:
 * app.module.spec.ts's DI-graph smoke test failed on exactly this before
 * this class carried the decorator). Constructor takes nothing — same
 * "never network I/O at construction" property `KeycloakAdminClient`/
 * `OutboxRepository`/etc. already have, which is what makes it safe to
 * register unconditionally for every app boot, including tests that only
 * ever call `app.init()`.
 */
@Injectable()
export class EchoConnector implements DirectoryConnector {
  readonly calls: EchoRecordedCall[] = []
  private readonly externalIdsByUsername = new Map<string, string>()
  private nextSequence = 1
  private config: Record<string, unknown> = {}

  /**
   * Binds this connector to a FRESH read of `connector_targets.config` —
   * called by `ConnectorRegistry.resolve` immediately before handing this
   * instance back to a caller, never by a caller directly. Not part of
   * `DirectoryConnector` — a registry-internal step, exactly analogous to
   * how `KeycloakConnector` needs no such step because its config source
   * (env, via `KeycloakAdminClient`) is unchanged by this milestone. Returns
   * `this` so `ConnectorRegistry.resolve` can `factory(config)` in one
   * expression.
   */
  configure(config: Record<string, unknown>): this {
    this.config = config
    return this
  }

  async plan(desired: DesiredUser): Promise<ConnectorOperation[]> {
    this.requireSecret()
    this.calls.push({ method: 'plan', desired, at: new Date() })
    const exists = this.externalIdsByUsername.has(desired.username)
    return [
      {
        kind: exists ? 'update' : 'create',
        description: `${exists ? 'update' : 'create'} echo user "${desired.username}" (enabled=${desired.enabled}, groups=[${desired.groups.join(', ')}])`,
      },
    ]
  }

  /**
   * Assigns a NEW synthetic external id the first time a given `username`
   * is seen, and returns the SAME one on every later call — the "immutable
   * external id" correlation (`external_identities`) depends on, and the
   * property idempotence tests need (applying the same desired state twice
   * must not mint a second identity). `requireSecret` runs FIRST, before any
   * recording or map mutation, so a missing secret leaves NOTHING applied —
   * "never partially applies" (Task 2 contract).
   */
  async apply(desired: DesiredUser): Promise<{ externalId: string }> {
    this.requireSecret()

    let externalId = this.externalIdsByUsername.get(desired.username)
    if (externalId === undefined) {
      externalId = `echo-${this.nextSequence++}`
      this.externalIdsByUsername.set(desired.username, externalId)
    }

    this.calls.push({ method: 'apply', desired, externalId, at: new Date() })
    return { externalId }
  }

  async disable(externalId: string): Promise<void> {
    this.requireSecret()
    this.calls.push({ method: 'disable', externalId, at: new Date() })
  }

  async health(): Promise<ConnectorHealth> {
    try {
      const secretName = this.secretName()
      resolveSecret(secretName)
      return { ok: true, detail: `echo target reachable; credential resolved from "${secretName}"` }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Throws `MissingSecretError` (secrets.ts) if the configured secret name has no value in the environment. Discards the resolved value immediately — it exists only to prove resolution succeeded. */
  private requireSecret(): void {
    resolveSecret(this.secretName())
  }

  /** Throws a plain, config-shape error (distinct from MissingSecretError) when `connector_targets.config` itself never named a secret — a configuration defect, not an absent environment variable. Never includes any secret VALUE, only ever the fixed, non-sensitive field name `credentialSecretName`. */
  private secretName(): string {
    const raw = this.config[CREDENTIAL_SECRET_NAME_KEY]
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new Error(
        `echo connector: connector_targets.config.${CREDENTIAL_SECRET_NAME_KEY} is required and must be a non-empty string`,
      )
    }
    return raw
  }
}
