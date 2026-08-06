import { RoleAssignmentsRepository } from '../authz/role-assignments.repository'
import { loadEnv } from '../config/env'
import { createDbClient } from '../db/client'
import { OrgUnitsRepository } from '../org-units/org-units.repository'
import { UsersRepository } from '../users/users.repository'
import { bootstrapAdmin, DEFAULT_BOOTSTRAP_USERNAME } from './bootstrap-admin'

/**
 * The runtime entrypoint for `pnpm run bootstrap:admin` — see
 * bootstrap-admin.ts's own doc comment for what this does and why it is
 * deliberately kept out of the Nest DI graph and unreachable via HTTP.
 * Mirrors db/migrate-cli.ts, outbox/reconcile-cli.ts and
 * jml/lifecycle-cli.ts exactly: a plain `tsx` script, connected as the
 * RUNTIME role (finding H1, docs/superpowers/audit-integrity.md) — every
 * write this makes (create a user, activate it, grant a role) is ordinary
 * DML the runtime role already holds; this is operationally part of "the
 * application," not a schema-owning migration step.
 *
 * Username resolution: `process.argv.slice(2)`, filtering out any literal
 * `"--"` token before taking the first remaining argument. That token isn't
 * hypothetical — it is what pnpm's own arg-forwarding actually produces
 * here: the root `package.json`'s `bootstrap:admin` script is itself
 * `pnpm --filter @idm/api run bootstrap:admin --`, and running
 * `pnpm bootstrap:admin foo` at the repo root was confirmed (empirically,
 * against the installed pnpm) to deliver `process.argv.slice(2)` to this
 * file as `['--', 'foo']`, not `['foo']` — even though the identical inner
 * command typed directly, with no outer wrapper, strips the `--` correctly.
 * Filtering the token out here is robust to that regardless of pnpm version
 * or OS, and is a harmless no-op when it's absent (e.g. running this file
 * directly via `tsx`).
 */
function resolveUsername(): string {
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const [first] = args
  return first && first.trim().length > 0 ? first.trim() : DEFAULT_BOOTSTRAP_USERNAME
}

async function main(): Promise<void> {
  const env = loadEnv(process.env)
  const { db, pool } = createDbClient(env.runtimeDatabaseUrl, { max: env.dbPoolMax })

  try {
    const username = resolveUsername()
    const deps = {
      users: new UsersRepository(db),
      orgUnits: new OrgUnitsRepository(db),
      roleAssignments: new RoleAssignmentsRepository(db),
    }

    console.log(`[bootstrap:admin] bootstrapping "${username}" ...`)
    const result = await bootstrapAdmin(deps, username)

    for (const step of result.steps) {
      console.log(`[bootstrap:admin] ${step.changed ? '+' : '='} ${step.message}`)
    }

    const anyChange = result.steps.some((step) => step.changed)
    console.log(
      anyChange
        ? `[bootstrap:admin] done — "${username}" now has an active local account with global super_admin.`
        : `[bootstrap:admin] done — "${username}" already had everything it needed; nothing changed.`,
    )
    console.log('[bootstrap:admin] next: pnpm dev, then sign in as this user through Keycloak.')
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[bootstrap:admin] failed: ${message}`)
  process.exitCode = 1
})
