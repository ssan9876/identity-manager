import type { ReactElement } from 'react'
import type { Action } from './permissions'

/**
 * Nav sections. Eight flat links read as a list of features; three named
 * groups read as a product with a shape — who exists, what they can reach,
 * and how the machine is running. Purely presentational: the groups carry
 * no permissions of their own, and a group whose every item is filtered
 * out by `GET /self/permissions` renders nothing at all (AppShell's
 * NavList drops it), so an auditor never sees an empty "Directory"
 * heading hinting at links they cannot use.
 */
export type NavGroup = 'directory' | 'access' | 'operations'

export const NAV_GROUP_LABELS: Record<NavGroup, string> = {
  directory: 'Directory',
  access: 'Access',
  operations: 'Operations',
}

/** Render order for the groups above. */
export const NAV_GROUP_ORDER: NavGroup[] = ['directory', 'access', 'operations']

export interface NavItem {
  key: string
  label: string
  path: string
  group: NavGroup
  /**
   * The action that gates this item's visibility. There is no dedicated
   * "read" action for roles/imports/audit in today's static catalog
   * (apps/api/src/authz/actions.ts) — each maps to the closest action that
   * implies the caller should see that area at all: `role:assign` (only
   * super_admin holds it — nobody else can act on roles anyway), `user:create`
   * (bulk import creates/updates users), `audit:read` (the auditor role's
   * whole purpose, per docs/product-brief.md).
   */
  action: Action
  icon: (props: { className?: string }) => ReactElement
}

function iconProps(className: string | undefined) {
  return {
    className,
    viewBox: '0 0 20 20',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
}

function PeopleIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <circle cx="7.5" cy="6.5" r="2.5" />
      <path d="M2.5 16c0-2.9 2.24-4.5 5-4.5s5 1.6 5 4.5" />
      <circle cx="14" cy="7.5" r="2" />
      <path d="M13 11.5c2.1.2 3.5 1.7 3.5 4.5" />
    </svg>
  )
}

function GroupsIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <rect x="2.5" y="2.5" width="6" height="6" rx="1" />
      <rect x="11.5" y="2.5" width="6" height="6" rx="1" />
      <rect x="7" y="11.5" width="6" height="6" rx="1" />
    </svg>
  )
}

function OrgUnitsIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <path d="M10 3v5M10 8H5.5a1 1 0 0 0-1 1v3M10 8h4.5a1 1 0 0 1 1 1v3" />
      <circle cx="10" cy="2.5" r="1.75" />
      <circle cx="4.5" cy="15" r="1.75" />
      <circle cx="15.5" cy="15" r="1.75" />
    </svg>
  )
}

function RolesIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <path d="M10 2.5 16 5v4.5c0 4-2.6 6.6-6 8-3.4-1.4-6-4-6-8V5l6-2.5Z" />
      <path d="M7.3 9.7 9 11.4l3.7-3.7" />
    </svg>
  )
}

/** A rule and what falls under it — a bracket over two rows, the shape of "everyone this describes gets this". Deliberately unlike RolesIcon's shield: admin roles are authority, business roles are a formula. */
function BusinessRolesIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <path d="M3 4.5h5l1.5 2H17" />
      <rect x="3" y="4.5" width="14" height="11" rx="1.5" />
      <path d="M6.5 10h7M6.5 12.75h4" />
    </svg>
  )
}

function ImportIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <path d="M10 2.5v9.5M6.5 8.5 10 12l3.5-3.5" />
      <path d="M3 13.5v2A1.5 1.5 0 0 0 4.5 17h11a1.5 1.5 0 0 0 1.5-1.5v-2" />
    </svg>
  )
}

function AuditIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <circle cx="8.5" cy="8.5" r="5" />
      <path d="M12.3 12.3 17 17" />
    </svg>
  )
}

/** Two nodes and a directional edge — this app pushing mastered identity outward to a directory backend (docs/product-brief.md's own sub-project framing), the same idea Milestone 14's console makes configurable and inspectable. */
function ConnectorsIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <circle cx="5" cy="6" r="2.5" />
      <circle cx="15" cy="14" r="2.5" />
      <path d="M7 7.3 12.6 12.2" />
      <path d="M10.2 12.2h2.7v-2.7" />
    </svg>
  )
}

function ApplicationsIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <rect x="2.5" y="4" width="15" height="12" rx="2" />
      <path d="M2.5 8h15" />
      <circle cx="5" cy="6" r="0.5" fill="currentColor" />
      <path d="M7 12h6" />
    </svg>
  )
}

/** A ring of separate enclosures around one centre — many tenants, one platform. Deliberately unlike OrgUnitsIcon's tree: org units are a hierarchy INSIDE one organization, organizations are peers. */
function OrganizationsIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <rect x="2.5" y="2.5" width="6" height="6" rx="1.5" />
      <rect x="11.5" y="2.5" width="6" height="6" rx="1.5" />
      <rect x="2.5" y="11.5" width="6" height="6" rx="1.5" />
      <rect x="11.5" y="11.5" width="6" height="6" rx="1.5" />
    </svg>
  )
}

export const NAV_ITEMS: NavItem[] = [
  { key: 'people', label: 'People', path: '/people', group: 'directory', action: 'user:read', icon: PeopleIcon },
  { key: 'groups', label: 'Groups', path: '/groups', group: 'directory', action: 'group:read', icon: GroupsIcon },
  { key: 'org-units', label: 'Org units', path: '/org-units', group: 'directory', action: 'org_unit:read', icon: OrgUnitsIcon },
  // Relabelled from "Roles" (Milestone 17, Task 17). Label ONLY — the
  // path, route and component are untouched. Two entries both reading
  // "Roles" would be genuinely ambiguous, and the business-roles entry
  // below is what creates that ambiguity, so fixing it belongs here.
  { key: 'roles', label: 'Admin roles', path: '/roles', group: 'access', action: 'role:assign', icon: RolesIcon },
  // `business_role:read` is held by user_admin/auditor/read_only, so the
  // catalogue is visible to everyone who can meaningfully read access;
  // every mutating control inside is gated separately on
  // `business_role:manage`, which is super_admin's alone.
  {
    key: 'business-roles',
    label: 'Business roles',
    path: '/business-roles',
    group: 'access',
    action: 'business_role:read',
    icon: BusinessRolesIcon,
  },
  { key: 'import', label: 'Import', path: '/import', group: 'operations', action: 'user:create', icon: ImportIcon },
  { key: 'audit', label: 'Audit', path: '/audit', group: 'operations', action: 'audit:read', icon: AuditIcon },
  // Milestone 14, Task 9 — the connector admin console. `connector:read`
  // gates visibility exactly like every other item here: super_admin and
  // auditor see it, nobody else does (authz/actions.ts).
  { key: 'connectors', label: 'Connectors', path: '/connectors', group: 'operations', action: 'connector:read', icon: ConnectorsIcon },
  // Organizations milestone, Task 15 — the tenant roster. In `operations`
  // rather than `directory`: an organization is not a thing you look people
  // up in, it is a thing the platform operator provisions and suspends,
  // which is what that group already collects. `organization:read` is
  // super_admin's alone (authz/actions.ts), so this item is invisible to
  // every other role — including the auditor, unlike Connectors above.
  {
    key: 'organizations',
    label: 'Organizations',
    path: '/organizations',
    group: 'operations',
    action: 'organization:read',
    icon: OrganizationsIcon,
  },
  // SSO applications. `sso_app:read` is held by super_admin ALONE — not
  // auditor, unlike connectors — so this item is invisible to everyone
  // else, matching who can actually act on it.
  { key: 'applications', label: 'Applications', path: '/applications', group: 'access', action: 'sso_app:read', icon: ApplicationsIcon },
]
