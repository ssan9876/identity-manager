import { Controller, Get, Req, UseGuards } from '@nestjs/common'
import { JwtGuard, type AuthenticatedRequest, type Principal } from './jwt.guard'

/**
 * `GET /me` is a pure JWT-CLAIMS ECHO, deliberately NOT a session-validity
 * check — finding L-1 (docs/superpowers/audit-authz.md): a `pending`,
 * `suspended` or `deactivated` principal gets 200 here today, while every
 * other route in the system correctly 403s them (`PermissionEngine
 * .resolveActor`'s `status !== 'active'` check, which `SelfServiceController`
 * and every guarded controller go through — this one deliberately does not).
 *
 * DECISION (this fix pass): documented as safe, not denied. Two things make
 * that the right call, not just the cheap one:
 *   1. It leaks nothing the caller's own token does not already contain —
 *      `subject`/`username`/`email` are read straight back out of the
 *      already-verified JWT, never out of a directory row. There is no
 *      information disclosure to a caller who, by construction, already
 *      holds this exact token.
 *   2. Something ACTUALLY DEPENDS on the current contract:
 *      `test/jwt.guard.spec.ts` deliberately targets THIS controller,
 *      specifically because it carries no dependency beyond `JwtGuard` —
 *      that isolation is what lets it exercise JwtGuard's own claim
 *      validation (missing/malformed `sub`/`preferred_username`, wrong
 *      issuer/audience, `alg:none`, ...) with no database at all. Resolving
 *      through `PermissionEngine.resolveActor` here would entangle a guard
 *      unit test with a full Postgres-backed active-user fixture for every
 *      case, for a route that already has an equivalent, actively-used
 *      session check elsewhere (`GET /self`, which DOES resolve through
 *      `resolveActor` — see `SelfServiceController.resolveCaller`'s doc
 *      comment — and is what `guard-coverage.spec.ts` documents as the
 *      "authenticated but not authorized" pattern for this exact shape of
 *      route). `apps/web`'s only caller (`HomePage.tsx`) uses `/me` purely
 *      to display "signed in as" immediately after an OIDC login completes,
 *      never as a polled liveness probe, so no production behaviour depends
 *      on a revoked account being denied here either.
 *
 * A client that needs "is this account still active right now" must use
 * `/self` (or any permission-gated route), never `/me` — that is the
 * intentional division of responsibility this comment documents.
 */
@Controller('me')
@UseGuards(JwtGuard)
export class MeController {
  @Get()
  me(@Req() request: AuthenticatedRequest): Principal {
    return request.principal
  }
}
