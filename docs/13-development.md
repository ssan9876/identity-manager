# 13 — Development

## Getting set up

See [04 — Quickstart](04-quickstart.md). In short:

```bash
pnpm setup:all && pnpm bootstrap:admin && pnpm dev
```

## The workspace

A pnpm workspace (`pnpm-workspace.yaml`: `apps/*`) with two packages:

| Package | Path | What |
|---|---|---|
| `@idm/api` | `apps/api` | NestJS API, sync worker, CLIs, migrations |
| `@idm/web` | `apps/web` | React + Vite admin console |

`tsconfig.base.json` at the root is extended by both. `apps/api/tsconfig.json` includes
`src/**/*`, `test/**/*` **and** `scripts/**/*` — the last was once outside the program and
therefore never typechecked by anything.

## The verification gate

**`pnpm verify` is the gate.** One command, one exit code, failing loudly on the first
broken stage rather than continuing past it. The stages are exactly the calls in
`scripts/verify.mjs`'s `main()`:

| Stage | Command | What |
|---|---|---|
| `typecheck` | `pnpm run typecheck` | Both packages, including `apps/api/scripts/` |
| `lint` | `pnpm -r run lint` | **Only if an ESLint config file exists** at the repo root, `apps/api` or `apps/web`. None does today, so the stage logs a line and is skipped |
| `build` | `pnpm run build` | Both packages — `tsc` emit for the API, `tsc -b && vite build` for the console |
| `web checks` | `pnpm --filter @idm/web test` | All three of `apps/web/scripts/`: `check-css-tokens.mjs` (no raw colour outside `styles/tokens.css`), `check-connector-targets.mjs` (the console's hand-copied target catalogue against the API's `ALL_CONNECTOR_TARGETS`), `check-csp.mjs` (the served CSP against the served `index.html`; it exits 0 loudly when there is no build output) |
| `docs checks` | `pnpm run check:docs` | The documentation guard — see below |
| `API suite` | `pnpm --filter @idm/api test` | Vitest against disposable Testcontainers. **The only stage that needs Docker**, and the only one `--quick` skips |

No stage is ever skipped silently on failure, and nothing uses `continue-on-error`.

```bash
pnpm verify:quick   # everything except the API suite — no containers. Run before every commit.
pnpm verify         # the whole gate. Run before anything that matters more.
```

`.github/workflows/ci.yml` runs `pnpm verify` — the identical gate — on every push and
pull request, plus the Playwright E2E suite against the Compose stack. GitHub-hosted
runners provide Docker out of the box, so both Testcontainers and `docker compose` work
there unmodified.

### The docs gate: `pnpm check:docs`

```bash
pnpm check:docs   # node scripts/extract-doc-facts.test.mjs && node scripts/check-docs.mjs
```

Two scripts. `extract-doc-facts.test.mjs` proves the fact base itself is sound (that the
extractor still finds routes, all 13 connector targets, the CLI scripts) — a fact
extractor that silently returns nothing would make every check below pass vacuously.
`check-docs.mjs` then compares documentation against those facts and prints one block per
problem, with the command to run and the fix.

**What it checks — all of it:**

| Check | Against |
|---|---|
| Every `docs/…` path cited from code resolves to a real file | the repo tree |
| `docs/11-operations.md` names every operator CLI | `apps/api/package.json`'s scripts, filtered to `OPERATOR_CLIS` |
| Four named documents each list all 13 connector targets | `ALL_CONNECTOR_TARGETS` in `apps/api/src/connectors/connector.ts` |
| `docs/10-api-reference.md` documents every route the API exposes | the extracted route table |
| …and documents no route that does not exist | ditto |
| …and its "Routes that do not exist" table still describes routes that really are absent | ditto |

**What it deliberately does not check.** Only mechanically verifiable claims. It reads
tokens — a `METHOD /path`, a target name, a script name, a file path — and never prose.
It would **not** have caught `docs/12-security.md` describing a ReDoS that had already
been fixed: that needed a human reading a claim against an implementation, and no guard
in this repo can do it.

That narrowness is the design, and the script says so in its own header comment: a guard
that is narrow and trusted beats one that is broad and noisy, because a noisy guard gets
suppressed and then catches nothing. Two consequences worth knowing:

- The target and CLI checks are substring matches (`body.includes(...)`), so they have
  latent false negatives — `echo` is an English word, and `keycloak` is a prefix of
  `keycloak_sso`.
- Adding a check is cheap; adding a check that fires on something a human would call fine
  is expensive. Prefer leaving a claim unguarded over guarding it approximately.

`docs/.facts.json` is generated and gitignored. Regenerate it freely; never commit it.

## Testing

### API — Vitest + Testcontainers

112 spec files under `apps/api/test/`, run against **disposable Postgres containers**,
independent of the Compose stack.

> ### Cap the fork pool, with **both** bounds
>
> ```bash
> cd apps/api
> pnpm vitest run --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3
> ```
>
> **Uncapped, the suite starts a Testcontainers Postgres per spec file** and exhausts the
> disk on an ordinary developer machine. The failures that follow are not real: dozens of
> specs fail on container startup, and the run tells you nothing about your change.
>
> **`maxForks` alone does not work.** `minForks` defaults to the CPU count, so on any
> machine with more cores than your cap the two conflict and Tinypool throws before a
> single test runs:
>
> ```
> RangeError: options.minThreads and options.maxThreads must not conflict
> ```
>
> Vitest reports that as an unhandled error and then prints `Test Files  no tests`, which
> reads like a filter that matched nothing. It is not a filter problem, and chasing it as
> one costs a run. Pass **both** bounds, every time.
>
> The `test` script in `apps/api/package.json` is a bare `vitest run` and carries no cap,
> so `pnpm --filter @idm/api test` and the `API suite` stage of `pnpm verify` both inherit
> the uncapped default. To cap through pnpm, pass the flags after `--`:
> `pnpm --filter @idm/api test -- --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3`.

One file at a time, which is what you want most of the time:

```bash
cd apps/api
pnpm vitest run --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3 users.write.spec.ts
```

Categories worth knowing:

| Kind | Examples |
|---|---|
| Repository / integration | `users.repository`, `groups.repository`, `org-units.repository`, `sso-apps.repository` |
| Controller / write path | `*.write.spec.ts`, `*.controller.spec.ts` |
| Authorization | `permission.engine`, `permission.guard`, `privilege.guards`, `scope-narrowing`, `guard-coverage` |
| Sync | `sync.worker`, `outbox-emission`, `outbox-multi-target`, `reconciliation`, `target-reconciliation`, `sync-state.repository` |
| Connectors | one per target, plus `connector-registry`, `connector-secrets`, `connector-target-catalog` |
| Access model | `business-roles`, `business-role-evaluator`, `role-miner`, `sod`, `recertification`, `access-requests.controller`, `user-entitlements` |
| Multi-tenancy | `organizations.isolation`, `organizations.uniqueness`, `master-organization`, `org-connector-targets` |
| Inbound | `hr-feed`, `hr-json-feed`, `hr-sync`, `csv`, `import-row` |
| Invariants | `migrate`, `harness`, `app.module`, `dev-environment`, `pool-exhaustion`, `payload-too-large.middleware` |

**Structural tests you must not break:**

- **`guard-coverage.spec.ts`** — every controller carries `JwtGuard`, and unless named in
  its `OPEN_BY_DESIGN` or `AUTHENTICATION_ONLY` sets, `PermissionGuard` with
  `@RequirePermission` on every route. A new controller without guards fails the suite,
  and adding an exemption means adding your controller to a list someone will read.
- **`connector-target-catalog.spec.ts`** — `ALL_CONNECTOR_TARGETS` matches the
  `outbox_target` pgEnum in **both** directions.
- **`jml-rule-engine.spec.ts`** and **`business-role-evaluator.spec.ts`** — behavioural
  specs that each also carry a static source scan over their own module directory
  (`src/jml`, `src/business-roles`), failing on any `eval(`, `new Function(` or bare
  `Function(`. Rules and role conditions are data, never code.
- **`connector-secrets.spec.ts`** — seeds a sentinel value into the environment and greps
  every response, log line and thrown error for it.
- **`migrate.spec.ts`** — replays the migration chain, so from 0027 on every migration
  must be re-runnable. Enum and column DDL needs `IF NOT EXISTS`.
- **`no-password-input.spec.ts`** (E2E) — scans the console source for password inputs.

### Console — Playwright

```bash
pnpm --filter @idm/web test:e2e
```

Runs against the Compose stack, signing in as a real Keycloak user. The 14 suites under
`apps/web/e2e/`: `audit`, `business-roles`, `connectors`, `groups`, `import`, `login`,
`no-password-input`, `organizations`, `people`, `people-write`, `person-picker`,
`self-service`, `sso-apps`, `theme`.

`pnpm --filter @idm/api e2e:cleanup` removes records the suite left behind.

### Smoke

```bash
pnpm --filter @idm/api smoke:dev    # boots the real dev server, hits it over HTTP
pnpm --filter @idm/api smoke:mail   # mail server contract check
```

## Changing the database schema

1. Add or edit a file under `apps/api/src/db/schema/`. **One table per file.**
2. Re-export it from `schema/index.ts` — drizzle-kit reads that barrel to discover the
   schema.
3. Generate the migration:
   ```bash
   pnpm --filter @idm/api db:generate
   ```
4. **Read the generated SQL.** It is committed, and it is what actually runs.
5. Apply it:
   ```bash
   pnpm --filter @idm/api db:migrate
   ```

### Rules that will bite you

- **Every migration must be re-runnable.** `migrate.spec.ts` replays the chain, so from
  0027 onward `CREATE TYPE`, `ALTER TYPE ... ADD VALUE`, `ALTER TABLE ... ADD COLUMN` and
  friends need `IF NOT EXISTS` (or the `DO $$ ... EXCEPTION` equivalent).
- **Never use an enum value in the same migration that adds it.** Postgres rejects
  `unsafe use of new value of enum type`, and drizzle applies every pending migration in
  **one** transaction — so on a fresh database (every Testcontainer, every new deploy)
  it fails outright. Add the value in one migration, use it in a later one.
- **A Postgres enum can gain values but never drop them.** A speculative value is a
  permanent mistake. Ship what genuinely exists.
- **New tables need runtime grants.** `db:migrate` recomputes the grant list from
  `pg_tables` on every run, so this is automatic — but it is why `db:migrate` must run
  before a restart, not after.
- **Composite index column order is load-bearing.** Equality columns lead, ordering
  columns trail. Reversing them yields correct results and a much worse plan.
- **`NULL`s are not equal in a unique index.** A single unique index over a nullable
  column permits unlimited duplicate `NULL` rows; use two partial indexes.
- **Backfill defensively.** A new provenance column defaults to the value the reconciler
  will never revoke.

## Adding an endpoint

1. **Pick or add an action** in `authz/actions.ts` and place it in `ROLE_PERMISSIONS`.
   The catalog is static code deliberately — a permission table is itself an escalation
   surface.
2. **Decorate the handler** with `@RequirePermission('...')`. `guard-coverage.spec.ts`
   requires it.
3. **Narrow to scope in the handler.** The guard only answers "anywhere". Use
   `scopePathsFor` for lists (filter `items` **and** `total`) and `assertCanIn` for
   single resources. If the resource has no org unit, require a **global** grant and say
   so in the error message.
4. **Parse with a `.strict()` Zod schema.** Wrap free text in `noNulChar`.
5. **One transaction** for the mutation, its audit row and its outbox event.
6. **Write the audit snapshot with explicit field names.** Never a spread.
7. **Throw `DomainError` subclasses**, never raw HTTP exceptions. Anything else is a bug
   and correctly becomes a 500.
8. **Add tests**, including the rejection paths — out of scope, outranked, malformed.
9. **Document it** in [10 — API reference](10-api-reference.md) as a `` `METHOD /path` ``
   token. `check-docs.mjs` fails the build if you do not, and fails it again if you
   document a path that does not exist.

## Adding a connector target

See [09 — Connectors and sync](09-connectors-and-sync.md#adding-a-new-target).

## Console conventions

The visual system is [`design-system.md`](design-system.md); the product priorities are
[`product-brief.md`](product-brief.md). Both are contracts, and source comments cite
them by name.

The rules most likely to catch you out:

- **Semantic tokens only.** Screens never reference light or dark directly, and never a
  raw colour. `styles/tokens.css` is the only file that knows two palettes exist —
  enforced by `check-css-tokens.mjs`, which is part of `pnpm verify`'s `web checks` stage.
- **Every interactive component ships all seven states**: default, hover, focus, active,
  disabled, loading, error. Shipping half is not shipping.
- **Active carries no colour.** Most of a directory is active; colouring the norm is
  noise. Colour marks the exception. Status is never colour alone — every badge carries
  its word.
- **Tables, not card grids.** People and groups are tabular data.
- **Tabs, not accordions**, on detail pages — with the WAI-ARIA pattern, arrow-key
  navigable.
- **Skeletons for content loading into a known shape; spinners only inside buttons**,
  and a loading button keeps its width so layout does not jump.
- **Empty states teach** — what the screen is for, and the one action to take.
- **Dropdowns use the popover/`<dialog>` API or `position: fixed`** — never
  `position: absolute` inside an `overflow` container, which clips them.
- **Toasts live above `<Routes>`**, because an action's result must survive the
  navigation that action often triggers.
- **The API is the authority.** Gate UI on `GET /self/permissions`; never decide
  authorization client-side.
- **Add a target to the console's catalogue by hand.** `apps/web/src/connectors/api.ts`
  hand-writes `ConnectorTarget`, `ALL_CONNECTOR_TARGETS` and `CONNECTOR_TARGET_LABEL`;
  there is no shared package. `check-connector-targets.mjs` is what stops that copy
  drifting — it exists because it once did, shipping a live target the console could not
  disable.
- Motion is 150–200ms `ease-out`, and every animation needs a
  `prefers-reduced-motion: reduce` alternative.

Banned outright: side-stripe borders, gradient text, glassmorphism, stat-tile hero rows,
green "active" badges, modal-as-first-thought, display type in labels or data, custom
scrollbars, reinvented form controls.

## Code conventions

- **Comments explain *why*, at length, especially for anything security-relevant.** This
  codebase's comments frequently document the attack a construct prevents and the
  regression that motivated it. Match that density when touching those files.
- **Index a lookup table with a database-sourced key only via `Object.create(null)` +
  `Object.hasOwn`.** Four separate bugs came from not doing this.
- **Use `satisfies` on a catalog literal, not `as` on the expression.** `as` on an `any`
  expression asserts nothing and compiles typos clean.
- **Bind every SQL parameter.** A bare array in Drizzle is spliced as a parenthesised
  list, not sent as one value.
- **`process.env` is read in `config/env.ts` and `connectors/secrets.ts` only.**
- **A failure that must not abort a batch becomes a reported row**, never a swallowed
  log line. Non-`DomainError` throws are rethrown — they are bugs.

## Working with git

The main branch is `master`. Branch off it for feature work; `pnpm verify` runs the same
gate locally that CI runs on the push.

Run `pnpm verify:quick` before every commit and `pnpm verify` before anything that
matters more.
