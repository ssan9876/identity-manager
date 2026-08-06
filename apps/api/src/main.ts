import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { DomainExceptionFilter } from './common/domain-exception.filter'
import { loadEnv } from './config/env'
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
  const app = await NestFactory.create(AppModule)
  app.enableCors({ origin: ['http://localhost:5173'], credentials: true })
  app.useGlobalFilters(new DomainExceptionFilter())
  app.enableShutdownHooks()
  await app.listen(env.port)

  if (env.syncWorkerEnabled) {
    app.get(SyncWorker).start()
  }
}

void bootstrap()
