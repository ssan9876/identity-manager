import type { ConnectorTarget } from './api'

/**
 * `secret-name` renders EXACTLY like `string` (a plain text input, never
 * masked) — the type exists only to select the field's help text. This is
 * the BUILD section's own non-negotiable, verbatim: "Secret names are
 * shown; values are never fetched, because nothing stores them. The UI must
 * state plainly where a value comes from — an environment variable name —
 * rather than implying it is stored here or offering a field that looks
 * like it could hold one. A masked input would be a lie about the
 * architecture." A password-style input, even an empty one, visually
 * promises "a secret lives here" — this console never makes that promise,
 * because it is never true: `connector_targets.config` cannot hold a
 * secret VALUE, only the NAME of an environment variable resolved
 * server-side at sync time (connectors/secrets.ts).
 */
export type ConfigFieldType = 'string' | 'secret-name' | 'boolean'

export interface ConfigFieldSpec {
  key: string
  label: string
  type: ConfigFieldType
  required: boolean
  placeholder?: string
  hint?: string
}

/**
 * Mirrors each real connector's own `parse*Config` — see
 * apps/api/src/connectors/{active-directory,entra-id,google-workspace}.connector.ts
 * and echo.connector.ts. Deliberately narrower than every key those
 * connectors will READ from `config`: test-only overrides
 * (`graphBaseUrl`/`authorityBaseUrl`/`adminBaseUrl`/`tokenUrl`) and rarely-
 * tuned timeouts/retry counts are left out of this admin-facing form on
 * purpose — `ConnectorTargetsRepository.upsert`'s merge semantics mean
 * omitting a key here never destroys one already present in storage (e.g.
 * one a test harness set directly), it simply is not surfaced as a field
 * an admin edits day to day.
 */

/**
 * Every SCIM slot takes the SAME fields — the protocol is identical and only
 * the values differ — so they are generated from one spec rather than copied
 * six times. A hand-copied list is exactly the "catalog drift" defect
 * connector.ts's own doc comment records, and it would be six chances to get
 * one wrong.
 *
 * `baseUrl` is the SCIM service root. `tokenSecretName` covers the common
 * static-bearer case; the OAuth2 trio below it is for services that mint
 * short-lived tokens instead. Neither is a credential BOX — both name an
 * environment variable, per this file's own `secret-name` doc comment.
 * `writeMode` is surfaced because PATCH is an OPTIONAL SCIM feature and a
 * service that lacks it rejects every write until this is switched to `put`
 * — a real, first-day configuration decision, not a tuning knob.
 */
const SCIM_TARGETS = [
  'scim_slack',
  'scim_zoom',
  'scim_atlassian',
  'scim_box',
  'scim_snowflake',
  'scim_generic',
] as const satisfies readonly ConnectorTarget[]

/** Derived from the array so the two cannot drift — the same shape `ALL_CONNECTOR_TARGETS` uses on the API side. */
type ScimTarget = (typeof SCIM_TARGETS)[number]

const SCIM_FIELDS: ConfigFieldSpec[] = [
  {
    key: 'baseUrl',
    label: 'SCIM base URL',
    type: 'string',
    required: true,
    placeholder: 'https://api.example.com/scim/v2',
    hint: 'The SCIM 2.0 service root — the URL that /Users and /Groups hang off. A trailing slash is trimmed.',
  },
  {
    key: 'tokenSecretName',
    label: 'Bearer token environment variable',
    type: 'secret-name',
    required: false,
    placeholder: 'CONNECTOR_SCIM_SLACK_TOKEN',
    hint: 'For a service that issues a long-lived token. Set this OR the three OAuth2 fields below, never both.',
  },
  {
    key: 'writeMode',
    label: 'Write mode',
    type: 'string',
    required: false,
    placeholder: 'patch',
    hint: 'patch (default) or put. PATCH is optional in SCIM — switch to put if this service advertises no PATCH support.',
  },
  {
    key: 'tokenUrl',
    label: 'OAuth2 token URL',
    type: 'string',
    required: false,
    hint: 'Only for services that mint short-lived tokens from client credentials. Leave blank when using a bearer token.',
  },
  { key: 'clientId', label: 'OAuth2 client ID', type: 'string', required: false },
  {
    key: 'clientSecretName',
    label: 'OAuth2 client secret environment variable',
    type: 'secret-name',
    required: false,
    placeholder: 'CONNECTOR_SCIM_CLIENT_SECRET',
  },
  { key: 'scope', label: 'OAuth2 scope', type: 'string', required: false },
]

function scimTargetFields(): Record<ScimTarget, ConfigFieldSpec[]> {
  const fields = {} as Record<ScimTarget, ConfigFieldSpec[]>
  for (const target of SCIM_TARGETS) {
    // A fresh array per slot: one shared reference would let a future
    // in-place edit for one application silently change all six.
    fields[target] = SCIM_FIELDS.map((field) => ({ ...field }))
  }
  return fields
}

export const TARGET_CONFIG_FIELDS: Record<ConnectorTarget, ConfigFieldSpec[]> = {
  keycloak: [],
  // SSO applications. A SEPARATE credential from the `keycloak` target's
  // above, deliberately: this one authenticates as `idm-sso-admin`, which
  // holds `manage-clients` and nothing else, so the user and group sync path
  // structurally cannot mint or alter an OIDC client.
  //
  // `realm` must name the SAME realm the console authenticates against —
  // an application registered in a different realm is invisible to every
  // account this system masters — which is why the connector's `health()`
  // compares it against KEYCLOAK_ISSUER rather than trusting these two
  // separately-carried values to stay aligned by hand.
  keycloak_sso: [
    {
      key: 'baseUrl',
      label: 'Keycloak base URL',
      type: 'string',
      required: true,
      placeholder: 'https://sso.example.com',
      hint: 'The Keycloak server root, without /realms. A trailing slash is trimmed.',
    },
    {
      key: 'realm',
      label: 'Realm',
      type: 'string',
      required: true,
      placeholder: 'identity-manager',
      hint: 'Must be the same realm the console signs in against, or registered applications will be invisible to your users.',
    },
    {
      key: 'clientId',
      label: 'Admin client ID',
      type: 'string',
      required: true,
      placeholder: 'idm-sso-admin',
      hint: 'Created by scripts/keycloak-setup.sh. Holds manage-clients only.',
    },
    {
      key: 'credentialSecretName',
      label: 'Client secret environment variable',
      type: 'secret-name',
      required: true,
      placeholder: 'CONNECTOR_KEYCLOAK_SSO_CLIENT_SECRET',
    },
  ],
  // Sub-project 4. Mirrors `mail-server.connector.ts`'s own BASE_URL_KEY /
  // TOKEN_SECRET_NAME_KEY (both required — `requiredString` throws without
  // them) plus the one genuinely admin-facing behavioural switch. Its
  // `requestTimeoutMs` is deliberately omitted for the same reason every
  // other connector's timeout is: rarely tuned, and omitting a key here
  // never destroys one already stored.
  mail_server: [
    {
      key: 'baseUrl',
      label: 'API base URL',
      type: 'string',
      required: true,
      placeholder: 'http://mail.internal:8081/api/v1',
      hint: 'The mail server admin API root. A trailing slash is trimmed.',
    },
    {
      key: 'tokenSecretName',
      label: 'API token environment variable',
      type: 'secret-name',
      required: true,
      placeholder: 'CONNECTOR_MAIL_SERVER_TOKEN',
    },
    {
      key: 'allowAdminProvisioning',
      label: 'Provision mail administrators',
      type: 'boolean',
      required: false,
      hint:
        'When on, a person holding a domain_admin or superadmin business role is also ' +
        'provisioned as an administrator of their own email domain. Off by default.',
    },
  ],
  echo: [
    {
      key: 'credentialSecretName',
      label: 'Credential environment variable',
      type: 'secret-name',
      required: true,
      placeholder: 'CONNECTOR_ECHO_CREDENTIAL',
    },
  ],
  active_directory: [
    {
      key: 'url',
      label: 'LDAPS URL',
      type: 'string',
      required: true,
      placeholder: 'ldaps://dc1.corp.example.com:636',
      hint: 'Plain ldap:// is never accepted — certificate verification is on by default.',
    },
    {
      key: 'baseDN',
      label: 'Base DN',
      type: 'string',
      required: true,
      placeholder: 'DC=corp,DC=example,DC=com',
    },
    {
      key: 'bindDN',
      label: 'Bind DN',
      type: 'string',
      required: true,
      placeholder: 'CN=svc-idm-sync,CN=Users,DC=corp,DC=example,DC=com',
    },
    {
      key: 'credentialSecretName',
      label: 'Bind password environment variable',
      type: 'secret-name',
      required: true,
      placeholder: 'AD_BIND_PASSWORD',
    },
    {
      key: 'caCertificate',
      label: 'CA certificate (PEM)',
      type: 'string',
      required: false,
      hint: 'Leave blank to trust the server’s own OS root store.',
    },
    {
      key: 'tlsServerName',
      label: 'TLS server name override',
      type: 'string',
      required: false,
    },
    {
      key: 'allowInsecureTls',
      label: 'Allow insecure TLS (skip certificate verification)',
      type: 'boolean',
      required: false,
      hint: 'The only way certificate verification is ever relaxed. Off by default, and should stay off outside a test lab.',
    },
    {
      key: 'createMissingOrgUnits',
      label: 'Create missing organizational units automatically',
      type: 'boolean',
      required: false,
    },
  ],
  entra_id: [
    { key: 'tenantId', label: 'Tenant ID', type: 'string', required: true },
    { key: 'clientId', label: 'Application (client) ID', type: 'string', required: true },
    {
      key: 'credentialSecretName',
      label: 'Client secret environment variable',
      type: 'secret-name',
      required: true,
      placeholder: 'ENTRA_CLIENT_SECRET',
    },
  ],
  google_workspace: [
    {
      key: 'impersonatedAdminEmail',
      label: 'Impersonated admin email',
      type: 'string',
      required: true,
      hint: 'The real Workspace admin this service account acts as, via domain-wide delegation.',
    },
    { key: 'domain', label: 'Workspace domain', type: 'string', required: true, placeholder: 'corp.example.com' },
    {
      key: 'credentialSecretName',
      label: 'Service-account key environment variable',
      type: 'secret-name',
      required: true,
      placeholder: 'GOOGLE_SERVICE_ACCOUNT_KEY',
      hint: 'Names the variable holding the FULL downloaded service-account key JSON, not a bare private key.',
    },
  ],
  ...scimTargetFields(),
}
