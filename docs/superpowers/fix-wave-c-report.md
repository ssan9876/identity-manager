# Fix Wave C — INJECTION / UNTRUSTED-INPUT findings

Branch: `fix/audit-critical-pool-exhaustion`, continuing from `c8fb15c` (Wave
A — pool-exhaustion deadlock) and `19ee90a` (Wave B — authorization scope
checks). Fixes the three HIGH findings from `docs/superpowers/audit-
injection.md` and the matching HIGH finding (H1) in `docs/superpowers/audit-
secrets.md`, plus the two LOW findings from the same area. Every write
handler touched threads `tx`, never the pool, into any check added inside an
already-open transaction — the Wave A discipline holds throughout.

## Summary of fixes

| # | Severity | Fix |
|---|---|---|
| 1 | HIGH | `csv.ts` and `import-row.ts` build every row/attribute bag on `Object.create(null)`, so a `__proto__` CSV header survives as a real key instead of silently vanishing. The 5 JSON body schemas' `attributes: z.record(z.unknown())` — which itself silently drops a `__proto__` key via Zod's own prototype-pollution defence — is replaced with a pass-through `rawAttributesSchema`, deferring to `validateAttributes`'s already-correct unrecognized-key rejection. Swept `keycloak-admin.client.ts`'s `buildSyncedAttributes` too. |
| 2 | HIGH | New `noNulChar()` Zod refinement (`common/http/safe-string.ts`) rejects an embedded NUL (Unicode code point 0) at validation time, applied to every free-text field in the 5 body schemas, `import-row.ts`'s `shapeSchema`, and `attribute-validator.ts`'s string branch. `ImportsController.commit`'s per-row write-attempt catch now uses a non-rethrowing `writeAttemptFailureReasons` so an unmapped error mid-batch is a row failure, never a request-aborting 500 that loses `batchId`. |
| 3 | HIGH | `resolveUpdateRow` now checks scope+privilege FIRST and returns immediately with only that rejection on failure — the field-mismatch/manager/attribute checks never run for a row the actor cannot reach. `preview()` now writes exactly one append-only audit row per invocation (actor, row count, timestamp), never one per candidate row. |
| 4 | LOW | `pagination.ts`'s `limit`/`offset` now go through a `z.union([z.string(), z.number()]).pipe(...)` — an array (including a single-element one) is rejected before `Number()` coercion ever runs. |
| 5 | LOW | `UsersRepository.create` normalises `username` to NFC before insert — the only site that ever sets it — so an NFD-typed username collides with its NFC equivalent instead of coexisting as a visually-identical second account. |

## 1 (HIGH) — `__proto__` silent elision (fourth recurrence)

**Root cause, confirmed against the installed `zod@3.25.76` source
(`zod/v3/helpers/parseUtil.js`, `ParseStatus.mergeObjectSync`) and
`zod/v3/types.js`:** both `ZodObject` and `ZodRecord` parsing funnel through
`mergeObjectSync`, which unconditionally skips assigning a key literally
named `"__proto__"` into its result object — a built-in prototype-pollution
defence with a side effect: `z.record(z.unknown())` parses
`{"__proto__":{...},"ok":"v"}` down to `{ok:"v"}` with **no error at all**.
`ZodObject.strict()` still catches it because it computes its own
`extraKeys` via `for...in ctx.data` *before* that merge step runs; `ZodRecord`
has no equivalent pass. This is the exact mechanism the CSV path hits too:
on a plain `{}`, `row[header] = value` for `header === '__proto__'` invokes
the inherited accessor *setter*, a silent no-op for a string value.

**Fix, at the source, per the audit's own three-part direction:**
- `csv.ts`: row object built on `Object.create(null)`.
- `import-row.ts`: `rawAttributes` built on `Object.create(null)` too — the
  *second* site the audit named; fixing only `csv.ts` leaves the identical
  bug one hop later; a `__proto__` header's value would flow through fine
  from `csv.ts` and then vanish again in this file's own `rawAttributes[key]
  = trimmed` loop.
- `attribute-validator.ts`: new exported `rawAttributesSchema = z.unknown().optional()`
  replaces `z.record(z.unknown())` in all 5 places it appeared
  (`users.controller.ts` ×2, `groups.controller.ts` ×2,
  `self-service.controller.ts` ×1). `z.unknown()` never inspects or rebuilds
  keys, so a genuine own `__proto__` property survives untouched into
  `validateAttributes`, which already handles it correctly end to end
  (`sanitizePayload`'s descriptor copy + `buildAttributeSchema(...).strict()`'s
  own `extraKeys` scan) — confirmed by `attribute-validator.spec.ts`'s
  pre-existing tests, unchanged by this fix.
- Swept `keycloak-admin.client.ts`'s `buildSyncedAttributes`: its
  `result: Record<string,string[]> = {}` is built on `Object.create(null)`
  too. Not reachable today (no write path exists for
  `attribute_definitions`, so `key` can only ever be a developer-seeded
  name), but the audit asked for a sweep, and a `string[]` VALUE assigned to
  a literal `__proto__` key on a plain object would actually reassign that
  object's own prototype (the setter treats an Object/Array value
  differently from a string) — worth closing before a write path ever lands.

No other `= {}` site in `apps/api/src` is a genuine sink (checked every one;
the rest are either static-key assignments or default parameter values).

## 2 (HIGH) — JSON-escaped NUL is an unhandled 500

**`common/http/safe-string.ts`** (new file): `noNulChar(schema)` wraps an
existing `ZodString` with a `.refine()` rejecting any value containing NUL
(Unicode code point 0, built via `String.fromCharCode(0)` — a source file
cannot safely contain a literal NUL byte; several tools, `git diff`
included, treat that as binary).
Applied to every free-text field reachable via HTTP that lands in a
`text`/`varchar`/`jsonb` column:

- `users.controller.ts`: `createUserBodySchema` / `updateUserBodySchema` —
  primaryEmail, username, firstName, lastName, employeeId, jobTitle, location.
- `groups.controller.ts`: `createGroupBodySchema` / `updateGroupBodySchema` —
  name, description.
- `org-units.controller.ts`: `createOrgUnitBodySchema` — name.
- `self-service.controller.ts`: `selfUpdateBodySchema` — location.
- `import-row.ts`: `shapeSchema` — employeeId, primaryEmail, username,
  firstName, lastName, jobTitle, location (never orgUnitId/managerId,
  already UUID-constrained, or startDate/endDate, already ISO-date-regex-
  constrained — neither shape can contain a NUL and pass).
- `attribute-validator.ts`: `fieldSchema`'s `'string'` branch (covers both
  JSON attribute values and CSV attribute-column cells, since both funnel
  through `validateAttributes`). The `'enum'` branch is unchanged: a NUL-
  containing value can never match a fixed, developer-configured `options`
  list, so it is already safe by construction.
- Checked every `@Query()` handler for a free-text parameter: none exists
  (`status` is an enum, every id-shaped param goes through `parseId`,
  `limit`/`offset` are numeric) — "query params" from the audit's fix
  direction is satisfied vacuously today, noted here rather than silently
  skipped.

Deliberately did **not** add a whole-CSV-text-level check on
`importBodySchema`'s `csv: z.string()` field: that would reject an entire
multi-row file for one bad cell in one row, breaking this codebase's
established per-row-isolation contract (a malformed email in row 15 today
correctly leaves rows 1–14 and 16–20 alone; a coarse whole-file NUL check
would not). The per-field `shapeSchema`/`attribute-validator.ts` checks
above give the same protection at the correct granularity — confirmed live:
`POST /imports/preview` with a NUL in one row's cell returns 200 with that
one row cleanly failed, naming the field.

**`ImportsController.commit`'s "sharp end":** `writeAttemptFailureReasons`
(new function, imports.controller.ts) replaces `domainErrorReasons` in the
one specific catch around the per-row `this.users.create`/`update` write
attempt. A `DomainError` there still reports its normal message; anything
else is logged server-side and turned into a generic row failure — the loop
**never rethrows**, so `batchId` and every other row's outcome are always
returned. `domainErrorReasons` itself is unchanged and still rethrows for
`resolveRow`'s own pre-write reads, where an unrecognized throw remains a
genuine bug worth surfacing loudly.

## 3 (HIGH) — `POST /imports/preview` cross-scope enumeration oracle

**(a) Suppress detail on scope rejection** (`imports.controller.ts`,
`resolveUpdateRow`): `assertCanIn(actor,'user:update',...)` and
`assertCanModifyPrincipal` now run first, accumulating into a separate
`scopeReasons` array; if either rejects, the method returns immediately with
`reasons: scopeReasons` alone. The three field-mismatch checks
(`primaryEmail`/`username`/`orgUnitId` "cannot be changed via import"),
`appendManagerReason`, and `validateAttributes` — everything that could
confirm or deny a guessed field value — now only run once scope AND
privilege have already passed. Live-confirmed: a scope-rejected row's
`reasons` array went from 4 entries (3 field-mismatch strings + the
rejection) to exactly 1.

**(b) Audit the invocation, not the candidates** (`imports.controller.ts`,
`preview()`): once `parseAndPrepare` succeeds (so a 400/403 request never
reaches this line), one `AuditWriter.record` call inside a minimal
`db.transaction` writes `{action:'import:preview', resourceType:'import',
resourceId:null, after:{rowCount}}`. Exactly one row per HTTP call,
regardless of how many candidate rows the file carries — an append-only
per-candidate log would itself become an amplified write against the same
unbounded row count the audit flags.

**Deliberately not fixed here** (out of this pass's explicit two-part
scope — see Concerns below): `resolveCreateRow`'s email/username collision
messages (`"a user with email ... already exists"`) still confirm existence
for a row whose OWN org unit is in scope but whose guessed contact info
belongs to an out-of-scope victim. `audit-secrets.md`'s fuller write-up
recommends a non-confirming `"primaryEmail: not available"` message for
this; the task's own restated fix direction enumerates exactly two required
changes ("both needed"), and this is a third, structurally distinct one
(scope legitimately *passes* for that row).

## 4 (LOW) — `z.coerce.number()` accepts a single-element array

`?limit[]=5` → Express's `qs` → `{limit:['5']}` → `Number(['5'])` is `5`
(`Array.prototype.toString` joins a one-element array with no separator
before coercion ever sees it — a two-element array already correctly 400s,
`Number(['5','6'])` is `NaN`). `pagination.ts`'s new `scalarOnly(target)`
helper is `z.union([z.string(), z.number()]).pipe(target)` — the union has
no array member, so any array (one element or many) is rejected before
`z.coerce.number()` ever runs.

## 5 (LOW) — Unicode username normalisation

`UsersRepository.create` — the only site that ever sets `username` (PATCH
deliberately excludes it, per that method's own doc comment) — now stores
`input.username.normalize('NFC')`. Not a resolution-ambiguity fix (the
`lower()` unique index already agreed exactly with
`PermissionEngine.resolveActor` pre-fix); closes the display-layer
impersonation gap where an NFD-typed username and its NFC equivalent, byte-
distinct even after `lower()`, could coexist as two visually identical
accounts.

## Files changed

Source: `apps/api/src/imports/csv.ts`, `apps/api/src/imports/import-row.ts`,
`apps/api/src/imports/imports.controller.ts`,
`apps/api/src/attributes/attribute-validator.ts`,
`apps/api/src/common/http/safe-string.ts` (new),
`apps/api/src/common/pagination.ts`, `apps/api/src/users/users.controller.ts`,
`apps/api/src/users/users.repository.ts`,
`apps/api/src/groups/groups.controller.ts`,
`apps/api/src/org-units/org-units.controller.ts`,
`apps/api/src/self-service/self-service.controller.ts`,
`apps/api/src/keycloak/keycloak-admin.client.ts`.

Tests: `apps/api/test/csv.spec.ts`, `apps/api/test/import-row.spec.ts`,
`apps/api/test/imports.write.spec.ts`,
`apps/api/test/attribute-validator.spec.ts`,
`apps/api/test/users.write.spec.ts`, `apps/api/test/users.repository.spec.ts`,
`apps/api/test/groups.write.spec.ts`, `apps/api/test/org-units.write.spec.ts`,
`apps/api/test/self-service.spec.ts`, `apps/api/test/pagination.spec.ts`.

No schema, migration, or non-injection file touched.

## Existing tests that changed meaning, and why

`imports.write.spec.ts`'s `POST /imports/preview` "writes NOTHING" test
asserted the OLD, vulnerable behaviour by name (zero audit rows, ever) —
split into "writes NOTHING about a user" (user/outbox counts still
unchanged) plus a new, adjacent "writes exactly one invocation-level audit
row" test asserting the NEW correct behaviour, matching Wave B's own
precedent for a test whose asserted behaviour the fix deliberately changes.

## New regression tests (24; 594 → 618)

Reproducing each original attack and asserting the CORRECT behaviour, per
file:
- `csv.spec.ts` (+2), `import-row.spec.ts` (+1): unit-level, `__proto__`
  header/extra-column survives as a genuine own key end to end.
- `attribute-validator.spec.ts` (+1): a NUL in a string attribute value.
- `pagination.spec.ts` (+3): single- and multi-element array rejection for
  `limit`/`offset`, plus a positive control (bare numeric still accepted).
- `users.repository.spec.ts` (+1): NFD username collides with its NFC
  equivalent post-fix; asserts the STORED form is NFC, not the raw input.
- `users.write.spec.ts` (+2), `groups.write.spec.ts` (+2),
  `self-service.spec.ts` (+2), `org-units.write.spec.ts` (+1): the JSON
  `__proto__`-attribute and NUL-field attacks against each of the 5 repro'd
  endpoints, via real HTTP requests (the `__proto__` cases use raw JSON text
  through `.type('json')`, never a JS object literal — `{__proto__: {x:1}}`
  as a literal SETS the prototype instead of creating an own property,
  which would silently defeat the test before it ever reached the server).
- `imports.write.spec.ts` (+9): the flagship `__proto__`-column
  attributes-wholesale-wipe reproduction (asserts the STORED attributes are
  byte-for-byte unchanged, not just the status code — this was the whole
  point of the finding); the NUL "sharp end" 3-row batch (other rows still
  commit, `batchId` always present); a mocked-unexpected-error variant of
  the same, pinning the defensive `writeAttemptFailureReasons` fix
  independently of the NUL root-cause fix; the cross-scope-disclosure
  reproduction (4 reasons → 1) with a paired in-scope positive control; the
  invocation-audit-row test plus two "rejected request writes zero audit
  rows" tests (malformed CSV, no permission); a NUL-in-cell preview test.

## Counterfactual verification

Each fix verified by disabling ONLY that fix (git-stashing the source
file(s), or — where a fix shares a file with an already-verified one from
this same wave — temporarily no-op'ing the specific function/hunk in place)
and confirming the new tests fail for the right reason, then restoring:

- **`__proto__` elision**: stashed `attribute-validator.ts`,
  `groups.controller.ts`, `csv.ts`, `import-row.ts`,
  `keycloak-admin.client.ts`, `self-service.controller.ts`,
  `users.controller.ts` together. All 6 new HTTP-level tests failed exactly
  as predicted (201/200 instead of 400, `updated:1` instead of `0`), 2
  unit-level tests failed (`hasOwnProperty` false instead of true); 130
  unaffected tests in the same files still passed.
- **NUL character**: disabled `noNulChar` in place (`return schema` instead
  of `.refine(...)`) — all 7 relevant tests failed with a REAL 500 and the
  literal Postgres error visible in the logs: `invalid byte sequence for
  encoding "UTF8": 0x00`. Notably, the "sharp end" batch test did NOT lose
  its `batchId` even with the root-cause check disabled — the SEPARATE
  `writeAttemptFailureReasons` defensive fix (untouched by this
  counterfactual) caught the raw `pg` error on its own, just with a less
  specific reason string, confirming the two-layer design. Separately,
  stashed only `imports.controller.ts`'s commit-loop change (with the NUL
  validation left intact): the unexpected-error test alone failed, 500,
  batchId lost — confirming that fix in isolation.
- **Enumeration oracle**: since both sub-fixes share `imports.controller.ts`
  with the already-verified NUL fix, reverted just the `resolveUpdateRow`
  reordering and the `preview()` audit-write block in place (keeping
  `writeAttemptFailureReasons` intact), confirmed the 2 new tests failed
  (`+0` instead of `+1` audit row; 4 reasons instead of 1), restored from a
  pre-edit backup copy of the file.
- **Pagination array coercion**: disabled `scalarOnly` in place — both new
  tests failed (`expected function to throw, but it didn't`).
- **Username NFC**: disabled `.normalize('NFC')` in place — the test failed
  with `expected 'caféuser' to be 'caféuser'` (two byte-distinct, visually
  identical strings) — itself a clear illustration of the bug.

All counterfactuals restored; full suite re-verified green afterward.

## Verification

- `pnpm --filter @idm/api build`: exit 0.
- `pnpm --filter @idm/api test`: **48 files, 618 tests passed** (594
  baseline + 24 new), twice (once mid-pass, once final).
- `pnpm --filter @idm/api db:generate`: `No schema changes, nothing to
  migrate` — confirmed no new migration file in `git status`.
- `pnpm --filter @idm/api smoke:dev`: green (`GET /users` → 200, 12 items;
  `GET /groups` → 200, 5 items), run twice.
- **Live** (real dev server, `SYNC_WORKER_ENABLED=false`, real Keycloak-
  issued token for `admin@example.com` / `idm-test-client` direct grant): a
  throwaway script reproduced all three original attacks and confirmed a
  legitimate import:
  - Attack 1: seeded a real user with `attributes = {"deptA":"Finance","costA":"CC-42"}`
    (via direct SQL — no HTTP write path for custom attributes exists to
    seed it any other way), then `POST /imports/commit` with a `__proto__`
    column → `{updated:0, failed:1, failures:[{"reasons":["Unrecognized
    key(s) in object: '__proto__'"]}]}`; re-fetched attributes byte-for-byte
    unchanged.
  - Attack 2: `POST /org-units`, `PATCH /self` (no role held), `POST
    /groups`, `POST /users` each with a NUL in a string field → clean 400
    `VALIDATION_FAILED` on all four (were 500); `POST /imports/preview`
    with a NUL in a row's `firstName` cell → 200, that row cleanly failed
    naming `firstName` (was 500).
  - Attack 3: temporarily rescoped `admin@example.com`'s own
    `role_assignments` row from global to a fresh `mine` org unit via
    direct SQL (same technique Wave B's own live H-1 reproduction used —
    there is no API to edit an existing assignment's scope), confirmed a
    direct `GET /users/<victim>` now 403s, then `POST /imports/preview`
    against the victim (wrong email/username guesses, real employeeId) →
    `failures[0].reasons` = exactly `["not permitted: user:update"]` (was 4
    reasons, 3 of them confirming/denying the guesses); confirmed exactly
    one new `action='import:preview'` audit row for the call; restored
    admin's original global scope and verified the restoration with a
    follow-up `SELECT` and a follow-up `GET /users/<victim>` → 200 again.
  - Legitimate import: `POST /imports/preview` then `POST /imports/commit`
    for a fresh row → `created:1`, real `batchId`, created user readable via
    `GET /users/:id` with correct data.
  - All throwaway users/org units deleted afterward; table counts for
    `users`/`org_units`/`groups` back to their pre-run baseline
    (15/15/5); the `audit_log`/`outbox_events` growth (+11/+8) is fully
    accounted for by legitimate creates and the new one-row-per-invocation
    preview audits — both figures reconciled exactly against the sequence
    of real actions performed. Script deleted, never committed.
- Compose stack (`identity-manager-postgres-1`, `identity-manager-keycloak-1`)
  left running throughout, untouched. Port 3000 confirmed free before and
  after every server-booting step (5 total: two `smoke:dev` runs, one live
  script run — the earlier attempt that failed on a test-script assertion
  bug still shut down and freed the port correctly in its `finally`).
- Working tree clean except the intended source/test diffs and this report
  (verified via `git status`); the five other auditors' untracked files
  (`audit-authz.md`, `audit-injection.md`, `audit-integrity.md`,
  `audit-secrets.md`, `security-audit-input.md`) were left alone, matching
  Wave A/B's own hygiene note.

## Requirements checklist

- Rejected requests write zero audit rows and zero outbox events, except
  the deliberate preview-invocation record: pinned by dedicated tests
  (`imports.write.spec.ts`'s two new "writes no audit row" tests) and
  confirmed live (Attack 2's four 400s never reached the audit-write line).
- Regression tests reproduce each original attack and assert the CORRECT
  behaviour; the `__proto__` one specifically asserts the user's stored
  attributes are byte-for-byte unchanged, not merely the status code.
- Each fix counterfactually verified (revert → new test fails for the right
  reason → restore) — see above.

## Concerns / follow-ups (not fixed here, out of this pass's scope)

- `resolveCreateRow`'s email/username collision messages still confirm
  existence for an in-scope-target row naming an out-of-scope victim's
  contact info (`audit-secrets.md`'s fuller write-up recommends a
  non-confirming `"not available"` message). Not one of the task's own
  explicitly enumerated "two ways, both needed" for this finding — flagged
  rather than silently left unaddressed.
- `docs/superpowers/audit-integrity.md`'s MEDIUM finding (no explicit
  row/file-size cap on `/imports/preview`+`/commit`, beyond Express's
  incidental 100 kB body limit) is untouched — out of this pass's
  INJECTION-only scope, and not one of the three HIGH findings this task
  named.
- `audit-injection.md`'s LOW finding on rejecting `Cf`-category Unicode
  characters (RTL overrides, ZWJ) in `username`/`firstName`/`lastName` is
  untouched — the task's own condensed restatement of this LOW item asked
  only for NFC normalisation, which is what landed.
