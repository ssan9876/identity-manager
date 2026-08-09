# Fix Wave E — database role separation (finding H1)

Branch: `fix/audit-critical-pool-exhaustion`, continuing from `c8fb15c` (Wave A —
pool-exhaustion deadlock), `19ee90a` (Wave B — authorization scope checks),
`abefeca` (Wave C — prototype elision, NUL handling, enumeration oracle), and
`cfb5438` (Wave D — remaining INTEGRITY/CONCURRENCY findings). Closes finding
H1 from `docs/archive/audits/audit-integrity.md`: the audit log's append-only
guarantee was enforced only by DML triggers, but the single database role
(`idm`) that served runtime traffic also owned `audit_log` and was a Postgres
superuser — so it could redefine or bypass the guard outright. The project
owner chose **database role separation** over documenting the limitation.

## The fix, in one sentence

Split one all-powerful database role into two: an **owner/migration role**
(`idm`, unchanged) that owns the schema and is the only credential
`db:migrate` ever uses, and a new **runtime role** (`idm_app`) that the
application, the sync worker, `reconcile`, `jml:lifecycle`, and `smoke:dev`
connect as instead — not a superuser, owns nothing, no `CREATE` on the
schema, full DML on ordinary tables but only `SELECT`/`INSERT` on
`audit_log`. The append-only guarantee is now a **privilege** property, not
just a trigger property — verified bypass-by-bypass below.

## What changed about the Postgres container

**Functionally, nothing about the container definition itself.** No new
service, no new environment variable, no `docker-entrypoint-initdb.d` script.
`docker-compose.yml`'s `postgres` service still boots exactly one bootstrap
role (`POSTGRES_USER=idm`) — that role is the OWNER, unchanged in name,
password, or (still-superuser) attributes. Only explanatory comments were
added to the compose file.

The runtime role is provisioned by **application code**, not by Docker: a
new `apps/api/src/db/roles.ts#provisionRuntimeRole`, called from
`runMigrations` (`apps/api/src/db/migrate.ts`) on every `db:migrate` run,
connected as the owner. It reads the runtime role's intended username/
password straight out of `RUNTIME_DATABASE_URL` (new env var — see below),
creates the role if it's missing (or re-asserts its password/attributes if
it already exists), and grants it exactly the privileges in the table below,
recomputing the table list fresh from `pg_tables` every time so a table
added by a future migration is covered automatically. This works identically
against this compose container, a CI Postgres, or a real managed instance
(RDS, Cloud SQL, ...) with no `docker-entrypoint-initdb.d` dependency — a
deliberate choice, since a real deployment likely won't have that mechanism
available at all.

**Why the container was still recreated.** To prove "migrations apply
cleanly to a database built from scratch under the new role setup" for
real, not just in the already-migrated dev stack, I stopped and removed
*only* the `postgres` service and its `identity-manager_pgdata` volume
(`docker compose stop postgres && docker compose rm -f postgres && docker
volume rm identity-manager_pgdata`), then `docker compose up -d postgres`
for a genuinely empty cluster. **The Keycloak container was never stopped,
restarted, or otherwise touched** — confirmed via `docker compose ps`
before and after (`identity-manager-keycloak-1`, "Up 11 hours" throughout).
This wiped whatever dev data was sitting in the shared Postgres from earlier
fix waves / the original audit's own live-verification runs — acceptable
per the README's own "must not be deployed to a real network" / "do not
point this build at a real organization's data" status, and exactly what
"recreating the postgres container is expected" anticipated. `db:migrate`
against the fresh container recreated all 11 tables and the runtime role
from nothing (evidence below).

## How a deployer sets this up

1. Provision one Postgres login to own the schema (superuser is fine for a
   dev/CI box; against a managed Postgres it needs at least `CREATEROLE`
   plus ownership/`CREATE` on the target database) and put its connection
   string in `DATABASE_URL`.
2. Pick a second username/password for the runtime role — it does **not**
   need to exist in Postgres yet — and put that connection string in
   `RUNTIME_DATABASE_URL`. Both are required, Zod-validated
   (`apps/api/src/config/env.ts`); either missing fails `loadEnv` outright.
3. Run `pnpm --filter @idm/api db:migrate` (connects as the OWNER). It
   applies schema migrations, then creates/updates the runtime role and its
   grants from `RUNTIME_DATABASE_URL`'s own credentials.
4. Start the app / sync worker / `reconcile` / `jml:lifecycle` / `smoke:dev`
   normally — they all read `RUNTIME_DATABASE_URL`, never `DATABASE_URL`,
   with **no fallback**: `app.module.ts`'s `DB_CLIENT` factory calls
   `createDbClient(env.runtimeDatabaseUrl, ...)` and nothing else, so a
   deployment that forgets to set `RUNTIME_DATABASE_URL` fails to boot
   instead of silently running with owner privileges.
5. Rotating the runtime password later is just editing `RUNTIME_DATABASE_URL`
   and re-running `db:migrate`.

Full detail (including the privilege table) is in README.md's new "Database
roles" section.

## Privilege model

| Grantee | Owns schema | `CREATE` on `public` | DML on ordinary tables | DML on `audit_log` |
|---|---|---|---|---|
| `idm` (OWNER) | yes | yes | yes | yes (see below) |
| `idm_app` (RUNTIME) | no | **no** | SELECT/INSERT/UPDATE/DELETE | **SELECT/INSERT only** |

`UPDATE`/`DELETE`/`TRUNCATE` on `audit_log` are explicitly `REVOKE`d from the
runtime role (never granted in the first place, but revoked anyway so
`\dp audit_log` shows the restriction). Sequence `USAGE`/`SELECT` granted
blanket across the schema (needed for the two `bigserial` PKs,
`audit_log.id` and `outbox_events.id`, to `nextval()` on INSERT).

## Proof: the eight-plus bypasses, re-run as the runtime role

Every statement below was run twice: empirically against the live dev
Postgres (via `docker exec ... psql -U idm_app`, to pin the exact error
text) and as a permanent regression test
(`apps/api/test/audit.spec.ts`, describe block `finding H1 — the runtime
role cannot bypass append-only via DDL or ownership`). **All fail. None
still succeed.**

| Bypass | Result as runtime role | Mechanism |
|---|---|---|
| `CREATE OR REPLACE FUNCTION audit_log_append_only() ... RETURN NULL` | **blocked** — `permission denied for schema public` | privilege (no `CREATE` on schema) |
| `ALTER TABLE audit_log DISABLE TRIGGER ALL` | **blocked** — `must be owner of table audit_log` | privilege (not owner) |
| `ALTER TABLE audit_log ALTER COLUMN action TYPE varchar(64) USING 'REDACTED'` | **blocked** — `must be owner of table audit_log` | privilege (not owner) |
| `ALTER TABLE audit_log ALTER COLUMN before TYPE jsonb USING '{}'::jsonb` | **blocked** — `must be owner of table audit_log` | privilege (not owner) |
| `ALTER TABLE audit_log DROP COLUMN before` | **blocked** — `must be owner of table audit_log` | privilege (not owner) |
| `SET session_replication_role = 'replica'` | **blocked** — `permission denied to set parameter "session_replication_role"` | privilege (superuser-only GUC) |
| `DROP TRIGGER audit_log_no_delete ON audit_log` | **blocked** — `must be owner of relation audit_log` | privilege (not owner) |
| `DROP TABLE audit_log CASCADE` | **blocked** — `must be owner of table audit_log` | privilege (not owner) |
| Rename-and-swap opener: `ALTER TABLE audit_log RENAME TO audit_log_old` | **blocked** — `must be owner of table audit_log` | privilege (not owner) — chain never reaches step 2 |
| Rewriting `CREATE OR REPLACE VIEW audit_log AS SELECT 1` | **blocked** — `permission denied for schema public` | privilege (no `CREATE` on schema) |
| Shadowing: `CREATE VIEW audit_log_shadow AS SELECT * FROM audit_log` | **blocked** — `permission denied for schema public` | privilege (no `CREATE` on schema) |
| Upsert-shaped: `INSERT ... ON CONFLICT (id) DO UPDATE SET action = ...` | **blocked** — `permission denied for table audit_log` | privilege (no UPDATE grant — Postgres checks this for the DO UPDATE branch regardless of whether any row conflicts) |
| Direct `UPDATE audit_log SET action = 'tampered'` | **blocked** — `permission denied for table audit_log` | privilege (no UPDATE grant) |
| Direct `DELETE FROM audit_log` | **blocked** — `permission denied for table audit_log` | privilege (no DELETE grant) |
| Direct `TRUNCATE audit_log` [CASCADE] | **blocked** — `permission denied for table audit_log` | privilege (no TRUNCATE grant) |

**What changed vs. before this wave:** every one of these used to be blocked
*only* by the append-only trigger (or, for the DDL rows, not blocked at
all). Now the DDL/ownership/schema-CREATE bypasses are closed by privilege
— a mechanism a non-owner, non-superuser role has no way to talk itself out
of — and the three plain-DML attacks (`UPDATE`/`DELETE`/`TRUNCATE`) are
blocked by privilege *before* Postgres ever reaches the trigger.

**The trigger is not dead weight — it's the defense for the OWNER role,**
which necessarily keeps full DML on its own table (ownership can't be
meaningfully revoked: an owner always retains implicit `GRANT OPTION` on
its own objects and can simply re-grant itself anything taken away).
Confirmed directly, both live (`docker exec ... psql -U idm`) and as a
permanent test (`audit.spec.ts`'s "the append-only trigger still blocks the
OWNER role directly" describe block, using the harness's new `ctx.ownerPool`):
`UPDATE`/`DELETE`/`TRUNCATE` as `idm` all still raise `audit_log is
append-only; <OP> is not permitted` from `audit_log_append_only()`, and
`pg_trigger` still shows all three triggers `tgenabled = 'O'`. Two
independent mechanisms — privilege for the runtime role, trigger for the
owner — so defeating one is not enough, exactly as asked.

**Honesty check — what this does *not* close.** The OWNER role (`idm`)
itself is unchanged: still database owner, still a Postgres superuser
(the official Postgres image's bootstrap-role default), still able to do
everything in the bypass table above. That is intentional, not an oversight
— the finding's threat model is explicitly "a party holding the
**application's own** database credentials," and the owner credential is
never that: it lives only in whoever runs `db:migrate` (an operator, offline,
out of band), never in the running application, the sync worker, or any of
the CLIs. A party who somehow obtains the *owner* credential specifically
(not the application's) is a different, larger compromise (equivalent to
root on the database), outside what a runtime-role restriction can address
by construction. The audit's other two fix directions for H1 — a hash chain
for tamper-*evidence*, or shipping audit rows to an external append-only
sink — are still open and were not attempted here; the task named database
role separation as the chosen option for this wave.

## Test harness changes

`apps/api/test/support/pg.ts`'s `withTestDatabase()` now creates **both**
roles in every throwaway Testcontainers Postgres, via the same
`runMigrations`/`provisionRuntimeRole` code path production uses (no
test-only duplicate logic to drift out of sync):

- `ctx.db`/`ctx.pool`/`ctx.connectionUri` — the handles nearly every existing
  test already used — now carry the **runtime** role. This is what makes the
  whole suite exercise the real, restricted privilege posture instead of a
  superuser one.
- `ctx.ownerDb`/`ctx.ownerPool`/`ctx.ownerConnectionUri` — new, for the rare
  test that legitimately needs elevated setup.

This surfaced exactly two real call sites (out of 51 spec files) that needed
the owner role for **test setup only** — the code under test in both stayed
on the runtime role:

- `permission.engine.spec.ts` / `privilege.guards.spec.ts` (7 call sites
  total): simulate `role_key` Postgres-enum drift via
  `ALTER TYPE role_key ADD VALUE ...` to test fail-closed behaviour against
  an unrecognized role. Widening an enum requires owning the type — moved to
  `ctx.ownerPool`; the INSERT using the new value and every method under
  test stayed on `ctx.pool` (runtime).
- `group-membership.spec.ts`: `TRUNCATE TABLE group_group_members CASCADE`
  between iterations of a 20-iteration concurrent-cycle race test. `TRUNCATE`
  was never part of the runtime role's grant on *any* table (only
  SELECT/INSERT/UPDATE/DELETE) — moved to `ctx.ownerPool`; `addChildGroup`
  (the code under test) stayed on `ctx.pool`.

This is exactly the shape the task anticipated ("if some existing test needs
the owner role for setup, that is fine, but the code under test must run as
the runtime role") and did **not** cascade into anything larger — no
repository, controller, or job code needed a single change to keep working
under the restricted role, because their DML was already exactly what the
runtime grant covers.

`audit.spec.ts`'s three pre-existing negative tests (`refuses UPDATE`/
`DELETE`/`TRUNCATE at the database level`) had their assertions updated:
they now expect `permission denied for table audit_log` (privilege) instead
of the trigger's `append-only` message, since `ctx.pool` is now the runtime
role and Postgres checks table privileges before it ever invokes a
`BEFORE` trigger. The behaviour (rejection) is unchanged; only which layer
rejects it first changed, and both layers now have direct test coverage.

## Files changed

Source: `apps/api/src/db/roles.ts` (new — `provisionRuntimeRole`,
`parseRoleCredentials`), `apps/api/src/db/migrate.ts`,
`apps/api/src/db/migrate-cli.ts`, `apps/api/src/config/env.ts`,
`apps/api/src/app.module.ts`, `apps/api/src/outbox/reconcile-cli.ts`,
`apps/api/src/jml/lifecycle-cli.ts`, `apps/api/scripts/smoke-dev.ts`,
`.env.example`, `.env` (gitignored, not part of this commit), `README.md`,
`docker-compose.yml` (comments only).

Tests: `apps/api/test/support/pg.ts`, `apps/api/test/audit.spec.ts`,
`apps/api/test/roles.spec.ts` (new), `apps/api/test/env.spec.ts`,
`apps/api/test/app.module.spec.ts`, `apps/api/test/group-membership.spec.ts`,
`apps/api/test/permission.engine.spec.ts`,
`apps/api/test/privilege.guards.spec.ts`.

No schema/migration file changed — `db:generate` reports no pending changes
(role/grant provisioning is imperative code in `migrate.ts`, not a
drizzle-generated SQL migration, matching how `enforceAuditAppendOnly`
already works).

## A note on scope beyond the letter of the brief

The brief says "the application and the sync worker connect as the runtime
role." I extended this to `reconcile-cli.ts`, `lifecycle-cli.ts`, and
`scripts/smoke-dev.ts`'s seeding as well: all three perform only ordinary
DML (reads, `users`/`role_assignments`/outbox writes, audit inserts) — none
need schema-owning privilege — and are operationally part of "the
application," not migration tooling. Giving them the owner credential would
have been a silent, unnecessary widening of exactly the blast radius this
wave exists to shrink. `smoke-dev.ts`'s seeding in particular doubles as a
live proof that the runtime role's grants are sufficient for real app-shaped
writes (create user, activate, assign a role, delete on cleanup) every time
it runs, not just a theoretical grant list.

## Verification

- `pnpm --filter @idm/api build`: exit 0 (run from repo root, canonical
  command).
- `pnpm --filter @idm/api test`: **51 files, 677 tests passed** (653
  baseline + 24 new: 19 in `audit.spec.ts`, 3 in the new `roles.spec.ts`, 2
  in `env.spec.ts`), run in full (194s, canonical command from repo root).
- `pnpm --filter @idm/api db:generate`: `No schema changes, nothing to
  migrate` — 11 tables listed, matches the pre-existing schema exactly.
- **From-scratch migration**: `postgres` container + `identity-manager_pgdata`
  volume removed (Keycloak untouched — confirmed via `docker compose ps`
  showing `identity-manager-keycloak-1` "Up 11 hours" continuously across
  the whole procedure), recreated empty, confirmed via `psql` to have zero
  tables and only the bootstrap `idm` role. `pnpm --filter @idm/api
  db:migrate` against it: all 11 tables created (owned by `idm`), `idm_app`
  created (`rolsuper = f`), `audit_log` grants exactly `SELECT,INSERT` to
  `idm_app` (`\dp audit_log` → `idm_app=ar/idm`), all three append-only
  triggers present and `tgenabled = 'O'`.
- `pnpm --filter @idm/api smoke:dev`: green, twice (once immediately after
  the from-scratch migration, once again after the live create/deactivate
  run below) — real `start:dev` under the runtime role, real Keycloak token,
  `GET /users` / `GET /groups` both 200.
- **Live create-then-deactivate** (real dev server via `pnpm run start:dev`,
  real Keycloak-issued token for `admin@example.com`, throwaway script
  deleted after, never committed):
  - `POST /users` → 201, `status: pending`.
  - SyncWorker (running under the runtime role) synced the new user into
    Keycloak within its normal poll interval — observed `enabled: false`
    (correct: not yet `active`).
  - `POST /users/:id/deactivate` (straight from `pending` — a legal
    transition since finding M5, Wave D) → 200, `status: deactivated`.
  - Synchronous Keycloak revocation succeeded directly — no
    "`synchronous Keycloak revocation failed`" fallback warning in server
    output.
  - `audit_log` holds exactly `user:create` and `user:deactivate` for this
    user — proving `AuditWriter`'s INSERT-only requirement is fully
    satisfied by the runtime role's restricted grant.
  - `outbox_events` holds the corresponding `created`/`status_changed` rows.
  - Cleanup deleted the target user/org unit it created; the seed actor
    (`admin@example.com`) was deliberately left in place once it performed
    an audited write — `audit_log.actor_user_id` (`ON DELETE RESTRICT`)
    makes it permanently un-deletable by design, exactly the guarantee this
    wave exists to make real, not a leak. `smoke:dev`'s own subsequent run
    confirmed it tolerates and reuses this leftover actor cleanly.
- Compose stack: `identity-manager-keycloak-1` never stopped/restarted
  (confirmed before/after via `docker compose ps`); `identity-manager-postgres-1`
  intentionally recreated (see above) and healthy throughout the rest of
  verification. Port 3000 confirmed free before and after every server boot.
- Working tree: `git status` shows only this wave's intended source/test
  diffs plus this report as untracked-then-added; the five other auditors'
  pre-existing untracked files (`audit-authz.md`, `audit-injection.md`,
  `audit-integrity.md`, `audit-secrets.md`, `security-audit-input.md`) left
  alone, matching prior waves' hygiene convention. `.env` was updated
  locally (adds `RUNTIME_DATABASE_URL`) but is gitignored and not part of
  this commit — `.env.example` carries the documented, non-secret template.

## Concerns / follow-ups (not fixed here, out of this wave's scope)

- The OWNER role remains a Postgres superuser (the official image's
  bootstrap-role default) — deliberately not hardened further, since it is
  never the credential the finding's threat model is about (see "Honesty
  check" above). A deployer using a managed Postgres where the master user
  is *not* a true superuser gets an even stronger owner boundary for free,
  with no code change needed here.
- The audit's other two H1 fix directions — a hash chain
  (`prev_hash`/`row_hash`) for tamper-*evidence*, and an external
  append-only sink — remain open. Role separation makes the guarantee real
  under the stated threat model; it does not make history tamper-evident
  against a compromised owner credential or a Postgres-level restore from a
  tampered backup.
- The audit's suggested `EVENT TRIGGER` on `ddl_command_start`/`sql_drop`
  (closing DDL for a non-superuser owner) was not added — moot for the
  current owner design (still superuser, so an event trigger can't stop it
  either), but worth revisiting if a future deployment makes the owner
  non-superuser.
- `reconcile-cli.ts`/`lifecycle-cli.ts`/`smoke-dev.ts` were moved to the
  runtime role as a deliberate scope extension (see above) — flagging in
  case that's considered outside what was asked, though I believe it's
  squarely in the spirit of the fix.
