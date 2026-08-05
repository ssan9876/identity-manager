export type RoleKey =
  | 'super_admin'
  | 'user_admin'
  | 'help_desk'
  | 'auditor'
  | 'read_only'

export type Action =
  | 'user:read'
  | 'user:create'
  | 'user:update'
  | 'user:deactivate'
  | 'group:read'
  | 'group:create'
  | 'group:update'
  | 'group:manage_members'
  | 'org_unit:read'
  | 'org_unit:create'
  | 'role:assign'
  | 'audit:read'

export const ALL_ROLE_KEYS: readonly RoleKey[] = [
  'super_admin',
  'user_admin',
  'help_desk',
  'auditor',
  'read_only',
]

export const ALL_ACTIONS: readonly Action[] = [
  'user:read',
  'user:create',
  'user:update',
  'user:deactivate',
  'group:read',
  'group:create',
  'group:update',
  'group:manage_members',
  'org_unit:read',
  'org_unit:create',
  'role:assign',
  'audit:read',
]

const READ_ONLY_ACTIONS: readonly Action[] = ['user:read', 'group:read', 'org_unit:read']

/**
 * The catalog is deliberately static code rather than database rows: a
 * permission table is itself a privilege-escalation surface, and these grants
 * should only change through code review.
 *
 * Built on `Object.create(null)` — no prototype chain — rather than an
 * ordinary object literal. A plain `{}` inherits `Object.prototype`, so
 * `ROLE_PERMISSIONS['constructor']`/`['toString']`/`['__proto__']`/etc. all
 * resolve to a real (inherited) value instead of `undefined`, for ANY key
 * that happens to collide with one of those names — and `role_key` is a
 * Postgres enum, so `ALTER TYPE role_key ADD VALUE 'constructor'` is
 * ordinary, valid SQL. `Object.hasOwn`/`in`/`?? fallback` guards at
 * individual call sites (see privilege.guards.ts) are only as good as every
 * present AND future call site remembering to use them; a null-prototype
 * catalog removes the hazard at its source, so an ordinary property lookup
 * on a colliding key is safely `undefined` everywhere, including call sites
 * that don't defend themselves (see PermissionEngine.grantingAssignments,
 * which relies on exactly this). This is the third time this project has
 * been bitten by prototype-chain semantics — see the Milestone 2 attribute
 * validator's two `__proto__` findings, and Task 4 fix round 2's Critical
 * finding, which is what closed this. `as Record<...>` is required because
 * `Object.create`'s return type is untyped (`any`); the object's actual
 * shape is guaranteed by the literal passed to `Object.assign`.
 */
export const ROLE_PERMISSIONS: Record<RoleKey, readonly Action[]> = Object.assign(
  Object.create(null),
  {
    super_admin: [...ALL_ACTIONS],
    user_admin: [
      'user:read',
      'user:create',
      'user:update',
      'user:deactivate',
      'group:read',
      'group:create',
      'group:update',
      'group:manage_members',
      'org_unit:read',
    ],
    help_desk: ['user:read', 'user:update', 'group:read', 'org_unit:read'],
    auditor: [...READ_ONLY_ACTIONS, 'audit:read'],
    read_only: READ_ONLY_ACTIONS,
  },
) as Record<RoleKey, readonly Action[]>

/**
 * Higher outranks lower. Used only by the privilege-escalation guards.
 * Null-prototype, for the same reason as ROLE_PERMISSIONS above — see its
 * doc comment.
 */
export const ROLE_RANK: Record<RoleKey, number> = Object.assign(Object.create(null), {
  super_admin: 40,
  user_admin: 30,
  help_desk: 20,
  auditor: 10,
  read_only: 0,
}) as Record<RoleKey, number>
