import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { JwtGuard } from '../src/auth/jwt.guard'

/** Only the liveness probe may be reached without authentication. */
const OPEN_BY_DESIGN = new Set(['HealthController'])

type Ctor = new (...args: never[]) => unknown

/** Collect controllers from a module and every module it imports, transitively. */
function collectControllers(module: unknown, seen = new Set<unknown>()): Ctor[] {
  if (typeof module !== 'function' || seen.has(module)) {
    return []
  }
  seen.add(module)

  const own: Ctor[] = Reflect.getMetadata('controllers', module) ?? []
  const imports: unknown[] = Reflect.getMetadata('imports', module) ?? []

  return imports.reduce<Ctor[]>(
    (all, imported) => all.concat(collectControllers(imported, seen)),
    own,
  )
}

describe('guard coverage', () => {
  it('finds controllers through the whole module graph, not just AppModule', () => {
    const found = collectControllers(AppModule).map((c) => c.name).sort()
    // If a controller is added or renamed, update this list deliberately.
    expect(found).toEqual(
      [
        'GroupsController',
        'HealthController',
        'MeController',
        'OrgUnitsController',
        'UsersController',
      ].sort(),
    )
  })

  it('applies JwtGuard to every controller except the health endpoint', () => {
    const unguarded = collectControllers(AppModule)
      .filter((controller) => !OPEN_BY_DESIGN.has(controller.name))
      .filter((controller) => {
        const guards: unknown[] = Reflect.getMetadata('__guards__', controller) ?? []
        return !guards.includes(JwtGuard)
      })
      .map((controller) => controller.name)

    expect(unguarded).toEqual([])
  })
})
