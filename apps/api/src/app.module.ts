import { Module } from '@nestjs/common'
import { JWT_GUARD_OPTIONS, JwtGuard, type JwtGuardOptions } from './auth/jwt.guard'
import { MeController } from './auth/me.controller'
import { DB_CLIENT } from './common/db.token'
import { loadEnv } from './config/env'
import { createDbClient } from './db/client'
import { HealthController } from './health/health.controller'
import { OrgUnitsController } from './org-units/org-units.controller'
import { OrgUnitsRepository } from './org-units/org-units.repository'
import { UsersController } from './users/users.controller'
import { UsersRepository } from './users/users.repository'

@Module({
  controllers: [HealthController, MeController, UsersController, OrgUnitsController],
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
  ],
})
export class AppModule {}
