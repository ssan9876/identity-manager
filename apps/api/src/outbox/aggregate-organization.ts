import { eq } from 'drizzle-orm'
import { groups } from '../db/schema/groups'
import { orgUnits } from '../db/schema/org-units'
import { organizations } from '../db/schema/organizations'
import { users } from '../db/schema/users'
import type { DbHandle, OutboxAggregateType } from './outbox.writer'

/**
 * WHICH ORGANIZATION does this aggregate belong to? The one implementation
 * of that question, shared by `OutboxWriter.record` (to decide which
 * organization's `connector_targets` rows govern fan-out) — per-organization
 * connector targets: `connector_targets`' identity is (organization_id,
 * target), so "which targets does this mutation reach" has no answer until
 * the aggregate's organization is known.
 *
 * Grew out of `OutboxWriter.belongsToMasterTenant`, which collapsed this
 * SAME switch to a boolean back when tenants were hard-narrowed to
 * `keycloak` because per-organization rows did not exist. The reasoning that
 * method documented carries over unchanged:
 *
 * DERIVED from the aggregate's own row, never passed in by a caller. There
 * is exactly ONE implementation of "which tenant is this", it cannot be
 * forgotten by a call site added later, and it cannot disagree with the row
 * that was actually written. A caller-supplied field would have made
 * cross-tenant fan-out — the precise failure the composite key exists to
 * prevent — a single mistyped argument away, at any call site, forever.
 *
 * The mapping is TOTAL over `ALL_OUTBOX_AGGREGATE_TYPES`, and the compiler
 * enforces that: the `switch` returns from every arm, so adding a new
 * aggregate type without classifying it here fails to compile rather than
 * silently defaulting to one answer or the other.
 *
 *  - `user`/`group`/`org_unit` carry `organization_id` themselves.
 *  - `membership` is a pure edge with no id of its own; its `aggregateId`
 *    is the PARENT GROUP's id (see GroupsController's own doc comment on
 *    that choice), so it resolves through `groups`.
 *  - `organization` resolves to MASTER, not to itself: an `organization`
 *    event is realm provisioning — a PLATFORM-level operation performed by
 *    the master deployment's own Keycloak credentials
 *    (`OrganizationConnector`), governed by the platform's own catalog, not
 *    by a catalog the tenant being provisioned has not been given yet.
 *  - `sso_app` has no `organization_id` column and deliberately never will:
 *    an SSO application is registered in the master realm and is
 *    platform-level, so it takes master's catalog.
 *
 * A MISSING ROW answers `null` — "organization unknown". The caller must
 * treat that as "configured for NOTHING" (no fan-out, empty config), never
 * as license to guess an organization: the conservative answer to "which
 * tenant's directory should this account be created in?" when the answer is
 * unknown is "none of them". It should be unreachable in practice —
 * `record` runs inside the transaction that just wrote the row it
 * describes.
 *
 * Every read goes through the CALLER's `tx` — never a second pooled
 * connection while a transaction is open (finding C1,
 * docs/archive/audits/audit-integrity.md).
 */
export async function resolveAggregateOrganizationId(
  tx: DbHandle,
  aggregateType: OutboxAggregateType,
  aggregateId: string,
): Promise<string | null> {
  switch (aggregateType) {
    case 'sso_app':
    case 'organization': {
      const [row] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.isMaster, true))
      return row?.id ?? null
    }
    case 'user': {
      const [row] = await tx
        .select({ organizationId: users.organizationId })
        .from(users)
        .where(eq(users.id, aggregateId))
      return row?.organizationId ?? null
    }
    case 'group':
    case 'membership': {
      const [row] = await tx
        .select({ organizationId: groups.organizationId })
        .from(groups)
        .where(eq(groups.id, aggregateId))
      return row?.organizationId ?? null
    }
    case 'org_unit': {
      const [row] = await tx
        .select({ organizationId: orgUnits.organizationId })
        .from(orgUnits)
        .where(eq(orgUnits.id, aggregateId))
      return row?.organizationId ?? null
    }
  }
}
