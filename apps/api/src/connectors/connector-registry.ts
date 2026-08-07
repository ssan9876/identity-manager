import { Inject, Injectable, Optional } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { connectorTargets } from '../db/schema/connector-targets'
import { KeycloakAdminClient } from '../keycloak/keycloak-admin.client'
import type { DbHandle } from '../outbox/outbox.writer'
import { ActiveDirectoryConnector } from './active-directory.connector'
import type { ConnectorTarget, DirectoryConnector, DirectoryGroupConnector } from './connector'
import { EchoConnector } from './echo.connector'
import { KeycloakConnector } from './keycloak.connector'

/** Builds a connector instance already bound to ITS target's current `connector_targets.config` (see `ConnectorRegistry.resolve`). */
type ConnectorFactory = (config: Record<string, unknown>) => DirectoryConnector

// Only the targets with a REAL implementation TODAY. Widening this (and the
// `satisfies` literal in the constructor below) together, in the SAME
// change that adds a real adapter class, is exactly how Milestones 11/12/13
// plug in `active_directory`/`entra_id`/`google_workspace` — see `resolve`'s
// own doc comment for why a target present in the wider `ConnectorTarget`
// union but ABSENT from this narrower one still fails safely rather than
// silently. Milestone 11, Task 5 widens this to `active_directory`, the
// FIRST real (non-echo) target added since Task 2 — proof this "cast a
// runtime-known-safe value, `satisfies`-check the literal" shape genuinely
// generalises rather than being echo-specific.
type ImplementedConnectorTarget = 'keycloak' | 'echo' | 'active_directory'

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
      } satisfies Record<ImplementedConnectorTarget, ConnectorFactory>,
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
   * A `target` with NO implementation yet (`active_directory`/`entra_id`/
   * `google_workspace` — Milestones 11-13) throws a clear, immediate error
   * rather than guessing or silently deferring to Keycloak's own connector —
   * exactly the failure mode Task 1's own report flagged as the risk of
   * leaving `SyncWorker.applyEvent` dispatching on `aggregateType` alone:
   * "claimed non-Keycloak events would be silently misprocessed as Keycloak
   * ones." `connector_targets` seeds no ENABLED row for any of those three
   * targets yet (Task 1), so `OutboxWriter.record`'s fan-out can never
   * actually produce a claimable event for one in practice — this is
   * defence in depth, not a path exercised by today's real traffic.
   */
  async resolve(target: ConnectorTarget, tx: DbHandle): Promise<DirectoryConnector> {
    if (!Object.hasOwn(this.factories, target)) {
      throw new Error(
        `no connector registered for target "${target}" — implemented targets: ${Object.keys(this.factories).join(', ')}`,
      )
    }

    const config = await this.loadConfig(target, tx)
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
   * A single literal `!==` comparison, not an `Object.hasOwn`-guarded
   * catalog lookup — deliberately: the prototype-chain-bypass hazard that
   * pattern defends against is specific to INDEXING an object by an
   * untrusted key (`this.factories[target]`, where `target` could
   * coincidentally name an inherited `Object.prototype` member); a plain
   * `===`/`!==` comparison against one fixed string literal has no such
   * hazard, so the extra machinery would add nothing here. When a second
   * target gains this capability (Entra ID/Google Workspace, Milestones
   * 12-13), this becomes a real multi-entry catalog and should adopt the
   * SAME `Object.create(null)` + `Object.hasOwn` + `satisfies` shape
   * `factories` above already uses — not before, per this project's own
   * "generalise when there is a second real case, not before" precedent
   * (see e.g. `ImplementedConnectorTarget`'s own doc comment on why
   * `active_directory` was the proof this shape genuinely generalises).
   */
  async resolveGroupConnector(target: ConnectorTarget, tx: DbHandle): Promise<DirectoryGroupConnector | null> {
    if (target !== 'active_directory') {
      return null
    }
    const config = await this.loadConfig(target, tx)
    return this.activeDirectoryConnector.configure(config)
  }

  /** The one Postgres read every `resolve*` method needs — `connector_targets.config` for `target`, via the CALLER's own `tx` (see `resolve`'s own doc comment on connection discipline). `undefined`/no row resolves to an empty config, same as before this was extracted. */
  private async loadConfig(target: ConnectorTarget, tx: DbHandle): Promise<Record<string, unknown>> {
    const [row] = await tx
      .select({ config: connectorTargets.config })
      .from(connectorTargets)
      .where(eq(connectorTargets.target, target))
      .limit(1)
    return row?.config ?? {}
  }
}
