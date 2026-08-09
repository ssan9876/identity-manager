import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { Request } from 'express'

export interface Principal {
  subject: string
  username: string
  email: string | null
}

export interface AuthenticatedRequest extends Request {
  principal: Principal
}

export interface JwtGuardOptions {
  issuer: string
  audience: string
}

/**
 * DI token carrying JwtGuardOptions into the guard.
 *
 * `@UseGuards(JwtGuard)` on a controller references JwtGuard by class, and
 * Nest resolves it by constructing its own instance through the container —
 * independent of any `useValue`/`useFactory` provider registered under the
 * `JwtGuard` token itself (verified empirically: a plain `{ provide: JwtGuard,
 * useValue }`/`useFactory` provider is not consulted for `@UseGuards`
 * resolution, in both a real NestFactory bootstrap and a Nest TestingModule).
 * That construction only succeeds if every constructor parameter is a
 * resolvable DI token. A plain TS interface erases at runtime (design:paramtypes
 * emits `Object`) and can never be such a token, so the options are injected
 * through this explicit token instead.
 */
export const JWT_GUARD_OPTIONS = Symbol('JWT_GUARD_OPTIONS')

@Injectable()
export class JwtGuard implements CanActivate {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>

  constructor(@Inject(JWT_GUARD_OPTIONS) private readonly options: JwtGuardOptions) {
    this.jwks = createRemoteJWKSet(
      new URL(`${options.issuer}/protocol/openid-connect/certs`),
    )
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const header = request.headers.authorization

    if (header === undefined || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('missing bearer token')
    }

    const token = header.slice('Bearer '.length).trim()

    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        // Explicit allowlist. Never accept "none", and never let the token
        // choose its own verification algorithm.
        algorithms: ['RS256'],
      })

      const subject = payload.sub
      const username = payload.preferred_username

      // A valid signature is necessary but not sufficient: without a subject
      // or username there is no identity to hand downstream authorization
      // code, and defaulting to '' would silently fabricate one. Fail closed
      // exactly like any other invalid token, with the same generic message.
      //
      // Finding M-3 (docs/archive/audits/audit-authz.md): the previous
      // `payload.preferred_username as string | undefined` cast suppressed
      // the compiler without checking anything at runtime, and `!username`
      // only rejects FALSY values — a non-string, TRUTHY claim (an array, a
      // number, an object) sailed through with `Principal.username: string`
      // becoming a type lie. That value then flowed straight into
      // `PermissionEngine.resolveActor`'s query, where Drizzle's `sql`
      // template splices a bare JS array specially: `preferred_username:
      // ["god"]` degraded to `lower(('god'))` — authenticating as "god" —
      // and a 2-element array became a row constructor that threw an
      // unhandled 500. Explicit `typeof` checks on BOTH claims (not just
      // `username`) reject every non-string shape here, at the
      // authentication boundary, with the same generic message every other
      // invalid token gets — no new information disclosure, and
      // `resolveActor` can no longer receive anything but a genuine,
      // non-empty string. `subject.length === 0` is checked too (the
      // original `!subject` caught an empty string; a bare `typeof` check
      // alone would not have).
      if (
        typeof subject !== 'string' ||
        subject.length === 0 ||
        typeof username !== 'string' ||
        username.length === 0
      ) {
        throw new UnauthorizedException('invalid token')
      }

      request.principal = {
        subject,
        username,
        email: (payload.email as string | undefined) ?? null,
      }

      return true
    } catch {
      throw new UnauthorizedException('invalid token')
    }
  }
}
