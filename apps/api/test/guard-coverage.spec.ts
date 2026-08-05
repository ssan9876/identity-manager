import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { JwtGuard } from '../src/auth/jwt.guard'

/** Only the liveness probe may be reached without authentication. */
const OPEN_BY_DESIGN = new Set(['HealthController'])

describe('guard coverage', () => {
  it('applies JwtGuard to every controller except the health endpoint', () => {
    // Pure metadata reflection — no DI container, no env, no database.
    // `@Module({controllers})` stores under 'controllers'; `@UseGuards` under '__guards__'.
    const registered: Array<new (...args: never[]) => unknown> =
      Reflect.getMetadata('controllers', AppModule) ?? []

    expect(registered.length).toBeGreaterThan(0)

    const unguarded = registered
      .filter((controller) => !OPEN_BY_DESIGN.has(controller.name))
      .filter((controller) => {
        const guards: unknown[] = Reflect.getMetadata('__guards__', controller) ?? []
        return !guards.includes(JwtGuard)
      })
      .map((controller) => controller.name)

    expect(unguarded).toEqual([])
  })
})
