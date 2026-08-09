import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module'
import { DomainExceptionFilter } from './common/domain-exception.filter'
import { payloadTooLargeMiddleware } from './common/http/payload-too-large.middleware'
import { DB_CLIENT } from './common/db.token'
import { loadEnv } from './config/env'
import { adoptMasterRealm } from './organizations/master-organization'
import { SyncWorker } from './outbox/sync.worker'

/**
 * The only place `SyncWorker.start()` is ever called (Milestone 4, Task 4)
 * — deliberately not a Nest lifecycle hook on the worker itself, so that
 * compiling/initialising `AppModule` (as every test that needs the real DI
 * graph does, e.g. app.module.spec.ts) constructs an inert worker instance
 * that never actually starts polling. `main.ts` is the real dev/prod
 * entrypoint (`start:dev` runs exactly this file) and is never imported or
 * executed by `vitest run` — no spec file references it — so gating
 * `start()` here, rather than in AppModule, is what keeps every test free
 * of background outbox polling regardless of `SYNC_WORKER_ENABLED`'s value.
 *
 * `app.enableShutdownHooks()` makes Nest translate SIGTERM/SIGINT into
 * `app.close()`, which fires `SyncWorker.onApplicationShutdown` — see its
 * doc comment for why that is safe to leave wired unconditionally.
 */
async function bootstrap(): Promise<void> {
  const env = loadEnv(process.env)

  // `bodyParser: false` + explicit `useBodyParser` calls below — finding M6
  // (docs/archive/audits/audit-integrity.md): letting Nest register its OWN
  // default parser first (the ordinary `NestFactory.create(AppModule)` path
  // every other controller in this codebase implicitly relied on) leaves
  // express's accidental 100 KiB default in place; a SECOND parser
  // registered afterward via `useBodyParser` never gets a chance to apply
  // its own limit, because express's `body-parser` skips re-parsing a
  // request whose body a PRIOR middleware already consumed. Disabling the
  // default and registering both parsers ourselves is what makes
  // `BODY_LIMIT_BYTES` the one, explicit, configurable limit actually in
  // effect, replacing the accidental one rather than merely sitting beside
  // it unused.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false })
  app.useBodyParser('json', { limit: env.bodyLimitBytes })
  app.useBodyParser('urlencoded', { limit: env.bodyLimitBytes, extended: true })
  app.use(payloadTooLargeMiddleware(env.bodyLimitBytes))

  app.enableCors({ origin: ['http://localhost:5173'], credentials: true })
  app.useGlobalFilters(new DomainExceptionFilter())
  app.enableShutdownHooks()

  // Milestone: organizations multi-tenancy, Task 6. BEFORE `listen`, so that
  // an issuer naming a realm other than the one master is bound to refuses
  // to serve traffic rather than serving it wrongly. Makes no Keycloak call
  // — master's realm already exists; this only records which one it is.
  //
  // Here rather than in a Nest lifecycle hook for the same reason
  // `SyncWorker.start()` is here: initialising AppModule in a test must
  // have no side effect on any database.
  await adoptMasterRealm(app.get(DB_CLIENT), env.keycloakIssuer)

  await app.listen(env.port)

  if (env.syncWorkerEnabled) {
    app.get(SyncWorker).start()
  }
}

void bootstrap()
