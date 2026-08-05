import 'reflect-metadata'
import { Controller, Module, forwardRef } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { JwtGuard } from '../src/auth/jwt.guard'
import { PermissionGuard } from '../src/authz/permission.guard'
import { REQUIRED_PERMISSION } from '../src/authz/require-permission.decorator'

/** Only the liveness probe may be reached without authentication. */
const OPEN_BY_DESIGN = new Set(['HealthController'])

/**
 * Authenticated but not authorized: these controllers need identity
 * (JwtGuard) but never a permission grant (PermissionGuard) — they return
 * only the caller's own principal, never directory data. Declared beside
 * OPEN_BY_DESIGN, by name, so every exemption this file honours is visible
 * in one place and adding one is a deliberate, reviewable act rather than an
 * inline string comparison buried in a loop.
 */
const AUTHENTICATION_ONLY = new Set(['MeController'])

type Ctor = new (...args: never[]) => unknown

interface ForwardReference {
  forwardRef: () => unknown
}

function isForwardReference(value: unknown): value is ForwardReference {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { forwardRef?: unknown }).forwardRef === 'function'
  )
}

/**
 * `forwardRef(() => Module)` — Nest's standard way to break a circular
 * dependency between two feature modules — does not pass the module class
 * itself as the `imports` entry. It passes `{ forwardRef: () => Module }`
 * instead, deferring evaluation until the callback is actually invoked.
 * Unwrapped, that plain object is neither a function nor previously "seen",
 * so leaving it unresolved would silently contribute zero controllers for
 * that branch — a controller declared only behind a forwardRef would be
 * invisible to both assertions below, exactly the "sees nothing, passes
 * anyway" failure mode this file exists to prevent.
 */
function resolveModule(value: unknown): unknown {
  return isForwardReference(value) ? value.forwardRef() : value
}

/** Collect controllers from a module and every module it imports, transitively. */
function collectControllers(module: unknown, seen = new Set<unknown>()): Ctor[] {
  const resolved = resolveModule(module)

  if (typeof resolved !== 'function' || seen.has(resolved)) {
    return []
  }
  // Cycle guard keyed on the RESOLVED class, not the forwardRef wrapper:
  // two modules that forwardRef each other produce two distinct wrapper
  // objects that would never compare equal, so guarding on the wrapper
  // would never terminate a genuine circular dependency between them.
  seen.add(resolved)

  const own: Ctor[] = Reflect.getMetadata('controllers', resolved) ?? []
  const imports: unknown[] = Reflect.getMetadata('imports', resolved) ?? []

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

  // Independent from the JwtGuard assertion above on purpose: a controller
  // can carry @UseGuards(JwtGuard) with @RequirePermission on every route
  // and still enforce NOTHING if PermissionGuard itself was left off the
  // decorator — the JwtGuard assertion is blind to that (it only checks
  // JwtGuard is present), and the "declares a permission" assertion below is
  // blind to it too (it only checks route METADATA exists, never that
  // anything actually reads it at request time). Found live in review:
  // exactly that shape returned 200 with the full user list to a principal
  // holding no role and no local user record at all. Two separate
  // assertions — one per guard — mean a controller missing EITHER one fails
  // loudly and by name, instead of the failure being silently absorbed by
  // whichever assertion still happens to pass.
  it('applies PermissionGuard to every controller except the health endpoint and /me', () => {
    const unguarded = collectControllers(AppModule)
      .filter(
        (controller) =>
          !OPEN_BY_DESIGN.has(controller.name) && !AUTHENTICATION_ONLY.has(controller.name),
      )
      .filter((controller) => {
        const guards: unknown[] = Reflect.getMetadata('__guards__', controller) ?? []
        return !guards.includes(PermissionGuard)
      })
      .map((controller) => controller.name)

    expect(unguarded).toEqual([])
  })

  it('declares a permission on every route of every guarded controller', () => {
    const missing: string[] = []

    for (const controller of collectControllers(AppModule)) {
      if (OPEN_BY_DESIGN.has(controller.name) || AUTHENTICATION_ONLY.has(controller.name)) {
        continue
      }

      const proto = controller.prototype as Record<string, unknown>
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (key === 'constructor') continue
        const handler = proto[key]
        if (typeof handler !== 'function') continue
        const isRoute = Reflect.hasMetadata('path', handler)
        if (!isRoute) continue
        if (Reflect.getMetadata(REQUIRED_PERMISSION, handler) === undefined) {
          missing.push(`${controller.name}.${key}`)
        }
      }
    }

    expect(missing).toEqual([])
  })
})

describe('collectControllers and forwardRef', () => {
  // Regression coverage for a review finding: a controller reachable only
  // through `imports: [forwardRef(() => X)]` — the standard way Nest breaks
  // a circular dependency between feature modules — must still be found.
  // Milestone 3b splits controllers into feature modules, which is exactly
  // when circular imports (and forwardRef) become likely.

  it('sees a controller behind a single forwardRef()-wrapped import', () => {
    @Controller('forward-ref-leaf')
    class LeafController {}

    @Module({ controllers: [LeafController] })
    class LeafModule {}

    @Module({ imports: [forwardRef(() => LeafModule)] })
    class RootModule {}

    const found = collectControllers(RootModule).map((c) => c.name)
    expect(found).toEqual(['LeafController'])
  })

  it('terminates on a genuinely circular forwardRef pair instead of hanging or overflowing, and still finds the controller', () => {
    // The controller lives on ModuleB, reachable from ModuleA ONLY by
    // crossing the forwardRef edge — so this only passes if forwardRef
    // resolution actually works. ModuleB in turn forwardRefs back to
    // ModuleA, a genuine cycle: if the `seen` guard were keyed on the
    // wrapper object identity rather than the resolved class, this would
    // recurse forever instead of terminating.
    @Controller('forward-ref-cycle')
    class CycleController {}

    @Module({ imports: [forwardRef(() => ModuleB)] })
    class ModuleA {}

    @Module({
      imports: [forwardRef(() => ModuleA)],
      controllers: [CycleController],
    })
    class ModuleB {}

    const found = collectControllers(ModuleA).map((c) => c.name)
    expect(found).toEqual(['CycleController'])
  })
})
