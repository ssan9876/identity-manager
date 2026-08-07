import { Module } from '@nestjs/common'
import { JWT_GUARD_OPTIONS, JwtGuard, type JwtGuardOptions } from './auth/jwt.guard'
import { MeController } from './auth/me.controller'
import { AttributeDefinitionsController } from './attributes/attribute-definitions.controller'
import { AttributeDefinitionsRepository } from './attributes/attribute-definitions.repository'
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
import { ConnectorRegistry } from './connectors/connector-registry'
import { EchoConnector } from './connectors/echo.connector'
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
import { OutboxController } from './outbox/outbox.controller'
import { OutboxRepository } from './outbox/outbox.repository'
import { OutboxWriter } from './outbox/outbox.writer'
import { SyncStateRepository } from './outbox/sync-state.repository'
import { SyncWorker } from './outbox/sync.worker'
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
      // Finding H1 (docs/superpowers/audit-integrity.md): the RUNTIME
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
      // Finding M6 (docs/superpowers/audit-integrity.md): the explicit,
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
    ConnectorRegistry,
    SyncWorker,
    SyncStateRepository,
  ],
})
export class AppModule {}
