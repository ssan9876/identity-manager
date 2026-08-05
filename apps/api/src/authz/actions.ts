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
 */
export const ROLE_PERMISSIONS: Record<RoleKey, readonly Action[]> = {
  super_admin: ALL_ACTIONS,
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
}

/** Higher outranks lower. Used only by the privilege-escalation guards. */
export const ROLE_RANK: Record<RoleKey, number> = {
  super_admin: 40,
  user_admin: 30,
  help_desk: 20,
  auditor: 10,
  read_only: 0,
}
