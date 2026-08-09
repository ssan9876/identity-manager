import { z } from 'zod'

const envSchema = z.object({
  // The OWNER/MIGRATION connection — owns the schema (every table, every
  // sequence, the audit_log_append_only() trigger function) and is the
  // only credential `db:migrate` (db/migrate-cli.ts) ever connects with.
  // NEVER used by the running application or the sync worker — see
  // RUNTIME_DATABASE_URL below, and docs/archive/audits/audit-integrity.md
  // finding H1: a role that both serves runtime traffic AND owns/can-alter
  // its own schema can simply redefine any guard it dislikes, DDL included.
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // The RUNTIME connection — what the API process and the SyncWorker (both
  // share this via the DB_CLIENT DI token, app.module.ts) actually connect
  // as. This role owns nothing and cannot ALTER/DROP/CREATE OR REPLACE any
  // object (no CREATE on the schema): `db:migrate`, connected as the OWNER
  // above, provisions it with exactly the DML it needs — full
  // SELECT/INSERT/UPDATE/DELETE on ordinary tables, but only SELECT/INSERT
  // on audit_log (db/roles.ts's provisionRuntimeRole; finding H1). No
  // fallback to DATABASE_URL when this is absent — deliberately: a missing
  // RUNTIME_DATABASE_URL fails loadEnv outright (same as every other
  // required field here) rather than silently booting the app with owner
  // privileges, which would quietly undo the whole fix.
  RUNTIME_DATABASE_URL: z.string().min(1, 'RUNTIME_DATABASE_URL is required'),
  KEYCLOAK_ISSUER: z.string().url('KEYCLOAK_ISSUER must be a valid URL'),
  KEYCLOAK_AUDIENCE: z.string().min(1, 'KEYCLOAK_AUDIENCE is required'),
  // The Keycloak Admin REST client's OWN service-account credentials
  // (Milestone 4, Task 2) — distinct from KEYCLOAK_AUDIENCE, which is the
  // audience JwtGuard checks on INBOUND end-user tokens. These authenticate
  // an OUTBOUND client-credentials grant against the same KEYCLOAK_ISSUER
  // realm, used to push user/group state INTO Keycloak.
  KEYCLOAK_ADMIN_CLIENT_ID: z.string().min(1, 'KEYCLOAK_ADMIN_CLIENT_ID is required'),
  KEYCLOAK_ADMIN_CLIENT_SECRET: z.string().min(1, 'KEYCLOAK_ADMIN_CLIENT_SECRET is required'),
  // (Organizations, Task 8) A service account in Keycloak's MASTER realm,
  // holding `create-realm`. `POST /admin/realms` is a SERVER-level endpoint,
  // so the realm-scoped KEYCLOAK_ADMIN_CLIENT_ID above structurally cannot
  // call it: that credential authenticates against — and is only ever
  // granted realm-management roles within — the `identity-manager` realm.
  //
  // Optional, deliberately. A deployment that never creates organizations
  // needs no such account, and every existing path keeps working without
  // one; making it required would break every current .env for a feature
  // most deployments will not use. `POST /organizations` answers
  // NOT_CONFIGURED (503) when it is absent rather than accepting a row that
  // can never provision.
  //
  // Both halves are `.optional()` INDIVIDUALLY rather than as a pair: zod
  // has no ergonomic "both or neither" here, and the pairing is enforced
  // where it matters instead — KeycloakAdminClientFactory.
  // hasProvisioningCredentials() requires BOTH to be non-null, so a
  // half-configured deployment behaves exactly like an unconfigured one
  // (refuses to provision) rather than attempting a client-credentials
  // grant with an empty secret.
  KEYCLOAK_PROVISION_CLIENT_ID: z.string().min(1).optional(),
  // NEVER logged, never echoed in an API response, never written to an audit
  // row — the same rule connectors/secrets.ts states for connector
  // credentials, and for the same reason. It is deliberately NOT reachable
  // through `resolveSecret`: that function admits only CONNECTOR_*-prefixed
  // names precisely so admin-editable connector config can never name a
  // process secret like this one (see its doc comment). This value is read
  // once, here, and handed only to KeycloakAdminClientFactory.
  KEYCLOAK_PROVISION_CLIENT_SECRET: z.string().min(1).optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  // Milestone 4, Task 4: the on/off switch for the SyncWorker's background
  // polling loop (see main.ts's bootstrap). Defaults ON so `start:dev` (and
  // any other real boot) drains the outbox without extra setup — but
  // `vitest run` never calls main.ts's bootstrap() at all (no spec file
  // imports it), so tests are unaffected by this default regardless of its
  // value; the flag exists to let a real deployment opt OUT, e.g. running
  // multiple app instances behind a load balancer with the worker enabled
  // on only one of them. Spelled as a string enum, not `z.coerce.boolean()`
  // — that coercion treats ANY non-empty string, including the literal text
  // "false", as `true` (`Boolean("false") === true`), which would make the
  // off switch impossible to actually flip via an env file.
  SYNC_WORKER_ENABLED: z.enum(['true', 'false']).default('true'),
  // Ceiling on physical Postgres connections `createDbClient`'s pool will
  // ever open (db/client.ts's `DbClientOptions.max`). Defaults to pg's own
  // default (10) so an unset env is a no-op — see db/client.ts's doc
  // comment. Exists so a deployment can raise or lower it (e.g. a bigger
  // managed Postgres instance, or several API instances sharing one small
  // one) without a code change; see docs/archive/audits/audit-integrity.md
  // finding C1 for why the pool's size and timeout behaviour are both
  // load-bearing for availability, not just performance tuning.
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  // Explicit, configurable ceiling on the whole request body `main.ts`'s
  // body parser will accept, replacing express's ACCIDENTAL 100 KiB default
  // (finding M6, docs/archive/audits/audit-integrity.md: "the practical
  // ceiling is ~800 rows / ~7s per request... that is an accidental
  // control: it disappears the instant anyone sets `bodyParser: { limit }`
  // for a legitimate reason"). 10 MiB comfortably covers a several-thousand
  // -row CSV import (the largest legitimate request this API accepts) while
  // still bounding worst-case memory use — see main.ts's own doc comment.
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  // Explicit, configurable ceiling on the number of DATA rows one
  // `POST /imports/preview`/`/commit` request may carry — the other half of
  // finding M6. Import commit is SERIAL, BLOCKING, on-request work — one
  // transaction per row, on the request path — so this number is really a
  // request-duration budget wearing a row count's clothes. Measured against a
  // real Postgres (test/import-bench, 5,000 rows, one org unit, all rows
  // valid), BEFORE and AFTER the lookups were batched:
  //
  //     commit  12.18 ms/row  ->  8.45 ms/row     (5,000 rows: 61s -> 42s)
  //     preview  2.99 ms/row  ->  0.05 ms/row     (5,000 rows: 15s -> 0.3s)
  //
  // so at this default:
  //
  //     1,000 rows x 8.45ms  ~= 8.5s   <- this default
  //     5,000 rows x 8.45ms  ~= 42s    <- the previous default
  //
  // against a pool of 10 (DB_POOL_MAX). Five concurrent maximal imports at
  // the old default could hold half the pool for the better part of a minute.
  //
  // Lowered from 5,000 after the carried-findings verification pass
  // (docs/archive/audits/carried-findings-verification.md, its item 1) pointed
  // out what the original choice had not reckoned with: express's ACCIDENTAL
  // 100 KiB body default used to cap a request at ~800 rows / ~7s, so the
  // deliberate 5,000 replaced an accident with something ~6x worse. That is
  // the opposite of what "we now have an explicit ceiling" is supposed to buy.
  //
  // 1,000 is still ~40% above the largest legitimate import this system has
  // ever been measured against (700 rows), so it should not bite in practice.
  // It is deliberately a DEFAULT and not a constant: an operator who genuinely
  // imports more can raise IMPORT_MAX_ROWS, and doing so is now an informed
  // decision about how long they are willing to occupy a pool connection
  // rather than a number they inherited without anyone reasoning about it.
  //
  // WHY THIS STAYS AT 1,000 NOW THAT THE LOOKUPS ARE BATCHED. The
  // verification pass named three ways out: lower this number, batch the
  // per-row lookups, or move commit off the request path. Batching landed
  // (see imports/import-lookups.ts) and it did NOT make this number
  // unnecessary — it only moved which part of the work dominates. Preview,
  // which is pure resolution, effectively stopped costing anything (15s ->
  // 0.3s for 5,000 rows, a ~58x improvement). Commit improved by ~31% and no
  // more, because what remains is not lookups: it is one DURABLE transaction
  // per row (BEGIN, the INSERT/UPDATE, the audit row, the outbox row, COMMIT
  // — a WAL flush each). Measured in the same environment, a trivial query
  // round trip is 0.31 ms and an empty transaction 0.85 ms, so ~8.45 ms/row
  // is dominated by real write work and per-row commit durability, not by
  // chattiness that batching can remove.
  //
  // One transaction per row is deliberate and load-bearing — it is what makes
  // a failing row roll back ONLY itself while every other row stays committed
  // and individually attributed (see ImportsController.commit). Collapsing it
  // is not a tuning knob; it is a change to the endpoint's failure contract.
  // So the remaining lever, short of moving commit off the request path
  // entirely (a job queue and a status-polling UI — a different project), is
  // this ceiling. It stays at 1,000.
  IMPORT_MAX_ROWS: z.coerce.number().int().positive().default(1_000),
})

export interface Env {
  databaseUrl: string
  runtimeDatabaseUrl: string
  keycloakIssuer: string
  keycloakAudience: string
  keycloakAdminClientId: string
  keycloakAdminClientSecret: string
  /** Null when this deployment cannot create realms — see the schema's own comment. */
  keycloakProvisionClientId: string | null
  /** Null when this deployment cannot create realms. Never log or serialize this. */
  keycloakProvisionClientSecret: string | null
  port: number
  syncWorkerEnabled: boolean
  dbPoolMax: number
  bodyLimitBytes: number
  importMaxRows: number
}

export function loadEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(source)

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    throw new Error(`Invalid environment configuration — ${detail}`)
  }

  return {
    databaseUrl: parsed.data.DATABASE_URL,
    runtimeDatabaseUrl: parsed.data.RUNTIME_DATABASE_URL,
    keycloakIssuer: parsed.data.KEYCLOAK_ISSUER.replace(/\/$/, ''),
    keycloakAudience: parsed.data.KEYCLOAK_AUDIENCE,
    keycloakAdminClientId: parsed.data.KEYCLOAK_ADMIN_CLIENT_ID,
    keycloakAdminClientSecret: parsed.data.KEYCLOAK_ADMIN_CLIENT_SECRET,
    keycloakProvisionClientId: parsed.data.KEYCLOAK_PROVISION_CLIENT_ID ?? null,
    keycloakProvisionClientSecret: parsed.data.KEYCLOAK_PROVISION_CLIENT_SECRET ?? null,
    port: parsed.data.PORT,
    syncWorkerEnabled: parsed.data.SYNC_WORKER_ENABLED === 'true',
    dbPoolMax: parsed.data.DB_POOL_MAX,
    bodyLimitBytes: parsed.data.BODY_LIMIT_BYTES,
    importMaxRows: parsed.data.IMPORT_MAX_ROWS,
  }
}
