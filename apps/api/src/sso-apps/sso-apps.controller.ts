import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import { AuditWriter } from '../audit/audit.writer'
import { JwtGuard } from '../auth/jwt.guard'
import type { Action } from '../authz/actions'
import { PermissionEngine } from '../authz/permission.engine'
import { PermissionGuard, type AuthorizedRequest } from '../authz/permission.guard'
import { RequirePermission } from '../authz/require-permission.decorator'
import { DB_CLIENT } from '../common/db.token'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../common/errors'
import { parseBody } from '../common/http/parse-body'
import { ConnectorTargetsRepository } from '../connectors/connector-targets.repository'
import { KeycloakSsoConnectorFactory } from '../connectors/keycloak-sso.connector'
import * as schema from '../db/schema/index'
import { OutboxWriter } from '../outbox/outbox.writer'
import {
  clientIdProblem,
  redirectUriProblem,
  webOriginProblem,
} from './sso-app-validation'
import { SsoAppsRepository, type SsoApp } from './sso-apps.repository'

const createBodySchema = z
  .object({
    clientId: z.string().min(1).max(255),
    name: z.string().min(1).max(255),
    description: z.string().max(2000).default(''),
    publicClient: z.boolean(),
    redirectUris: z.array(z.string().min(1)).min(1),
    webOrigins: z.array(z.string().min(1)).default([]),
    groupsClaim: z.boolean().default(true),
  })
  .strict()

/**
 * No `clientId`: immutable after create, because downstream applications
 * hard-code it and Keycloak would happily rename it. No `publicClient`:
 * flipping a confidential client to public silently invalidates its secret
 * and changes its whole auth model — that is a new application, not an edit.
 * No `enabled`: enable and disable are separately-audited verb routes.
 *
 * `.strict()` on top of the omissions means sending any of them is a 400
 * NAMING the field, rather than being silently ignored — an admin who thinks
 * they renamed a clientId must not be told it worked.
 */
const patchBodySchema = createBodySchema
  .omit({ clientId: true, publicClient: true })
  .partial()
  .strict()

function snapshotSsoApp(app: SsoApp): Record<string, unknown> {
  return {
    id: app.id,
    clientId: app.clientId,
    name: app.name,
    description: app.description,
    protocol: app.protocol,
    publicClient: app.publicClient,
    redirectUris: app.redirectUris,
    webOrigins: app.webOrigins,
    groupsClaim: app.groupsClaim,
    enabled: app.enabled,
  }
}

@Controller('sso-apps')
@UseGuards(JwtGuard, PermissionGuard)
export class SsoAppsController {
  constructor(
    @Inject(SsoAppsRepository) private readonly apps: SsoAppsRepository,
    @Inject(PermissionEngine) private readonly engine: PermissionEngine,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
    @Inject(OutboxWriter) private readonly outboxWriter: OutboxWriter,
    @Inject(ConnectorTargetsRepository) private readonly targets: ConnectorTargetsRepository,
    @Inject(KeycloakSsoConnectorFactory) private readonly ssoFactory: KeycloakSsoConnectorFactory,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * An SSO application has no containing org unit, so a scoped grant has
   * nothing to narrow to — the same rule that already governs the audit log,
   * dead letters, connector targets and attribute mappings. A caller holding
   * `sso_app:manage` only within some org unit is rejected rather than
   * silently treated as global.
   */
  private async requireGlobalGrant(request: AuthorizedRequest, action: Action): Promise<void> {
    const scopePaths = await this.engine.scopePathsFor(request.actor, action)
    if (scopePaths !== null) {
      throw new ForbiddenError(
        `${action} requires a global grant — an SSO application belongs to no org unit, ` +
          'so there is nothing for a scoped grant to narrow to',
      )
    }
  }

  /**
   * Collects EVERY problem rather than throwing on the first, so an admin
   * pasting four redirect URIs learns about all four bad ones in one round
   * trip instead of across four submissions.
   */
  private assertSafeUris(redirectUris: readonly string[], webOrigins: readonly string[]): void {
    const problems = [
      ...redirectUris.map(redirectUriProblem),
      ...webOrigins.map(webOriginProblem),
    ].filter((problem): problem is string => problem !== null)

    if (problems.length > 0) {
      throw new ValidationError(problems)
    }
  }

  private async requireApp(id: string): Promise<SsoApp> {
    const app = await this.apps.findById(id)
    if (app === null) {
      throw new NotFoundError('sso application', id)
    }
    return app
  }

  @Get()
  @RequirePermission('sso_app:read')
  async list(@Req() request: AuthorizedRequest): Promise<SsoApp[]> {
    await this.requireGlobalGrant(request, 'sso_app:read')
    return this.apps.list()
  }

  @Get(':id')
  @RequirePermission('sso_app:read')
  async findOne(@Param('id') id: string, @Req() request: AuthorizedRequest): Promise<SsoApp> {
    await this.requireGlobalGrant(request, 'sso_app:read')
    return this.requireApp(id)
  }

  @Post()
  @RequirePermission('sso_app:manage')
  async create(@Body() body: unknown, @Req() request: AuthorizedRequest): Promise<SsoApp> {
    await this.requireGlobalGrant(request, 'sso_app:manage')
    const parsed = parseBody(createBodySchema, body)

    const clientIdIssue = clientIdProblem(parsed.clientId)
    if (clientIdIssue !== null) {
      throw new ValidationError([clientIdIssue])
    }
    // `?? ` rather than relying on zod's .default(): parseBody's generic
    // resolves to the schema's INPUT type, where a defaulted field is still
    // optional. Applying the defaults explicitly keeps the compiler honest
    // instead of casting the difference away.
    const webOrigins = parsed.webOrigins ?? []
    this.assertSafeUris(parsed.redirectUris, webOrigins)

    // Checked here for a clear 409; the unique index is what actually
    // prevents the race.
    if ((await this.apps.findByClientId(parsed.clientId)) !== null) {
      throw new ConflictError(`an application with clientId "${parsed.clientId}" already exists`)
    }

    return this.db.transaction(async (tx) => {
      const app = await this.apps.create(
        {
          clientId: parsed.clientId,
          name: parsed.name,
          description: parsed.description ?? '',
          protocol: 'openid-connect',
          publicClient: parsed.publicClient,
          redirectUris: parsed.redirectUris,
          webOrigins,
          groupsClaim: parsed.groupsClaim ?? true,
        },
        tx,
      )

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'sso_app:create',
        resourceType: 'sso_app',
        resourceId: app.id,
        before: null,
        after: snapshotSsoApp(app),
      })

      await this.outboxWriter.record(tx, {
        aggregateType: 'sso_app',
        aggregateId: app.id,
        eventType: 'created',
        payload: { ...snapshotSsoApp(app), action: 'sso_app:create' },
      })

      return app
    })
  }

  @Patch(':id')
  @RequirePermission('sso_app:manage')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ): Promise<SsoApp> {
    await this.requireGlobalGrant(request, 'sso_app:manage')
    const before = await this.requireApp(id)
    const parsed = parseBody(patchBodySchema, body)

    this.assertSafeUris(parsed.redirectUris ?? before.redirectUris, parsed.webOrigins ?? before.webOrigins)

    return this.db.transaction(async (tx) => {
      const app = await this.apps.update(id, parsed, tx)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'sso_app:update',
        resourceType: 'sso_app',
        resourceId: app.id,
        before: snapshotSsoApp(before),
        after: snapshotSsoApp(app),
      })

      await this.outboxWriter.record(tx, {
        aggregateType: 'sso_app',
        aggregateId: app.id,
        eventType: 'updated',
        payload: { ...snapshotSsoApp(app), action: 'sso_app:update' },
      })

      return app
    })
  }

  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('sso_app:manage')
  async enable(@Param('id') id: string, @Req() request: AuthorizedRequest): Promise<SsoApp> {
    return this.setEnabled(id, true, request)
  }

  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('sso_app:manage')
  async disable(@Param('id') id: string, @Req() request: AuthorizedRequest): Promise<SsoApp> {
    return this.setEnabled(id, false, request)
  }

  /**
   * Verb routes rather than a PATCH field, mirroring `POST
   * /users/:id/deactivate`: a toggle that changes who can log into what
   * deserves its own audited action, not a field buried inside an edit.
   */
  private async setEnabled(
    id: string,
    enabled: boolean,
    request: AuthorizedRequest,
  ): Promise<SsoApp> {
    await this.requireGlobalGrant(request, 'sso_app:manage')
    const before = await this.requireApp(id)

    return this.db.transaction(async (tx) => {
      const app = await this.apps.setEnabled(id, enabled, tx)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: enabled ? 'sso_app:enable' : 'sso_app:disable',
        resourceType: 'sso_app',
        resourceId: app.id,
        before: snapshotSsoApp(before),
        after: snapshotSsoApp(app),
      })

      await this.outboxWriter.record(tx, {
        aggregateType: 'sso_app',
        aggregateId: app.id,
        eventType: 'status_changed',
        payload: { ...snapshotSsoApp(app), action: enabled ? 'sso_app:enable' : 'sso_app:disable' },
      })

      return app
    })
  }

  /**
   * Mints a NEW client secret, invalidating the previous one, and returns it
   * in THIS response and nowhere else. It never enters `sso_apps`, the outbox,
   * or the audit snapshot. The audit row records that a secret was minted, by
   * whom, for which application — never the value. Rotation is a re-mint.
   *
   * Same rule the Google connector's one-time bootstrap password states:
   * generate it, transmit it once, retain nothing.
   */
  @Post(':id/client-secret')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('sso_app:manage')
  async mintSecret(
    @Param('id') id: string,
    @Req() request: AuthorizedRequest,
  ): Promise<{ secret: string }> {
    await this.requireGlobalGrant(request, 'sso_app:manage')
    const app = await this.requireApp(id)

    if (app.publicClient) {
      throw new ConflictError(
        `"${app.clientId}" is a public client — public clients authenticate with PKCE and have no secret`,
      )
    }

    const externalId = await this.apps.findExternalId(id)
    if (externalId === null) {
      // A conflict, not a 404: the application exists HERE — there is simply
      // no Keycloak client to mint against until the first sync succeeds.
      throw new ConflictError(
        `"${app.clientId}" has not synced to Keycloak yet — no client exists to mint a secret for`,
      )
    }

    const target = await this.targets.findOne('keycloak_sso')
    if (!target.configured || !target.enabled) {
      throw new ConflictError('the keycloak_sso target is not configured and enabled')
    }

    const admin = this.ssoFactory.configureAdmin(target.config)
    const secret = await admin.mintClientSecret(externalId)

    await this.db.transaction((tx) =>
      this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'sso_app:mint_secret',
        resourceType: 'sso_app',
        resourceId: app.id,
        before: null,
        // The ACT is recorded; the value never is.
        after: { clientId: app.clientId, minted: true },
      }),
    )

    return { secret }
  }
}
