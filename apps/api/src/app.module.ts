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
import { OrgUnitsController } from './org-units/org-units.controller'
import { OrgUnitsRepository } from './org-units/org-units.repository'
import { OutboxWriter } from './outbox/outbox.writer'
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
      useFactory: () => createDbClient(loadEnv(process.env).databaseUrl).db,
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
  ],
})
export class AppModule {}
