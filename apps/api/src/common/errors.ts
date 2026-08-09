/**
 * Every error the domain raises deliberately extends DomainError, so the HTTP
 * layer can map it to a status code. Anything that is NOT a DomainError is a
 * genuine bug and must surface as a 500 — never rewrite one into a 4xx.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string

  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND'

  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`)
  }
}

export class ConflictError extends DomainError {
  readonly code = 'CONFLICT'
}

export class InvalidTransitionError extends DomainError {
  readonly code = 'INVALID_TRANSITION'
}

export class CycleError extends DomainError {
  readonly code = 'CYCLE_DETECTED'
}

export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_FAILED'

  constructor(
    public readonly issues: string[],
    message = `validation failed: ${issues.join('; ')}`,
  ) {
    super(message)
  }
}

export class ForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN'
}

/**
 * The one DomainError that is NOT the caller's fault and NOT a 4xx: stored
 * data that this binary cannot interpret, found on a path that must fail
 * closed rather than guess. Finding AUTHZ-L-4
 * (docs/archive/audits/audit-authz.md).
 *
 * The motivating case is `PrivilegeGuards.assertCanModifyPrincipal`: a
 * `role_assignments.role_key` that is a legal value of the Postgres enum but
 * absent from this code's static `ROLE_RANK` catalog. That combination is
 * reachable — the enum can grow by migration ahead of the catalog, which is
 * deliberately static code changed only by review (see ROLE_PERMISSIONS's own
 * doc comment) — and the only safe reading of it is "refuse", never "this
 * principal holds no privilege, go ahead".
 *
 * Why it needs its own class rather than the plain `Error` that was there
 * before. Both produce a 500, so this changes nothing about failing closed.
 * What it changes is triage: a plain Error falls through to Nest's default
 * handler and returns a bodyless 500 that is INDISTINGUISHABLE from a genuine
 * crash, on a principal who is by then permanently unmodifiable through the
 * API with no actionable error anywhere. The audit's words: "un-triageable".
 * A mapped code and a message naming the offending role_key turn a mystery
 * 500 into a one-line fix ("add this key to ROLE_RANK, or remove the
 * assignment").
 *
 * This does NOT weaken errors.ts's rule that a non-DomainError is a bug and
 * must be a 500. It carves out the narrow case that is a DATA fault rather
 * than a code fault, and keeps it at 500 explicitly (see
 * DomainExceptionFilter's STATUS_BY_CODE) rather than by falling off the end
 * of the map. Do not add a 4xx mapping for it: nothing the caller sent caused
 * it, and nothing the caller can send fixes it.
 *
 * The message names a value read from the DATABASE, never one submitted by
 * the caller, so it is not the existence-oracle shape finding SEC-L2 is
 * about — and reaching this code at all already required passing the
 * permission guard for the write in question.
 */
export class DataIntegrityError extends DomainError {
  readonly code = 'DATA_INTEGRITY_FAULT'
}

/**
 * A required piece of DEPLOYMENT CONFIGURATION is absent — not the caller's
 * fault, and not retryable by them. Organizations milestone, Task 12.
 *
 * The motivating case is `POST /organizations` on a deployment with no
 * `KEYCLOAK_PROVISION_CLIENT_ID`/`_SECRET`: the request is perfectly
 * well-formed, the actor is perfectly entitled, and the row would insert
 * cleanly — but the realm it names could never be provisioned, so the
 * organization would sit "provisioning" forever while its outbox event
 * retried and dead-lettered. Refusing up front turns that into one
 * actionable answer at the moment of the request.
 *
 * 503, not 500 and not a 4xx. Not a 4xx because nothing the caller sent
 * caused it and nothing they can send fixes it; not a 500 because it is not
 * a bug — the service is functioning correctly and is simply not equipped
 * for this operation yet. 503 is also the honest "try again once the
 * operator has configured it" signal, which is exactly the remedy.
 *
 * The message must name the ENVIRONMENT VARIABLES and never their values —
 * the same split `MissingSecretError` (connectors/secrets.ts) and
 * `KeycloakFactoryConfig.provisionClientId` already make.
 */
export class NotConfiguredError extends DomainError {
  readonly code = 'NOT_CONFIGURED'
}
