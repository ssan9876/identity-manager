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

    // Resolved fresh on every request — never cached. PermissionEngine
    // snapshots the actor's role assignments (and each assignment's scope
    // path) into the Actor it returns; that snapshot is only correct for the
    // request it was built for. Caching it (e.g. a module-level map keyed by
    // username) would let a revoked role, a moved user, or a deactivated
    // account keep working until some arbitrary cache expiry — see Task 3's
    // review and permission.guard.spec.ts's "reflects a revoked role on the
    // very next request" test, which exists specifically to pin this.
    const actor = await this.engine.resolveActor(request.principal)

    // Gates route ENTRY only: does this actor hold `required` ANYWHERE at
    // all? This is deliberately `assertCanAnywhere`, not a per-resource
    // scope check — the engine has no `assertCan(actor, action, target?)`
    // anymore (see permission.engine.ts): an optional target let "no target
    // to check, this is a list route" and "a failed lookup" collapse into
    // the same `undefined`, and the list-route branch resolved to an
    // accidental allow (Task 3 review, Finding I-2). `canIn`/`assertCanIn`
    // require an already-resolved target and belong to the controllers
    // (narrowing a list by `scopePathsFor`, or checking a single identified
    // resource) — that per-resource narrowing is this milestone's read
    // controllers today and Milestone 3b's write paths next; it is never
    // this guard's job.
    this.engine.assertCanAnywhere(actor, required)

    request.actor = actor
    return true
  }
}
