import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
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
})

export interface Env {
  databaseUrl: string
  keycloakIssuer: string
  keycloakAudience: string
  keycloakAdminClientId: string
  keycloakAdminClientSecret: string
  port: number
  syncWorkerEnabled: boolean
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
    keycloakIssuer: parsed.data.KEYCLOAK_ISSUER.replace(/\/$/, ''),
    keycloakAudience: parsed.data.KEYCLOAK_AUDIENCE,
    keycloakAdminClientId: parsed.data.KEYCLOAK_ADMIN_CLIENT_ID,
    keycloakAdminClientSecret: parsed.data.KEYCLOAK_ADMIN_CLIENT_SECRET,
    port: parsed.data.PORT,
    syncWorkerEnabled: parsed.data.SYNC_WORKER_ENABLED === 'true',
  }
}
