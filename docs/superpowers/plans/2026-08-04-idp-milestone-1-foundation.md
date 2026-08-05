# Identity Provider — Milestone 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the repository, dev environment, database schema foundation, and a React admin console that authenticates against Keycloak via OIDC and successfully calls a protected API endpoint.

**Architecture:** A pnpm workspace with a NestJS API and a React (Vite) console. Postgres is the system of record, accessed through Drizzle ORM with `ltree` for org hierarchy. Keycloak runs in Docker and owns all credentials; the API validates its JWTs against Keycloak's JWKS and never issues or stores credentials of its own.

**Tech Stack:** TypeScript, pnpm workspaces, NestJS, Drizzle ORM, Postgres 16 (`ltree`), Zod, Keycloak 26, React 18 + Vite, `react-oidc-context`, `jose`, Vitest, Testcontainers, Playwright.

**Source spec:** `docs/superpowers/specs/2026-08-04-identity-provider-core-design.md`

## Global Constraints

These apply to every task in this plan and every later plan in this project.

- **The system never generates, transmits, or stores a credential.** Keycloak owns passwords, MFA, and sessions. No password column, no password hashing, no login form in this codebase.
- **Attribute propagation is default-deny.** `attribute_definitions.sync_to_keycloak` and `.self_editable` both default to `false`.
- **There is no delete operation.** Users transition to `deactivated` (terminal) and are retained. No `DELETE` statements against `users`.
- **Authorization is enforced in the API, never in the UI.** (RBAC lands in Milestone 3; until then no write endpoints are exposed to the console.)
- **Postgres and Keycloak are tested with Testcontainers, never mocks.**
- **Single tenant.** No `tenant_id` anywhere.
- TypeScript `strict: true` everywhere.
- Node 20+, pnpm 9+.

---

## File Structure

```
identity-manager/
├── docker-compose.yml                      # dev Postgres + Keycloak
├── keycloak/realm-import/
│   └── identity-manager-realm.json         # realm, clients, dev user
├── pnpm-workspace.yaml
├── package.json                            # workspace root scripts
├── tsconfig.base.json
├── apps/
│   ├── api/
│   │   ├── drizzle.config.ts
│   │   ├── vitest.config.ts
│   │   └── src/
│   │       ├── main.ts                     # bootstrap
│   │       ├── app.module.ts               # root module wiring
│   │       ├── config/env.ts               # Zod-validated env
│   │       ├── health/health.controller.ts
│   │       ├── auth/
│   │       │   ├── jwt.guard.ts            # Keycloak JWKS verification
│   │       │   └── me.controller.ts        # protected identity echo
│   │       ├── db/
│   │       │   ├── client.ts               # pool + drizzle instance
│   │       │   ├── migrate.ts              # extensions + drizzle migrate
│   │       │   ├── ltree.ts                # custom ltree column type
│   │       │   └── schema/
│   │       │       ├── index.ts            # barrel — drizzle-kit entrypoint
│   │       │       ├── org-units.ts
│   │       │       ├── users.ts
│   │       │       └── attribute-definitions.ts
│   │       ├── org-units/org-units.repository.ts
│   │       ├── users/users.repository.ts
│   │       └── attributes/attribute-validator.ts
│   │   └── test/
│   │       ├── support/pg.ts               # Testcontainers Postgres helper
│   │       ├── support/keycloak.ts         # Testcontainers Keycloak helper
│   │       └── *.spec.ts
│   └── web/
│       ├── vite.config.ts
│       ├── playwright.config.ts
│       ├── src/
│       │   ├── main.tsx
│       │   ├── App.tsx
│       │   └── auth/oidc-config.ts
│       └── e2e/login.spec.ts
└── docs/superpowers/{specs,plans}/
```

Each schema file owns exactly one table so migrations stay reviewable and files stay small. Repositories sit beside the domain they serve rather than in a shared `repositories/` directory, so files that change together live together.

---

### Task 1: Workspace scaffolding and test harness

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `.gitignore`
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/vitest.config.ts`
- Test: `apps/api/test/harness.spec.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: a working `pnpm test` at the repo root; `@idm/api` workspace package

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/harness.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'

describe('test harness', () => {
  it('runs TypeScript with decorator metadata enabled', () => {
    function Marker(): ClassDecorator {
      return (target) => {
        Reflect.defineMetadata('marker', 'present', target)
      }
    }

    @Marker()
    class Probe {}

    expect(Reflect.getMetadata('marker', Probe)).toBe('present')
  })
})
```

This is not a trivial smoke test: NestJS depends on emitted decorator metadata, and Vitest's default esbuild transform does **not** emit it. This test fails until the SWC plugin is configured correctly, catching the single most common NestJS+Vitest misconfiguration up front.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api test`
Expected: FAIL — the command itself does not exist yet.

- [ ] **Step 3: Create the workspace files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - 'apps/*'
```

`package.json`:
```json
{
  "name": "identity-manager",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "pnpm -r test",
    "build": "pnpm -r build"
  },
  "devDependencies": {
    "typescript": "^5.6.3"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

`.gitignore`:
```
node_modules/
dist/
.env
.env.local
playwright-report/
test-results/
```

`apps/api/package.json`:
```json
{
  "name": "@idm/api",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start:dev": "tsx watch src/main.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "reflect-metadata": "^0.2.2"
  },
  "devDependencies": {
    "@swc/core": "^1.7.35",
    "tsx": "^4.19.1",
    "typescript": "^5.6.3",
    "unplugin-swc": "^1.5.1",
    "vitest": "^2.1.3"
  }
}
```

`apps/api/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src/**/*", "test/**/*"]
}
```

`apps/api/vitest.config.ts`:
```ts
import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['reflect-metadata'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
})
```

The long timeouts are deliberate — later tasks start Docker containers inside tests.

- [ ] **Step 4: Install and run the test to verify it passes**

Run:
```bash
pnpm install
pnpm --filter @idm/api test
```
Expected: PASS — 1 test.

- [ ] **Step 5: Commit**

```bash
git add pnpm-workspace.yaml package.json tsconfig.base.json .gitignore apps/api
git commit -m "chore: scaffold pnpm workspace and NestJS-compatible test harness"
```

---

### Task 2: Dev environment — Postgres and Keycloak via Docker Compose

**Files:**
- Create: `docker-compose.yml`
- Create: `keycloak/realm-import/identity-manager-realm.json`
- Create: `.env.example`
- Test: `apps/api/test/dev-environment.spec.ts`

**Interfaces:**
- Consumes: Task 1 workspace
- Produces: realm `identity-manager` at `http://localhost:8080`, clients `idm-console` (public, PKCE), `idm-api` (bearer-only), `idm-test-client` (direct grant, dev/test only); Postgres at `localhost:5432` as `idm/identity_manager`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/dev-environment.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'

const DISCOVERY =
  'http://localhost:8080/realms/identity-manager/.well-known/openid-configuration'

describe('dev environment', () => {
  it('serves the identity-manager realm discovery document', async () => {
    const res = await fetch(DISCOVERY)
    expect(res.status).toBe(200)

    const doc = (await res.json()) as { issuer: string; jwks_uri: string }
    expect(doc.issuer).toBe('http://localhost:8080/realms/identity-manager')
    expect(doc.jwks_uri).toContain('/protocol/openid-connect/certs')
  })
})
```

Checking discovery rather than a bare health endpoint proves two things at once: Keycloak is running *and* the realm import actually applied.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api test dev-environment`
Expected: FAIL — `fetch failed` (connection refused).

- [ ] **Step 3: Create the compose file and realm import**

`docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: idm
      POSTGRES_PASSWORD: idm_dev_password
      POSTGRES_DB: identity_manager
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U idm -d identity_manager"]
      interval: 5s
      timeout: 3s
      retries: 10

  keycloak:
    image: quay.io/keycloak/keycloak:26.0
    command: ["start-dev", "--import-realm"]
    environment:
      KC_BOOTSTRAP_ADMIN_USERNAME: admin
      KC_BOOTSTRAP_ADMIN_PASSWORD: admin_dev_password
      KC_HEALTH_ENABLED: "true"
    ports:
      - "8080:8080"
      - "9000:9000"
    volumes:
      - ./keycloak/realm-import:/opt/keycloak/data/import:ro

volumes:
  pgdata:
```

Keycloak 26 uses `KC_BOOTSTRAP_ADMIN_USERNAME` / `KC_BOOTSTRAP_ADMIN_PASSWORD`. Older guides show `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD`, which are ignored on 26 and will leave you with no admin user.

`keycloak/realm-import/identity-manager-realm.json`:
```json
{
  "realm": "identity-manager",
  "enabled": true,
  "sslRequired": "none",
  "registrationAllowed": false,
  "loginWithEmailAllowed": true,
  "duplicateEmailsAllowed": false,
  "clients": [
    {
      "clientId": "idm-console",
      "name": "Identity Manager Console",
      "enabled": true,
      "publicClient": true,
      "standardFlowEnabled": true,
      "directAccessGrantsEnabled": false,
      "redirectUris": ["http://localhost:5173/*"],
      "webOrigins": ["http://localhost:5173"],
      "attributes": {
        "pkce.code.challenge.method": "S256",
        "post.logout.redirect.uris": "http://localhost:5173/*"
      },
      "protocolMappers": [
        {
          "name": "idm-api-audience",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-audience-mapper",
          "config": {
            "included.client.audience": "idm-api",
            "access.token.claim": "true",
            "id.token.claim": "false"
          }
        }
      ]
    },
    {
      "clientId": "idm-api",
      "name": "Identity Manager API",
      "enabled": true,
      "bearerOnly": true,
      "publicClient": false
    },
    {
      "clientId": "idm-test-client",
      "name": "DEV/TEST ONLY - direct grant for automated tests",
      "enabled": true,
      "publicClient": true,
      "standardFlowEnabled": false,
      "directAccessGrantsEnabled": true,
      "protocolMappers": [
        {
          "name": "idm-api-audience",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-audience-mapper",
          "config": {
            "included.client.audience": "idm-api",
            "access.token.claim": "true",
            "id.token.claim": "false"
          }
        }
      ]
    }
  ],
  "users": [
    {
      "username": "admin@example.com",
      "email": "admin@example.com",
      "firstName": "Platform",
      "lastName": "Admin",
      "enabled": true,
      "emailVerified": true,
      "credentials": [
        { "type": "password", "value": "dev_password_change_me", "temporary": false }
      ]
    }
  ]
}
```

The audience mapper is required. Without it, access tokens carry no `idm-api` audience and the API guard in Task 8 rejects every request.

`idm-test-client` and the seeded user exist **only** for local development and automated tests. The production realm is provisioned separately and must contain neither.

`.env.example`:
```
DATABASE_URL=postgres://idm:idm_dev_password@localhost:5432/identity_manager
KEYCLOAK_ISSUER=http://localhost:8080/realms/identity-manager
KEYCLOAK_AUDIENCE=idm-api
PORT=3000
```

- [ ] **Step 4: Start the stack and run the test to verify it passes**

Run:
```bash
docker compose up -d
cp .env.example .env
pnpm --filter @idm/api test dev-environment
```
Expected: PASS. Keycloak takes 20–40s on first start; if the test fails with a connection error, wait and re-run.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml keycloak .env.example apps/api/test/dev-environment.spec.ts
git commit -m "feat: add Postgres and Keycloak dev environment with realm import"
```

---

### Task 3: NestJS application skeleton with validated config

**Files:**
- Create: `apps/api/src/config/env.ts`, `apps/api/src/health/health.controller.ts`, `apps/api/src/app.module.ts`, `apps/api/src/main.ts`
- Modify: `apps/api/package.json` (add NestJS dependencies)
- Test: `apps/api/test/health.spec.ts`, `apps/api/test/env.spec.ts`

**Interfaces:**
- Consumes: Task 1 workspace
- Produces:
  - `loadEnv(source: NodeJS.ProcessEnv): Env` where `Env = { databaseUrl: string; keycloakIssuer: string; keycloakAudience: string; port: number }`
  - `AppModule` — the root Nest module
  - `GET /health` → `200 { status: 'ok' }`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/env.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { loadEnv } from '../src/config/env'

const valid = {
  DATABASE_URL: 'postgres://idm:pw@localhost:5432/identity_manager',
  KEYCLOAK_ISSUER: 'http://localhost:8080/realms/identity-manager',
  KEYCLOAK_AUDIENCE: 'idm-api',
  PORT: '3000',
}

describe('loadEnv', () => {
  it('parses a valid environment', () => {
    expect(loadEnv(valid)).toEqual({
      databaseUrl: valid.DATABASE_URL,
      keycloakIssuer: valid.KEYCLOAK_ISSUER,
      keycloakAudience: 'idm-api',
      port: 3000,
    })
  })

  it('defaults the port when absent', () => {
    const { PORT, ...withoutPort } = valid
    expect(loadEnv(withoutPort).port).toBe(3000)
  })

  it('throws a descriptive error when DATABASE_URL is missing', () => {
    const { DATABASE_URL, ...broken } = valid
    expect(() => loadEnv(broken)).toThrow(/DATABASE_URL/)
  })

  it('rejects a non-URL issuer', () => {
    expect(() => loadEnv({ ...valid, KEYCLOAK_ISSUER: 'not-a-url' })).toThrow(
      /KEYCLOAK_ISSUER/,
    )
  })
})
```

Create `apps/api/test/health.spec.ts`:

```ts
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HealthController } from '../src/health/health.controller'

describe('GET /health', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it('returns ok', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200)
    expect(res.body).toEqual({ status: 'ok' })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @idm/api test env health`
Expected: FAIL — cannot resolve `../src/config/env` or `../src/health/health.controller`.

- [ ] **Step 3: Add dependencies and write the implementation**

Add to `apps/api/package.json` dependencies:
```json
"@nestjs/common": "^10.4.4",
"@nestjs/core": "^10.4.4",
"@nestjs/platform-express": "^10.4.4",
"rxjs": "^7.8.1",
"zod": "^3.23.8"
```

Add to devDependencies:
```json
"@nestjs/testing": "^10.4.4",
"@types/supertest": "^6.0.2",
"supertest": "^7.0.0"
```

Then run `pnpm install`.

`apps/api/src/config/env.ts`:
```ts
import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  KEYCLOAK_ISSUER: z.string().url('KEYCLOAK_ISSUER must be a valid URL'),
  KEYCLOAK_AUDIENCE: z.string().min(1, 'KEYCLOAK_AUDIENCE is required'),
  PORT: z.coerce.number().int().positive().default(3000),
})

export interface Env {
  databaseUrl: string
  keycloakIssuer: string
  keycloakAudience: string
  port: number
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
    port: parsed.data.PORT,
  }
}
```

The trailing-slash strip matters: Keycloak's `iss` claim never has one, and a mismatch fails token verification with a confusing error.

`apps/api/src/health/health.controller.ts`:
```ts
import { Controller, Get } from '@nestjs/common'

@Controller('health')
export class HealthController {
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' }
  }
}
```

`apps/api/src/app.module.ts`:
```ts
import { Module } from '@nestjs/common'
import { HealthController } from './health/health.controller'

@Module({
  controllers: [HealthController],
})
export class AppModule {}
```

`apps/api/src/main.ts`:
```ts
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { loadEnv } from './config/env'

async function bootstrap(): Promise<void> {
  const env = loadEnv(process.env)
  const app = await NestFactory.create(AppModule)
  app.enableCors({ origin: ['http://localhost:5173'], credentials: true })
  await app.listen(env.port)
}

void bootstrap()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @idm/api test env health`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat: add NestJS skeleton with Zod-validated config and health endpoint"
```

---

### Task 4: Database client, migration runner, and `ltree` extension

**Files:**
- Create: `apps/api/src/db/client.ts`, `apps/api/src/db/migrate.ts`, `apps/api/src/db/ltree.ts`, `apps/api/src/db/schema/index.ts`
- Create: `apps/api/drizzle.config.ts`
- Create: `apps/api/test/support/pg.ts`
- Modify: `apps/api/package.json` (Drizzle, pg, Testcontainers)
- Test: `apps/api/test/migrate.spec.ts`

**Interfaces:**
- Consumes: `loadEnv` (Task 3)
- Produces:
  - `createDbClient(databaseUrl: string): { db: NodePgDatabase<typeof schema>; pool: Pool }`
  - `runMigrations(pool: Pool): Promise<void>` — enables extensions, then applies Drizzle migrations
  - `ltree(name: string)` — Drizzle custom column type
  - `withTestDatabase()` — Vitest helper returning `{ db, pool }` against a throwaway container

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/migrate.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { withTestDatabase } from './support/pg'

describe('runMigrations', () => {
  const ctx = withTestDatabase()

  it('enables the ltree extension', async () => {
    const { rows } = await ctx.pool.query(
      `SELECT extname FROM pg_extension WHERE extname = 'ltree'`,
    )
    expect(rows).toHaveLength(1)
  })

  it('is idempotent when run twice', async () => {
    await expect(ctx.runMigrationsAgain()).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api test migrate`
Expected: FAIL — cannot resolve `./support/pg`.

- [ ] **Step 3: Add dependencies and write the implementation**

Add to `apps/api/package.json` dependencies:
```json
"drizzle-orm": "^0.36.0",
"pg": "^8.13.0"
```

devDependencies:
```json
"@testcontainers/postgresql": "^10.13.2",
"@types/pg": "^8.11.10",
"drizzle-kit": "^0.28.0",
"testcontainers": "^10.13.2"
```

Add script to `apps/api/package.json`:
```json
"db:generate": "drizzle-kit generate"
```

Then `pnpm install`.

`apps/api/src/db/ltree.ts`:
```ts
import { customType } from 'drizzle-orm/pg-core'

/**
 * Postgres `ltree` column. Labels must match [A-Za-z0-9_]+ and are
 * dot-separated; use `toLabel()` in the org-units repository to build them.
 */
export const ltree = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'ltree'
  },
})
```

`apps/api/src/db/schema/index.ts`:
```ts
// Barrel file — drizzle-kit reads this to discover every table.
// Each table lives in its own module; re-export them here as they are added.
export {}
```

`apps/api/src/db/client.ts`:
```ts
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema/index'

export interface DbClient {
  db: NodePgDatabase<typeof schema>
  pool: Pool
}

export function createDbClient(databaseUrl: string): DbClient {
  const pool = new Pool({ connectionString: databaseUrl })
  return { db: drizzle(pool, { schema }), pool }
}
```

`apps/api/src/db/migrate.ts`:
```ts
import { existsSync } from 'node:fs'
import path from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import type { Pool } from 'pg'

const REQUIRED_EXTENSIONS = ['ltree'] as const

/**
 * Resolved from the working directory rather than `__dirname`, because this
 * module runs under both tsx (CommonJS, `__dirname` defined) and Vitest's SWC
 * transform (ES modules, `__dirname` undefined). Every script that loads it
 * runs with apps/api as the working directory.
 */
export const MIGRATIONS_FOLDER = path.resolve(process.cwd(), 'src/db/migrations')

/**
 * Extensions are created here rather than in a generated migration because
 * drizzle-kit does not emit CREATE EXTENSION statements. This runs first and
 * is safe to repeat.
 */
export async function runMigrations(pool: Pool): Promise<void> {
  for (const extension of REQUIRED_EXTENSIONS) {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS ${extension}`)
  }

  // No migrations have been generated yet at this point in the build order.
  // drizzle-kit creates the journal on its first `db:generate` run.
  if (!existsSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'))) {
    return
  }

  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER })
}
```

`apps/api/drizzle.config.ts`:
```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
})
```

`apps/api/test/support/pg.ts`:
```ts
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { afterAll, beforeAll } from 'vitest'
import { runMigrations } from '../../src/db/migrate'
import * as schema from '../../src/db/schema/index'

export interface TestDatabase {
  db: NodePgDatabase<typeof schema>
  pool: Pool
  runMigrationsAgain: () => Promise<void>
}

/**
 * Starts a throwaway Postgres container for the current test file and applies
 * all migrations. Real Postgres, never a mock — ltree, recursive CTEs, and
 * constraint behaviour cannot be faked.
 */
export function withTestDatabase(): TestDatabase {
  const ctx = {} as TestDatabase
  let container: StartedPostgreSqlContainer

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start()
    ctx.pool = new Pool({ connectionString: container.getConnectionUri() })
    ctx.db = drizzle(ctx.pool, { schema })
    ctx.runMigrationsAgain = () => runMigrations(ctx.pool)
    await runMigrations(ctx.pool)
  })

  afterAll(async () => {
    await ctx.pool?.end()
    await container?.stop()
  })

  return ctx
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @idm/api test migrate`
Expected: PASS — 2 tests. Docker must be running; first run pulls the Postgres image.

Do not hand-author the migrations folder or its journal — drizzle-kit creates
both on the first `db:generate` in Task 5, and a hand-written journal with the
wrong `version` field silently breaks migration tracking.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat: add Drizzle client, migration runner with ltree, and Testcontainers helper"
```

---

### Task 5: `org_units` schema and repository with `ltree` paths

**Files:**
- Create: `apps/api/src/db/schema/org-units.ts`, `apps/api/src/org-units/org-units.repository.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Test: `apps/api/test/org-units.repository.spec.ts`

**Interfaces:**
- Consumes: `withTestDatabase` (Task 4), `ltree` (Task 4)
- Produces:
  - `orgUnits` table export
  - `toLabel(name: string): string`
  - `class OrgUnitsRepository` with:
    - `createRoot(name: string): Promise<OrgUnit>`
    - `createChild(parentId: string, name: string): Promise<OrgUnit>`
    - `findById(id: string): Promise<OrgUnit | null>`
    - `findSubtree(rootId: string): Promise<OrgUnit[]>`
    - `isWithinScope(scopePath: string, targetPath: string): Promise<boolean>`
  - `interface OrgUnit { id: string; name: string; parentId: string | null; path: string; createdAt: Date; updatedAt: Date }`

`isWithinScope` is the primitive Milestone 3's permission engine is built on — it is introduced here because it is a property of the hierarchy, not of authorization.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/org-units.repository.spec.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { OrgUnitsRepository, toLabel } from '../src/org-units/org-units.repository'
import { orgUnits } from '../src/db/schema/org-units'
import { withTestDatabase } from './support/pg'

describe('toLabel', () => {
  it('lowercases and replaces unsafe characters with underscores', () => {
    expect(toLabel('Research & Development')).toBe('research_development')
  })

  it('collapses runs of separators', () => {
    expect(toLabel('Sales   ---  EMEA')).toBe('sales_emea')
  })

  it('rejects a name with no usable characters', () => {
    expect(() => toLabel('!!!')).toThrow(/valid ltree label/)
  })
})

describe('OrgUnitsRepository', () => {
  const ctx = withTestDatabase()
  let repo: OrgUnitsRepository

  beforeEach(async () => {
    await ctx.pool.query('TRUNCATE TABLE org_units CASCADE')
    repo = new OrgUnitsRepository(ctx.db)
  })

  it('creates a root whose path is its own label', async () => {
    const root = await repo.createRoot('Acme Corp')
    expect(root.parentId).toBeNull()
    expect(root.path).toBe('acme_corp')
  })

  it('creates a child whose path extends the parent path', async () => {
    const root = await repo.createRoot('Acme Corp')
    const sales = await repo.createChild(root.id, 'Sales')
    const emea = await repo.createChild(sales.id, 'EMEA')

    expect(sales.path).toBe('acme_corp.sales')
    expect(emea.path).toBe('acme_corp.sales.emea')
    expect(emea.parentId).toBe(sales.id)
  })

  it('returns the whole subtree including its root', async () => {
    const root = await repo.createRoot('Acme Corp')
    const sales = await repo.createChild(root.id, 'Sales')
    await repo.createChild(sales.id, 'EMEA')
    await repo.createChild(root.id, 'Engineering')

    const subtree = await repo.findSubtree(sales.id)
    expect(subtree.map((u) => u.path).sort()).toEqual([
      'acme_corp.sales',
      'acme_corp.sales.emea',
    ])
  })

  it('rejects two siblings that resolve to the same label', async () => {
    const root = await repo.createRoot('Acme Corp')
    await repo.createChild(root.id, 'Sales')
    await expect(repo.createChild(root.id, 'sales')).rejects.toThrow()
  })

  it('rejects a child of a nonexistent parent', async () => {
    await expect(
      repo.createChild('00000000-0000-0000-0000-000000000000', 'Orphan'),
    ).rejects.toThrow(/parent org unit not found/)
  })

  it('reports containment for scope checks', async () => {
    const root = await repo.createRoot('Acme Corp')
    const sales = await repo.createChild(root.id, 'Sales')
    const emea = await repo.createChild(sales.id, 'EMEA')
    const eng = await repo.createChild(root.id, 'Engineering')

    expect(await repo.isWithinScope(sales.path, emea.path)).toBe(true)
    expect(await repo.isWithinScope(sales.path, sales.path)).toBe(true)
    expect(await repo.isWithinScope(sales.path, eng.path)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api test org-units`
Expected: FAIL — cannot resolve `../src/org-units/org-units.repository`.

- [ ] **Step 3: Write the implementation**

`apps/api/src/db/schema/org-units.ts`:
```ts
import {
  type AnyPgColumn,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { ltree } from '../ltree'

export const orgUnits = pgTable(
  'org_units',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => orgUnits.id, {
      onDelete: 'restrict',
    }),
    path: ltree('path').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pathGist: index('org_units_path_gist').using('gist', table.path),
    pathUnique: uniqueIndex('org_units_path_unique').on(table.path),
  }),
)
```

The unique index on `path` is what enforces sibling-name uniqueness — two siblings with the same label would produce identical paths.

Update `apps/api/src/db/schema/index.ts`:
```ts
export * from './org-units'
```

`apps/api/src/org-units/org-units.repository.ts`:
```ts
import { eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../db/schema/index'
import { orgUnits } from '../db/schema/org-units'

export interface OrgUnit {
  id: string
  name: string
  parentId: string | null
  path: string
  createdAt: Date
  updatedAt: Date
}

/**
 * Converts a human name into a single valid ltree label.
 * ltree labels permit only [A-Za-z0-9_].
 */
export function toLabel(name: string): string {
  const label = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

  if (label.length === 0) {
    throw new Error(`"${name}" does not contain a valid ltree label`)
  }

  return label
}

export class OrgUnitsRepository {
  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async createRoot(name: string): Promise<OrgUnit> {
    const [row] = await this.db
      .insert(orgUnits)
      .values({ name, parentId: null, path: toLabel(name) })
      .returning()

    return row as OrgUnit
  }

  async createChild(parentId: string, name: string): Promise<OrgUnit> {
    const parent = await this.findById(parentId)
    if (parent === null) {
      throw new Error(`parent org unit not found: ${parentId}`)
    }

    const [row] = await this.db
      .insert(orgUnits)
      .values({
        name,
        parentId,
        path: `${parent.path}.${toLabel(name)}`,
      })
      .returning()

    return row as OrgUnit
  }

  async findById(id: string): Promise<OrgUnit | null> {
    const [row] = await this.db
      .select()
      .from(orgUnits)
      .where(eq(orgUnits.id, id))
      .limit(1)

    return (row as OrgUnit | undefined) ?? null
  }

  async findSubtree(rootId: string): Promise<OrgUnit[]> {
    const root = await this.findById(rootId)
    if (root === null) {
      return []
    }

    const rows = await this.db
      .select()
      .from(orgUnits)
      .where(sql`${orgUnits.path} <@ ${root.path}::ltree`)

    return rows as OrgUnit[]
  }

  /**
   * True when `targetPath` is `scopePath` or a descendant of it. This is the
   * single indexed containment check the scoped permission engine relies on.
   */
  async isWithinScope(scopePath: string, targetPath: string): Promise<boolean> {
    const { rows } = await this.db.execute<{ contained: boolean }>(
      sql`SELECT ${targetPath}::ltree <@ ${scopePath}::ltree AS contained`,
    )

    return rows[0]?.contained ?? false
  }
}
```

- [ ] **Step 4: Generate the migration and run the tests**

Run:
```bash
pnpm --filter @idm/api db:generate
pnpm --filter @idm/api test org-units
```
Expected: PASS — 9 tests.

If `db:generate` reports no schema changes, confirm `src/db/schema/index.ts` re-exports `./org-units`.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat: add org_units schema and repository with ltree hierarchy"
```

---

### Task 6: `users` schema and repository with lifecycle transitions

**Files:**
- Create: `apps/api/src/db/schema/users.ts`, `apps/api/src/users/users.repository.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Test: `apps/api/test/users.repository.spec.ts`

**Interfaces:**
- Consumes: `orgUnits` (Task 5), `withTestDatabase` (Task 4)
- Produces:
  - `users` table export, `userStatus` pg enum
  - `type UserStatus = 'pending' | 'active' | 'suspended' | 'deactivated'`
  - `class UsersRepository` with:
    - `create(input: CreateUserInput): Promise<User>`
    - `findById(id: string): Promise<User | null>`
    - `findByEmail(email: string): Promise<User | null>`
    - `changeStatus(id: string, next: UserStatus): Promise<User>`
  - `interface CreateUserInput { primaryEmail: string; username: string; firstName: string; lastName: string; orgUnitId: string; employeeId?: string; jobTitle?: string; managerId?: string; attributes?: Record<string, unknown> }`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/users.repository.spec.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

describe('UsersRepository', () => {
  const ctx = withTestDatabase()
  let users: UsersRepository
  let orgUnitId: string

  beforeEach(async () => {
    await ctx.pool.query('TRUNCATE TABLE users, org_units CASCADE')
    users = new UsersRepository(ctx.db)
    const orgUnits = new OrgUnitsRepository(ctx.db)
    orgUnitId = (await orgUnits.createRoot('Acme Corp')).id
  })

  const input = (overrides = {}) => ({
    primaryEmail: 'ada@example.com',
    username: 'ada',
    firstName: 'Ada',
    lastName: 'Lovelace',
    orgUnitId,
    ...overrides,
  })

  it('creates a user in pending status with a derived display name', async () => {
    const user = await users.create(input())
    expect(user.status).toBe('pending')
    expect(user.displayName).toBe('Ada Lovelace')
    expect(user.deactivatedAt).toBeNull()
  })

  it('stores custom attributes as JSONB', async () => {
    const user = await users.create(
      input({ attributes: { cost_center: 'CC-1024', remote: true } }),
    )
    const found = await users.findById(user.id)
    expect(found?.attributes).toEqual({ cost_center: 'CC-1024', remote: true })
  })

  it('rejects a duplicate primary email', async () => {
    await users.create(input())
    await expect(users.create(input({ username: 'ada2' }))).rejects.toThrow()
  })

  it('finds by email case-insensitively', async () => {
    await users.create(input())
    expect((await users.findByEmail('ADA@EXAMPLE.COM'))?.username).toBe('ada')
  })

  it('allows pending to active to suspended to deactivated', async () => {
    const user = await users.create(input())
    expect((await users.changeStatus(user.id, 'active')).status).toBe('active')
    expect((await users.changeStatus(user.id, 'suspended')).status).toBe('suspended')

    const done = await users.changeStatus(user.id, 'deactivated')
    expect(done.status).toBe('deactivated')
    expect(done.deactivatedAt).toBeInstanceOf(Date)
  })

  it('treats deactivated as terminal', async () => {
    const user = await users.create(input())
    await users.changeStatus(user.id, 'active')
    await users.changeStatus(user.id, 'deactivated')

    await expect(users.changeStatus(user.id, 'active')).rejects.toThrow(
      /deactivated is terminal/,
    )
  })

  it('rejects a transition straight from pending to suspended', async () => {
    const user = await users.create(input())
    await expect(users.changeStatus(user.id, 'suspended')).rejects.toThrow(
      /cannot transition/,
    )
  })

  it('exposes no delete operation', () => {
    expect((users as unknown as Record<string, unknown>).delete).toBeUndefined()
  })
})
```

The final test encodes a global constraint as an executable assertion rather than a comment.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api test users.repository`
Expected: FAIL — cannot resolve `../src/users/users.repository`.

- [ ] **Step 3: Write the implementation**

`apps/api/src/db/schema/users.ts`:
```ts
import {
  type AnyPgColumn,
  date,
  index,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgUnits } from './org-units'

export const userStatus = pgEnum('user_status', [
  'pending',
  'active',
  'suspended',
  'deactivated',
])

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    status: userStatus('status').notNull().default('pending'),
    primaryEmail: varchar('primary_email', { length: 320 }).notNull(),
    username: varchar('username', { length: 128 }).notNull(),
    firstName: varchar('first_name', { length: 128 }).notNull(),
    lastName: varchar('last_name', { length: 128 }).notNull(),
    displayName: varchar('display_name', { length: 256 }).notNull(),
    employeeId: varchar('employee_id', { length: 64 }),
    jobTitle: varchar('job_title', { length: 255 }),
    orgUnitId: uuid('org_unit_id')
      .notNull()
      .references(() => orgUnits.id, { onDelete: 'restrict' }),
    managerId: uuid('manager_id').references((): AnyPgColumn => users.id, {
      onDelete: 'set null',
    }),
    location: varchar('location', { length: 255 }),
    startDate: date('start_date'),
    endDate: date('end_date'),
    attributes: jsonb('attributes')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  },
  (table) => ({
    emailUnique: uniqueIndex('users_primary_email_unique').on(
      sql`lower(${table.primaryEmail})`,
    ),
    usernameUnique: uniqueIndex('users_username_unique').on(
      sql`lower(${table.username})`,
    ),
    employeeIdUnique: uniqueIndex('users_employee_id_unique')
      .on(table.employeeId)
      .where(sql`${table.employeeId} IS NOT NULL`),
    orgUnitIdx: index('users_org_unit_idx').on(table.orgUnitId),
  }),
)
```

There is deliberately no password column. Credentials live in Keycloak.

Update `apps/api/src/db/schema/index.ts`:
```ts
export * from './org-units'
export * from './users'
```

`apps/api/src/users/users.repository.ts`:
```ts
import { eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../db/schema/index'
import { users } from '../db/schema/users'

export type UserStatus = 'pending' | 'active' | 'suspended' | 'deactivated'

export interface User {
  id: string
  status: UserStatus
  primaryEmail: string
  username: string
  firstName: string
  lastName: string
  displayName: string
  employeeId: string | null
  jobTitle: string | null
  orgUnitId: string
  managerId: string | null
  location: string | null
  startDate: string | null
  endDate: string | null
  attributes: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
  deactivatedAt: Date | null
}

export interface CreateUserInput {
  primaryEmail: string
  username: string
  firstName: string
  lastName: string
  orgUnitId: string
  employeeId?: string
  jobTitle?: string
  managerId?: string
  location?: string
  startDate?: string
  endDate?: string
  attributes?: Record<string, unknown>
}

const ALLOWED_TRANSITIONS: Record<UserStatus, readonly UserStatus[]> = {
  pending: ['active'],
  active: ['suspended', 'deactivated'],
  suspended: ['active', 'deactivated'],
  deactivated: [],
}

export class UsersRepository {
  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async create(input: CreateUserInput): Promise<User> {
    const [row] = await this.db
      .insert(users)
      .values({
        primaryEmail: input.primaryEmail,
        username: input.username,
        firstName: input.firstName,
        lastName: input.lastName,
        displayName: `${input.firstName} ${input.lastName}`.trim(),
        orgUnitId: input.orgUnitId,
        employeeId: input.employeeId ?? null,
        jobTitle: input.jobTitle ?? null,
        managerId: input.managerId ?? null,
        location: input.location ?? null,
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
        attributes: input.attributes ?? {},
      })
      .returning()

    return row as User
  }

  async findById(id: string): Promise<User | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1)

    return (row as User | undefined) ?? null
  }

  async findByEmail(email: string): Promise<User | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.primaryEmail}) = lower(${email})`)
      .limit(1)

    return (row as User | undefined) ?? null
  }

  /**
   * There is no delete. Removal is a transition to `deactivated`, which is
   * terminal, so historical access questions stay answerable.
   */
  async changeStatus(id: string, next: UserStatus): Promise<User> {
    const current = await this.findById(id)
    if (current === null) {
      throw new Error(`user not found: ${id}`)
    }

    if (current.status === 'deactivated') {
      throw new Error('deactivated is terminal; the user cannot be reactivated')
    }

    if (!ALLOWED_TRANSITIONS[current.status].includes(next)) {
      throw new Error(`cannot transition from ${current.status} to ${next}`)
    }

    const [row] = await this.db
      .update(users)
      .set({
        status: next,
        updatedAt: new Date(),
        deactivatedAt: next === 'deactivated' ? new Date() : current.deactivatedAt,
      })
      .where(eq(users.id, id))
      .returning()

    return row as User
  }
}
```

- [ ] **Step 4: Generate the migration and run the tests**

Run:
```bash
pnpm --filter @idm/api db:generate
pnpm --filter @idm/api test users.repository
```
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat: add users schema and repository with lifecycle transitions"
```

---

### Task 7: `attribute_definitions` schema and validation engine

**Files:**
- Create: `apps/api/src/db/schema/attribute-definitions.ts`, `apps/api/src/attributes/attribute-validator.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Test: `apps/api/test/attribute-validator.spec.ts`

**Interfaces:**
- Consumes: `withTestDatabase` (Task 4)
- Produces:
  - `attributeDefinitions` table export, `attributeDataType` pg enum
  - `interface AttributeDefinition { key: string; label: string; dataType: 'string'|'number'|'boolean'|'date'|'enum'; required: boolean; validationRules: ValidationRules; appliesTo: 'user'|'group'; isActive: boolean; syncToKeycloak: boolean; selfEditable: boolean }`
  - `interface ValidationRules { minLength?: number; maxLength?: number; pattern?: string; min?: number; max?: number; options?: string[] }`
  - `buildAttributeSchema(definitions: AttributeDefinition[]): z.ZodType<Record<string, unknown>>`
  - `validateAttributes(definitions: AttributeDefinition[], value: unknown): Record<string, unknown>` — throws `AttributeValidationError`
  - `class AttributeValidationError extends Error { issues: string[] }`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/attribute-validator.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  AttributeValidationError,
  type AttributeDefinition,
  validateAttributes,
} from '../src/attributes/attribute-validator'

const def = (
  overrides: Partial<AttributeDefinition> & Pick<AttributeDefinition, 'key' | 'dataType'>,
): AttributeDefinition => ({
  label: overrides.key,
  required: false,
  validationRules: {},
  appliesTo: 'user',
  isActive: true,
  syncToKeycloak: false,
  selfEditable: false,
  ...overrides,
})

describe('validateAttributes', () => {
  it('accepts a valid payload and returns it', () => {
    const defs = [
      def({ key: 'cost_center', dataType: 'string' }),
      def({ key: 'headcount', dataType: 'number' }),
    ]
    expect(validateAttributes(defs, { cost_center: 'CC-1', headcount: 4 })).toEqual({
      cost_center: 'CC-1',
      headcount: 4,
    })
  })

  it('rejects a missing required attribute', () => {
    const defs = [def({ key: 'cost_center', dataType: 'string', required: true })]
    expect(() => validateAttributes(defs, {})).toThrow(AttributeValidationError)
  })

  it('rejects a wrong data type', () => {
    const defs = [def({ key: 'headcount', dataType: 'number' })]
    expect(() => validateAttributes(defs, { headcount: 'four' })).toThrow(
      /headcount/,
    )
  })

  it('rejects an unknown attribute key', () => {
    const defs = [def({ key: 'cost_center', dataType: 'string' })]
    expect(() => validateAttributes(defs, { salary: 100 })).toThrow(/salary/)
  })

  it('enforces string pattern and length rules', () => {
    const defs = [
      def({
        key: 'cost_center',
        dataType: 'string',
        validationRules: { pattern: '^CC-\\d{4}$', maxLength: 7 },
      }),
    ]
    expect(() => validateAttributes(defs, { cost_center: 'XX-1' })).toThrow(
      /cost_center/,
    )
    expect(validateAttributes(defs, { cost_center: 'CC-1024' })).toEqual({
      cost_center: 'CC-1024',
    })
  })

  it('enforces numeric bounds', () => {
    const defs = [
      def({ key: 'headcount', dataType: 'number', validationRules: { min: 1, max: 10 } }),
    ]
    expect(() => validateAttributes(defs, { headcount: 0 })).toThrow(/headcount/)
  })

  it('enforces enum options', () => {
    const defs = [
      def({
        key: 'contract',
        dataType: 'enum',
        validationRules: { options: ['permanent', 'contractor'] },
      }),
    ]
    expect(validateAttributes(defs, { contract: 'contractor' })).toEqual({
      contract: 'contractor',
    })
    expect(() => validateAttributes(defs, { contract: 'intern' })).toThrow(
      /contract/,
    )
  })

  it('validates dates as ISO calendar dates', () => {
    const defs = [def({ key: 'badge_issued', dataType: 'date' })]
    expect(validateAttributes(defs, { badge_issued: '2026-08-04' })).toEqual({
      badge_issued: '2026-08-04',
    })
    expect(() => validateAttributes(defs, { badge_issued: '04/08/2026' })).toThrow(
      /badge_issued/,
    )
  })

  it('ignores inactive definitions, treating their keys as unknown', () => {
    const defs = [def({ key: 'legacy_code', dataType: 'string', isActive: false })]
    expect(() => validateAttributes(defs, { legacy_code: 'x' })).toThrow(
      /legacy_code/,
    )
  })

  it('only applies definitions scoped to the matching entity', () => {
    const defs = [def({ key: 'group_owner', dataType: 'string', appliesTo: 'group' })]
    expect(() => validateAttributes(defs, { group_owner: 'x' })).toThrow(
      /group_owner/,
    )
  })

  it('collects every issue rather than stopping at the first', () => {
    const defs = [
      def({ key: 'a', dataType: 'string', required: true }),
      def({ key: 'b', dataType: 'number', required: true }),
    ]
    try {
      validateAttributes(defs, {})
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as AttributeValidationError).issues).toHaveLength(2)
    }
  })
})
```

Rejecting unknown keys is a deliberate security property, not strictness for its own sake: it prevents arbitrary un-modelled data being written into a record and later propagating outward.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api test attribute-validator`
Expected: FAIL — cannot resolve `../src/attributes/attribute-validator`.

- [ ] **Step 3: Write the implementation**

`apps/api/src/db/schema/attribute-definitions.ts`:
```ts
import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

export const attributeDataType = pgEnum('attribute_data_type', [
  'string',
  'number',
  'boolean',
  'date',
  'enum',
])

export const attributeAppliesTo = pgEnum('attribute_applies_to', ['user', 'group'])

export const attributeDefinitions = pgTable(
  'attribute_definitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: varchar('key', { length: 64 }).notNull(),
    label: varchar('label', { length: 255 }).notNull(),
    dataType: attributeDataType('data_type').notNull(),
    required: boolean('required').notNull().default(false),
    defaultValue: jsonb('default_value'),
    validationRules: jsonb('validation_rules')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    appliesTo: attributeAppliesTo('applies_to').notNull().default('user'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),

    // Default-deny: an attribute leaves this system only when explicitly
    // opted in, and is user-editable only when explicitly opted in.
    syncToKeycloak: boolean('sync_to_keycloak').notNull().default(false),
    selfEditable: boolean('self_editable').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    keyScopeUnique: uniqueIndex('attribute_definitions_key_scope_unique').on(
      table.key,
      table.appliesTo,
    ),
  }),
)
```

Update `apps/api/src/db/schema/index.ts`:
```ts
export * from './attribute-definitions'
export * from './org-units'
export * from './users'
```

`apps/api/src/attributes/attribute-validator.ts`:
```ts
import { z } from 'zod'

export type AttributeDataType = 'string' | 'number' | 'boolean' | 'date' | 'enum'

export interface ValidationRules {
  minLength?: number
  maxLength?: number
  pattern?: string
  min?: number
  max?: number
  options?: string[]
}

export interface AttributeDefinition {
  key: string
  label: string
  dataType: AttributeDataType
  required: boolean
  validationRules: ValidationRules
  appliesTo: 'user' | 'group'
  isActive: boolean
  syncToKeycloak: boolean
  selfEditable: boolean
}

export class AttributeValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`attribute validation failed: ${issues.join('; ')}`)
    this.name = 'AttributeValidationError'
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function fieldSchema(definition: AttributeDefinition): z.ZodTypeAny {
  const rules = definition.validationRules

  switch (definition.dataType) {
    case 'string': {
      let schema = z.string()
      if (rules.minLength !== undefined) schema = schema.min(rules.minLength)
      if (rules.maxLength !== undefined) schema = schema.max(rules.maxLength)
      if (rules.pattern !== undefined) schema = schema.regex(new RegExp(rules.pattern))
      return schema
    }
    case 'number': {
      let schema = z.number()
      if (rules.min !== undefined) schema = schema.min(rules.min)
      if (rules.max !== undefined) schema = schema.max(rules.max)
      return schema
    }
    case 'boolean':
      return z.boolean()
    case 'date':
      return z.string().regex(ISO_DATE, 'must be an ISO date (YYYY-MM-DD)')
    case 'enum': {
      const options = rules.options ?? []
      if (options.length === 0) {
        throw new Error(
          `enum attribute "${definition.key}" has no options configured`,
        )
      }
      return z.enum(options as [string, ...string[]])
    }
  }
}

/**
 * Builds a strict Zod object from the active definitions for one entity type.
 * Unknown keys are rejected: un-modelled data must never enter a record.
 */
export function buildAttributeSchema(
  definitions: AttributeDefinition[],
  appliesTo: 'user' | 'group' = 'user',
): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {}

  for (const definition of definitions) {
    if (!definition.isActive || definition.appliesTo !== appliesTo) {
      continue
    }

    const field = fieldSchema(definition)
    shape[definition.key] = definition.required ? field : field.optional()
  }

  return z.object(shape).strict() as z.ZodType<Record<string, unknown>>
}

export function validateAttributes(
  definitions: AttributeDefinition[],
  value: unknown,
  appliesTo: 'user' | 'group' = 'user',
): Record<string, unknown> {
  const result = buildAttributeSchema(definitions, appliesTo).safeParse(value ?? {})

  if (!result.success) {
    throw new AttributeValidationError(
      result.error.issues.map((issue) => {
        const key = issue.path.join('.')
        return key.length > 0 ? `${key}: ${issue.message}` : issue.message
      }),
    )
  }

  return result.data
}
```

Zod's `.strict()` reports unknown keys with the offending key in the message, which satisfies the `/salary/` and `/legacy_code/` assertions.

- [ ] **Step 4: Generate the migration and run the tests**

Run:
```bash
pnpm --filter @idm/api db:generate
pnpm --filter @idm/api test attribute-validator
```
Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat: add attribute definitions schema and strict validation engine"
```

---

### Task 8: Keycloak JWT guard and protected `/me` endpoint

**Files:**
- Create: `apps/api/src/auth/jwt.guard.ts`, `apps/api/src/auth/me.controller.ts`
- Create: `apps/api/test/support/keycloak.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/jwt.guard.spec.ts`

**Interfaces:**
- Consumes: `loadEnv` (Task 3), realm from Task 2
- Produces:
  - `class JwtGuard implements CanActivate` — verifies bearer tokens against Keycloak JWKS
  - `interface AuthenticatedRequest extends Request { principal: Principal }`
  - `interface Principal { subject: string; username: string; email: string | null }`
  - `GET /me` → `200 Principal`, `401` when unauthenticated
  - `startKeycloak()` test helper → `{ issuer, tokenFor(username, password) }`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/jwt.guard.spec.ts`:

```ts
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { JwtGuard } from '../src/auth/jwt.guard'
import { MeController } from '../src/auth/me.controller'
import { startKeycloak, type TestKeycloak } from './support/keycloak'

describe('JwtGuard on GET /me', () => {
  let app: INestApplication
  let keycloak: TestKeycloak
  let token: string

  beforeAll(async () => {
    keycloak = await startKeycloak()
    token = await keycloak.tokenFor('admin@example.com', 'dev_password_change_me')

    const moduleRef = await Test.createTestingModule({
      controllers: [MeController],
      providers: [
        {
          provide: JwtGuard,
          useValue: new JwtGuard({
            issuer: keycloak.issuer,
            audience: 'idm-api',
          }),
        },
      ],
    }).compile()

    app = moduleRef.createNestApplication()
    await app.init()
  })

  afterAll(async () => {
    await app?.close()
    await keycloak?.stop()
  })

  it('returns the principal for a valid token', async () => {
    const res = await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    expect(res.body.username).toBe('admin@example.com')
    expect(res.body.email).toBe('admin@example.com')
    expect(typeof res.body.subject).toBe('string')
  })

  it('rejects a request with no Authorization header', async () => {
    await request(app.getHttpServer()).get('/me').expect(401)
  })

  it('rejects a malformed Authorization header', async () => {
    await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', 'Basic abc123')
      .expect(401)
  })

  it('rejects a structurally valid but unsigned token', async () => {
    const forged = [
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'attacker' })).toString('base64url'),
      '',
    ].join('.')

    await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${forged}`)
      .expect(401)
  })

  it('rejects a token whose audience is wrong', async () => {
    const wrongAudience = new JwtGuard({
      issuer: keycloak.issuer,
      audience: 'some-other-api',
    })

    const moduleRef = await Test.createTestingModule({
      controllers: [MeController],
      providers: [{ provide: JwtGuard, useValue: wrongAudience }],
    }).compile()

    const strictApp = moduleRef.createNestApplication()
    await strictApp.init()

    await request(strictApp.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401)

    await strictApp.close()
  })
})
```

The `alg: none` case is tested explicitly — accepting unsigned tokens is a classic JWT vulnerability and must be proven closed, not assumed.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api test jwt.guard`
Expected: FAIL — cannot resolve `../src/auth/jwt.guard`.

- [ ] **Step 3: Add the dependency and write the implementation**

Add to `apps/api/package.json` dependencies:
```json
"jose": "^5.9.6"
```
Then `pnpm install`.

`apps/api/test/support/keycloak.ts`:
```ts
import path from 'node:path'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'

export interface TestKeycloak {
  issuer: string
  tokenFor: (username: string, password: string) => Promise<string>
  stop: () => Promise<void>
}

const REALM = 'identity-manager'

// Resolved from the working directory (apps/api) rather than `__dirname`,
// which Vitest's SWC/ESM transform does not define.
const REALM_IMPORT_DIR = path.resolve(process.cwd(), '../../keycloak/realm-import')

/**
 * Real Keycloak, imported with the project realm. The design depends on actual
 * Keycloak token behaviour, so mocking the JWKS would only validate our
 * assumptions about Keycloak rather than Keycloak itself.
 */
export async function startKeycloak(): Promise<TestKeycloak> {
  const container: StartedTestContainer = await new GenericContainer(
    'quay.io/keycloak/keycloak:26.0',
  )
    .withCommand(['start-dev', '--import-realm'])
    .withEnvironment({
      KC_BOOTSTRAP_ADMIN_USERNAME: 'admin',
      KC_BOOTSTRAP_ADMIN_PASSWORD: 'admin_dev_password',
    })
    .withCopyDirectoriesToContainer([
      { source: REALM_IMPORT_DIR, target: '/opt/keycloak/data/import' },
    ])
    .withExposedPorts(8080)
    .withWaitStrategy(
      Wait.forHttp(
        `/realms/${REALM}/.well-known/openid-configuration`,
        8080,
      ).withStartupTimeout(180_000),
    )
    .start()

  const issuer = `http://${container.getHost()}:${container.getMappedPort(8080)}/realms/${REALM}`

  return {
    issuer,

    async tokenFor(username: string, password: string): Promise<string> {
      const res = await fetch(`${issuer}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: 'idm-test-client',
          scope: 'openid profile email',
          username,
          password,
        }),
      })

      if (!res.ok) {
        throw new Error(`token request failed: ${res.status} ${await res.text()}`)
      }

      return ((await res.json()) as { access_token: string }).access_token
    },

    stop: () => container.stop(),
  }
}
```

`apps/api/src/auth/jwt.guard.ts`:
```ts
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { Request } from 'express'

export interface Principal {
  subject: string
  username: string
  email: string | null
}

export interface AuthenticatedRequest extends Request {
  principal: Principal
}

export interface JwtGuardOptions {
  issuer: string
  audience: string
}

@Injectable()
export class JwtGuard implements CanActivate {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>

  constructor(private readonly options: JwtGuardOptions) {
    this.jwks = createRemoteJWKSet(
      new URL(`${options.issuer}/protocol/openid-connect/certs`),
    )
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const header = request.headers.authorization

    if (header === undefined || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('missing bearer token')
    }

    const token = header.slice('Bearer '.length).trim()

    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        // Explicit allowlist. Never accept "none", and never let the token
        // choose its own verification algorithm.
        algorithms: ['RS256'],
      })

      request.principal = {
        subject: payload.sub ?? '',
        username: (payload.preferred_username as string | undefined) ?? '',
        email: (payload.email as string | undefined) ?? null,
      }

      return true
    } catch {
      throw new UnauthorizedException('invalid token')
    }
  }
}
```

`apps/api/src/auth/me.controller.ts`:
```ts
import { Controller, Get, Req, UseGuards } from '@nestjs/common'
import { JwtGuard, type AuthenticatedRequest, type Principal } from './jwt.guard'

@Controller('me')
@UseGuards(JwtGuard)
export class MeController {
  @Get()
  me(@Req() request: AuthenticatedRequest): Principal {
    return request.principal
  }
}
```

Wire it into `apps/api/src/app.module.ts`:
```ts
import { Module } from '@nestjs/common'
import { JwtGuard } from './auth/jwt.guard'
import { MeController } from './auth/me.controller'
import { loadEnv } from './config/env'
import { HealthController } from './health/health.controller'

@Module({
  controllers: [HealthController, MeController],
  providers: [
    {
      provide: JwtGuard,
      useFactory: () => {
        const env = loadEnv(process.env)
        return new JwtGuard({
          issuer: env.keycloakIssuer,
          audience: env.keycloakAudience,
        })
      },
    },
  ],
})
export class AppModule {}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @idm/api test jwt.guard`
Expected: PASS — 5 tests. The Keycloak container takes 30–60s to become ready on first run.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat: verify Keycloak JWTs and expose protected /me endpoint"
```

---

### Task 9: React console with OIDC login and end-to-end verification

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`
- Create: `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/auth/oidc-config.ts`
- Create: `apps/web/playwright.config.ts`, `apps/web/e2e/login.spec.ts`
- Create: `apps/web/.env.example`

**Interfaces:**
- Consumes: realm and `idm-console` client (Task 2), `GET /me` (Task 8)
- Produces: console at `http://localhost:5173` that signs in via Keycloak and renders the `/me` response

This is the spine test from the spec: a user authenticates through Keycloak and the API accepts the resulting token.

- [ ] **Step 1: Write the failing test**

Create `apps/web/e2e/login.spec.ts`:

```ts
import { expect, test } from '@playwright/test'

const USERNAME = 'admin@example.com'
const PASSWORD = 'dev_password_change_me'

test('signs in through Keycloak and reads the protected endpoint', async ({
  page,
}) => {
  await page.goto('/')

  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await page.getByRole('button', { name: 'Sign in' }).click()

  // Keycloak-hosted login page — this app has no login form of its own.
  await page.waitForURL(/\/realms\/identity-manager\/protocol\/openid-connect\/auth/)
  await page.getByLabel(/username|email/i).fill(USERNAME)
  await page.getByLabel(/password/i).fill(PASSWORD)
  await page.getByRole('button', { name: /sign in|log in/i }).click()

  await page.waitForURL('http://localhost:5173/')

  await expect(page.getByTestId('signed-in-as')).toHaveText(USERNAME)
  await expect(page.getByTestId('me-username')).toHaveText(USERNAME)
})

test('shows the signed-out state before authentication', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('me-username')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @idm/web test:e2e`
Expected: FAIL — the command does not exist yet.

- [ ] **Step 3: Write the implementation**

`apps/web/package.json`:
```json
{
  "name": "@idm/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "echo \"no unit tests yet\" && exit 0",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "oidc-client-ts": "^3.1.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-oidc-context": "^3.2.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.48.0",
    "@types/react": "^18.3.11",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.2",
    "typescript": "^5.6.3",
    "vite": "^5.4.9"
  }
}
```

The root `pnpm test` runs `pnpm -r test`; the placeholder `test` script keeps that green until this package has unit tests.

`apps/web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

`apps/web/vite.config.ts`:
```ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
})
```

`apps/web/.env.example`:
```
VITE_KEYCLOAK_ISSUER=http://localhost:8080/realms/identity-manager
VITE_KEYCLOAK_CLIENT_ID=idm-console
VITE_API_BASE_URL=http://localhost:3000
```

`apps/web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Identity Manager</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/src/auth/oidc-config.ts`:
```ts
import { WebStorageStateStore } from 'oidc-client-ts'
import type { AuthProviderProps } from 'react-oidc-context'

export const apiBaseUrl =
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000'

export const oidcConfig: AuthProviderProps = {
  authority: import.meta.env.VITE_KEYCLOAK_ISSUER,
  client_id: import.meta.env.VITE_KEYCLOAK_CLIENT_ID,
  redirect_uri: `${window.location.origin}/`,
  post_logout_redirect_uri: `${window.location.origin}/`,
  response_type: 'code',
  scope: 'openid profile email',
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  // Strip the ?code=&state= query params after the redirect completes.
  onSigninCallback: () => {
    window.history.replaceState({}, document.title, window.location.pathname)
  },
}
```

`apps/web/src/main.tsx`:
```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { AuthProvider } from 'react-oidc-context'
import App from './App'
import { oidcConfig } from './auth/oidc-config'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider {...oidcConfig}>
      <App />
    </AuthProvider>
  </React.StrictMode>,
)
```

`apps/web/src/App.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { apiBaseUrl } from './auth/oidc-config'

interface Principal {
  subject: string
  username: string
  email: string | null
}

export default function App() {
  const auth = useAuth()
  const [principal, setPrincipal] = useState<Principal | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!auth.isAuthenticated || auth.user == null) {
      setPrincipal(null)
      return
    }

    void fetch(`${apiBaseUrl}/me`, {
      headers: { Authorization: `Bearer ${auth.user.access_token}` },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`API returned ${res.status}`)
        setPrincipal((await res.json()) as Principal)
      })
      .catch((cause: Error) => setError(cause.message))
  }, [auth.isAuthenticated, auth.user])

  if (auth.isLoading) {
    return <p>Loading…</p>
  }

  if (!auth.isAuthenticated) {
    return (
      <main>
        <h1>Identity Manager</h1>
        <button type="button" onClick={() => void auth.signinRedirect()}>
          Sign in
        </button>
      </main>
    )
  }

  return (
    <main>
      <h1>Identity Manager</h1>
      <p>
        Signed in as{' '}
        <strong data-testid="signed-in-as">{auth.user?.profile.preferred_username}</strong>
      </p>

      {error !== null && <p role="alert">Could not reach the API: {error}</p>}

      {principal !== null && (
        <dl>
          <dt>API says username</dt>
          <dd data-testid="me-username">{principal.username}</dd>
          <dt>Subject</dt>
          <dd data-testid="me-subject">{principal.subject}</dd>
        </dl>
      )}

      <button type="button" onClick={() => void auth.signoutRedirect()}>
        Sign out
      </button>
    </main>
  )
}
```

`apps/web/playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
```

- [ ] **Step 4: Run the end-to-end test to verify it passes**

The API and the dev stack must both be running:
```bash
docker compose up -d
pnpm --filter @idm/api start:dev   # in a second terminal
cp apps/web/.env.example apps/web/.env
pnpm install
pnpm --filter @idm/web exec playwright install chromium
pnpm --filter @idm/web test:e2e
```
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat: add React console with Keycloak OIDC login and E2E login test"
```

---

## Milestone 1 Definition of Done

- [ ] `docker compose up -d` brings up Postgres and Keycloak with the realm imported
- [ ] `pnpm test` passes from the repo root (unit + Testcontainers integration)
- [ ] `pnpm --filter @idm/web test:e2e` passes
- [ ] Migrations create `org_units` (with `ltree` + GiST index), `users`, and `attribute_definitions`
- [ ] No password column, credential field, or login form exists anywhere in the codebase
- [ ] `sync_to_keycloak` and `self_editable` both default to `false`
- [ ] `UsersRepository` exposes no delete operation, and `deactivated` is terminal

## What Milestone 2 Builds On This

Groups with nested membership and effective-membership expansion, plus the HTTP layer for user and org-unit CRUD. It consumes `UsersRepository`, `OrgUnitsRepository`, `validateAttributes`, and `JwtGuard` unchanged.

Per the spec's build order, **no write endpoints are exposed to the console until Milestone 3 lands the RBAC engine and audit log.** Milestone 2's HTTP surface is read-only.
