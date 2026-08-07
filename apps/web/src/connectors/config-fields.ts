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
export const TARGET_CONFIG_FIELDS: Record<ConnectorTarget, ConfigFieldSpec[]> = {
  keycloak: [],
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
}
