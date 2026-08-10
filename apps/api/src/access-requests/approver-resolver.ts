import type { RoleKey } from '../authz/actions'

/**
 * The CLOSED approver-resolution vocabulary — the JML posture applied to
 * approvals: resolvers are DATA (an enum label recorded on the request),
 * never code. There is deliberately no expression language, no
 * admin-authored script, no per-role resolver configuration: an IdP that
 * runs admin-authored code against its own directory is a
 * privilege-escalation vector by construction. This file must survive the
 * same static source scan jml-rule-engine.spec.ts applies to src/jml (see
 * test/access-requests.controller.spec.ts's "resolvers are DATA" block).
 *
 * Exactly two resolvers ship:
 *
 *  - `manager_of_subject` — the subject's `users.manager_id`. Chosen at
 *    request time when the subject HAS a manager; at decision time the
 *    manager is re-resolved FRESH, so a re-org between request and decision
 *    moves the decision to the new manager rather than the stale one.
 *  - `role_holder:super_admin` — the fallback when the subject has no
 *    manager: any holder of the `super_admin` admin role may decide. The
 *    role is part of the LABEL, not a parameter — widening the vocabulary
 *    is a reviewed enum change (schema + this list + the pgEnum), never a
 *    data write.
 */
export const APPROVER_RESOLVERS = ['manager_of_subject', 'role_holder:super_admin'] as const

export type ApproverResolver = (typeof APPROVER_RESOLVERS)[number]

/** The admin role `role_holder:super_admin` names. Derived from the label so the two can never disagree. */
export const FALLBACK_APPROVER_ROLE: RoleKey = 'super_admin'

/**
 * Which resolver governs a subject: their manager when they have one, the
 * admin-role fallback when they do not. Pure data-in, label-out — the ONLY
 * decision this module makes.
 */
export function resolverForSubject(subject: { managerId: string | null }): ApproverResolver {
  return subject.managerId === null ? 'role_holder:super_admin' : 'manager_of_subject'
}
