import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import { AuditWriter } from '../audit/audit.writer'
import { JwtGuard } from '../auth/jwt.guard'
import type { Action } from '../authz/actions'
import { PermissionEngine } from '../authz/permission.engine'
import { PermissionGuard, type AuthorizedRequest } from '../authz/permission.guard'
import { RequirePermission } from '../authz/require-permission.decorator'
import { DB_CLIENT } from '../common/db.token'
import { ConflictError, ForbiddenError, NotConfiguredError, NotFoundError } from '../common/errors'
import { parseBody } from '../common/http/parse-body'
import { parseId } from '../common/http/parse-id'
import { noNulChar } from '../common/http/safe-string'
import { type Page, parsePageQuery } from '../common/pagination'
import * as schema from '../db/schema/index'
import type { Organization } from '../db/schema/organizations'
import { KeycloakAdminClientFactory } from '../keycloak/keycloak-admin-client.factory'
import { OrgUnitsRepository } from '../org-units/org-units.repository'
import { OutboxWriter } from '../outbox/outbox.writer'
import { OrganizationsRepository } from './organizations.repository'

/**
 * Slugs this API refuses regardless of what is already in the database.
 *
 * `master` is Keycloak's OWN administrative realm — the one every
 * provisioning credential authenticates against — and it exists in every
 * Keycloak installation whether or not this system knows about it. Creating
 * an organization named `master` would produce a row whose `realm` names a
 * realm we must never touch, and `OrganizationConnector` would (correctly)
 * refuse every call for it forever, leaving a permanently unprovisionable
 * tenant. Rejecting it up front is the same "refuse rather than accept a row
 * that can never provision" rule the NOT_CONFIGURED check below applies.
 *
 * NOT a substitute for the separate check against the master ORGANIZATION's
 * own realm below: this deployment's master realm is whatever
 * `KEYCLOAK_ISSUER` names (`identity-manager` in the shipped realm import),
 * which is usually NOT literally `master`. Both checks are needed, and
 * neither implies the other.
 */
const RESERVED_SLUGS = new Set(['master'])

// The pattern is IDENTICAL to the `organizations_slug_format` CHECK
// constraint (db/schema/organizations.ts) — a DNS label, which is what
// Keycloak accepts as a realm name and what will appear in every issuer URL
// this tenant's people authenticate against. Duplicated deliberately rather
// than derived: the CHECK is the last line of defence and must hold no
// matter what reaches the database, while this one exists to turn a bad
// slug into a 400 with a readable message instead of a 500 from a constraint
// violation. If they ever drift, the repository's own
// `translateWriteError` doc comment records that the CHECK violation is
// deliberately left as a 500, precisely so the drift is loud.
const createOrganizationBodySchema = z
  .object({
    slug: noNulChar(z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/)),
    name: noNulChar(z.string().min(1).max(255)),
  })
  .strict()

// `.strict()` is what turns an attempt to PATCH `slug` into a 400 rather
// than a silently-ignored field: a slug becomes a Keycloak realm name, and
// every `external_identities` row for every person in the tenant points into
// that realm, so accepting-and-ignoring would be the worst of both answers.
const updateOrganizationBodySchema = z
  .object({ status: z.enum(['active', 'suspended']) })
  .strict()

/**
 * Builds an audit `before`/`after` payload from explicitly named fields —
 * never `{ ...org }`. Same reasoning as UsersController's snapshotUser: a
 * spread would silently carry forward any column added to `organizations`
 * later into an append-only log a leak can never be removed from.
 */
function snapshotOrganization(org: Organization): Record<string, unknown> {
  return { slug: org.slug, name: org.name, realm: org.realm, status: org.status }
}

/**
 * The tenant lifecycle: create, list, suspend, reactivate. Organizations
 * milestone, Task 12.
 *
 * THERE IS NO DELETE, here or anywhere else in this API. Deleting an
 * organization would mean deleting its Keycloak realm, which destroys every
 * user, session, client and credential inside it irreversibly — see
 * `OrganizationConnector.setRealmEnabled`'s own doc comment for the same
 * rule stated at the connector level. A retired tenant is `suspended`,
 * exactly as a terminated person is `deactivated`.
 *
 * GLOBAL GRANT ONLY on all three routes. An organization has no containing
 * org unit — it is the thing org units hang off — so a scoped grant has
 * nothing to narrow to; the same rule already governs the audit log, dead
 * letters, connector targets, SSO applications and business roles.
 */
@Controller('organizations')
@UseGuards(JwtGuard, PermissionGuard)
export class OrganizationsController {
  constructor(
    @Inject(OrganizationsRepository) private readonly organizations: OrganizationsRepository,
    @Inject(OrgUnitsRepository) private readonly orgUnits: OrgUnitsRepository,
    @Inject(PermissionEngine) private readonly engine: PermissionEngine,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
    @Inject(OutboxWriter) private readonly outboxWriter: OutboxWriter,
    @Inject(KeycloakAdminClientFactory) private readonly factory: KeycloakAdminClientFactory,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * See this class's own doc comment. A caller holding `organization:create`
   * only within some org unit is rejected rather than silently treated as
   * global — the identical shape `SsoAppsController.requireGlobalGrant` and
   * `BusinessRolesController` already use, and the reason both exist.
   */
  private async requireGlobalGrant(request: AuthorizedRequest, action: Action): Promise<void> {
    const scopePaths = await this.engine.scopePathsFor(request.actor, action)
    if (scopePaths !== null) {
      throw new ForbiddenError(
        `${action} requires a global grant — an organization belongs to no org unit, ` +
          'so there is nothing for a scoped grant to narrow to',
      )
    }
  }

  @Post()
  @RequirePermission('organization:create')
  async create(@Body() body: unknown, @Req() request: AuthorizedRequest): Promise<Organization> {
    await this.requireGlobalGrant(request, 'organization:create')
    const input = parseBody(createOrganizationBodySchema, body)

    // Refuse up front rather than accepting a row that can never provision.
    // Without this the insert succeeds, the outbox event is written, and the
    // worker then burns the full retry schedule before dead-lettering — an
    // organization stuck "provisioning" forever, and an operator with a
    // dead-letter to decode instead of an answer.
    if (!this.factory.hasProvisioningCredentials()) {
      throw new NotConfiguredError(
        'creating an organization requires KEYCLOAK_PROVISION_CLIENT_ID and ' +
          'KEYCLOAK_PROVISION_CLIENT_SECRET, which are not configured',
      )
    }

    const master = await this.organizations.findMaster()
    if (RESERVED_SLUGS.has(input.slug) || input.slug === master.realm || input.slug === master.slug) {
      throw new ConflictError(`the slug "${input.slug}" is reserved`)
    }

    return this.db.transaction(async (tx) => {
      // slug === realm, always and by construction. Keeping them one value
      // is what makes the realm name predictable from the API surface
      // (`/realms/acme`), and what lets the slug's own format check double as
      // the realm-name check — see createOrganizationBodySchema above.
      const organization = await this.organizations.create(tx, {
        slug: input.slug,
        name: input.name,
        realm: input.slug,
      })

      // Exactly one root org unit per organization (design decision 6), and
      // creating the organization is the ONLY thing that creates one —
      // `POST /org-units` requires a `parentId` precisely so no second route
      // can make a second root. See OrgUnitsController.create's doc comment.
      await this.orgUnits.createRoot(input.name, tx, organization.id)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'organization:create',
        resourceType: 'organization',
        resourceId: organization.id,
        before: null,
        after: snapshotOrganization(organization),
      })

      await this.outboxWriter.record(tx, {
        aggregateType: 'organization',
        aggregateId: organization.id,
        eventType: 'created',
        // An organization IS its own tenant, so this event takes the
        // Keycloak-only fan-out path Task 13 installs — `OutboxWriter`
        // derives that from the row itself, so nothing is passed here.
        // Sending it anywhere else would ask Active Directory or Google to
        // create a Keycloak realm, which they have no concept of.
        payload: { slug: organization.slug, realm: organization.realm },
      })

      return organization
    })
  }

  @Get()
  @RequirePermission('organization:read')
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: AuthorizedRequest,
  ): Promise<Page<Organization>> {
    await this.requireGlobalGrant(request, 'organization:read')
    const page = parsePageQuery(query)
    const [items, total] = await Promise.all([
      this.organizations.list(page),
      this.organizations.count(),
    ])
    return { items, total, limit: page.limit, offset: page.offset }
  }

  @Patch(':id')
  @RequirePermission('organization:update')
  async update(
    @Param('id') rawId: string,
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ): Promise<Organization> {
    await this.requireGlobalGrant(request, 'organization:update')
    const id = parseId(rawId)
    const input = parseBody(updateOrganizationBodySchema, body)

    return this.db.transaction(async (tx) => {
      const before = await this.organizations.findById(id, tx)
      if (before === null) {
        throw new NotFoundError('organization', id)
      }
      if (before.isMaster) {
        // Suspending master would disable the realm every admin logs in
        // through, including whoever is making this request — there would be
        // no API path back in, because there would be no way to authenticate
        // to call it. `OrganizationConnector.refuseMasterRealm` is the
        // second, connector-level half of the same refusal; this one exists
        // so the answer is a clean 409 rather than a dead-lettered event.
        //
        // Rejects `status: 'active'` on master too, not just 'suspended':
        // master is always active, so the request is either a no-op or an
        // attempt to undo something that cannot have happened.
        throw new ConflictError('the master organization cannot be suspended')
      }

      const after = await this.organizations.setStatus(tx, id, input.status)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'organization:update',
        resourceType: 'organization',
        resourceId: id,
        before: snapshotOrganization(before),
        after: snapshotOrganization(after),
      })

      await this.outboxWriter.record(tx, {
        aggregateType: 'organization',
        aggregateId: id,
        eventType: 'status_changed',
        payload: { status: after.status },
      })

      return after
    })
  }
}
