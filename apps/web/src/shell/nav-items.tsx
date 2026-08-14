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
   *
   * OPTIONAL since recertification: an item with NO action is visible to
   * every authenticated user. Exactly one item uses this — Recertification
   * — because its "My reviews" queue belongs to whoever a campaign
   * resolved as a reviewer, and reviewers are ordinary managers holding no
   * role in the catalog at all (the API's RecertReviewsController is
   * authentication-only for the same reason). The campaigns half of that
   * page still gates itself on `recert:read` internally.
   */
  action?: Action
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

function AttributesIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h8" />
      <circle cx="14.5" cy="14.5" r="2" />
    </svg>
  )
}

function LifecycleRulesIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <path d="M4 10a6 6 0 0 1 10.5-4M16 10a6 6 0 0 1-10.5 4" />
      <path d="M14.5 2.5V6H11M5.5 17.5V14H9" />
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
/** Two nodes feeding a centre node that fans out to three — the map's own shape: in, through, out. */
function DataFlowsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <circle cx="4" cy="7" r="1.6" />
      <circle cx="4" cy="17" r="1.6" />
      <circle cx="12" cy="12" r="2.2" />
      <circle cx="20" cy="6" r="1.6" />
      <circle cx="20" cy="12" r="1.6" />
      <circle cx="20" cy="18" r="1.6" />
      <path d="M5.5 7.6 10 11m-4.5 5.4L10 13m4.2-1.6h3.9m-3.6-1.3 3.6-3m-3.6 5.6 3.6 3" strokeLinecap="round" />
    </svg>
  )
}

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

/** A checked list — reviews worked through one row at a time. Deliberately unlike BusinessRolesIcon's bracket-over-rows: roles are the rule, recertification is the audit of what the rule granted. */
function RecertificationIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <rect x="3" y="2.5" width="14" height="15" rx="1.5" />
      <path d="M6.2 7.2l1.2 1.2 2.2-2.2" />
      <path d="M11.5 7.5H14" />
      <path d="M6.2 12.2l1.2 1.2 2.2-2.2" />
      <path d="M11.5 12.5H14" />
    </svg>
  )
}

/** An arrow pulling inward from an outside system into a person row — a PULL-based inbound feed, deliberately the mirror of ConnectorsIcon's outward push. */
function HrSourcesIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <rect x="2.5" y="3" width="6" height="6" rx="1" />
      <path d="M8.5 6h5.5M11.5 3.5 14 6l-2.5 2.5" />
      <circle cx="15" cy="13.5" r="2" />
      <path d="M11.5 17.5c0-1.9 1.5-3 3.5-3s3.5 1.1 3.5 3" />
    </svg>
  )
}

export const NAV_ITEMS: NavItem[] = [
  { key: 'people', label: 'People', path: '/people', group: 'directory', action: 'user:read', icon: PeopleIcon },
  { key: 'groups', label: 'Groups', path: '/groups', group: 'directory', action: 'group:read', icon: GroupsIcon },
  { key: 'org-units', label: 'Org units', path: '/org-units', group: 'directory', action: 'org_unit:read', icon: OrgUnitsIcon },
  // Milestone 8, Task 11 — the attribute catalogue. In `directory` rather
  // than `operations` because an attribute definition is part of WHO EXISTS:
  // it decides what this directory records about a person or a group, and it
  // is the People and Groups forms it shapes. Contrast Organizations, which
  // sits in `operations` precisely because a tenant is not something you look
  // people up in.
  //
  // Gated on `attribute:read`, which super_admin, user_admin, auditor and
  // read_only all hold — a user_admin filling in someone's profile needs to
  // know what attributes exist. Every mutating control inside is gated
  // separately on `attribute:manage`, which is super_admin's ALONE and which
  // the API additionally requires to be GLOBAL.
  {
    key: 'attributes',
    label: 'Attributes',
    path: '/attributes',
    group: 'directory',
    action: 'attribute:read',
    icon: AttributesIcon,
  },
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
  // NOT permission-gated — the only such item (see NavItem.action's own
  // comment): the "My reviews" queue must reach managers who hold no role
  // at all, exactly as "My Profile" does. The campaign list inside the
  // page gates itself on `recert:read`, and every mutating control on
  // `recert:manage`, which the API re-decides anyway.
  {
    key: 'recertification',
    label: 'Recertification',
    path: '/recertification',
    group: 'access',
    icon: RecertificationIcon,
  },
  { key: 'import', label: 'Import', path: '/import', group: 'operations', action: 'user:create', icon: ImportIcon },
  { key: 'audit', label: 'Audit', path: '/audit', group: 'operations', action: 'audit:read', icon: AuditIcon },
  // Milestone 14, Task 9 — the connector admin console. `connector:read`
  // gates visibility exactly like every other item here: super_admin and
  // auditor see it, nobody else does (authz/actions.ts).
  { key: 'connectors', label: 'Connectors', path: '/connectors', group: 'operations', action: 'connector:read', icon: ConnectorsIcon },
  // The data-flow map. Immediately after Connectors and before HR sources
  // because it is the OVERVIEW those two pages are the detail of, and gated
  // on the same `connector:read`: it shows strictly less than either.
  {
    key: 'data-flows',
    label: 'Data flows',
    path: '/data-flows',
    group: 'operations',
    action: 'connector:read',
    icon: DataFlowsIcon,
  },
  // HR inbound feeds — pull-based sources feeding the import pipeline.
  // Gated on `connector:read`, exactly like Connectors above: super_admin
  // and auditor see it; every mutating control inside is additionally
  // gated on a GLOBAL `connector:manage` grant by the API itself.
  // Joiner/mover/leaver automation. In `operations` beside HR sources and
  // Connectors because it is the same category of thing — machinery that acts
  // on the directory on its own — rather than a place you look people up.
  //
  // Gated on `jml:read`, held by super_admin, user_admin, auditor and
  // read_only: a rule is the only actor here that changes an account with no
  // human in the loop, so someone who cannot read the rules cannot explain a
  // change they are looking at. Every mutating control inside is gated
  // separately on `jml:manage`, which is super_admin's ALONE and which the
  // API additionally requires to be GLOBAL.
  {
    key: 'lifecycle-rules',
    label: 'Lifecycle rules',
    path: '/lifecycle-rules',
    group: 'operations',
    action: 'jml:read',
    icon: LifecycleRulesIcon,
  },
  {
    key: 'hr-sources',
    label: 'HR sources',
    path: '/hr-sources',
    group: 'operations',
    action: 'connector:read',
    icon: HrSourcesIcon,
  },
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
