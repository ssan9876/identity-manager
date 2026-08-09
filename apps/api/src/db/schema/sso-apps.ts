import { boolean, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/**
 * One value today. The discriminator exists from day one so that adding SAML
 * later widens an enum rather than reshaping the table — SAML is out of scope
 * for this version, but it is the obvious next protocol and a column added
 * afterwards would mean backfilling every existing row.
 */
export const ssoAppProtocol = pgEnum('sso_app_protocol', ['openid-connect'])

/**
 * A downstream application registered for SSO. THIS row is the system of
 * record; Keycloak holds a projection of it, asserted through the outbox like
 * every other target.
 *
 * There is no delete anywhere in this feature — no route, no repository
 * method, no connector method. Disabling sets `enabled = false` here and on
 * the Keycloak client. Removing the capability removes the class of disaster,
 * rather than leaving a convention for someone to remember.
 */
export const ssoApps = pgTable(
  'sso_apps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * IMMUTABLE after create. Downstream applications hard-code this in their
     * own configuration, and Keycloak treats it as renameable, so nothing
     * downstream would stop us from breaking every app that trusts it. It is
     * settable on create and absent from PATCH.
     */
    clientId: text('client_id').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    protocol: ssoAppProtocol('protocol').notNull().default('openid-connect'),
    publicClient: boolean('public_client').notNull(),
    /**
     * Validated before they ever reach here — a wildcard is permitted only in
     * the path. See sso-apps/sso-app-validation.ts for why an over-broad
     * redirect URI is a token-theft primitive rather than a style question.
     */
    redirectUris: text('redirect_uris').array().notNull(),
    webOrigins: text('web_origins').array().notNull(),
    /** Whether to assert the `groups` protocol mapper on the Keycloak client. */
    groupsClaim: boolean('groups_claim').notNull().default(true),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    clientIdUnique: uniqueIndex('sso_apps_client_id_unique').on(table.clientId),
  }),
)
