import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../db/schema/index'
import { organizations } from '../db/schema/organizations'

/**
 * `<serverRoot>/realms/<realm>` — the same shape `KeycloakAdminClient`
 * already parses out of `config.issuer` (see its constructor). Kept as its
 * own exported function rather than reaching into that class because the
 * two callers want different halves of the result: the admin client needs
 * the SERVER ROOT to build `/admin/realms/...`, this needs only the realm
 * NAME to record on the master organization row.
 *
 * Built from `url.origin + url.pathname` rather than the raw string, so a
 * trailing `?x=y`, a `#fragment` or a default port written out explicitly
 * cannot change which realm this resolves to.
 */
export function realmFromIssuer(issuer: string): string {
  const url = new URL(issuer)
  const match = /^(.*)\/realms\/([^/]+)$/.exec(`${url.origin}${url.pathname}`)
  if (match === null) {
    throw new Error(`KEYCLOAK_ISSUER must contain /realms/<name>: ${issuer}`)
  }
  return match[2]
}

/**
 * Milestone: organizations multi-tenancy, Task 6 — master adopts the realm
 * it is already running against.
 *
 * Master's realm ALREADY EXISTS: it is the one named in `KEYCLOAK_ISSUER`,
 * the realm this API authenticates against and every existing user lives
 * in. So this makes NO Keycloak call and provisions nothing. It records,
 * exactly once, WHICH realm master is — the fact `organizations.realm` is
 * nullable for master alone (Task 1) exists to be filled in here, and it is
 * the only nullable window in the schema.
 *
 * Called from `main.ts` before `app.listen`, never from a Nest lifecycle
 * hook, for the same reason `SyncWorker.start()` is (see main.ts's own doc
 * comment): compiling or initialising `AppModule` in a test must have no
 * side effect, and app.module.spec.ts does exactly that. Placing it before
 * `listen` is also what makes a mismatch REFUSE TO SERVE traffic rather
 * than serve it wrongly.
 *
 * Idempotent by construction: the second call reads back the realm the
 * first call wrote, finds it equal, and returns without writing.
 */
export async function adoptMasterRealm(
  db: NodePgDatabase<typeof schema>,
  issuer: string,
): Promise<void> {
  const realm = realmFromIssuer(issuer)
  const [master] = await db.select().from(organizations).where(eq(organizations.isMaster, true))

  if (master === undefined) {
    // Not a "not found" a caller should handle gracefully — 0025 creates
    // this row, and `organizations_master_unique` guarantees there is never
    // more than one. Reaching here means the database predates the backfill.
    throw new Error(
      'no master organization exists — the organizations backfill migration has not been applied',
    )
  }

  if (master.realm === null) {
    await db
      .update(organizations)
      .set({ realm, updatedAt: new Date() })
      .where(eq(organizations.id, master.id))
    return
  }

  if (master.realm !== realm) {
    // Accepting this would silently re-point every existing user at a
    // different realm — one where none of their accounts exist. Every
    // connector derives its target from the organization's realm, so the
    // next sync pass would then try to create the entire directory afresh
    // in the new realm while the old one drifted, unmanaged, still holding
    // live credentials. A refusal to start is the only safe answer; the
    // operator either fixes KEYCLOAK_ISSUER or deliberately migrates the
    // row, and neither should happen by accident on a restart.
    throw new Error(
      `KEYCLOAK_ISSUER names realm "${realm}" but the master organization is bound to ` +
        `"${master.realm}". Refusing to start: changing it would re-point every existing user.`,
    )
  }
}
