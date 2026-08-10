import { boolean, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/**
 * The discriminator this enum was created for now does its job: 'saml'
 * arrives as a WIDENING (migration 0039), exactly the "adding SAML later
 * widens an enum rather than reshaping the table" the original comment
 * promised. The values are Keycloak's own protocol strings — the connector
 * writes `protocol` into the ClientRepresentation verbatim, so inventing
 * prettier local names ('oidc') would buy a mapping table and nothing else.
 *
 * IMMUTABLE after create, like `client_id`: switching an application's
 * protocol in place is a different application wearing the same row — every
 * SAML column below is meaningless for OIDC and vice versa, and the SP's own
 * configuration is protocol-shaped. It is settable on create and absent from
 * PATCH; `.strict()` makes sending it there a 400 naming the field.
 */
export const ssoAppProtocol = pgEnum('sso_app_protocol', ['openid-connect', 'saml'])

/**
 * A CLOSED set, deliberately smaller than Keycloak's. 'transient' is omitted:
 * a transient NameID hands the SP no stable subject to key an account on,
 * which for the workforce applications this system registers is a
 * misconfiguration, not an option. Ship what genuinely exists — a Postgres
 * enum value is permanent (docs/13).
 */
export const ssoAppNameIdFormat = pgEnum('sso_app_name_id_format', [
  'email',
  'persistent',
  'username',
])

/**
 * A downstream application registered for SSO. THIS row is the system of
 * record; Keycloak holds a projection of it, asserted through the outbox like
 * every other target.
 *
 * There is no delete anywhere in this feature — no route, no repository
 * method, no connector method. Disabling sets `enabled = false` here and on
 * the Keycloak client. Removing the capability removes the class of disaster,
 * rather than leaving a convention for someone to remember.
 *
 * SAML applications (migration 0039) share this table rather than getting a
 * sibling: an application's lifecycle — create, edit, enable, disable, audit,
 * outbox fan-out to `keycloak_sso` — is protocol-independent, and a second
 * table would duplicate every one of those paths. The protocol-specific
 * columns are nullable and null on the other protocol's rows; the closed
 * request schemas in sso-apps.controller.ts are what keep a SAML field from
 * ever being set on an OIDC row (and vice versa), the same layer that already
 * owns every other shape rule for this table. A CHECK constraint tying the
 * columns to `protocol = 'saml'` is deliberately ABSENT from 0039: it would
 * reference the enum value added in the same migration, and drizzle applies
 * the pending tail in one transaction — the exact "unsafe use of new value of
 * enum type" failure docs/13 warns about, hit on every fresh Testcontainer.
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
     *
     * For a SAML application this holds the SP's ENTITY ID — Keycloak keys a
     * SAML client by entity id in this same `clientId` field, so storing it
     * anywhere else would mean two columns whose divergence is a bug. The
     * API surface calls it `entityId` on the SAML request shapes; it lands
     * here. Same immutability, same uniqueness, same reserved-name denylist.
     */
    clientId: text('client_id').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    protocol: ssoAppProtocol('protocol').notNull().default('openid-connect'),
    /** Always false for SAML — a SAML SP has no "public client" auth model. */
    publicClient: boolean('public_client').notNull(),
    /**
     * Validated before they ever reach here — a wildcard is permitted only in
     * the path. See sso-apps/sso-app-validation.ts for why an over-broad
     * redirect URI is a token-theft primitive rather than a style question.
     * OIDC only; empty (not null) for SAML rows — the connector derives the
     * Keycloak client's redirectUris from `saml_acs_urls` instead.
     */
    redirectUris: text('redirect_uris').array().notNull(),
    webOrigins: text('web_origins').array().notNull(),
    /**
     * Whether to assert the `groups` mapper on the Keycloak client. ONE
     * column for both protocols, deliberately: it answers the same question —
     * "does the token/assertion carry group membership?" — realised as an
     * OIDC claim mapper or a SAML attribute-statement mapper respectively.
     */
    groupsClaim: boolean('groups_claim').notNull().default(true),
    enabled: boolean('enabled').notNull().default(true),

    // ------------------------------------------------------------------
    // SAML-only columns. Null on every OIDC row, including all rows that
    // existed before 0039. Nullable rather than defaulted so an OIDC row
    // cannot quietly carry a plausible-looking SAML configuration.
    // ------------------------------------------------------------------

    /**
     * Assertion Consumer Service URLs, validated by `acsUrlProblem` — https
     * only (http for localhost), no wildcards at all: SAML has no wildcard
     * semantics and an over-broad ACS is assertion theft, the same class of
     * bug as an over-broad redirect URI. First entry is the primary POST
     * binding endpoint; all entries become the client's valid redirect URIs,
     * which is how Keycloak scopes acceptable ACS destinations.
     */
    samlAcsUrls: text('saml_acs_urls').array(),
    /**
     * The SP's signing certificate, PEM. Optional: supplying one turns ON
     * "client signature required" in Keycloak, so the IdP rejects unsigned
     * AuthnRequests claiming to be this SP; absent, the SP simply does not
     * sign its requests.
     */
    samlSpCertificate: text('saml_sp_certificate'),
    /** Whether the IdP signs individual assertions (beyond the response document). */
    samlSignAssertions: boolean('saml_sign_assertions'),
    samlNameIdFormat: ssoAppNameIdFormat('saml_name_id_format'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    clientIdUnique: uniqueIndex('sso_apps_client_id_unique').on(table.clientId),
  }),
)
