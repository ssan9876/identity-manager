import { ConflictError } from './errors'

/** Postgres SQLSTATE for a foreign-key violation — every composite FK below reports this. */
const FOREIGN_KEY_VIOLATION = '23503'

/**
 * The COMPOSITE foreign keys migration 0029 added, mapped to what a caller
 * needs to be told. Organizations milestone, Task 12 — the third of the four
 * deferrals Task 11 left here.
 *
 * Each of these pairs a reference with `organization_id`, so it fires for
 * exactly one reason: the row would have joined two things that belong to
 * DIFFERENT tenants. Every one of them is genuinely reachable from the HTTP
 * surface, because nothing above the database narrows a `userId`/`groupId`/
 * `managerId` to the actor's own organization — that is the whole point of
 * the constraints, and this milestone's design (decision 3) is that admins
 * are platform operators who can legitimately see every tenant and so can
 * legitimately mistype an id from the wrong one.
 *
 * Untranslated, each surfaced as a raw SQLSTATE 23503 falling off the end of
 * `DomainExceptionFilter`'s map into a bodyless 500 — indistinguishable from
 * a crash, on a request that was refused for a completely comprehensible
 * reason. Exactly the "un-triageable" shape `DataIntegrityError`'s own doc
 * comment was written about.
 *
 * 409 CONFLICT, not 404 and not 400. Not a 404: the referenced row genuinely
 * exists and the actor is entitled to see it — claiming otherwise would be a
 * lie the actor can immediately disprove with a GET. Not a 400: the request
 * is well-formed and every id in it is real; what fails is a relationship
 * between two existing rows, which is the definition of a conflict.
 *
 * The messages name the RELATIONSHIP, never the tenant's slug or id. An
 * actor reaching here already holds a global grant for the write in
 * question, so this is not the existence-oracle shape finding SEC-L2 is
 * about — but there is also nothing to gain from naming the other tenant,
 * and "these two are in different organizations" is the whole actionable
 * content.
 *
 * `Object.create(null)`, not a plain object literal: `constraint` arrives
 * from the Postgres driver and is indexed directly below, so a value like
 * `constructor` or `toString` would otherwise resolve to an inherited
 * function and defeat the `?? `-style guard. This project has been bitten by
 * prototype-chain semantics five times now — see `ROLE_PERMISSIONS`
 * (authz/actions.ts) and `ConnectorRegistry.factories` for the full list.
 */
const MESSAGE_BY_CONSTRAINT: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  {
    users_org_unit_organization_fk:
      'the org unit belongs to a different organization than the user',
    users_manager_organization_fk:
      'the manager belongs to a different organization than their report',
    groups_org_unit_organization_fk:
      'the org unit belongs to a different organization than the group',
    org_units_parent_organization_fk:
      'the parent org unit belongs to a different organization',
    gum_group_organization_fk:
      'the group and the user belong to different organizations',
    gum_user_organization_fk:
      'the group and the user belong to different organizations',
    ggm_parent_organization_fk:
      'the parent and child groups belong to different organizations',
    ggm_child_organization_fk:
      'the parent and child groups belong to different organizations',
  },
)

/**
 * A `ConflictError` when `cause` is one of the composite-FK violations
 * above, `null` otherwise — so a caller's own `translateWriteError` can
 * consult this and then fall through to its existing branches and its final
 * `throw cause`. Deliberately RETURNS rather than throws: the constraint
 * catalog is shared, but the decision about precedence between it and a
 * repository's own single-column mappings belongs to that repository.
 *
 * By CONSTRAINT NAME, never by SQLSTATE alone — the same rule
 * `UsersRepository.translateWriteError`'s doc comment sets out at length.
 * Every single-column FK on these same tables reports the identical 23503,
 * and several of them have well-established 404 translations that must not
 * be replaced by a 409.
 */
export function crossTenantConflict(cause: unknown): ConflictError | null {
  const pgError = cause as { code?: string; constraint?: string } | null
  if (pgError?.code !== FOREIGN_KEY_VIOLATION || pgError.constraint === undefined) {
    return null
  }
  const message = MESSAGE_BY_CONSTRAINT[pgError.constraint]
  return message === undefined ? null : new ConflictError(message)
}
