import { Inject, Injectable, Optional } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import { connectorTargets } from '../db/schema/connector-targets'
import { KeycloakAdminClient } from '../keycloak/keycloak-admin.client'
import { KeycloakAdminClientFactory } from '../keycloak/keycloak-admin-client.factory'
import type { DbHandle } from '../outbox/outbox.writer'
import { ActiveDirectoryConnector } from './active-directory.connector'
import type {
  ConnectorHealth,
  ConnectorTarget,
  DirectoryConnector,
  DirectoryGroupConnector,
  SsoConnector,
} from './connector'
import { EchoConnector } from './echo.connector'
import { EntraIdConnector } from './entra-id.connector'
import { GoogleWorkspaceConnector } from './google-workspace.connector'
import { KeycloakConnector } from './keycloak.connector'
import { KeycloakSsoConnectorFactory } from './keycloak-sso.connector'
import { MailServerConnector } from './mail-server.connector'

/** Builds a connector instance already bound to ITS target's current `connector_targets.config` (see `ConnectorRegistry.resolve`). */
type ConnectorFactory = (config: Record<string, unknown>) => DirectoryConnector

/** The GROUP-shaped mirror of `ConnectorFactory`, for `resolveGroupConnector` below. */
type GroupConnectorFactory = (config: Record<string, unknown>) => DirectoryGroupConnector
type SsoConnectorFactory = (config: Record<string, unknown>) => SsoConnector

// Only the targets with a REAL implementation TODAY. Widening this (and the
// `satisfies` literal in the constructor below) together, in the SAME
// change that adds a real adapter class, is exactly how Milestones 11/12/13
// plug in `active_directory`/`entra_id`/`google_workspace` — see `resolve`'s
// own doc comment for why a target present in the wider `ConnectorTarget`
// union but ABSENT from this narrower one still fails safely rather than
// silently. Milestone 11, Task 5 widened this to `active_directory`, the
// FIRST real (non-echo) target added since Task 2 — proof this "cast a
// runtime-known-safe value, `satisfies`-check the literal" shape genuinely
// generalises rather than being echo-specific. Milestone 12, Task 7 widens it
// a second time to `entra_id`; Milestone 13, Task 8 widens it a THIRD time
// to `google_workspace` — the last of the three real vendor targets this
// sub-project set out to build (design doc build order M11-M13), and proof
// this shape holds regardless of how many real targets accumulate.
// Sub-project 4 widens this a FOURTH time, to `mail_server` — the first
// target that is not a general-purpose directory backend, and the first that
// addresses a principal by THIS system's own user id rather than by an id of
// its own (see `DesiredUser.userId`'s doc comment in connector.ts).
type ImplementedConnectorTarget =
  | 'keycloak'
  | 'echo'
  | 'active_directory'
  | 'entra_id'
  | 'google_workspace'
  | 'mail_server'

// Milestone 13, Task 8 — the targets with a REAL `DirectoryGroupConnector`
// implementation today: `active_directory` (Milestone 11, Task 6) and
// `echo` (this task — see `EchoConnector`'s own doc comment for why the
// in-repo target gains this capability too). Deliberately NOT `entra_id`/
// `google_workspace`: both represent group membership through the FLAT
// `DesiredUser.groups` shape instead (Entra via `$ref`, Google via the
// Members API — see each connector's own doc comment), the same choice
// `KeycloakConnector` already made, so neither implements this optional
// capability. This is the "second real case" `resolveGroupConnector`'s
// PREVIOUS single-`!==`-comparison implementation explicitly named as the
// trigger to adopt the catalog shape `factories` above already uses — see
// `resolveGroupConnector`'s own doc comment for why THIS array now needs
// the identical `Object.create(null)` + `Object.hasOwn` + `satisfies`
// defence `factories` already has: a second real entry means this is now a
// genuine lookup table indexed by a value sourced from `outbox_events.target`
// (a Postgres enum column — closed today, but not a compile-time guarantee
// — see `factories`'s own doc comment for the full prototype-chain-bypass
// reasoning, identical here).
type ImplementedGroupConnectorTarget = 'active_directory' | 'echo'

// The third interface family. `keycloak_sso` is deliberately absent from
// BOTH unions above: it implements neither DirectoryConnector nor
// DirectoryGroupConnector, so `resolve` throwing for it is correct, not a
// gap -- see `healthFor` for the one place that must not care which family
// a target belongs to.
type ImplementedSsoConnectorTarget = 'keycloak_sso'

/**
 * Target -> connector. This project has been bitten FOUR times by
 * prototype-chain bypasses (`'constructor' in obj` is `true`, and returns a
 * truthy INHERITED function — a real, non-nullish value that defeats a bare
 * `?? fallback` — see authz/actions.ts's `ROLE_PERMISSIONS`/`ROLE_RANK` doc
 * comment for the first three, and jml/rule-engine.ts's `closedSet`/
 * `CONDITION_FIELD_EXTRACTORS`/`OPERATOR_EVALUATORS` for the same defence
 * applied a second time). `target` is sourced from `outbox_events.target`, a
 * Postgres enum column — closed today, but "a Postgres enum column can hold
 * any label a migration ever added, past or future" (rule-engine.ts) is the
 * exact same hazard here, so this is built the same way, for the same
 * reason: `Object.create(null)` (no inherited `Object.prototype` members to
 * accidentally resolve to) plus `Object.hasOwn` (never `in`, which walks the
 * prototype chain regardless) before ever indexing.
 *
 * Compile-time exhaustiveness is kept with a TYPED LITERAL plus `satisfies`
 * — never a cast to `Record<...>` on the whole expression. `authz/
 * actions.ts`'s own doc comment records the exact regression that shape
 * causes: `Object.create(null)`'s return type is `any`, so
 * `Object.assign(any, {...})` collapses to `any` too, and a trailing `as` on
 * an `any` expression is not a structural check — it succeeds
 * unconditionally, so a typo'd target, a dropped connector, an EXTRA one, or
 * a wrong-shaped factory would all have compiled clean. The fix here is the
 * SAME two-part shape actions.ts settled on: (1) `Object.create(null) as
 * Record<ImplementedConnectorTarget, ConnectorFactory>` casts a value
 * already known at runtime to be an empty, prototype-less object, not a
 * claim about a literal's shape; (2) the object LITERAL passed to
 * `Object.assign` carries `satisfies Record<ImplementedConnectorTarget,
 * ConnectorFactory>`, which DOES structurally check the literal (missing
 * target, extra target, wrong-shaped factory) while still preserving its own
 * precise inferred type for the `Object.assign` call.
 */
@Injectable()
export class ConnectorRegistry {
  private readonly factories: Record<ImplementedConnectorTarget, ConnectorFactory>
  private readonly groupFactories: Record<ImplementedGroupConnectorTarget, GroupConnectorFactory>
  private readonly ssoFactories: Record<ImplementedSsoConnectorTarget, SsoConnectorFactory>

  constructor(
    @Inject(KeycloakAdminClient) keycloak: KeycloakAdminClient,
    // `@Optional()` so a RAW `new ConnectorRegistry(keycloak)` — every test
    // in this file and connector-secrets.spec.ts that doesn't care to
    // inspect the echo connector directly — still gets a fresh, working
    // one via the TS default. Under real Nest DI (app.module.ts), Nest
    // resolves the registered `EchoConnector` provider and passes THAT
    // instead of ever falling through to the default — the decorator is
    // what makes it resolvable at all: Nest reflects every constructor
    // parameter's TYPE regardless of a JS-level default value, so an
    // unregistered class parameter fails DI even with one written here
    // (see EchoConnector's own doc comment for the exact failure this
    // fixed).
    @Optional() @Inject(EchoConnector) private readonly echoConnector: EchoConnector = new EchoConnector(),
    // Milestone 11, Task 5 — the SAME `@Optional()`-with-JS-default shape as
    // `echoConnector` immediately above, for the identical reason: a raw
    // `new ConnectorRegistry(keycloak)` (every pre-Task-5 test in this file)
    // keeps compiling and working via the TS default, while real Nest DI
    // (app.module.ts) hands every caller the ONE registered instance instead.
    @Optional()
    @Inject(ActiveDirectoryConnector)
    private readonly activeDirectoryConnector: ActiveDirectoryConnector = new ActiveDirectoryConnector(),
    // Milestone 12, Task 7 — the SAME `@Optional()`-with-JS-default shape as
    // `activeDirectoryConnector` immediately above, for the identical reason:
    // a raw `new ConnectorRegistry(keycloak)` (every pre-Task-7 test in this
    // file) keeps compiling and working via the TS default, while real Nest
    // DI (app.module.ts) hands every caller the ONE registered instance
    // instead.
    @Optional()
    @Inject(EntraIdConnector)
    private readonly entraIdConnector: EntraIdConnector = new EntraIdConnector(),
    // Milestone 13, Task 8 — the SAME `@Optional()`-with-JS-default shape as
    // `entraIdConnector` immediately above, for the identical reason: a raw
    // `new ConnectorRegistry(keycloak)` (every pre-Task-8 test in this file)
    // keeps compiling and working via the TS default, while real Nest DI
    // (app.module.ts) hands every caller the ONE registered instance
    // instead.
    @Optional()
    @Inject(GoogleWorkspaceConnector)
    private readonly googleWorkspaceConnector: GoogleWorkspaceConnector = new GoogleWorkspaceConnector(),
    // Sub-project 4 — the SAME `@Optional()`-with-JS-default shape as
    // `googleWorkspaceConnector` immediately above, for the identical
    // reason: a raw `new ConnectorRegistry(keycloak)` (every earlier test in
    // this file) keeps compiling and working via the TS default, while real
    // Nest DI (app.module.ts) hands every caller the ONE registered instance
    // instead.
    @Optional()
    @Inject(MailServerConnector)
    private readonly mailServerConnector: MailServerConnector = new MailServerConnector(),
    @Optional()
    @Inject(KeycloakSsoConnectorFactory)
    private readonly keycloakSsoConnectorFactory: KeycloakSsoConnectorFactory = new KeycloakSsoConnectorFactory(),
    // Organizations milestone, Task 14 — the per-realm admin client factory,
    // consulted by `resolve` ONLY when a caller names a non-master realm.
    // `@Optional()` with NO default, unlike every parameter above: there is
    // nothing sensible to construct here (a factory needs real credentials),
    // and a raw `new ConnectorRegistry(keycloak)` — every pre-Task-14 test
    // in the suite — must keep meaning exactly what it meant before, which
    // is "everything goes through the one injected client". `null` is
    // therefore a first-class value here and is handled explicitly in
    // `resolve`, never a missing dependency.
    @Optional()
    @Inject(KeycloakAdminClientFactory)
    private readonly keycloakFactory: KeycloakAdminClientFactory | null = null,
  ) {
    // Keycloak's OWN config source is unchanged by this task (still the
    // env-sourced KEYCLOAK_ADMIN_CONFIG token — see keycloak.connector.ts's
    // own doc comment), so its factory ignores the `config` argument every
    // OTHER factory here uses; ONE long-lived KeycloakConnector wrapping the
    // injected client is constructed once, not rebuilt per resolve() call,
    // since it has no per-target-row config to go stale.
    const keycloakConnector = new KeycloakConnector(keycloak)

    this.factories = Object.assign(
      Object.create(null) as Record<ImplementedConnectorTarget, ConnectorFactory>,
      {
        keycloak: () => keycloakConnector,
        // `echoConnector.configure(config)` rebinds the SAME long-lived
        // instance to the freshly-read config and returns `this` — a fresh
        // config snapshot every resolve() call, but ONE instance whose
        // `.calls`/id map persist across calls, which is exactly what lets
        // a caller (a test, or a future console) hold a reference and
        // observe what the echo target was asked to do.
        echo: (config: Record<string, unknown>) => this.echoConnector.configure(config),
        // Same `configure(config)`-rebinds-the-long-lived-instance shape as
        // `echo` above — see ActiveDirectoryConnector's own doc comment for
        // why reusing ONE instance (and, inside it, one lazily-established
        // LDAPS connection) across resolve() calls is deliberate, not an
        // oversight: a fresh TLS handshake + bind per call would be
        // needlessly slow for a batch reconcile, and the connector already
        // detects a stale/changed config and reconnects on its own.
        active_directory: (config: Record<string, unknown>) => this.activeDirectoryConnector.configure(config),
        // Milestone 12, Task 7 — same `configure(config)`-rebinds-the-long-
        // lived-instance shape as every other real target above: ONE
        // `EntraIdConnector` instance (and its own in-memory token cache) is
        // reused across `resolve()` calls, only its config snapshot changes.
        // There is no persistent socket to invalidate/reconnect here (unlike
        // AD's LDAPS client) — `EntraIdConnector` re-validates its cached
        // token's identity against the freshly-bound config on every actual
        // use instead (see that class's own `getToken` doc comment).
        entra_id: (config: Record<string, unknown>) => this.entraIdConnector.configure(config),
        // Milestone 13, Task 8 — same `configure(config)`-rebinds-the-long-
        // lived-instance shape as every other real target above: ONE
        // `GoogleWorkspaceConnector` instance (and its own in-memory token
        // cache) is reused across `resolve()` calls, only its config
        // snapshot changes. No persistent socket to invalidate/reconnect
        // here (unlike AD's LDAPS client) — `GoogleWorkspaceConnector`
        // re-validates its cached token's identity against the
        // freshly-bound config on every actual use, the identical pattern
        // `EntraIdConnector.getToken` already establishes.
        google_workspace: (config: Record<string, unknown>) => this.googleWorkspaceConnector.configure(config),
        mail_server: (config: Record<string, unknown>) => this.mailServerConnector.configure(config),
      } satisfies Record<ImplementedConnectorTarget, ConnectorFactory>,
    )

    // Milestone 13, Task 8 — the GROUP-shaped mirror of `this.factories`
    // immediately above, same `Object.create(null)` + `satisfies` shape, now
    // that a SECOND target (`echo`) genuinely implements `DirectoryGroupConnector`
    // — see `ImplementedGroupConnectorTarget`'s own doc comment for why this
    // stopped being a single `!==` comparison.
    this.groupFactories = Object.assign(
      Object.create(null) as Record<ImplementedGroupConnectorTarget, GroupConnectorFactory>,
      {
        active_directory: (config: Record<string, unknown>) => this.activeDirectoryConnector.configure(config),
        echo: (config: Record<string, unknown>) => this.echoConnector.configure(config),
      } satisfies Record<ImplementedGroupConnectorTarget, GroupConnectorFactory>,
    )
    this.ssoFactories = Object.assign(
      Object.create(null) as Record<ImplementedSsoConnectorTarget, SsoConnectorFactory>,
      {
        keycloak_sso: (config: Record<string, unknown>) =>
          this.keycloakSsoConnectorFactory.configure(config),
      } satisfies Record<ImplementedSsoConnectorTarget, SsoConnectorFactory>,
    )
  }

  /**
   * Resolves `target` to a ready-to-use connector, reading
   * `connector_targets.config` via the CALLER's OWN `tx` — never a second
   * pool connection (see `DirectoryConnector`'s own doc comment on
   * connection discipline; this is the ONE Postgres read every connector
   * needs, done HERE, once, before any of the four interface methods is
   * ever called, so no connector implementation needs database access of
   * its own). A target absent from `connector_targets` entirely (no row —
   * see connector-targets.ts's own doc comment on why that is common and
   * expected for a target nothing has configured yet) resolves with an
   * EMPTY config, which every current factory turns into a clean, actionable
   * failure the first time a method needing a secret is actually called
   * (`EchoConnector.health`/`apply`/`plan`/`disable` -> `MissingSecretError`)
   * — never a silent misconfiguration.
   *
   * Every target `ConnectorTarget` names has a real implementation as of
   * Milestone 13 (`active_directory`/Milestone 11, `entra_id`/Milestone 12,
   * `google_workspace`/Milestone 13, plus `keycloak`/`echo` from Milestone
   * 10) — but this method still fails LOUDLY, never silently, for any
   * target absent from `this.factories` (a hypothetical FUTURE enum value,
   * or a typo'd/synthetic one — see `test/connector-registry.spec.ts`'s own
   * prototype-chain-bypass tests, which deliberately probe values outside
   * the compile-time `ConnectorTarget` union), rather than guessing or
   * silently deferring to Keycloak's own connector — exactly the failure
   * mode Task 1's own report flagged as the risk of leaving
   * `SyncWorker.applyEvent` dispatching on `aggregateType` alone: "claimed
   * non-Keycloak events would be silently misprocessed as Keycloak ones."
   */
  async resolve(
    target: ConnectorTarget,
    tx: DbHandle,
    // Per-organization connector targets: WHICH organization's row of
    // `connector_targets` this resolution reads. REQUIRED, never defaulted
    // — a default (to master, or to anything) would mean a call site that
    // forgot to derive the aggregate's organization silently resolved
    // another organization's credentials and estate, which is the exact
    // cross-tenant account-creation bug the (organization_id, target) key
    // exists to prevent. An organization with NO row for `target` resolves
    // with an EMPTY config — the same clean, loud MissingSecretError-style
    // failure a globally-unconfigured target always produced — never
    // another organization's config.
    organizationId: string,
    // Organizations milestone, Task 14 — OPTIONAL and TRAILING. Meaningful
    // for `keycloak` alone: it names the REALM this particular event's
    // principal lives in, which for a tenant is not the realm the single
    // injected `KeycloakAdminClient` is bound to. Every other target is
    // realm-blind (Active Directory, Entra, Google and the mail server have
    // no realm concept — see target-fanout.ts).
    realm: string | null = null,
  ): Promise<DirectoryConnector> {
    if (!Object.hasOwn(this.factories, target)) {
      throw new Error(
        `no connector registered for target "${target}" — implemented targets: ${Object.keys(this.factories).join(', ')}`,
      )
    }

    // A TENANT realm gets its own connector, wrapping the admin client the
    // factory memoizes for that realm — authenticated as the master-realm
    // PROVISIONING service account, because a realm-scoped credential can
    // only ever administer its own realm (see KeycloakAdminClientFactory's
    // own doc comment).
    //
    // MASTER deliberately falls through to the long-lived
    // `keycloakConnector` built in the constructor, even though
    // `forRealm(master)` would return an equivalent client. That is what
    // makes "master keeps today's behaviour exactly" true in the strongest
    // sense — the same instance, the same token cache, and, decisively, the
    // SAME client a test substituted via `new SyncWorker(..., kc)` or a
    // `GatedKeycloakAdminClient`. Routing master through the factory would
    // silently ignore every such substitution.
    if (
      target === 'keycloak' &&
      realm !== null &&
      this.keycloakFactory !== null &&
      realm !== this.keycloakFactory.masterRealmName()
    ) {
      return new KeycloakConnector(this.keycloakFactory.forRealm(realm))
    }

    const config = await this.loadConfig(organizationId, target, tx)
    const factory = this.factories[target as ImplementedConnectorTarget]
    return factory(config)
  }

  /**
   * Milestone 11, Task 6 — the GROUP-shaped mirror of `resolve` above, for
   * targets implementing the optional `DirectoryGroupConnector` capability
   * (`connector.ts`'s own doc comment: native group nesting, not every
   * target has one). Returns `null`, never throws, for a target with no
   * group-shaped capability — this is a normal, expected outcome (Keycloak
   * and echo both resolve their OWN group membership entirely through
   * `DesiredUser.groups` inside `apply()`, unchanged by this task), not a
   * misconfiguration the way an UNIMPLEMENTED user-facing target is
   * (`resolve`'s own thrown error, above) — `SyncWorker` uses this `null` to
   * fall back to that pre-existing per-user path, exactly as it did before
   * this task for every target.
   *
   * Milestone 13, Task 8 — WIDENED from a single literal `!==` comparison to
   * the SAME `Object.create(null)` + `Object.hasOwn` + `satisfies` catalog
   * shape `resolve`/`factories` above already use, now that `echo` is a
   * SECOND real `DirectoryGroupConnector` implementation (see
   * `EchoConnector`'s own doc comment for why, and `ImplementedGroupConnectorTarget`'s
   * own doc comment for why this specific migration is the "second real
   * case" this method's own PREVIOUS doc comment named as the trigger).
   * `target` is sourced from the exact same untrusted-enum-column origin as
   * `resolve`'s own `target` parameter (`outbox_events.target` /
   * `TargetReconciliationJob`'s own `target` argument) — the identical
   * prototype-chain-bypass hazard `factories` defends against now genuinely
   * applies here too, since this is a real lookup table indexed by that
   * value, not a single fixed-literal comparison.
   *
   * Still returns `null`, never throws, for a target absent from this
   * catalog — a normal, expected outcome (Keycloak, Entra ID and Google
   * Workspace all resolve their OWN group membership entirely through
   * `DesiredUser.groups` inside `apply()` — see connector.ts's own
   * `DirectoryGroupConnector` doc comment), not a misconfiguration the way
   * an unimplemented user-facing target is (`resolve`'s own thrown error,
   * above).
   */
  async resolveGroupConnector(
    target: ConnectorTarget,
    tx: DbHandle,
    organizationId: string,
  ): Promise<DirectoryGroupConnector | null> {
    if (!Object.hasOwn(this.groupFactories, target)) {
      return null
    }
    const config = await this.loadConfig(organizationId, target, tx)
    const factory = this.groupFactories[target as ImplementedGroupConnectorTarget]
    return factory(config)
  }

  /** The one Postgres read every `resolve*` method needs — `connector_targets.config` for `target`, via the CALLER's own `tx` (see `resolve`'s own doc comment on connection discipline). `undefined`/no row resolves to an empty config, same as before this was extracted. */
  async resolveSsoConnector(
    target: ConnectorTarget,
    tx: DbHandle,
    organizationId: string,
  ): Promise<SsoConnector | null> {
    if (!Object.hasOwn(this.ssoFactories, target)) {
      return null
    }
    const config = await this.loadConfig(organizationId, target, tx)
    return this.ssoFactories[target as ImplementedSsoConnectorTarget](config)
  }

  /**
   * Health for ANY target, whichever interface family implements it.
   *
   * The console's target list must summarize every target in
   * ALL_CONNECTOR_TARGETS, and `resolve` only knows the user-directory
   * family. Calling it for `keycloak_sso` throws "no connector registered",
   * which the caller would render as a FAILING health status on a target that
   * is in fact perfectly healthy -- an operator would go hunting for a
   * Keycloak outage that does not exist.
   */
  async healthFor(target: ConnectorTarget, tx: DbHandle, organizationId: string): Promise<ConnectorHealth> {
    const sso = await this.resolveSsoConnector(target, tx, organizationId)
    if (sso !== null) {
      return sso.health()
    }
    const connector = await this.resolve(target, tx, organizationId)
    return connector.health()
  }

  private async loadConfig(
    organizationId: string,
    target: ConnectorTarget,
    tx: DbHandle,
  ): Promise<Record<string, unknown>> {
    const [row] = await tx
      .select({ config: connectorTargets.config })
      .from(connectorTargets)
      .where(and(eq(connectorTargets.organizationId, organizationId), eq(connectorTargets.target, target)))
      .limit(1)
    // No row for THIS organization resolves to an empty config — a clean,
    // loud failure the first time a secret is needed. NEVER another
    // organization's row: that fallback is the cross-estate bug the
    // composite key exists to prevent.
    return row?.config ?? {}
  }
}
