import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { AuthenticatedRequest } from '../auth/jwt.guard'
import { ForbiddenError } from '../common/errors'
import type { Action } from './actions'
import { PermissionEngine, type Actor } from './permission.engine'
import { REQUIRED_PERMISSION } from './require-permission.decorator'

export interface AuthorizedRequest extends AuthenticatedRequest {
  actor: Actor
}

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    @Inject(PermissionEngine) private readonly engine: PermissionEngine,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.get<Action | undefined>(
      REQUIRED_PERMISSION,
      context.getHandler(),
    )

    // Fail closed: a route that forgot to declare a permission is denied, not
    // waved through. Authorization is opt-out only by explicit exemption
    // (guard-coverage.spec.ts enforces that every route on every guarded
    // controller declares one, so "forgot the decorator" is a build-time-ish
    // test failure, not a silent production bypass).
    if (required === undefined) {
      throw new ForbiddenError('route declares no permission')
    }

    const request = context.switchToHttp().getRequest<AuthorizedRequest>()

    // Defensive: this guard reads request.principal, which exists only
    // because JwtGuard ran first and set it. `@UseGuards(JwtGuard,
    // PermissionGuard)` on every controller is what guarantees that order
    // today, but nothing at compile time or runtime enforces it — reversing
    // the decorator's argument order (or a controller that adds
    // PermissionGuard without JwtGuard) would leave request.principal
    // undefined here. AuthorizedRequest's type claims principal always
    // exists, so without this check resolveActor(undefined) would throw an
    // unhandled TypeError from deep inside a SQL template — still a fail
    // CLOSED outcome (a 500 grants nothing), but an illegible one: a raw
    // 500 instead of the same clean 403 every other denial in this guard
    // produces, and nothing in the test suite would catch it (every
    // controller in the real app happens to declare the guards in the
    // working order). Checking explicitly turns a silent ordering mistake
    // into the same intentional, legible denial as any other.
    if (request.principal === undefined) {
      throw new ForbiddenError('no authenticated principal on request — check guard order')
    }

    // Resolved fresh on every request — never cached. PermissionEngine
    // snapshots the actor's role assignments (and each assignment's scope
    // path) into the Actor it returns; that snapshot is only correct for the
    // request it was built for. Caching it (e.g. a module-level map keyed by
    // username) would let a revoked role, a moved user, or a deactivated
    // account keep working until some arbitrary cache expiry — see Task 3's
    // review and permission.guard.spec.ts's "reflects a revoked role on the
    // very next request" test, which exists specifically to pin this.
    const actor = await this.engine.resolveActor(request.principal)

    // Gates route ENTRY only: "does this actor hold `required` ANYWHERE at
    // all?" Deliberately `assertCanAnywhere`, not a per-resource check (see
    // permission.engine.ts, Task 3 Finding I-2, for why there is no
    // optional-target `assertCan` to call instead). This is intentionally
    // NOT the whole authorization decision for a scoped actor — it only
    // decides whether the route is reachable at all.
    //
    // TRUTH as of Milestone 3b: per-resource scope narrowing IS wired, but
    // NOT here — it lives in each controller, one layer downstream. Every
    // list handler additionally calls `scopePathsFor(actor, action)` and
    // filters through the repository; every single-resource handler
    // additionally loads the target and calls `assertCanIn(actor, action,
    // target.orgUnitId)` before returning it (global groups, `orgUnitId =
    // NULL`, are the one documented exception — see GroupsController). An
    // actor holding `required` only at a narrow scope now reaches this
    // route (this check passes) but sees only their own subtree once
    // inside it. Both checks are load-bearing and neither subsumes the
    // other: this one denies an actor who holds `required` nowhere at all
    // before a single query runs; the controller-level ones deny an actor
    // who holds it somewhere but not over THIS resource. See
    // permission.guard.spec.ts's "MILESTONE 3b GATE" pair for the pinned
    // before/after, and each controller for its own narrowing call sites.
    this.engine.assertCanAnywhere(actor, required)

    request.actor = actor
    return true
  }
}
