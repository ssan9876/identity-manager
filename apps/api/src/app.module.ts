import { Module } from '@nestjs/common'
import { JWT_GUARD_OPTIONS, JwtGuard, type JwtGuardOptions } from './auth/jwt.guard'
import { MeController } from './auth/me.controller'
import { AuditRepository } from './audit/audit.repository'
import { AuditWriter } from './audit/audit.writer'
import { PermissionEngine } from './authz/permission.engine'
import { PermissionGuard } from './authz/permission.guard'
import { PrivilegeGuards } from './authz/privilege.guards'
import { RoleAssignmentsController } from './authz/role-assignments.controller'
import { RoleAssignmentsRepository } from './authz/role-assignments.repository'
import { DB_CLIENT } from './common/db.token'
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
      provide: DB_CLIENT,
      useFactory: () => {
        const env = loadEnv(process.env)
        return createDbClient(env.databaseUrl, { max: env.dbPoolMax }).db
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
    SyncWorker,
    SyncStateRepository,
  ],
})
export class AppModule {}
