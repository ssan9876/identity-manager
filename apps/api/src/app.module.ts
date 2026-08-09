import { Module } from '@nestjs/common'
import { JWT_GUARD_OPTIONS, JwtGuard, type JwtGuardOptions } from './auth/jwt.guard'
import { MeController } from './auth/me.controller'
import { AttributeDefinitionsController } from './attributes/attribute-definitions.controller'
import { AttributeDefinitionsRepository } from './attributes/attribute-definitions.repository'
import { AttributeTargetMappingsController } from './attributes/attribute-target-mappings.controller'
import { AttributeTargetMappingsRepository } from './attributes/attribute-target-mappings.repository'
import { AuditController } from './audit/audit.controller'
import { AuditRepository } from './audit/audit.repository'
import { AuditWriter } from './audit/audit.writer'
import { PermissionEngine } from './authz/permission.engine'
import { PermissionGuard } from './authz/permission.guard'
import { PrivilegeGuards } from './authz/privilege.guards'
import { RoleAssignmentsController } from './authz/role-assignments.controller'
import { RoleAssignmentsRepository } from './authz/role-assignments.repository'
import { DB_CLIENT } from './common/db.token'
import { ActiveDirectoryConnector } from './connectors/active-directory.connector'
import { ConnectorRegistry } from './connectors/connector-registry'
import { ConnectorTargetsController } from './connectors/connector-targets.controller'
import { ConnectorTargetsRepository } from './connectors/connector-targets.repository'
import { EchoConnector } from './connectors/echo.connector'
import { EntraIdConnector } from './connectors/entra-id.connector'
import { GoogleWorkspaceConnector } from './connectors/google-workspace.connector'
import { MailServerConnector } from './connectors/mail-server.connector'
import { loadEnv } from './config/env'
import { createDbClient } from './db/client'
import { GroupsController } from './groups/groups.controller'
import { GroupsRepository } from './groups/groups.repository'
import { HealthController } from './health/health.controller'
import { IMPORTS_CONFIG, ImportsController, type ImportsConfig } from './imports/imports.controller'
import {
  KEYCLOAK_ADMIN_CONFIG,
  KeycloakAdminClient,
  type KeycloakAdminClientConfig,
} from './keycloak/keycloak-admin.client'
import { OrgUnitsController } from './org-units/org-units.controller'
import { OrgUnitsRepository } from './org-units/org-units.repository'
import { OrganizationsRepository } from './organizations/organizations.repository'
import { OutboxController } from './outbox/outbox.controller'
import { OutboxRepository } from './outbox/outbox.repository'
import { OutboxWriter } from './outbox/outbox.writer'
import { SyncStateRepository } from './outbox/sync-state.repository'
import { SyncWorker } from './outbox/sync.worker'
import { TargetReconciliationJob } from './outbox/target-reconciliation.job'
import { SelfServiceController } from './self-service/self-service.controller'
import { UsersController } from './users/users.controller'
import { UsersRepository } from './users/users.repository'

@Module({
  controllers: [
    HealthController,
    MeController,
    UsersController,
    OrgUnitsController,
    GroupsController,
    RoleAssignmentsController,
    ImportsController,
    SelfServiceController,
    OutboxController,
    AttributeDefinitionsController,
    AuditController,
    // Milestone 14, Task 9: the connector admin console's API surface —
    // target configuration/health/dry-run (ConnectorTargetsController) and
    // the attribute mapping editor (AttributeTargetMappingsController).
    ConnectorTargetsController,
    AttributeTargetMappingsController,
  ],
  providers: [
    {
      provide: JWT_GUARD_OPTIONS,
      useFactory: (): JwtGuardOptions => {
        const env = loadEnv(process.env)
        return { issuer: env.keycloakIssuer, audience: env.keycloakAudience }
      },
    },
    {
      // Finding H1 (docs/archive/audits/audit-integrity.md): the RUNTIME
      // connection, not the OWNER one — this is what makes every controller/
      // repository/SyncWorker (all inject DB_CLIENT) run as a role that owns
      // nothing and cannot alter its own schema. Deliberately
      // `env.runtimeDatabaseUrl` with NO fallback to `env.databaseUrl` — see
      // config/env.ts's doc comment: a missing RUNTIME_DATABASE_URL must
      // fail loadEnv, not silently boot the app with owner privileges.
      provide: DB_CLIENT,
      useFactory: () => {
        const env = loadEnv(process.env)
        return createDbClient(env.runtimeDatabaseUrl, { max: env.dbPoolMax }).db
      },
    },
    {
      // Milestone 4, Task 4: shared by `SyncWorker`, `UsersController`
      // (synchronous revocation) and anything else that needs to push
      // state into Keycloak. Reuses the SAME env vars Task 2 already made
      // mandatory in `loadEnv` (`KEYCLOAK_ADMIN_CLIENT_ID`/`_SECRET`).
      provide: KEYCLOAK_ADMIN_CONFIG,
      useFactory: (): KeycloakAdminClientConfig => {
        const env = loadEnv(process.env)
        return {
          issuer: env.keycloakIssuer,
          clientId: env.keycloakAdminClientId,
          clientSecret: env.keycloakAdminClientSecret,
        }
      },
    },
    {
      // Finding M6 (docs/archive/audits/audit-integrity.md): the explicit,
      // configurable row-count cap on bulk import — see ImportsController's
      // own doc comment.
      provide: IMPORTS_CONFIG,
      useFactory: (): ImportsConfig => {
        const env = loadEnv(process.env)
        return { maxRows: env.importMaxRows }
      },
    },
    JwtGuard,
    UsersRepository,
    AttributeDefinitionsRepository,
    // Milestone 10, Task 3: read-only mapping lookups `SyncWorker` (and,
    // when raw-constructed outside DI, `ReconciliationJob`) resolve
    // `attribute_target_mappings` rows through — see that repository's own
    // doc comment. Registered here so real Nest DI hands both the SAME
    // managed instance `ConnectorRegistry`/`EchoConnector` already get,
    // rather than either falling back to its own raw-constructed default.
    AttributeTargetMappingsRepository,
    OrgUnitsRepository,
    GroupsRepository,
    OrganizationsRepository,
    PermissionEngine,
    PermissionGuard,
    PrivilegeGuards,
    RoleAssignmentsRepository,
    AuditWriter,
    AuditRepository,
    OutboxWriter,
    // Milestone 4, Task 4: registering these three constructs (never
    // network I/O — see each class's own constructor) a real SyncWorker
    // instance for every app boot, INCLUDING every test that compiles
    // AppModule (app.module.spec.ts). That is safe: `start()` is never
    // called by DI/a Nest lifecycle hook, only explicitly from `main.ts`'s
    // `bootstrap()`, which no test ever executes — see SyncWorker's
    // file-level doc comment.
    KeycloakAdminClient,
    OutboxRepository,
    // Milestone 10, Task 2: the connector spine. `EchoConnector` (never
    // network I/O at construction — same property as KeycloakAdminClient/
    // OutboxRepository above) must be registered BEFORE `ConnectorRegistry`
    // can resolve it as a constructor parameter — see EchoConnector's own
    // doc comment for why the `@Injectable()` decorator alone is not
    // optional here, even though that constructor parameter also carries a
    // JS-level default. `ConnectorRegistry` (target -> connector registry,
    // connectors/connector-registry.ts) depends on it plus the
    // already-provided KeycloakAdminClient above; SyncWorker's own
    // constructor declares its OWN ConnectorRegistry parameter `@Optional()`
    // so this real, DI-wired instance is what production and every
    // AppModule-compiling test (app.module.spec.ts) actually gets — the
    // internally-built fallback in SyncWorker's constructor exists only for
    // the raw, non-DI `new SyncWorker(...)` call sites in scripts/tests (see
    // that constructor's own doc comment).
    EchoConnector,
    // Milestone 11, Task 5: real, no-network-at-construction (same property
    // as EchoConnector/KeycloakAdminClient above — LDAPS connects lazily on
    // first actual use, never inside a constructor) — registered for the
    // identical reason EchoConnector is: `ConnectorRegistry`'s own
    // `ActiveDirectoryConnector` constructor parameter needs a REAL
    // registered provider to resolve through DI at all, JS-level default or
    // not (see EchoConnector's own doc comment above for the exact failure
    // this avoids).
    ActiveDirectoryConnector,
    // Milestone 12, Task 7: real, no-network-at-construction (same property
    // as ActiveDirectoryConnector/EchoConnector/KeycloakAdminClient above —
    // the token endpoint is only ever called lazily, from inside `getToken`,
    // never a constructor) — registered for the identical reason those are:
    // `ConnectorRegistry`'s own `EntraIdConnector` constructor parameter
    // needs a REAL registered provider to resolve through DI at all,
    // JS-level default or not (see EchoConnector's own doc comment above for
    // the exact failure this avoids).
    EntraIdConnector,
    // Milestone 13, Task 8: real, no-network-at-construction (same property
    // as EntraIdConnector/ActiveDirectoryConnector/EchoConnector/
    // KeycloakAdminClient above — the token endpoint is only ever called
    // lazily, from inside `getToken`, never a constructor) — registered for
    // the identical reason those are: `ConnectorRegistry`'s own
    // `GoogleWorkspaceConnector` constructor parameter needs a REAL
    // registered provider to resolve through DI at all, JS-level default or
    // not (see EchoConnector's own doc comment above for the exact failure
    // this avoids).
    GoogleWorkspaceConnector,
    // Sub-project 4 — same property and same reason as every connector
    // above: no network I/O at construction (its `fetch` is only ever called
    // from inside a request), and `ConnectorRegistry`'s own
    // `MailServerConnector` parameter needs a REAL registered provider to
    // resolve through DI, JS-level default or not.
    MailServerConnector,
    ConnectorRegistry,
    SyncWorker,
    SyncStateRepository,
    // Milestone 14, Task 9 — the connector console's own read/write
    // repository for `connector_targets` (ConnectorTargetsController).
    ConnectorTargetsRepository,
    // Milestone 10 Task 4 built this job CLI-only, deliberately not
    // registered here yet — its own report named this task ("Milestone 14
    // Task 9 ... will need to either register it there or build a thin
    // controller around it") as the moment it would need real Nest DI, to
    // back ConnectorTargetsController's dry-run/apply route. Never network
    // I/O at construction (its constructor only stores already-provided
    // dependencies), so — like SyncWorker/EchoConnector/every connector
    // above — it is safe to register unconditionally for every app boot.
    TargetReconciliationJob,
  ],
})
export class AppModule {}
