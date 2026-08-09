# 13 — Development

## Getting set up

See [04 — Quickstart](04-quickstart.md). In short:

```bash
pnpm setup:all && pnpm bootstrap:admin && pnpm dev
```

## The workspace

A pnpm workspace with two packages:

| Package | Path | What |
|---|---|---|
| `@idm/api` | `apps/api` | NestJS API, sync worker, CLIs, migrations |
| `@idm/web` | `apps/web` | React + Vite admin console |

`tsconfig.base.json` at the root is extended by both. `apps/api/scripts/` is inside the
API's `tsc` program — it was once outside it and therefore never typechecked by anything.

## The verification gate

**`pnpm verify` is the gate.** One command, one exit code, failing loudly on the first
broken stage rather than continuing past it.

| Stage | What |
|---|---|
| `typecheck` | Both packages, including `apps/api/scripts/` |
| `lint` | Runs if a linter is configured; logs and continues if none is |
| `build` | Both packages |
| `web tokens` | CSS design-token check (`apps/web/scripts/check-css-tokens.mjs`) |
| `API suite` | The full Vitest suite against disposable Testcontainers |

No stage is ever skipped silently on failure, and nothing uses `continue-on-error`.

```bash
pnpm verify:quick   # typecheck + build only — no containers. Run before every commit.
pnpm verify         # the whole gate. Run before anything that matters more.
```

`.github/workflows/ci.yml` runs the identical gate on every push and pull request, plus
the Playwright E2E suite against the Compose stack. GitHub-hosted runners provide Docker
out of the box, so both Testcontainers and `docker compose` work there unmodified.

## Testing

### API — Vitest + Testcontainers

73 spec files under `apps/api/test/`, run against **disposable Postgres containers**,
independent of the Compose stack.

```bash
pnpm --filter @idm/api test
pnpm --filter @idm/api test -- users.write.spec.ts
```

Categories worth knowing:

| Kind | Examples |
|---|---|
| Repository / integration | `users.repository`, `groups.repository`, `org-units.repository` |
| Controller / write path | `*.write.spec.ts`, `*.controller.spec.ts` |
| Authorization | `permission.engine`, `permission.guard`, `privilege.guards`, `scope-narrowing`, `guard-coverage` |
| Sync | `sync.worker`, `outbox-emission`, `outbox-multi-target`, `reconciliation`, `target-reconciliation`, `sync-state.repository` |
| Connectors | one per target, plus `connector-registry`, `connector-secrets`, `connector-target-catalog` |
| Invariants | `migrate`, `harness`, `app.module`, `dev-environment`, `pool-exhaustion`, `payload-too-large` |

**Structural tests you must not break:**

- **`guard-coverage.spec.ts`** — every controller carries `JwtGuard`, and unless listed
  as authentication-only, `PermissionGuard` with `@RequirePermission` on every route. A
  new controller without guards fails the suite.
- **`connector-target-catalog.spec.ts`** — `ALL_CONNECTOR_TARGETS` matches the
  `outbox_target` pgEnum in **both** directions.
- **`jml-rule-engine.spec.ts`** and **`business-role-evaluator.spec.ts`** — static source
  scans proving rules and role conditions are data, never code (no `eval`, no `Function`,
  no dynamic dispatch on rule content).
- **`connector-secrets.spec.ts`** — seeds a sentinel value into the environment and
  greps every response, log line and thrown error for it.
- **`no-password-input.spec.ts`** (E2E) — scans the console source for password inputs.

### Console — Playwright

```bash
pnpm --filter @idm/web test:e2e
```

Runs against the Compose stack, signing in as a real Keycloak user. Suites: `login`,
`people`, `people-write`, `person-picker`, `groups`, `import`, `audit`, `connectors`,
`self-service`, `theme`, `no-password-input`.

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

## Adding a connector target

See [09 — Connectors and sync](09-connectors-and-sync.md#adding-a-new-target).

## Console conventions

The visual system is [`design-system.md`](design-system.md); the product priorities are
[`product-brief.md`](product-brief.md). Both are contracts, and source comments cite
them by name.

The rules most likely to catch you out:

- **Semantic tokens only.** Screens never reference light or dark directly, and never a
  raw colour. `styles/tokens.css` is the only file that knows two palettes exist —
  enforced by `check-css-tokens.mjs`, which is a `pnpm verify` stage.
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

Current branch: `feat/business-roles-entitlements`. Main branch: `master`.

Run `pnpm verify:quick` before every commit and `pnpm verify` before anything that
matters more.
