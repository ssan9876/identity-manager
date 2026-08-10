import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common'
import { asc, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { AttributeTargetMappingsRepository } from '../attributes/attribute-target-mappings.repository'
import { JwtGuard } from '../auth/jwt.guard'
import { PermissionGuard } from '../authz/permission.guard'
import { RequirePermission } from '../authz/require-permission.decorator'
import { DB_CLIENT } from '../common/db.token'
import { NotFoundError } from '../common/errors'
import { parseId } from '../common/http/parse-id'
import { connectorTargets } from '../db/schema/connector-targets'
import { hrSources, type HrSource } from '../db/schema/hr-sources'
import * as schema from '../db/schema/index'
import type { Organization } from '../db/schema/organizations'
import { provisioningMode } from '../db/schema/user-target-accounts'
import { OrganizationsRepository } from '../organizations/organizations.repository'
import { ALL_CONNECTOR_TARGETS, DIRECTORY_TARGETS, type ConnectorTarget } from './connector'
import { ConnectorTargetsRepository } from './connector-targets.repository'

/** Derived from the pgEnum rather than re-typed, so the two cannot drift — the same rule `ALL_CONNECTOR_TARGETS` follows. */
type ProvisioningMode = (typeof provisioningMode.enumValues)[number]

/**
 * "What of ours goes where" — one read-only map of this organization's whole
 * data flow, inbound and outbound, in a single response.
 *
 * Every fact here ALREADY EXISTS and this endpoint stores nothing new: HR
 * sources are the inbound edges, `connector_targets` the outbound ones, and
 * `attribute_target_mappings` is what rides each outbound edge. What was
 * missing was any one place that shows them together — the connectors page
 * answers "is Entra healthy", the attributes page answers "where does
 * `costCentre` go", and neither answers "what leaves this system, and to
 * whom".
 *
 * DELIBERATELY NO LIVE HEALTH CHECK. `ConnectorTargetsController.list`
 * already calls `connector.health()` per target and is the right place for
 * "is it reachable right now". Doing it here too would mean thirteen outbound
 * HTTP calls on every page load of a screen whose question is structural, not
 * operational — and would make a map of the estate unavailable exactly when
 * part of the estate is down, which is when someone most wants to look at it.
 * `enabled`, `configured` and `lastSuccessfulSyncAt` are all read from
 * Postgres and are enough to distinguish a live edge from a dormant one.
 *
 * NO TRANSACTION, deliberately: there is nothing to make atomic, and holding
 * one open across these reads would be the shape of finding C1.
 *
 * NO SECRETS. `connector_targets.config` can hold a secret NAME but never a
 * value (that table's own doc comment), and this endpoint does not return
 * `config` at all — only the derived shape below.
 */

/** One inbound edge: an HR feed this system pulls FROM. */
export interface DataFlowInbound {
  id: string
  name: string
  kind: HrSource['kind']
  enabled: boolean
  /** The feed's own host, not the full URL — enough to identify the upstream on a diagram without turning the page into a list of long query strings. */
  host: string
  lastRunOutcome: HrSource['lastRunOutcome']
  lastRunFinishedAt: Date | null
  /**
   * The import-pipeline columns this source populates — i.e. the VALUES of
   * its column mapping, which is the closed statement of what crosses the
   * boundary (`applyColumnMapping`'s own doc comment). Sorted so the map
   * renders stably rather than in jsonb key order.
   */
  populatesColumns: string[]
}

/** One attribute riding an outbound edge. */
export interface DataFlowAttribute {
  localKey: string
  label: string | null
  source: 'custom' | 'core'
  remoteName: string
  /** A DISABLED mapping is shown rather than hidden: "this used to flow and no longer does" is exactly the question this screen exists to answer, and `SyncWorker` actively CLEARS such a name on partial-update targets. */
  enabled: boolean
}

/** One outbound edge: a target this system pushes TO. */
export interface DataFlowOutbound {
  target: ConnectorTarget
  configured: boolean
  enabled: boolean
  provisioningMode: ProvisioningMode
  lastSuccessfulSyncAt: Date | null
  /** False for `keycloak_sso`, which carries applications rather than people — see `DIRECTORY_TARGETS`. */
  carriesUsers: boolean
  attributes: DataFlowAttribute[]
}

export interface DataFlowMap {
  organizationId: string
  organizationName: string
  inbound: DataFlowInbound[]
  outbound: DataFlowOutbound[]
}

@Controller('data-flows')
@UseGuards(JwtGuard, PermissionGuard)
export class DataFlowsController {
  constructor(
    @Inject(ConnectorTargetsRepository) private readonly targets: ConnectorTargetsRepository,
    @Inject(AttributeTargetMappingsRepository) private readonly mappings: AttributeTargetMappingsRepository,
    @Inject(OrganizationsRepository) private readonly organizations: OrganizationsRepository,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Read-only, and guarded by `connector:read` rather than a new action:
   * every fact returned is already readable through the connector-targets and
   * attribute-mapping routes that action covers, so a separate permission
   * would imply a boundary that does not exist.
   */
  @Get()
  @RequirePermission('connector:read')
  async map(@Query() query: Record<string, unknown>): Promise<DataFlowMap> {
    const organization = await this.resolveOrganization(query.organizationId)

    const [inbound, outbound] = await Promise.all([
      this.inboundFor(organization.id),
      this.outboundFor(organization.id),
    ])

    return {
      organizationId: organization.id,
      organizationName: organization.name,
      inbound,
      outbound,
    }
  }

  /**
   * Same optional-`?organizationId=` contract as every route on
   * `ConnectorTargetsController` — omitted means MASTER, and a named
   * organization must exist (404 otherwise).
   *
   * A `connector:read` holder may read ANY organization's map, including one
   * outside their org-unit scope. That is deliberate, and it matches
   * `ConnectorTargetsController.list` exactly: the global-grant assertion
   * that controller enforces (`requireGlobalManageGrant`) covers
   * `connector:manage` — the MUTATING half — and reads have never been
   * org-scoped there. Making this one endpoint stricter would be a different
   * authorization model for a view that exposes strictly LESS than the list
   * route it draws from (no `config`, so not even a secret NAME), which
   * would be surprising rather than safer. If connector reads should become
   * org-scoped, that is one change across both controllers, not a special
   * case here.
   */
  private async resolveOrganization(raw: unknown): Promise<Organization> {
    if (raw === undefined) {
      return this.organizations.findMaster()
    }
    const id = parseId(raw, 'organizationId')
    const organization = await this.organizations.findById(id)
    if (organization === null) {
      throw new NotFoundError('organization', id)
    }
    return organization
  }

  private async inboundFor(organizationId: string): Promise<DataFlowInbound[]> {
    const rows = await this.db
      .select()
      .from(hrSources)
      .where(eq(hrSources.organizationId, organizationId))
      .orderBy(asc(hrSources.name))

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      enabled: row.enabled,
      host: hostOf(row.url),
      lastRunOutcome: row.lastRunOutcome,
      lastRunFinishedAt: row.lastRunFinishedAt,
      populatesColumns: [...new Set(Object.values(row.columnMapping))].sort(),
    }))
  }

  private async outboundFor(organizationId: string): Promise<DataFlowOutbound[]> {
    // `listAll` gives configured/enabled per target; `provisioning_mode` is
    // not on `ConnectorTargetRow`, so it is read here rather than by widening
    // a type several other call sites depend on.
    const [configured, modes, mappingRows] = await Promise.all([
      this.targets.listAll(organizationId),
      this.provisioningModes(organizationId),
      this.mappings.listAllRows(),
    ])

    const byTarget = new Map<ConnectorTarget, DataFlowAttribute[]>()
    for (const row of mappingRows) {
      const list = byTarget.get(row.target) ?? []
      list.push({
        localKey: row.localKey,
        label: row.label,
        source: row.source,
        remoteName: row.remoteName,
        enabled: row.enabled,
      })
      byTarget.set(row.target, list)
    }

    const directory = new Set<ConnectorTarget>(DIRECTORY_TARGETS)

    return Promise.all(
      ALL_CONNECTOR_TARGETS.map(async (target) => {
        const row = configured.get(target)
        return {
          target,
          configured: row?.configured ?? false,
          enabled: row?.enabled ?? false,
          provisioningMode: modes.get(target) ?? 'all_users',
          lastSuccessfulSyncAt: await this.targets.lastSuccessfulSyncAt(organizationId, target),
          carriesUsers: directory.has(target),
          attributes: byTarget.get(target) ?? [],
        }
      }),
    )
  }

  private async provisioningModes(organizationId: string): Promise<Map<ConnectorTarget, ProvisioningMode>> {
    const rows = await this.db
      .select({ target: connectorTargets.target, provisioningMode: connectorTargets.provisioningMode })
      .from(connectorTargets)
      .where(eq(connectorTargets.organizationId, organizationId))
    return new Map(rows.map((row) => [row.target, row.provisioningMode]))
  }
}

/** The feed's host, or the raw string when it will not parse — never throws, because a display field must not be able to fail a whole page. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
