import { Inject, Injectable } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import { externalSsoAppIdentities } from '../db/schema/external-sso-app-identities'
import * as schema from '../db/schema/index'
import { ssoApps } from '../db/schema/sso-apps'
import type { DbHandle } from '../outbox/outbox.writer'

export type SsoAppProtocol = 'openid-connect' | 'saml'
export type SamlNameIdFormat = 'email' | 'persistent' | 'username'

export interface SsoApp {
  id: string
  /** For SAML rows this IS the SP's entity id — see db/schema/sso-apps.ts. */
  clientId: string
  name: string
  description: string
  protocol: SsoAppProtocol
  publicClient: boolean
  redirectUris: string[]
  webOrigins: string[]
  groupsClaim: boolean
  enabled: boolean
  /**
   * SAML-only, null on every OIDC row. Nullable fields rather than a
   * discriminated union: the union would be the honest shape, but every
   * caller routes through Drizzle rows whose types cannot express the
   * correlation, so the union would be asserted, not proven. The
   * controller's closed request schemas are what actually maintain the
   * invariant — a SAML field can never be written to an OIDC row.
   */
  samlAcsUrls: string[] | null
  samlSpCertificate: string | null
  samlSignAssertions: boolean | null
  samlNameIdFormat: SamlNameIdFormat | null
  createdAt: Date
  updatedAt: Date
}

export interface SsoAppInput {
  clientId: string
  name: string
  description: string
  protocol: SsoAppProtocol
  publicClient: boolean
  redirectUris: string[]
  webOrigins: string[]
  groupsClaim: boolean
  samlAcsUrls?: string[] | null
  samlSpCertificate?: string | null
  samlSignAssertions?: boolean | null
  samlNameIdFormat?: SamlNameIdFormat | null
}

/**
 * No `clientId`: immutable after create, because downstream applications
 * hard-code it. No `protocol`: one value today, and changing an application's
 * protocol in place would be a different client, not an edit. No `enabled`:
 * enable and disable are their own separately-audited verb routes, mirroring
 * `POST /users/:id/deactivate` — a toggle that changes who can log into what
 * should not be a field buried inside an edit.
 */
export type SsoAppPatch = Partial<Omit<SsoAppInput, 'clientId' | 'protocol'>>

/**
 * Every write takes an explicit `DbHandle`, never opening its own
 * transaction: the caller writes the `sso_apps` row, its `audit_log` row and
 * its `outbox_events` row in ONE transaction, which is the whole reason this
 * feature needs no distributed transaction between Postgres and Keycloak.
 *
 * Reads accept an optional handle so a controller can read outside a
 * transaction while the sync worker reads inside its own.
 *
 * There is deliberately no `delete`.
 */
@Injectable()
export class SsoAppsRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>) {}

  async create(input: SsoAppInput, tx: DbHandle): Promise<SsoApp> {
    const [row] = await tx.insert(ssoApps).values(input).returning()
    return row as SsoApp
  }

  async findById(id: string, tx?: DbHandle): Promise<SsoApp | null> {
    const handle = tx ?? this.db
    const [row] = await handle.select().from(ssoApps).where(eq(ssoApps.id, id)).limit(1)
    return (row as SsoApp | undefined) ?? null
  }

  async findByClientId(clientId: string, tx?: DbHandle): Promise<SsoApp | null> {
    const handle = tx ?? this.db
    const [row] = await handle.select().from(ssoApps).where(eq(ssoApps.clientId, clientId)).limit(1)
    return (row as SsoApp | undefined) ?? null
  }

  async list(tx?: DbHandle): Promise<SsoApp[]> {
    const handle = tx ?? this.db
    return (await handle.select().from(ssoApps).orderBy(ssoApps.clientId)) as SsoApp[]
  }

  async update(id: string, patch: SsoAppPatch, tx: DbHandle): Promise<SsoApp> {
    const [row] = await tx
      .update(ssoApps)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(ssoApps.id, id))
      .returning()
    return row as SsoApp
  }

  async setEnabled(id: string, enabled: boolean, tx: DbHandle): Promise<SsoApp> {
    const [row] = await tx
      .update(ssoApps)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(ssoApps.id, id))
      .returning()
    return row as SsoApp
  }

  /**
   * The Keycloak client UUID, or null before the first successful sync.
   *
   * `null` is what makes minting a client secret a 409 rather than a 404: the
   * application exists HERE, there is simply no Keycloak client to mint
   * against yet.
   */
  async findExternalId(appId: string, tx?: DbHandle): Promise<string | null> {
    const handle = tx ?? this.db
    const [row] = await handle
      .select({ externalId: externalSsoAppIdentities.externalId })
      .from(externalSsoAppIdentities)
      .where(eq(externalSsoAppIdentities.appId, appId))
      .limit(1)
    return row?.externalId ?? null
  }
}
