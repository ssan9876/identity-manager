import { Injectable } from '@nestjs/common'
import type {
  ConnectorHealth,
  ConnectorOperation,
  DesiredUser,
  DirectoryConnector,
} from './connector'
import { NotApplicableError } from './connector'
import { resolveSecret } from './secrets'

const BASE_URL_KEY = 'baseUrl'
const TOKEN_SECRET_NAME_KEY = 'tokenSecretName'
const REQUEST_TIMEOUT_KEY = 'requestTimeoutMs'
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

/** Injected so a test can substitute `fetch` without touching the global — the same "no network I/O at construction" property every other connector has. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/**
 * A non-200 from the provisioning API.
 *
 * `permanent` is the distinction the counterpart's own spec asks callers to
 * make: "409 and 422 are permanent failures the connector should dead-letter
 * rather than retry forever; 5xx is retriable." A 403 is deliberately
 * RETRIABLE — a revoked or expired service token is an operator fix that
 * should heal without replaying events, and `health()` is what makes it
 * legible in the meantime.
 *
 * `429` is RETRIABLE, and that is now deliberate rather than incidental. A
 * security audit established that the counterpart's provisioning routes ARE
 * rate limited — 120/min per source IP, inherited from slowapi's globally
 * applied `default_limits`, which are opt-OUT — despite BOTH systems' specs
 * having claimed no application-level limit existed. This default-to-retriable
 * shape happened to handle it correctly all along; the enumeration below makes
 * that a decision instead of a lucky accident. A rate limit clears on its own,
 * so dead-lettering one would drop a legitimate identity over a transient
 * condition — the realistic way to hit it is a bulk reconciliation pass, i.e.
 * exactly when losing users is least acceptable.
 *
 * NOTE the asymmetry: this is a DENYLIST of permanent statuses, not an
 * allowlist of retriable ones. An unrecognised status is therefore retried
 * rather than dropped, which is the safe direction — retrying something
 * hopeless costs a bounded 8 attempts and leaves a visible dead letter, while
 * dropping something recoverable loses a user silently.
 *
 * Carries no credential: `responseBody` is the target's own error payload,
 * and the resolved token is never part of any message built here.
 */
export class MailServerRequestError extends Error {
  readonly permanent: boolean

  constructor(
    readonly status: number,
    readonly responseBody: unknown,
  ) {
    super(`mail server returned ${status}: ${JSON.stringify(responseBody)}`)
    this.name = 'MailServerRequestError'
    this.permanent = status === 409 || status === 422
  }
}

/**
 * A misconfiguration this connector must not paper over. Carries
 * `permanent = true` so `SyncWorker` dead-letters it on the first attempt
 * rather than retrying a state only a human can fix.
 */
export class MailServerConfigurationError extends Error {
  readonly permanent = true

  constructor(detail: string) {
    super(`mail server connector: ${detail}`)
    this.name = 'MailServerConfigurationError'
  }
}

function readNumber(attributes: Record<string, string[]>, key: string): number | undefined {
  const raw = attributes[key]?.[0]
  if (raw === undefined) {
    return undefined
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * The mail-server target — provisions mailboxes and mail-admin records on the
 * counterpart system at `D:\mail-server`, whose own receiving half is already
 * built and merged (its `feat/idm-sync-phase1`). Design:
 * docs/superpowers/specs/2026-08-07-mail-server-connector-implementation-design.md.
 *
 * NEVER sends a credential, in either direction. There is none to send —
 * Keycloak owns every credential here and does not release them — and the
 * counterpart's payload schema is `extra="forbid"`, so one would be rejected
 * outright. Asserted by test on both sides rather than assumed.
 *
 * Opens no database connection: every method here runs inside `SyncWorker`'s
 * own transaction, and everything this connector needs arrives in `desired`
 * or was bound by `configure()` before any method was called.
 *
 * Addresses a principal by THIS system's user id, not by an id of its own —
 * see `DesiredUser.userId`'s doc comment. It is the only target that does.
 */
@Injectable()
export class MailServerConnector implements DirectoryConnector {
  private config: Record<string, unknown> = {}

  // Delegating arrow rather than a bare `globalThis.fetch` reference: the
  // global is not bound to its own receiver, and calling it detached throws
  // in some runtimes.
  private fetchImpl: FetchLike = (url, init) => globalThis.fetch(url, init)

  /**
   * Test seam — substitutes the HTTP client. Production code never calls
   * this; the default above delegates to the global `fetch`.
   *
   * This exists as a METHOD rather than a constructor parameter because Nest
   * reflects EVERY constructor parameter's type regardless of whether it also
   * has a JS-level default, and `FetchLike` (a bare function type) erases to
   * `Object` — which DI cannot resolve, so `AppModule` fails to compile with
   * "can't resolve dependencies of the MailServerConnector (?)". `EchoConnector`
   * documents the same hazard from the other direction, and takes nothing in
   * its constructor for the same reason. Caught by app.module.spec.ts's
   * DI-graph smoke test.
   */
  withFetch(fetchImpl: FetchLike): this {
    this.fetchImpl = fetchImpl
    return this
  }

  /** Binds this connector to a fresh read of `connector_targets.config` — called by `ConnectorRegistry.resolve`, never by a caller directly. Returns `this` so the registry can `factory(config)` in one expression. */
  configure(config: Record<string, unknown>): this {
    this.config = config
    return this
  }

  async health(env: NodeJS.ProcessEnv = process.env): Promise<ConnectorHealth> {
    try {
      const { status } = await this.request('GET', '/provisioning/health', undefined, env)
      return status === 200
        ? { ok: true, detail: `mail server reachable at ${this.baseUrl()}; service token accepted` }
        : {
            ok: false,
            detail: `mail server at ${this.baseUrl()} answered ${status} on /provisioning/health`,
          }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Three eligibility outcomes, per the design's own table:
   *
   *  - not mail-enabled, no prior identity -> `NotApplicableError`. Nothing
   *    was ever created there, so there is nothing to do and nothing to
   *    correlate. Critically it must NOT `PUT`: the counterpart's upsert
   *    CREATES on first write, so pushing `deactivated` here would create a
   *    mailbox for someone who should never have had one, reserve their
   *    address against future collisions, and then deactivate it.
   *  - not mail-enabled, prior identity exists -> `PUT` forcing
   *    `deactivated`. This is ENTITLEMENT REMOVAL: mail access revoked while
   *    the person stays active in the directory, which is exactly why the
   *    forced status deliberately disagrees with `desired.status`.
   *  - mail-enabled -> `PUT` the full desired state.
   *
   * Eligibility is decided HERE, at apply time, never at emission. If
   * `OutboxWriter` only emitted mail events for mail-enabled users, then
   * flipping `mail_enabled` to false would emit nothing at all and the
   * mailbox would live forever. That optimisation looks attractive every
   * time someone reads this fresh; it is a correctness bug.
   */
  async apply(
    desired: DesiredUser,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<{ externalId: string }> {
    // THREE states, not two. `mail_enabled` ABSENT is not the same as
    // `mail_enabled = false`, and conflating them was a mass-deactivation
    // hazard (security audit).
    //
    // `desired.attributes` only ever contains keys with an ENABLED
    // `attribute_target_mappings` row (buildTargetAttributes iterates the
    // mappings, not the user's attributes), so `mail_enabled` disappears
    // entirely if an admin disables that mapping, deletes it, or deactivates
    // the attribute definition. Read as `false`, that turned any of those
    // three ordinary-looking configuration changes into "every provisioned
    // user just lost their mailbox" — and worse than an outage, because the
    // counterpart stamps `deactivated_at` on `deactivated`, which starts its
    // retention clock and so begins the countdown to PURGING their mail.
    const rawEnabled = desired.attributes.mail_enabled?.[0]
    const enabled = rawEnabled?.toLowerCase() === 'true'

    if (rawEnabled === undefined) {
      if (desired.existingExternalId === undefined) {
        // Nothing was ever created here, so there is nothing to do and
        // nothing to correlate — the same outcome as an explicit `false`.
        throw new NotApplicableError(
          'mail_server',
          'no mail_enabled attribute reached this connector and the user has no mailbox here',
        )
      }
      // This user HAS a mailbox, and we have just been told nothing about
      // whether they should. Deactivating on a guess is destructive and
      // starts a retention clock; doing nothing silently would hide a broken
      // integration. Fail loudly instead, permanently, so it dead-letters and
      // an operator sees it. Retrying cannot help — the fix is configuration.
      throw new MailServerConfigurationError(
        'the mail_enabled attribute did not reach this connector, but this user already has a ' +
          'mailbox. Refusing to guess: deactivating would start the retention clock on their ' +
          'mail. Check that the mail_enabled attribute definition is active AND has an enabled ' +
          'attribute_target_mappings row for target mail_server.',
      )
    }

    // An EXPLICIT non-true value, for someone with no mailbox here: nothing
    // was created, so nothing to do and nothing to correlate. (Distinct from
    // the absent case above, which cannot know this.)
    if (!enabled && desired.existingExternalId === undefined) {
      throw new NotApplicableError('mail_server', 'user is not mail-enabled and has no mailbox here')
    }

    const payload = enabled
      ? this.buildPayload(desired, desired.status ?? 'active')
      : this.buildPayload(desired, 'deactivated', { minimal: true })

    const { status, body } = await this.request('PUT', this.identityPath(desired.userId), payload, env)
    if (status !== 200) {
      throw new MailServerRequestError(status, body)
    }
    return { externalId: desired.userId }
  }

  async plan(
    desired: DesiredUser,
    _env: NodeJS.ProcessEnv = process.env,
  ): Promise<ConnectorOperation[]> {
    // Mirrors `apply`'s three-state read. A plan must never claim a mutation
    // that `apply` would refuse to make — reporting "disable" here for a
    // merely ABSENT mail_enabled would show an operator a mass-deactivation
    // plan that is really a misconfiguration.
    const rawEnabled = desired.attributes.mail_enabled?.[0]
    const enabled = rawEnabled?.toLowerCase() === 'true'
    if (rawEnabled === undefined) {
      return [
        {
          kind: 'update',
          description:
            `CANNOT PLAN ${desired.email}: no mail_enabled attribute reached this connector. ` +
            `Check the attribute definition is active and mapped to mail_server.`,
        },
      ]
    }
    if (!enabled && desired.existingExternalId === undefined) {
      return []
    }

    // A plan writes NOTHING, including no READ against the target: every
    // other connector's plan() is answerable from desired state plus what
    // the caller already handed us, and a dry run that makes network calls
    // is not a dry run.
    const status = enabled ? (desired.status ?? 'active') : 'deactivated'
    const kind =
      desired.existingExternalId === undefined
        ? 'create'
        : status === 'deactivated'
          ? 'disable'
          : 'update'

    return [{ kind, description: `${kind} mail identity for ${desired.email} (status=${status})` }]
  }

  /**
   * The documented last-resort removal path. Currently UNREACHABLE — nothing
   * in this codebase calls `disable()` on any connector, and
   * `TargetReconciliationJob` documents that it deliberately never will,
   * because a principal whose desired state is "not enabled" is asserted
   * through `apply()` like every other desired-state assertion. Implemented
   * correctly anyway so the escape hatch is real rather than a trap for
   * whoever first wires it up.
   *
   * Reads the address back first because the counterpart's upsert requires
   * `email` and `status` (every other field is optional), while this method
   * takes no user data by contract. A 404, or an identity with no mailbox,
   * is a no-op: there is nothing there to deactivate.
   */
  async disable(externalId: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const path = this.identityPath(externalId)
    const current = await this.request('GET', path, undefined, env)

    if (current.status === 404) {
      return
    }
    if (current.status !== 200) {
      throw new MailServerRequestError(current.status, current.body)
    }

    const email = (current.body as { email?: string | null } | null)?.email
    if (typeof email !== 'string' || email.length === 0) {
      return
    }

    const { status, body } = await this.request('PUT', path, { email, status: 'deactivated' }, env)
    if (status !== 200) {
      throw new MailServerRequestError(status, body)
    }
  }

  /**
   * A CLOSED payload — every field is named here explicitly, so no attribute
   * can reach the counterpart merely by existing. Default-deny holds
   * STRUCTURALLY rather than by a flag: there is nowhere in this object to
   * put an unrecognised key. That is a stronger property than the Keycloak
   * path, where `buildSyncedAttributes` must actively filter, and it is why
   * the counterpart has no free-form attribute bag either.
   *
   * Absent means ABSENT, never null. The counterpart gives absent and null
   * different meanings for every scalar, and rejects an explicit null for
   * `quota_mb` and `aliases` outright.
   */
  private buildPayload(
    desired: DesiredUser,
    status: string,
    options: { minimal?: boolean } = {},
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      username: desired.username,
      email: desired.email,
      status,
    }
    if (options.minimal === true) {
      return payload
    }

    const displayName = [desired.firstName, desired.lastName]
      .filter((part) => part.length > 0)
      .join(' ')
    if (displayName.length > 0) {
      payload.display_name = displayName
    }

    const quota = readNumber(desired.attributes, 'mail_quota_mb')
    if (quota !== undefined) {
      payload.quota_mb = quota
    }

    const aliases = desired.attributes.mail_aliases
    if (aliases !== undefined) {
      payload.aliases = [...aliases]
    }

    // Provisioning mail-admin rights is OPT-IN, per target, and off by
    // default (security audit, high).
    //
    // `mail_admin_role` is an ordinary user attribute, so setting it needs
    // only `user:update` — which `help_desk` holds (authz/actions.ts), and
    // which is a SCOPABLE role. Without this gate, a help_desk scoped to one
    // org unit could set `mail_admin_role = superadmin` on any user in their
    // subtree and the next sync would mint a mail-server SUPERADMIN with
    // authority over every hosted domain.
    //
    // That is a role grant wearing an attribute's clothing. This system
    // guards real role assignment with three independent checks — hold the
    // action, may grant THIS role at THIS scope, and the target must not
    // outrank you (authz/privilege.guards.ts). An attribute value bypasses
    // every one of them, because nothing marks it as privilege-bearing.
    //
    // Closing that properly means teaching the IdM that some attributes ARE
    // grants, which is a larger design change. Until then this is default-
    // deny: a deployment that wants IdM-driven mail admins sets
    // `allowAdminProvisioning: true` in connector_targets.config, and thereby
    // accepts that `user:update` becomes equivalent to granting mail-admin
    // rights. A deployment that does not set it cannot be escalated through
    // this path at all.
    const role = desired.attributes.mail_admin_role?.[0]
    if ((role === 'domain_admin' || role === 'superadmin') && this.config.allowAdminProvisioning === true) {
      // The administered domain is derived from the user's own address — a
      // settled simplification (design doc): it covers someone administering
      // the domain they are in, and avoids a list-valued attribute that is
      // awkward to edit in the console. An admin managing several domains
      // they are not a member of is not supported.
      const domain = desired.email.split('@').pop() ?? ''
      payload.admin = {
        role,
        domains: role === 'domain_admin' && domain.length > 0 ? [domain] : [],
      }
    }

    return payload
  }

  private identityPath(externalId: string): string {
    return `/provisioning/identities/${encodeURIComponent(externalId)}`
  }

  /**
   * One authenticated round trip. Returns the status rather than throwing on
   * a non-2xx, so each caller maps status to retriable-or-permanent itself.
   * The resolved token is used and discarded — never stored on the instance,
   * never returned, never included in any thrown message.
   */
  private async request(
    method: string,
    path: string,
    body: unknown | undefined,
    env: NodeJS.ProcessEnv,
  ): Promise<{ status: number; body: unknown }> {
    const token = resolveSecret(this.requiredString(TOKEN_SECRET_NAME_KEY), env)
    const timeout =
      typeof this.config[REQUEST_TIMEOUT_KEY] === 'number'
        ? (this.config[REQUEST_TIMEOUT_KEY] as number)
        : DEFAULT_REQUEST_TIMEOUT_MS

    const response = await this.fetchImpl(`${this.baseUrl()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    })

    let parsed: unknown = null
    try {
      parsed = await response.json()
    } catch {
      // A non-JSON body is not itself an error — the status is what callers
      // map on, and /provisioning/health's 403 carries no JSON body.
    }
    return { status: response.status, body: parsed }
  }

  private baseUrl(): string {
    return this.requiredString(BASE_URL_KEY).replace(/\/+$/, '')
  }

  /** Throws a config-shape error (distinct from `MissingSecretError`) naming only the non-sensitive KEY — never a value. Same shape `EchoConnector.secretName` already uses. */
  private requiredString(key: string): string {
    const raw = this.config[key]
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new Error(
        `mail server connector: connector_targets.config.${key} is required and must be a non-empty string`,
      )
    }
    return raw
  }
}
