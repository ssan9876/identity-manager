# 11 — Operations

## Command reference

Run from the repo root unless noted. On an installed host, prefix with the env file:

```bash
cd /opt/identity-manager
sudo -u idm bash -c 'set -a && . .env && set +a && <command>'
```

### Workspace-level

| Command | What it does |
|---|---|
| `pnpm setup:all` | Dev only — Compose stack, deps, env files, migrations |
| `pnpm bootstrap:admin [username]` | Create/activate a local admin and grant global `super_admin`. Idempotent. |
| `pnpm dev` | Run the API and console together |
| `pnpm build` | Build both packages |
| `pnpm typecheck` | Typecheck both packages |
| `pnpm test` | All package tests |
| `pnpm verify` | Full gate, in order: typecheck → lint (if configured) → build → web checks → docs checks → API suite. `scripts/verify.mjs` |
| `pnpm verify:quick` | The same gate with the **API suite** skipped — everything up to and including the docs checks, and nothing needing Docker |
| `pnpm check:docs` | Docs guard on its own: `scripts/extract-doc-facts.test.mjs` then `scripts/check-docs.mjs`. Fails when a document claims something the code contradicts. No containers |

### Installed-host scripts (run as root, on the machine)

| Command | What it does |
|---|---|
| `bash scripts/install.sh` | First install. See [05 — Installation](05-installation.md). |
| `bash scripts/update.sh` | Upgrade in place — pull, rebuild, back up, migrate, **re-render `deploy/`**, restart, verify. See "Upgrading a deployed host" below. |
| `bash scripts/keycloak-setup.sh` | Create/repair the realm, clients and the sync account. |
| `sudo -u postgres bash scripts/backup.sh` | Take one database dump now and prune old ones. Normally driven by `idm-backup.timer`. Run by hand it has **no `.env`** — the timer's unit supplies `DATABASE_URL` through `EnvironmentFile=`, and the `postgres` user cannot read that file — so it falls back to the database name `identity_manager`. On a host whose `.env` names something else, pass `DB_NAME=<name>`. See "Backup and restore" below. |

### API package (`pnpm --filter @idm/api …`)

| Command | What it does |
|---|---|
| `db:migrate` | Apply migrations **and** provision/re-grant the runtime role |
| `db:generate` | Generate a migration from schema changes (drizzle-kit) |
| `reconcile` | Walk users, compare against Keycloak, report drift, enqueue corrections |
| `target-reconcile <target> [--apply] [--force]` | Reconcile one connector target. The target is **required** and must be a directory target — see [the target list](#which-targets-target-reconcile-accepts) below. **Dry run is the default.** |
| `role-reconcile [<roleId>\|--role=<id>]` | Re-derive every user's business-role entitlements and grant/revoke to match, then report standing segregation-of-duties violations. With no argument it sweeps every **enabled** role; naming one narrows the log label, not the work. **No dry-run flag** — it only writes rows this database can derive again, and the preview that matters is the role's own *simulate* before publish. Exits non-zero if it *refused* any user (an unevaluable role), so a scheduled run shows up in the journal as a failure. |
| `hr:sync <source> --actor=<username> [--commit] [--allow-partial] [--force]` | Pull one HR source (by id or name) through the import pipeline: preview, blast-radius check, then create/update people. **Dry run is the default** — `--commit` is the only thing that writes. `--actor` is **required** and resolves to a real active user, so the run holds exactly that person's authority and every audit row is attributed. |
| `jml:lifecycle` | Apply date-driven joiner/leaver transitions and fire rules |
| `activate (--all \| --org-unit=<uuid>) [--apply]` | Bulk-activate `pending` users, whole directory or one subtree and its descendants. **Dry run is the default**, and the scope must be typed — there is no way to mean "everyone" by omitting an argument. |
| `smoke:dev` | Boot the real dev server and exercise it over HTTP |
| `smoke:mail` | Contract check against a real mail server |
| `e2e:cleanup` | Remove records left by the Playwright suite |
| `start:dev` | API only, with `--watch` |

**Passing flags.** A bare positional argument goes straight through
(`pnpm --filter @idm/api target-reconcile echo`), but anything starting with `--` has to
be forwarded past pnpm: `pnpm --filter @idm/api run activate -- --all --apply`. The
separator is always safe to include: the CLIs in this document that parse arguments at all
— `target-reconcile`, `role-reconcile`, `hr:sync`, `activate` and `bootstrap:admin` —
each filter a literal `--` out of their own argument list, and `db:migrate`,
`reconcile` and `jml:lifecycle` never read `process.argv`, so they ignore it along with
everything else you pass them.

### Web package (`pnpm --filter @idm/web …`)

| Command | What it does |
|---|---|
| `dev` | Vite dev server on 5173 |
| `build` | Typecheck + production bundle |
| `test` | Three static checks, no browser: CSS design-token check, connector-target catalog drift check (`check-connector-targets.mjs`, against the API's `ALL_CONNECTOR_TARGETS`), and the CSP hash check |
| `test:e2e` | Playwright suite |

## Scheduled work

There is **no scheduler in the process**. **Most** recurring jobs are a plain script
driven by a systemd timer the installer sets up and enables for you — nothing to write by
hand, and nothing to add to a crontab. But **three commands are exceptions**, and only the
first is one by design:

- `target-reconcile` stays manual **deliberately**. See "Per-target reconciliation stays
  manual" below for why putting it on a timer would defeat the guards it was given.
- `role-reconcile` and `hr:sync` ship **no unit at all** — there are seven files in
  `deploy/systemd/` and none of them is theirs. **Nothing runs either one until somebody
  does**, by hand or from a timer you write yourself.

So the table below is the complete list of what this host does on a schedule, not the
complete list of recurring work.

| Timer | Fires | What it does |
|---|---|---|
| `idm-backup.timer` | 01:00 daily | `pg_dump` into `/var/backups/identity-manager`, then prune |
| `idm-lifecycle.timer` | 02:00 daily | Joiner activation, leaver deactivation |
| `idm-reconcile.timer` | 03:00 daily | Keycloak drift detection and repair |

The order is deliberate. The backup runs first so the night's restore point predates the
automated writes the other two make — which is what you want on the morning one of those
passes turns out to be the problem.

Three timers, three oneshot services behind them, and `idm-api.service` — **seven units**
in `deploy/systemd/`, all seven rendered into `/etc/systemd/system/` by `install.sh` and
`update.sh`.

```bash
systemctl list-timers 'idm-*'   # all three, with next and last fire times
ls -1 /etc/systemd/system/idm-*.service /etc/systemd/system/idm-*.timer   # all seven
```

### Database backup — installed as a daily timer

Postgres holds every durable thing this system knows, including an append-only
`audit_log` that by design cannot be reconstructed after the fact. Until this timer
existed the only `pg_dump` anywhere on a host was the pre-update one `scripts/update.sh`
takes, so the newest backup on a dead host was from whenever somebody last chose to
upgrade — and the recovery story was "reinstall and re-enter everyone".

`scripts/install.sh` installs `idm-backup.service` and `idm-backup.timer` from
`deploy/systemd/` in the same loop as the other units, and enables the **timer**.

```bash
systemctl list-timers idm-backup.timer      # confirm it is armed
systemctl start idm-backup.service          # take one dump now
journalctl -u idm-backup -n 20              # what the last dump did
ls -l /var/backups/identity-manager         # the dumps themselves
```

It fires at 01:00 daily with `Persistent=true` (a host powered off at 01:00 takes the
missed dump on next boot) and up to five minutes of jitter. It runs
`scripts/backup.sh` **as the `postgres` user**, not as `idm`: the dump goes over
Postgres' local peer authentication, and the `idm_app` runtime role deliberately does not
hold the privileges a whole-database dump needs. The unit is confined by
`ProtectSystem=strict` with a single writable path, `/var/backups/identity-manager`.

See "Backup and restore" below for where the files land, how many are kept, and how to
restore one.

### Lifecycle — installed as a daily timer

`scripts/install.sh` installs `idm-lifecycle.service` and `idm-lifecycle.timer` from
`deploy/systemd/` alongside the API unit, and enables the **timer**. Nothing to write by
hand.

```bash
systemctl list-timers idm-lifecycle.timer   # confirm it is armed
systemctl start idm-lifecycle.service       # run one pass now
journalctl -u idm-lifecycle -n 50           # what the last pass did
```

To run it manually against any environment:

```bash
pnpm --filter @idm/api jml:lifecycle
```

- Activates users whose `start_date` has arrived (`pending → active`).
- Deactivates users whose `end_date` has passed.
- Fires `start_date_reached` / `end_date_reached` rules for exactly the users it
  transitioned.

**Idempotent by construction**, not by a tracked flag: it re-derives "who is due" from
queries whose `WHERE` clauses (`status = 'pending'`, `status <> 'deactivated'`) exclude
anyone a prior run already handled. A second run the same day transitions nobody, writes
no audit rows, and fires no rules.

Rule-firing happens **inline** with each transition, so a user appears in that loop on
the one run that actually transitions them — each date rule fires exactly once per user,
ever, with no extra bookkeeping.

It reports `skipped` — every due user it selected but could not transition, with a
reason. **A clean run has an empty list.** Anything in it is a genuine race worth
looking at.

The timer fires at 02:00 daily with `Persistent=true`, so a host that was powered off
at 02:00 runs the missed pass on next boot rather than skipping a day, plus a jittered
delay of up to five minutes. It runs the compiled output as the `idm` user under the
same hardening block as the API unit — see `deploy/systemd/idm-lifecycle.service` for
the units themselves and the reasoning in their comments.

> **This was a real outage, not a hypothetical.** Until 2026-08-08 this section told you
> to hand-write those units, and the timer had never actually been installed on any
> host. Nothing invoked the lifecycle job, so every joiner with a `start_date` stayed
> `pending` forever — and because each connector derives `desiredEnabled` from
> `status === 'active'`, those people were asserted into Keycloak and every other target
> as **disabled accounts** and left that way. If you are upgrading a host installed
> before that date, run `scripts/update.sh` (it renders every unit in `deploy/systemd/`
> and enables every timer it finds) and then run one pass immediately to clear the
> backlog.

### Reconciliation — installed as a daily timer

A queue cannot detect drift someone caused directly inside a target. Reconciliation is
what catches a manually-disabled AD account or a group edited in the Keycloak console —
and it is the backstop a good deal of this system's residual risk is parked against, so
it needs to run whether or not anyone remembers to run it.

`scripts/install.sh` installs `idm-reconcile.service` and `idm-reconcile.timer` from
`deploy/systemd/` in the same loop as the lifecycle units, and enables the **timer**.

```bash
systemctl list-timers idm-reconcile.timer   # confirm it is armed
systemctl start idm-reconcile.service       # run one pass now
journalctl -u idm-reconcile -n 50           # what the last pass found and repaired
```

It fires at 03:00 daily — an hour after the lifecycle timer, so a night's status
transitions have settled before reconciliation decides what counts as drift — with
`Persistent=true` (a host powered off at 03:00 runs the missed pass on next boot) and up
to five minutes of jitter. It runs the compiled output as the `idm` user under the same
hardening block as the API unit — see `deploy/systemd/idm-reconcile.service` for the
units themselves and the reasoning in their comments.

The journal is the only report. A pass prints every drifted user with its reasons, then
how many repair events it enqueued and how many outbox events it drained; a clean run
says it found none. Nothing is written anywhere else, so drift that a run silently
repaired is invisible unless someone reads `journalctl -u idm-reconcile`.

**It compares against Keycloak only, and in one direction.** It walks `users` in Postgres
and checks each against Keycloak; an account that exists *only* in Keycloak is not seen,
not reported, and not disabled. That gap is open and tracked — this timer closes the
"nothing ever runs it" half of it, not that half.

To run it manually against any environment:

```bash
pnpm --filter @idm/api reconcile
```

**Per-target reconciliation stays manual**, and is deliberately not on a timer:

```bash
pnpm --filter @idm/api target-reconcile active_directory        # dry run first
pnpm --filter @idm/api run target-reconcile active_directory -- --apply
```

That is not an oversight. `target-reconcile` requires a target argument, applies nothing
unless given `--apply`, and has a blast-radius guard that `--force` exists to override.
Putting it on a timer would mean baking `--apply` into a unit file and — the first time
the guard tripped at 03:00 — `--force` after it, defeating the confirm-first design it
was given on purpose. Run it by hand, dry run first, after a connector incident or a bulk
change made at the target.

#### Which targets `target-reconcile` accepts

The catalog is **thirteen** values, closed and machine-checked: `ALL_CONNECTOR_TARGETS` in
`apps/api/src/connectors/connector.ts` is the single source of truth, and
`test/connector-target-catalog.spec.ts` asserts it matches the `outbox_target` and
`external_identity_system` pgEnums in both directions.

`target-reconcile` accepts **twelve** of them — `DIRECTORY_TARGETS`, which is the catalog
minus `keycloak_sso`:

| Target | Notes |
|---|---|
| `keycloak` | The identity provider itself. Also what the daily `reconcile` pass walks |
| `active_directory` | LDAPS only |
| `entra_id` | Microsoft Graph |
| `google_workspace` | Directory API |
| `mail_server` | The provisioning API — see "Mail server over a separate host" below |
| `echo` | In-repo test target. Real, configurable and enable-able like any other; it exercises the spine without touching a live directory |
| `scim_slack` | SCIM 2.0 |
| `scim_zoom` | SCIM 2.0 |
| `scim_atlassian` | SCIM 2.0 |
| `scim_box` | SCIM 2.0 |
| `scim_snowflake` | SCIM 2.0 |
| `scim_generic` | SCIM 2.0 |

Those six `scim_*` rows are **six target values sharing one adapter**
(`apps/api/src/connectors/scim.connector.ts`) — the protocol is identical and only the
base URL, the credential and the write mode differ. They are separate target values
rather than rows of a single `scim` target because `(organization_id, target)` is
`connector_targets`' primary key and `(user_id, system)` is unique in
`external_identities`, so one configured instance per target value is load-bearing for
the outbox and correlation design. Full detail in
[09 — Connectors and sync](09-connectors-and-sync.md) and
[06 — Configuration](06-configuration.md).

The thirteenth, **`keycloak_sso`, is not accepted here** and it is not an oversight: it is
a different interface family (`SsoConnector`) that registers OIDC and SAML *applications*
and carries no principals at all, so there is nobody for a per-target reconcile to walk.
It remains a first-class target everywhere principals are not involved — it is
configurable, enable-able and disable-able, and an `sso_app` event can dead-letter under
it like any other.

## Upgrading a deployed host

```bash
sudo bash /opt/identity-manager/scripts/update.sh
```

That is the whole procedure. It pulls, rebuilds, backs up the database,
migrates, **re-renders everything under `deploy/` onto the machine**, restarts
the service and then verifies the result. Run it as root, inside the host
`scripts/install.sh` installed.

It takes no arguments on purpose. The hostname, port, service user, scheme and
certificate paths are read back off the installed unit and vhost, because
getting one wrong by hand rewrites the vhost to serve a *different*
`server_name` — after which requests fall through to another server block and
the console appears to break with no error anywhere.

| Variable | Effect |
|---|---|
| `SKIP_PULL=1` | Do not touch git — rebuild and re-render what is already on disk. This is also how you complete a rollback. |
| `REPO_BRANCH=<branch>` | Branch to pull. Defaults to the checked-out branch. |
| `SKIP_DB_BACKUP=1` | Skip the pre-migration `pg_dump`. |
| `BACKUP_DIR=<path>` | Where that dump lands. Default `/var/backups/identity-manager`. |
| `BACKUP_KEEP=<n>` | Pre-update dumps to keep; older ones are deleted after a successful dump. Default 7. Scheduled dumps are counted separately — see "Backup and restore". |
| `DEBUG=1` | `set -x`. |

It refuses rather than guesses: a host with no `.env`, no unit or no vhost is
not an installed host and is sent to `install.sh`; a checkout with local
modifications is reported and left alone; a diverged branch is a situation for
a human, not for a merge resolver.

### Before upgrading past migration 0043: check for keys the new CHECK would reject

Migration `0043_sleepy_lord_tyger.sql` adds a database `CHECK` constraint,
`attribute_definitions_key_format`, requiring every `attribute_definitions.key`
to match `^[A-Za-z_][A-Za-z0-9_]*$` and not be `__proto__`, `constructor` or
`prototype`. Every row in this table predates that constraint — every one was
created by a hand-written `INSERT` with no validation at all — so a host that
has been running long enough may hold a key the migration rejects, and
`ALTER TABLE ... ADD CONSTRAINT` fails with an error that names the
constraint but not the offending row.

Run this **before** upgrading, against the live database:

```sql
SELECT id, key FROM attribute_definitions
WHERE key !~ '^[A-Za-z_][A-Za-z0-9_]*$'
   OR key IN ('__proto__', 'constructor', 'prototype');
```

If it returns any rows, the migration will fail on purpose rather than
silently rename or delete them: a key is referenced by every `users.attributes`
blob that carries it, so renaming one orphans data and deleting one destroys a
definition an admin created deliberately. Decide the fix yourself — rename the
definition (and re-key every `users.attributes` blob that references it) or
retire it — before running the upgrade again.

### Why this script exists rather than a documented `git pull`

The obvious upgrade is incomplete in a way that fails **silently**:

```bash
cd /opt/identity-manager
git pull --ff-only origin master
sudo -u idm pnpm install --frozen-lockfile
sudo -u idm pnpm build
sudo -u idm pnpm --filter @idm/api run db:migrate
sudo systemctl restart idm-api
sudo nginx -t && sudo systemctl reload nginx
```

That last line is **not optional after a rebuild**. The console's
`Content-Security-Policy` carries the sha256 of the inline pre-paint theme
script in `apps/web/dist/index.html`; the build regenerates it into
`apps/web/dist/csp.conf`, which both vhosts `include`. nginx reads that file
when it loads its configuration, so between `pnpm build` and the reload it is
still serving the PREVIOUS build's hash. If `index.html` changed in the pull,
the policy then blocks the very script it was written for and the console
renders an empty shell, with the only clue in the browser's console. Reloading
costs nothing and closes that window; `nginx -t` first, because a build that
failed leaves no `csp.conf` and the include will then refuse to load.

`scripts/update.sh` re-renders and reloads nginx on every run, so it closes
that window for you. This hazard belongs to the manual path only — which is
one more reason to prefer the script.

**And the manual path is still not sufficient.** `deploy/` is a set of
TEMPLATES; nothing copies them onto a running host except `scripts/install.sh`
and `scripts/update.sh`. A `git pull` therefore updates the repository and
changes nothing about how the machine actually serves traffic. Anything below
`deploy/` needs re-rendering by hand, or by running one of those two scripts:

| Changed in the repo | Reaches a running host only via |
|---|---|
| `deploy/nginx/*.conf` | re-rendering into `/etc/nginx/sites-available/idm.conf` |
| `deploy/nginx/idm-log.conf` | copying to `/etc/nginx/conf.d/` |
| `deploy/systemd/*` | re-rendering into `/etc/systemd/system/` + `daemon-reload` |
| `apps/web/index.html` (its inline script) | `pnpm build` **and** `systemctl reload nginx` — the CSP hash lives in `apps/web/dist/csp.conf`, which nginx only re-reads on reload |

This matters concretely: an upgrade that pulls the CS-M1 security-header fix and
the CS-L3 log-format fix, and then only restarts `idm-api`, leaves a console
still serving **no** `X-Frame-Options`, `X-Content-Type-Options` or
`Referrer-Policy`, and still writing people's names and email addresses into
`/var/log/nginx/access.log`. Both were confirmed absent after a pull-only
upgrade, and confirmed present after re-rendering. Verified end to end against a
real deployment (Proxmox LXC, Ubuntu 24.04, PostgreSQL 16.14, upgrading a host
that was 90 commits behind).

The same gap is why a host installed before the timers existed runs neither of
them (see "Scheduled work" above). `update.sh` renders *every* unit in
`deploy/systemd/` and enables every `.timer` it finds, so a release that adds
one does not need this document to change.

### What it verifies before claiming success

Each check below corresponds to a failure this project has actually hit, and any
of them failing exits non-zero with the rollback commands printed:

- `idm-api` reaches `active` (polled once a second, up to 30s).
- `/health` answers on `127.0.0.1:<port>` — isolating "the app is up" from
  "nginx routes to it". Polled up to **60s**, not sampled once: `systemctl
  is-active` reports a `Type=simple` unit as active the moment the process
  forks, while Nest needs several more seconds to bind the port.
- nginx answers **with the real `Host` header**, and the three security headers
  are present in the response. Polled up to **15s**, because `systemctl reload
  nginx` returns as soon as the master accepts the signal while workers on the
  previous config keep answering for a moment.
- `/etc/nginx/conf.d/idm-log.conf` contains the `idm_noquery` format, i.e. the
  file is the current one rather than merely present.

### Rolling back

Migrations in this repository are forward-only — there are no down-migrations,
so the pre-migration dump is the only way back. To return to the previous build:

```bash
cd /opt/identity-manager
sudo -u idm git checkout <previous-commit>     # printed by the failing run
sudo SKIP_PULL=1 bash scripts/update.sh
```

If the failure was in `db:migrate`, restore that dump before running an older
build against the database.

### Re-rendering nginx by hand

Only needed if you cannot run the script. Substitute your own hostname, port and
paths — `grep server_name /etc/nginx/sites-available/idm.conf` shows what this
host was installed with:

```bash
cd /opt/identity-manager
sudo cp deploy/nginx/idm-log.conf /etc/nginx/conf.d/idm-log.conf
sudo sed -e "s|@REPO_ROOT@|/opt/identity-manager|g"          -e "s|@IDM_HOSTNAME@|<hostname>|g" -e "s|@IDM_PORT@|3000|g"          -e "s|@TLS_CERT@|/etc/nginx/tls/idm.crt|g"          -e "s|@TLS_KEY@|/etc/nginx/tls/idm.key|g"          deploy/nginx/idm-tls.conf | sudo tee /etc/nginx/sites-available/idm.conf >/dev/null
sudo nginx -t && sudo systemctl reload nginx
```

Then confirm against the **real** hostname, not `127.0.0.1` — the vhost is
selected by `server_name`, so a request without the right `Host` header is
answered by a different server block and will appear to have no headers at all:

```bash
curl -sIk -H "Host: <hostname>" https://127.0.0.1/ | grep -i x-frame-options
```

And confirm the CSP hash the browser is being given is the hash of the script it
is being given — the one check that catches a policy left behind by an earlier
build:

```bash
curl -sIk -H "Host: <hostname>" https://127.0.0.1/ | grep -io "sha256-[A-Za-z0-9+/=]*"
node -e '
  const fs=require("fs"),c=require("crypto");
  const h=fs.readFileSync("/opt/identity-manager/apps/web/dist/index.html","utf8");
  for (const m of h.replace(/<!--[\s\S]*?-->/g,"").matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))
    if (!/\bsrc\s*=/i.test(m[1]))
      console.log("sha256-"+c.createHash("sha256").update(m[2].replace(/\r\n?/g,"\n")).digest("base64"));
'
```

The two must print the same string. If they differ, nginx has not been reloaded
since the last build; the console will be showing an empty page. (`\r\n` is
normalized to `\n` because the HTML parser does that before CSP hashes the
script's source text.)

## Monitoring

### What to watch

| Signal | How | Why it matters |
|---|---|---|
| **Dead letters** | `GET /outbox/dead-letters` | Something is not being delivered |
| **Users with `syncState: failed`** | `GET /users?…` | Same, per person |
| **Connector health** | `GET /connector-targets` | An enabled target that is `failing` |
| **Outbox backlog** | `SELECT count(*) FROM outbox_events WHERE status = 'pending'` | Worker stalled or a target slow |
| **Lifecycle skips** | Job stdout | A due transition did not happen |
| **Service** | `systemctl status idm-api` | |

A steadily growing `pending` count with no dead letters means the worker is not running
— check `SYNC_WORKER_ENABLED` and that exactly one instance has it on.

### Logs

```bash
journalctl -u idm-api -f
journalctl -u idm-api -n 200 --no-pager
```

Resolved **connector** secret values never appear in the journal. `test/connector-secrets.spec.ts`
puts a unique sentinel into a `CONNECTOR_*` variable and asserts it appears in none of:
the `connector_targets` config read, the `health()` body, the `apply()` body, the
connector's own call log, a deliberately-thrown error, or anything written to the console
during the whole block. That is the guarantee that is *tested* — it covers the credentials
a connector resolves, not a blanket promise about every value the process ever holds.

#### nginx's access log, and why it drops query strings

nginx keeps its own log at `/var/log/nginx/access.log`, rotated by the distribution's
`logrotate`. Both vhosts log through a custom `idm_noquery` format rather than the stock
`combined` one — defined in `deploy/nginx/idm-log.conf`, installed to
`/etc/nginx/conf.d/idm-log.conf`.

It is `combined` with **the query string removed from the request line, and from the
referrer**. That matters because search terms in this product are people's names,
usernames and email addresses, and they ride in the query string on both sides of the
edge: the console's own `/people?q=…`, and the `GET /api/users?search=…` it makes to
render the result. Under `combined`, anyone able to read `/var/log/nginx/` — an ops role
that needs no grant in the directory itself — would have a running record of who looked
up whom, sitting outside the append-only, privilege-separated audit log described in
[12 — Security](12-security.md). Finding CS-L3.

Two consequences worth knowing:

- **Filters are still in the URL, deliberately.** A search result stays shareable,
  bookmarkable and reload-safe. What changed is only what gets written to disk. The terms
  still enter the operator's *browser* history, so treat an admin's workstation profile as
  sensitive — the console cannot control that without giving up deep links.
- **Diagnosing from the access log loses `limit`/`offset`.** Paging and filter parameters
  are no longer in the log line. Use the API's own logs (`journalctl -u idm-api`) or the
  audit log for that; the access log is for status codes, latencies and traffic shape.

The OIDC redirect back from Keycloak (`/?code=…&state=…`) is covered by the same
truncation. That is the authorization-code flow behaving as specified, not a defect — the
console already clears it from browser history on callback — and the code is single-use
and PKCE-bound; the change here is only that it is no longer retained on disk.

## Backup and restore

Everything durable is in Postgres. Keycloak has its own state (credentials, sessions,
realm configuration) and needs its own backup — **nothing here backs Keycloak up.**

### What an installed host does on its own

Two things write dumps into `/var/backups/identity-manager`, and they are counted and
pruned separately:

| Filename | Written by | When |
|---|---|---|
| `<db>-<UTC stamp>-scheduled.sql.gz` | `idm-backup.timer` → `scripts/backup.sh` | 01:00 daily |
| `<db>-<UTC stamp>-pre-update.sql.gz` | `scripts/update.sh` | Before every migration |

The directory is `0700` and owned by `postgres`; each dump is `0600`. Treat it as
sensitive — one file is every name, email address and entitlement in the system.

**Retention: the newest 7 of each kind, set by `BACKUP_KEEP`.** Seven is one week of
daily restore points, which covers a corruption nobody noticed until Monday, and it bounds
the directory at a size you can reason about instead of one that grows for as long as the
host lives. The two kinds are pruned against separate counts on purpose: a single combined
count would let an afternoon of upgrades evict every scheduled backup, and the file you
want when a host dies is exactly the one a burst of unrelated activity would delete first.

Both scripts read `BACKUP_KEEP` and `BACKUP_DIR` from the environment:

```bash
sudo BACKUP_KEEP=14 bash scripts/update.sh          # keep 14 pre-update dumps
sudo systemctl edit idm-backup.service              # keep 14 scheduled ones
# [Service]
# Environment="BACKUP_KEEP=14"
```

Changing `BACKUP_DIR` for the timer needs a matching `ReadWritePaths=` in the same
drop-in — the unit runs under `ProtectSystem=strict`, so an un-listed directory is
read-only and the dump fails. **These dumps are on the same disk as the database.** They
survive a bad migration, not a dead disk; copy them somewhere else if that matters.

### Restoring one

These are **plain gzipped SQL**, not custom-format archives, so `psql` restores them and
`pg_restore` does not. Plain SQL also means no `--clean`: the dump only knows how to
create objects, so it has to go into an empty database or every `CREATE` collides.

```bash
# Newest scheduled dump on the host
ls -t /var/backups/identity-manager/*-scheduled.sql.gz | head -1

# Stop the API first — dropdb fails while anything holds a connection
sudo systemctl stop idm-api

sudo -u postgres dropdb identity_manager
sudo -u postgres createdb -O idm_app identity_manager
gunzip -c /var/backups/identity-manager/identity_manager-20260810T010000Z-scheduled.sql.gz \
  | sudo -u postgres psql -v ON_ERROR_STOP=1 identity_manager

# Re-assert the runtime role's grants (see below), then:
sudo systemctl start idm-api
```

`ON_ERROR_STOP=1` is not optional. Without it `psql` reports each failed statement and
carries on to the end, exiting 0 — a half-restored database that claims success.

### By hand

```bash
# Back up
sudo -u postgres pg_dump -Fc identity_manager > idm-$(date +%F).dump

# Restore into an empty database
sudo -u postgres pg_restore -d identity_manager --clean --if-exists idm-2026-08-08.dump

# Then re-assert the runtime role's grants
sudo -u idm bash -c 'set -a && . .env && set +a && pnpm --filter @idm/api db:migrate'
```

**Always run `db:migrate` after a restore.** A restore may not carry the runtime role's
grants; `db:migrate` re-asserts them every run. Verify:

```sql
\du idm_app
SELECT privilege_type FROM information_schema.role_table_grants
 WHERE grantee = 'idm_app' AND table_name = 'audit_log';
-- expect SELECT and INSERT only
```

Note that `audit_log` is append-only, so a partial restore cannot be "corrected" by
editing rows. Restore whole.

## Rotating credentials

### Runtime database password

```bash
sudo -u idm sed -i 's|^RUNTIME_DATABASE_URL=.*|RUNTIME_DATABASE_URL=postgres://idm_app:NEWPASS@localhost:5432/identity_manager|' .env
sudo -u idm bash -c 'set -a && . .env && set +a && pnpm --filter @idm/api db:migrate'
systemctl restart idm-api
```

`db:migrate` re-asserts the role's password from that URL — that is the whole rotation
procedure.

### Keycloak sync client secret

```bash
KEYCLOAK_URL=https://kc.example.com KC_ADMIN_USER=admin KC_ADMIN_PASS=... \
  CONSOLE_URL=https://idm.example.com bash scripts/keycloak-setup.sh
# put the printed secret into KEYCLOAK_ADMIN_CLIENT_SECRET in .env
systemctl restart idm-api
```

### A connector credential

Update the `CONNECTOR_*` variable and restart. Nothing is cached beyond a single call,
but the process reads its environment at start.

## Scaling out

Run several API instances behind a load balancer, but set
**`SYNC_WORKER_ENABLED=false`** on all but one. Multiple drains are technically safe
(`FOR UPDATE SKIP LOCKED` plus per-user advisory locks), but per-`(aggregate, target)`
ordering is enforced within a single claim query, so one drainer is the supported shape.

Raise `DB_POOL_MAX` for a larger Postgres, or lower it when several instances share a
small one.

## Mail server over a separate host

When the mail server runs on a public VPS and this system is internal, use a **WireGuard
tunnel**. This is not defence in depth — it is the load-bearing control.

The mail server's provisioning security argument is one sentence: *a leaked token is
useless from outside*. That holds only because its provisioning routes are unreachable
except on a private network, and its own spec notes that those routes carry no rate
limiting because nginx's public block returns 404 first. Separate hosts means either
recreating that private network or replacing the argument. WireGuard recreates it.

Traffic is **outbound from this system** — it pushes, the mail server never calls back —
so NAT on this side is fine.

### 1. WireGuard

The VPS is the server; this host dials out.

```bash
wg genkey | tee privatekey | wg pubkey > publickey   # on both hosts
```

```ini
# VPS — /etc/wireguard/wg0.conf
[Interface]
Address = 10.8.0.1/24
ListenPort = 51820
PrivateKey = <vps-private-key>

[Peer]
PublicKey = <idm-public-key>
AllowedIPs = 10.8.0.2/32
```

```ini
# This host — /etc/wireguard/wg0.conf
[Interface]
Address = 10.8.0.2/24
PrivateKey = <idm-private-key>

[Peer]
PublicKey = <vps-public-key>
Endpoint = <vps-public-ip>:51820
AllowedIPs = 10.8.0.1/32
PersistentKeepalive = 25
```

`wg-quick up wg0` and `systemctl enable wg-quick@wg0` on both, then `ping -c1 10.8.0.1`
from this host. Open `51820/udp` on the VPS firewall and **nothing else** for this.

### 2. The provisioning listener

Shipped in the mail-server repo as `20-provisioning.conf.template` plus the
`docker-compose.provisioning.yml` overlay. The public server block keeps its
`location ^~ /api/v1/provisioning { return 404; }` untouched — this is a separate
listener, not a hole in the first one.

nginx runs inside a container where the host's WireGuard address is not an interface at
all, so it listens on a plain port and Docker restricts the address:

```yaml
services:
  nginx:
    ports:
      - "${WIREGUARD_ADDRESS}:8081:8081"
```

Set `WIREGUARD_ADDRESS=10.8.0.1`, then bring the stack up **naming both files**:

```bash
docker compose -f docker-compose.yml -f docker-compose.provisioning.yml up -d
```

The overlay is separate on purpose: an unset variable inside an inline port mapping
collapses to `":8081:8081"`, which publishes provisioning on **every** interface,
silently. A stack that never opts in cannot make that mistake.

### 3. Verify the binding — every time

```bash
ss -lntp | grep -E ':(8081|8000|5432|6379)'
```

`8081` must show the tunnel address, never `0.0.0.0`. **Check the other three too, and
expect them to be absent.** `docker-compose.override.yml` is a development file Compose
auto-loads whenever no `-f` flags are given, and it publishes Postgres, Redis and the
backend directly. Naming `-f` files suppresses it, which is why the command above is
written that way and not as a bare `docker compose up -d`.

### 4. This side

```
CONNECTOR_MAIL_SERVER_TOKEN=<issued once by the mail server, stored there as a hash>
```

Then configure the `mail_server` target with `baseUrl` pointing at the tunnel address
and `tokenSecretName=CONNECTOR_MAIL_SERVER_TOKEN`. Dry-run before enabling, and confirm
the contract:

```bash
MAIL_SERVER_BASE_URL=http://10.8.0.1:8081 MAIL_SMOKE_EMAIL=someone@a-hosted-domain \
  pnpm --filter @idm/api smoke:mail
```

## Incident playbooks

### "Nobody can sign in"

1. `systemctl status idm-api` and `journalctl -u idm-api -n 50`.
2. Is Keycloak up and its certificate valid? The API fetches JWKS over TLS; an expired
   or untrusted certificate produces 401s on perfectly valid tokens.
3. Did the console's URL change? `idm-console`'s `redirectUris` must match. Re-run
   `keycloak-setup.sh`.
4. Is the console being served over plain HTTP on a non-localhost host? Then the sign-in
   button does nothing at all — see [05 — Installation](05-installation.md#tls--required-not-optional).

### "One admin is locked out"

`pnpm bootstrap:admin <their-keycloak-username>` — idempotent, and it grants global
`super_admin`. Their Keycloak account must already exist.

### "A deactivation did not take effect downstream"

The local record and Keycloak revocation are independent of the queue. Check:

1. `GET /users/:id` — is `status` actually `deactivated`?
2. `GET /outbox/dead-letters?target=…` — did the event dead-letter?
3. Fix the cause, then `pnpm --filter @idm/api run target-reconcile <target> -- --apply`.

The synchronous Keycloak revocation runs on the deactivate request itself; if it failed,
the reconcile pass re-asserts `enabled` every time it runs.

### "A reconcile halted on the blast-radius guard"

That is the guard working. Read the report: `populationSize`, the change count, and the
configured threshold and floor.

- If the plan is **correct** (a genuinely large legitimate change), re-run with
  `--force`. It is audited.
- If the plan is **wrong**, do not force it. A large unexpected diff usually means a
  configuration mistake — wrong `baseDN`, wrong domain, or an attribute mapping change
  that reinterpreted every record.

### "The outbox is backing up"

1. Is the worker running? `SYNC_WORKER_ENABLED` should be `true` on exactly one
   instance.
2. `SELECT target, status, count(*) FROM outbox_events GROUP BY 1, 2;` — which target?
3. Check that target's health. A slow or failing target with retries backs up its own
   stream but must not block others; ordering is per `(aggregate, target)`.
4. Disabling a target stops **new** fan-out to it. It does not clear the existing
   backlog.

## Useful queries

```sql
-- Outbox by target and status
SELECT target, status, count(*) FROM outbox_events GROUP BY 1, 2 ORDER BY 1, 2;

-- Dead letters with their errors
SELECT id, aggregate_type, aggregate_id, target, attempts, left(last_error, 120)
  FROM outbox_events WHERE status = 'failed' ORDER BY id DESC LIMIT 50;

-- Everything one import commit did
SELECT action, resource_type, resource_id, created_at
  FROM audit_log WHERE batch_id = '…' ORDER BY id;

-- Who holds what, where
SELECT u.username, ra.role_key, coalesce(ou.path::text, '(global)') AS scope
  FROM role_assignments ra
  JOIN users u ON u.id = ra.user_id
  LEFT JOIN org_units ou ON ou.id = ra.scope_org_unit_id
 ORDER BY u.username;

-- Correlation state per target
SELECT system, sync_state, count(*) FROM external_identities GROUP BY 1, 2;

-- Users due for activation today
SELECT id, username, start_date FROM users
 WHERE status = 'pending' AND start_date <= current_date;
```
