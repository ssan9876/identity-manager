import { Module } from '@nestjs/common'
import { JWT_GUARD_OPTIONS, JwtGuard, type JwtGuardOptions } from './auth/jwt.guard'
import { MeController } from './auth/me.controller'
import { loadEnv } from './config/env'
import { HealthController } from './health/health.controller'

@Module({
  controllers: [HealthController, MeController],
  providers: [
    {
      provide: JWT_GUARD_OPTIONS,
      useFactory: (): JwtGuardOptions => {
        const env = loadEnv(process.env)
        return {
          issuer: env.keycloakIssuer,
          audience: env.keycloakAudience,
        }
      },
    },
    JwtGuard,
  ],
})
export class AppModule {}
