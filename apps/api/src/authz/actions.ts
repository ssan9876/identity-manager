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
  | 'user:activate'
  | 'user:deactivate'
  | 'group:read'
  | 'group:create'
  | 'group:update'
  | 'group:manage_members'
  | 'org_unit:read'
  | 'org_unit:create'
  | 'role:assign'
  | 'audit:read'
  | 'connector:read'
  | 'connector:manage'
  | 'sso_app:read'
  | 'sso_app:manage'

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
  'user:activate',
  'user:deactivate',
  'group:read',
  'group:create',
  'group:update',
  'group:manage_members',
  'org_unit:read',
  'org_unit:create',
  'role:assign',
  'audit:read',
  'connector:read',
  'connector:manage',
  // SSO applications. GLOBAL GRANT ONLY -- an application has no
  // containing org unit, so there is nothing to narrow a scoped grant to;
  // same rule as the audit log, dead letters and connector targets.
  'sso_app:read',
  'sso_app:manage',
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
 * finding, which is what closed this.
 *
 * Round 2 shipped this as `Object.assign(Object.create(null), {...}) as
 * Record<RoleKey, ...>` — a REGRESSION found in round 3. `Object.create`'s
 * return type is `any`, so `Object.assign(any, {...})` collapses to `any`
 * too, and a trailing `as` on an `any` expression is not a structural
 * check at all — it succeeds unconditionally, so a typo'd action, a
 * dropped role, an EXTRA role, or a wrong-typed rank all compiled clean.
 * Fixed two ways together: (1) the `Object.create(null)` call itself is
 * cast — `Object.create(null) as Record<RoleKey, ...>` — an assertion on a
 * value already known at runtime to be an empty, prototype-less object,
 * not a claim about a literal's shape; (2) the object LITERAL passed to
 * `Object.assign` carries `satisfies Record<RoleKey, ...>`, which DOES
 * structurally check the literal (missing keys, extra keys, wrong value
 * types) while still preserving its own precise inferred type for the
 * `Object.assign` call. It is the `satisfies` clause on the literal —
 * not the runtime `Object.assign` call, and not any cast on the overall
 * expression, because there no longer is one — that guarantees the shape.
 *
 * One behaviour change from an ordinary object literal: `String(ROLE_RANK)`
 * (or `` `${ROLE_RANK}` ``) now throws `TypeError: Cannot convert object to
 * primitive value`, because a null-prototype object has no inherited
 * `toString`/`valueOf` for `ToPrimitive` to fall back on. Latent today —
 * nothing in this codebase interpolates a catalog — but worth knowing
 * before adding logging/debugging code that does.
 */
export const ROLE_PERMISSIONS: Record<RoleKey, readonly Action[]> = Object.assign(
  Object.create(null) as Record<RoleKey, readonly Action[]>,
  {
    super_admin: [...ALL_ACTIONS],
    user_admin: [
      'user:read',
      'user:create',
      'user:update',
      'user:activate',
      'user:deactivate',
      'group:read',
      'group:create',
      'group:update',
      'group:manage_members',
      'org_unit:read',
    ],
    help_desk: ['user:read', 'user:update', 'group:read', 'org_unit:read'],
    // Milestone 14, Task 9 — connector admin console. `connector:read` joins
    // `audit:read` here for the identical reason it was already granted:
    // per-target health and dead letters are the same category of
    // operational/security visibility this role exists to see ("what
    // happened, what is broken" — OutboxController's own doc comment).
    // `connector:manage` (editing target config, attribute mappings, and
    // triggering a reconcile — including a dry run, which still makes a
    // real outbound call to whatever the target is) is DELIBERATELY not
    // granted here, mirroring `role:assign`'s own "only super_admin"
    // posture: both are structural, directory-wide capabilities with
    // outsized blast radius if misused, not ordinary read/write directory
    // work.
    auditor: [...READ_ONLY_ACTIONS, 'audit:read', 'connector:read'],
    read_only: READ_ONLY_ACTIONS,
  } satisfies Record<RoleKey, readonly Action[]>,
)

/**
 * Higher outranks lower. Used only by the privilege-escalation guards.
 * Null-prototype, for the same reason as ROLE_PERMISSIONS above — see its
 * doc comment, including the round-2 `as`-cast-on-`any` regression that
 * round 3 fixed (typed `Object.create(null)` target + `satisfies` on the
 * literal, no cast on the overall expression).
 */
export const ROLE_RANK: Record<RoleKey, number> = Object.assign(
  Object.create(null) as Record<RoleKey, number>,
  {
    super_admin: 40,
    user_admin: 30,
    help_desk: 20,
    auditor: 10,
    read_only: 0,
  } satisfies Record<RoleKey, number>,
)
