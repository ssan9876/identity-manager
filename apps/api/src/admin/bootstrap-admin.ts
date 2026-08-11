import type { RoleKey } from '../authz/actions'
import type { RoleAssignmentsRepository } from '../authz/role-assignments.repository'
import { ConflictError } from '../common/errors'
import type { OrgUnitsRepository } from '../org-units/org-units.repository'
import type { UsersRepository } from '../users/users.repository'

/**
 * The anti-lockout script (task-1-brief.md). A fresh install has no local
 * `users` row and no role grant for anyone — `PermissionEngine.resolveActor`
 * (permission.engine.ts) rejects every request from a principal that
 * doesn't map to one, so a brand new installer who signs in through Keycloak
 * gets 403 on everything, with no path through the UI to fix it (the UI
 * needs exactly the permission it doesn't have yet). This closes that hole
 * by doing, as a trusted local operator script, what no HTTP caller is ever
 * allowed to do to themselves: create their own local user, activate it, and
 * grant it global `super_admin`.
 *
 * Deliberately NOT `@Injectable()` and NOT registered as a provider in
 * `AppModule` — it must never become reachable through the Nest DI graph a
 * controller could be wired into, let alone through an HTTP route. Its only
 * caller is `bootstrap-admin-cli.ts`, run by hand via `pnpm run
 * bootstrap:admin`, exactly like `db:migrate`, `reconcile` and
 * `jml:lifecycle` — a local script that connects directly to the database,
 * not a request the API ever serves. Takes already-constructed repository
 * instances rather than resolving them itself (mirrors
 * scripts/smoke-dev.ts's `seedActor`), which is also what makes this
 * function trivial to unit-test against a real Testcontainers Postgres
 * without booting the Nest application at all.
 *
 * IDEMPOTENT by construction, not by accident: every step below checks
 * "does this already exist / already hold this?" before writing, and the one
 * write that has a unique-constraint to violate (the role grant) is ALSO
 * guarded by a pre-check so a normal repeated run never even attempts the
 * insert `RoleAssignmentsRepository.assign` would otherwise 409 on — the
 * try/catch around it is belt-and-braces for a genuine concurrent race (two
 * `bootstrap-admin` runs at once), not the primary mechanism. Running this
 * twice in a row must succeed both times and leave exactly one user, one
 * grant, and no duplicate org unit.
 */

export interface BootstrapAdminDeps {
  users: UsersRepository
  orgUnits: OrgUnitsRepository
  roleAssignments: RoleAssignmentsRepository
}

/** One line of what this run did — or found already true — for CLI reporting. */
export interface BootstrapAdminStep {
  message: string
  /** `true` if this run performed a write; `false` if the state already matched. */
  changed: boolean
}

export interface BootstrapAdminResult {
  username: string
  userId: string
  orgUnitId: string
  steps: BootstrapAdminStep[]
}

export const DEFAULT_BOOTSTRAP_USERNAME = 'admin@example.com'

// Matches the seeded dev Keycloak user's own profile (see
// keycloak/realm-import/identity-manager-realm.dev.json's "admin@example.com"
// entry: firstName "Platform", lastName "Admin") when bootstrapping the
// default user, and is a reasonable, obviously-a-placeholder default for any
// other username — this script's whole job is to grant ACCESS, not to know
// someone's real name. Both fields are editable afterward through the
// ordinary `PATCH /users/:id` route once the bootstrapped admin can reach it.
const DEFAULT_FIRST_NAME = 'Platform'
const DEFAULT_LAST_NAME = 'Admin'

const DEFAULT_ORG_UNIT_NAME = 'Organization'

const GLOBAL_SUPER_ADMIN: RoleKey = 'super_admin'

export async function bootstrapAdmin(
  deps: BootstrapAdminDeps,
  username: string = DEFAULT_BOOTSTRAP_USERNAME,
): Promise<BootstrapAdminResult> {
  const steps: BootstrapAdminStep[] = []

  // 1. Ensure SOME org unit exists IN MASTER — needed only as the FK target
  // if step 2 below ends up creating a brand new user; reused as-is (see
  // OrgUnitsRepository.findFirst's own doc comment) rather than always
  // minting a fresh root, so re-running this against a database that
  // already has one never scatters extra roots.
  //
  // Master, not "any org unit": `UsersRepository.create` derives
  // `organization_id` from the org unit, and `PermissionEngine.resolveActor`
  // only ever resolves principals within master — so a tenant's org unit
  // here would produce a recovery admin nobody can authenticate as. Both
  // calls below mean master (`createRoot`'s organization argument is omitted
  // precisely because omitting it means master; see its doc comment).
  let orgUnit = await deps.orgUnits.findFirst()
  if (orgUnit === null) {
    orgUnit = await deps.orgUnits.createRoot(DEFAULT_ORG_UNIT_NAME)
    steps.push({ message: `created root org unit "${DEFAULT_ORG_UNIT_NAME}" (none existed)`, changed: true })
  } else {
    steps.push({ message: `using existing org unit "${orgUnit.name}"`, changed: false })
  }

  // 2. Find-or-create the local user — matched EXACTLY the way
  // `PermissionEngine.resolveActor` matches an authenticated principal:
  // case-insensitively on `username`, within the master organization, never
  // on `primaryEmail` (see UsersRepository.findByUsername's own doc comment
  // for why the two must not be confused, and for why an unscoped match here
  // would let this script activate and globally privilege a TENANT's
  // identically-named row).
  let user = await deps.users.findByUsername(username)
  if (user === null) {
    // Keycloak usernames in this realm are email addresses
    // (loginWithEmailAllowed, and the seeded dev user IS one) — reusing the
    // username as primaryEmail when it looks like one is what a human
    // operator would do by hand. A username that ISN'T an email gets a
    // synthetic address on the `.invalid` TLD (RFC 2606 — guaranteed never a
    // real, resolvable domain), the same convention scripts/smoke-dev.ts
    // already uses for exactly this reason.
    const primaryEmail = username.includes('@') ? username : `${username}@local.invalid`
    try {
      user = await deps.users.create({
        primaryEmail,
        username,
        firstName: DEFAULT_FIRST_NAME,
        lastName: DEFAULT_LAST_NAME,
        orgUnitId: orgUnit.id,
      })
    } catch (cause) {
      // The one write in this function with a REALISTIC chance of a
      // pre-existing collision: some other, unrelated user already holds
      // this exact email under a different username (see
      // scripts/smoke-dev.ts's own doc comment on its seedActor — the
      // reviewer's Finding 2 scenario this mirrors). Surfacing it as a
      // clear, actionable error is the whole point of this script existing
      // — a raw 23505 stack trace here would be exactly the failure mode
      // this task exists to eliminate.
      if (cause instanceof ConflictError) {
        throw new Error(
          `cannot bootstrap "${username}": ${cause.message}. Resolve the conflicting record first (or choose a different username), then re-run \`pnpm run bootstrap:admin\`.`,
        )
      }
      throw cause
    }
    steps.push({ message: `created local user for "${username}"`, changed: true })
  } else {
    steps.push({ message: `using existing local user for "${username}"`, changed: false })
  }

  // 3. Activate. `resolveActor` denies anything but `status: 'active'`, and
  // `UsersRepository.create` defaults new rows to `pending` — so even the
  // just-created branch above still needs this step.
  //
  // `deactivated` is TERMINAL (UsersRepository.changeStatus's own doc
  // comment: "there is no route to remove a user... deactivated is
  // terminal") — a deliberate system invariant, not an oversight. Bootstrap
  // is a powerful script by necessity, but it must not become the back door
  // that undoes a deliberate terminal state; it fails loudly here instead.
  const statusBeforeActivation = user.status
  if (statusBeforeActivation === 'deactivated') {
    throw new Error(
      `the local user for "${username}" is deactivated, and deactivated is terminal — bootstrap-admin will not reactivate it. Create a new user (with a different username) instead.`,
    )
  }
  if (statusBeforeActivation !== 'active') {
    user = await deps.users.changeStatus(user.id, 'active')
    steps.push({ message: `activated "${username}" (was ${statusBeforeActivation})`, changed: true })
  } else {
    steps.push({ message: `"${username}" is already active`, changed: false })
  }

  // 4. Grant global super_admin — global (`scopeOrgUnitId: null`), not
  // scoped: this is the recovery account for a system with nobody in it
  // yet, so anything less than every permission everywhere would just trade
  // one lockout for a narrower one.
  const existingAssignments = await deps.roleAssignments.listForUser(user.id)
  const alreadyGlobalSuperAdmin = existingAssignments.some(
    (assignment) => assignment.roleKey === GLOBAL_SUPER_ADMIN && assignment.scopeOrgUnitId === null,
  )

  if (alreadyGlobalSuperAdmin) {
    steps.push({ message: `"${username}" already holds global super_admin`, changed: false })
  } else {
    try {
      await deps.roleAssignments.assign({ userId: user.id, roleKey: GLOBAL_SUPER_ADMIN })
      steps.push({ message: `granted global super_admin to "${username}"`, changed: true })
    } catch (cause) {
      // Belt-and-braces for a genuine concurrent race (two bootstrap runs
      // overlapping) — the pre-check above is what makes an ORDINARY
      // repeated run idempotent without ever reaching this catch at all.
      if (cause instanceof ConflictError) {
        steps.push({ message: `"${username}" already holds global super_admin (granted concurrently)`, changed: false })
      } else {
        throw cause
      }
    }
  }

  return { username, userId: user.id, orgUnitId: orgUnit.id, steps }
}
