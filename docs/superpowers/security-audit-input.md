# Security Audit — Known Carried Findings (input, not a limit)

This lists what is **already known** so auditors do not spend effort rediscovering it.
It is a starting point, **not a scope limit** — the whole tree is in scope.

## System summary

A single-tenant identity provider. Postgres is the system of record for identity data;
Keycloak owns all credentials and issues tokens. NestJS API + React console.
Sub-project 1 (Milestones 1–7) is complete: schema, groups-as-DAG, RBAC with org-unit
scoping, append-only audit log, transactional outbox syncing to Keycloak, bulk import,
self-service portal, and joiner/mover/leaver automation.

## Binding constraints the system claims to uphold

1. Never generates, transmits, or stores a credential. Keycloak owns them.
2. Attribute propagation is default-deny — only `sync_to_keycloak = true` leaves the system.
3. Self-service edits are default-deny — only `self_editable = true`.
4. There is no delete operation for users; `deactivated` is terminal.
5. Deactivated users are excluded from all default list and search views.
6. Authorization is enforced in the API, never the UI.
7. Every mutation is permission-checked, scope-narrowed, audited AND outboxed in one transaction.
8. A rejected mutation writes zero audit rows and zero outbox events.
9. The audit log is append-only, enforced by database triggers (UPDATE/DELETE/TRUNCATE).
10. Scope is evaluated per request and never cached across requests.
11. JML rules are data, never executable code.
12. Single tenant — no `tenant_id` anywhere.

## Known open items (verify these still hold, then look elsewhere)

- **ReDoS**: `new RegExp(rules.pattern)` in `attribute-validator.ts` compiles an unvalidated
  DB-sourced pattern. Measured: `^(a+)+$` blocked the event loop **96.7s on a 33-char input**.
  Currently unreachable — `attribute_definitions` has no write path. Verify that is still true.
- **No row-count or file-size cap on bulk import** — a DoS surface.
- **Principal resolution uses `username`**, deliberately, not `external_identities`.
- **No suspend/activate HTTP endpoint** — revocation exists as a private method.
- **Group-rename fan-out** re-syncs only *current* effective members; the reconciliation job
  is the backstop.
- **`PATCH /self` merges** attribute edits rather than replacing wholesale, diverging from the
  admin `PATCH /users/:id` convention. Deliberate — prevents a self-service edit erasing
  admin-set attributes — but confirm it cannot be abused.
- **Self-editable core whitelist is only `location`.** `firstName`/`lastName`/`jobTitle` were
  deliberately excluded as an impersonation surface. Confirm nothing else is reachable.
- **JML `deactivate` action performs synchronous Keycloak revocation**, beyond its literal scope.
- **System-actor writes (reconciliation, JML) bypass `PermissionEngine`** — `actorUserId` is
  null and there is no principal. Confirm this cannot be induced from a user-facing path.
- **`user_created` / `user_attribute_changed` JML triggers exist but nothing auto-fires them.**
- **Bulk import references org units and managers by UUID**, not name.

## Historical defect classes this project has actually hit

Worth probing for recurrences — each of these shipped at least once and was caught late:

1. **Fail-open lookups.** `ROLE_RANK[unknown]` → `undefined` → `NaN` → every comparison false →
   guard never threw. Also a status *denylist* that let `pending` (the default status) through.
2. **Prototype-chain bypasses.** `'constructor' in ROLE_RANK` is `true`; `ROLE_RANK['constructor']`
   is a truthy inherited function so `?? fallback` never fired. Hit **three times** in this project.
   Catalogs are now `Object.create(null)` with `Object.hasOwn`.
3. **Vacuous tests.** A decorator-metadata test that passed with the plugin removed; a
   "no credential is set" assertion that was vacuous because Keycloak never echoes credentials
   on a plain GET; a `Café → cafe` test that passed with the normalisation disabled.
4. **Guards with holes shaped like the mistake they prevent.** `guard-coverage` once passed a
   controller carrying `JwtGuard` but no `PermissionGuard`.
5. **Optional parameters that conflate "not applicable" with "lookup failed."**
   `can(actor, action, missingUser?.orgUnitId)` returned **true**.
6. **Transform mismatches.** `tsx`/esbuild does not emit decorator metadata; the app booted
   clean and 500'd on every authenticated request. Invisible to the test suite by construction.
7. **Trigger gaps.** `BEFORE DELETE` does not fire on `TRUNCATE`.
