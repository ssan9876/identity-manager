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
  // finding M6. Import commit is ~10ms/row of serial, blocking work
  // (task-2-brief.md's own measurement), so this bounds worst-case request
  // duration and memory, independent of whatever the body-size limit above
  // happens to be. 5,000 rows is comfortably above every legitimate import
  // this system has been measured against (up to 700 rows) while still
  // being a real, enforced ceiling rather than "whatever fits in the body".
  IMPORT_MAX_ROWS: z.coerce.number().int().positive().default(5_000),
})

export interface Env {
  databaseUrl: string
  runtimeDatabaseUrl: string
  keycloakIssuer: string
  keycloakAudience: string
  keycloakAdminClientId: string
  keycloakAdminClientSecret: string
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
    port: parsed.data.PORT,
    syncWorkerEnabled: parsed.data.SYNC_WORKER_ENABLED === 'true',
    dbPoolMax: parsed.data.DB_POOL_MAX,
    bodyLimitBytes: parsed.data.BODY_LIMIT_BYTES,
    importMaxRows: parsed.data.IMPORT_MAX_ROWS,
  }
}
