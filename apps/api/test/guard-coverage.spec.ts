import 'reflect-metadata'
import { Controller, Module, forwardRef } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { IMMUTABLE_THROUGH_PATCH } from '../src/attributes/attribute-definitions.controller'
import { JwtGuard } from '../src/auth/jwt.guard'
import { PermissionGuard } from '../src/authz/permission.guard'
import { REQUIRED_PERMISSION } from '../src/authz/require-permission.decorator'

/**
 * Only the PROBE endpoints may be reached without authentication.
 *
 * `HealthController` (liveness) and `ReadinessController` (`GET
 * /health/ready`) are both called by things that hold no token and cannot be
 * given one: a systemd unit, a kubelet, the deploy script's curl loop. An
 * authenticated probe is not a probe — it fails for reasons that have
 * nothing to do with whether this instance can serve, and it cannot run
 * before a token issuer is reachable.
 *
 * The cost of that exemption is paid in the handlers themselves: neither may
 * return anything an anonymous caller should not see. Liveness returns a
 * constant. Readiness returns a closed vocabulary of literal strings and
 * never the underlying error (see readiness.controller.ts, and the leak
 * assertions in readiness.spec.ts).
 *
 * Readiness is a SEPARATE controller rather than a second route on
 * `HealthController` precisely so that it had to be added here by hand: a
 * new unauthenticated route on an already-exempt controller would have
 * slipped past this file entirely.
 */
const OPEN_BY_DESIGN = new Set(['HealthController', 'ReadinessController'])

/**
 * Authenticated but not authorized: these controllers need identity
 * (JwtGuard) but never a permission grant (PermissionGuard) — they return
 * only the caller's own principal, never directory data. Declared beside
 * OPEN_BY_DESIGN, by name, so every exemption this file honours is visible
 * in one place and adding one is a deliberate, reviewable act rather than an
 * inline string comparison buried in a loop.
 *
 * `SelfServiceController` (Milestone 6, Task 3) joins `MeController` here
 * for the same reason: every route it exposes (`GET /self`, `PATCH /self`,
 * `GET /self/groups`) resolves its target exclusively from the verified JWT
 * principal, never from a permission grant — the brief requires it to work
 * for a user holding no role at all (`PermissionEngine.resolveActor`
 * requires only an ACTIVE user, never a role assignment). Gating it behind
 * `PermissionGuard`/`@RequirePermission` would be a REGRESSION, not
 * hardening: an ordinary employee with zero grants would be locked out of
 * their own profile.
 */
/*
 * `AccessRequestsController` (self-service access-request catalogue) joins
 * on the same terms as `SelfServiceController`: every route serves the
 * authenticated caller as themselves � browsing the catalogue, requesting a
 * role, cancelling their own request, and deciding requests as the RESOLVED
 * APPROVER (an ordinary manager holding no admin role and no permission
 * grant at all). Gating it behind PermissionGuard would lock every ordinary
 * employee out of the catalogue and every manager out of their own inbox.
 * Its authorization is per-route and in-handler, from server-resolved facts
 * only � see that controller's own class doc comment.
 *
 * `RecertReviewsController` joins on the same terms: a recertification
 * campaign's resolved reviewers are ordinary managers who legitimately hold
 * NO role in the static catalog, so gating the reviewer surface behind
 * `PermissionGuard`/`@RequirePermission` would lock every one of them out of
 * the queue that was just assigned to them. Authorization there is
 * IDENTITY-based per item instead � the caller must BE the item's resolved
 * reviewer (or hold a global recert:manage grant), resolved exclusively from
 * the verified JWT principal, and nobody may decide an item about their own
 * access. The OPERATOR surface (`RecertCampaignsController`) is fully
 * permission-guarded and is NOT exempted here.
 */
const AUTHENTICATION_ONLY = new Set([
  'MeController',
  'SelfServiceController',
  'AccessRequestsController',
  'RecertReviewsController',
])

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
        'AccessRequestsController',
        'AttributeDefinitionsController',
        'AttributeTargetMappingsController',
        'AuditController',
        'BusinessRolesController',
        'ConnectorTargetsController',
        'DataFlowsController',
        'GroupsController',
        'HealthController',
        'HrSourcesController',
        'ImportsController',
        'MeController',
        'OrgUnitsController',
        'OrganizationsController',
        'OutboxController',
        'ReadinessController',
        'RecertCampaignsController',
        'RecertReviewsController',
        'RoleAssignmentsController',
        'SelfServiceController',
        'SsoAppsController',
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

/**
 * Milestone 8, Task 7 owes Milestone 8, Task 10 a message update, and this is
 * what makes that debt FAIL rather than rot.
 *
 * `PATCH /attribute-definitions/:id` refuses `dataType`/`appliesTo` with a
 * message pointing at the preview/commit migration route. That message
 * deliberately names no URL, because when it was written Tasks 8-10 had not
 * chosen one and a stale URL inside a 400 is worse than none — but it also
 * says "Until that lands, create a new definition with the type you want",
 * which becomes ACTIVELY FALSE the moment the route exists and would send an
 * admin off to create a duplicate attribute.
 *
 * The controller spec only asserts the message matches /preview/i and
 * /commit/i, which the current text already satisfies, so nothing there
 * would notice. This does: the instant a route whose path contains `preview`
 * or `commit` is registered under `attribute-definitions`, the refusal
 * message must name that path. Until then it passes trivially, asserting
 * over an empty set — which is the point. A TODO comment cannot fail.
 *
 * Scoped to the `attribute-definitions` base path ON PURPOSE:
 * `ImportsController` (`POST /imports/preview`, `POST /imports/commit`) and
 * `HrSourcesController` (`POST /hr-sources/:id/preview`) already register
 * routes with both words and have nothing to do with this message.
 */
describe('the attribute migration route obligation (Milestone 8, Task 10)', () => {
  const MIGRATION_WORDS = ['preview', 'commit']

  /** Every route path registered under the `attribute-definitions` base path, controller prefix included. */
  function attributeDefinitionRoutePaths(): string[] {
    const paths: string[] = []

    for (const controller of collectControllers(AppModule)) {
      const base = String(Reflect.getMetadata('path', controller) ?? '')
      if (!base.startsWith('attribute-definitions')) continue

      const proto = controller.prototype as Record<string, unknown>
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (key === 'constructor') continue
        const handler = proto[key]
        if (typeof handler !== 'function') continue
        if (!Reflect.hasMetadata('path', handler)) continue

        const own = String(Reflect.getMetadata('path', handler) ?? '')
        paths.push(`${base}/${own}`.replace(/\/+/g, '/').replace(/\/$/, ''))
      }
    }

    return paths
  }

  it('names the real preview/commit path in the dataType refusal once that route exists', () => {
    const migrationRoutes = attributeDefinitionRoutePaths().filter((path) =>
      MIGRATION_WORDS.some((word) => path.includes(word)),
    )

    const unnamed = migrationRoutes.filter(
      (path) => !IMMUTABLE_THROUGH_PATCH.dataType.includes(path),
    )

    expect(unnamed).toEqual([])
  })

  // Guards the guard: if the message ever loses the words the controller spec
  // matches on, this file's premise (that the message is where the pointer
  // lives) has quietly stopped being true.
  it('still points at a preview-then-commit flow at all', () => {
    expect(IMMUTABLE_THROUGH_PATCH.dataType).toMatch(/preview/i)
    expect(IMMUTABLE_THROUGH_PATCH.dataType).toMatch(/commit/i)
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
