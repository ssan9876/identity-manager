import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  // Carried papercut, fixed here (Milestone 11, Task 6). This config used to
  // start only the web dev server (`webServer.command: 'pnpm dev'`, a single
  // object, `cwd` defaulting to this file's own directory — i.e. `apps/web`'s
  // OWN "dev" script, `vite`, never the API's) — every E2E spec calls the API
  // directly at `VITE_API_BASE_URL` (no Vite proxy — see apps/web/.env.example),
  // so `test:e2e` silently depended on a human starting `apps/api`'s
  // `start:dev` by hand FIRST. Milestone 10 Task 2's own report first named
  // this gap (its "Concerns" #5) and left it unfixed as out of that task's
  // scope; Milestone 11 Task 5 hit the identical gap and worked around it
  // the same way, again without fixing it — two separate tasks paying the
  // same tax. Fixed for good here:
  //
  // `webServer` as an ARRAY starts BOTH the API and the web dev server,
  // CONCURRENTLY (Playwright's own documented behaviour for an array), and
  // waits for BOTH before running a single test. Each entry's `url` is a
  // REAL, application-level readiness probe, not "the port accepted a TCP
  // connection" — a check that can pass while a process is still mid-boot,
  // which is exactly the shape of flakiness this task was warned against.
  // The API's `/health` (health.controller.ts) is a dependency-free 200
  // that only ever answers once `app.listen()` has genuinely resolved — by
  // which point Nest's whole module graph is already wired up — so "the URL
  // answers" and "the API is actually ready to serve a real request" are
  // the same moment here; this is the identical endpoint
  // apps/api/scripts/smoke-dev.ts already polls for the identical reason,
  // not a new, unproven readiness signal invented for this file.
  //
  // The API entry runs `start:e2e`, NOT the human-facing `start:dev` —
  // discovered empirically while proving this fix from a cold start:
  // `start:dev`'s `node --watch` supervises the real listener in a CHILD
  // process with its own PID (confirmed via `tasklist`/`netstat`), the
  // SAME multi-process shape apps/api/scripts/smoke-dev.ts's own
  // `killPid`/`listeningPids` doc comment already names as needing a
  // belt-and-braces `taskkill /T /F`. Playwright's own webServer teardown
  // has no hook to run project-specific cleanup like that — it just
  // terminates the process IT spawned — so with `start:dev` a real API
  // process was left LISTENING on :3000 after every `test:e2e` run,
  // silently failing this project's own "ports 3000/5173 free" exit
  // condition. `start:e2e` is the identical entrypoint with no `--watch`
  // (file-watching is a development convenience `test:e2e`'s one-shot run
  // never benefits from) — one process, one PID, cleanly killable, nothing
  // orphaned. `start:dev` itself is untouched; human developers running
  // `pnpm dev` still get the watch behaviour they expect.
  webServer: [
    {
      command: 'pnpm --filter @idm/api run start:e2e',
      url: 'http://localhost:3000/health',
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @idm/web run dev',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
})
