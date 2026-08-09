# Identity Provider — Milestones 10–14 (Directory Connectors) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Push mastered identity outward into on-prem Active Directory, Entra ID and Google Workspace, over one shared spine.

**Architecture:** Per `docs/archive/specs/2026-08-06-directory-connectors-design.md` — outbound only, reconcile-to-desired-state, connectors never delete, service credentials from the environment only. The existing transactional outbox fans out one row per target; each target retries independently.

**Tech Stack:** Existing spine plus `ldapts` (LDAPS), Microsoft Graph over `fetch`, Google Admin SDK over `fetch` with a service-account JWT. Testcontainers, Samba AD DC container, contract fakes for the two cloud APIs.

**Builds on:** Milestones 1–9. Read the spec before Task 1 — its settled decisions are binding and are not re-opened by any task here.

## Global Constraints

- Never generate, transmit or store a **user** credential. Connector **service** credentials resolve from the environment by name — never a table, never a response body, never a log line, never the console.
- Connectors never delete. Disable only. There is no code path that issues a delete to any target.
- Reconcile to desired state; never replay a delta.
- Authorization is enforced in the API, never the UI.
- Testcontainers, never mocks, for anything with a real container. `strict: true`, no `any`/`@ts-ignore`.
- Any `package.json` change commits `pnpm-lock.yaml`; any schema change commits its migration and `meta/`.
- Every mutation stays permission-checked, scope-narrowed, audited **and** outboxed in one transaction. A rejected mutation writes zero audit rows and zero outbox events.
- Audit rows pin users via a `restrict` FK — new spec files that write audit rows must not `DELETE FROM users`.

---

## Milestone 10 — The connector spine

### Task 1: Multi-target outbox

**Contract:**
- Widen `outbox_target` to `keycloak`, `active_directory`, `entra_id`, `google_workspace`.
- The writer emits one event row per **enabled** target, in the same transaction as the mutation and its audit row. A target that is not configured produces no row at all — not a row that fails later.
- **Per-aggregate ordering becomes per-(aggregate, target).** The existing worker refuses to process an event for an aggregate with an older pending event; scoped globally, one dead-lettered AD event silently blocks every later Keycloak event for that user. Change the predicate and the supporting index together.
- Dead letters, claim queries and backoff all become per-target. The existing `/outbox/dead-letters` endpoint gains a target dimension without losing its current shape.

**Tests that matter:** an event for a stalled target does **not** block another target for the same aggregate — assert directly, this is the whole point of the task; a disabled target emits no rows; the existing Keycloak path is byte-for-byte unchanged in behaviour.

### Task 2: Connector interface, registry and configuration

**Contract:**
- `plan(desired)` / `apply(desired)` / `disable(externalId)` / `health()`. Nothing else. There is deliberately no `delete`.
- `connector_targets` table: which targets exist, enabled or not, and their non-secret configuration (host, base DN, tenant id, domain, blast-radius threshold).
- **Secret resolution:** config stores a secret *name*; the value resolves from the environment at point of use. Reading a target through any API returns configuration with no secret field present — not redacted, absent. Add a test that no endpoint response and no log line can ever contain a resolved secret value.
- An **echo target** implementing the full interface in-repo, recording what it was asked to do. This proves the spine end-to-end before a single line of vendor protocol exists.
- Correlation writes `external_identities` per (user, system), using each target's immutable id — never a DN, never an email.

**Tests that matter:** the echo target receives exactly the desired state for a create, an update and a disable; a target whose secret is missing from the environment fails health cleanly with an actionable message and never partially applies.

### Task 3: Attribute mappings, and default-deny preserved

**Contract:**
- New `attribute_target_mappings` (attribute definition × target → remote name, enabled). **Absence of a row means no propagation** — default-deny becomes structural rather than a default value.
- Migrate every `attribute_definitions.sync_to_keycloak = true` row to `(attribute, 'keycloak', key, true)`, then drop the boolean.
- Core fields map per target too (given name, surname, title, department from the org path).

This edits a binding security constraint. **Re-prove it rather than assuming it survived:** for every target, an attribute with no mapping row must not leave the system, asserted against what the target actually received — not against a filter function in isolation.

**Tests that matter:** an unmapped attribute reaches no target; the migration preserves exactly the previously-syncing set, no more; a mapping disabled after being enabled stops propagating.

### Task 4: Per-target reconcile, blast-radius guard, dry run

**Contract:**
- The reconciliation job takes a target and asserts desired state for every in-scope principal. It remains idempotent — a second run changes nothing.
- **Blast-radius guard:** a run that would mutate more than the target's configured threshold halts and reports what it would have done, instead of proceeding. Halting is the default; overriding is explicit and audited.
- A dry-run CLI printing the plan for a target, writing nothing — same shape as the import preview.

**Tests that matter:** a run exceeding the threshold applies **nothing** — assert zero mutations reached the target, not merely that a warning was logged; dry run writes nothing anywhere; a second reconcile is a no-op.

---

## Milestone 11 — On-prem Active Directory

### Task 5: LDAP adapter — users

**Contract:**
- LDAPS against a real Samba AD domain controller container. Certificate verification on by default; any relaxation is explicit configuration, never a silent fallback.
- Create, update and **disable** users — `userAccountControl` bit 2. No delete.
- Correlate on `objectGUID`. A rename or an OU move must not orphan the correlation; prove it by doing both and re-reading.
- Local org-unit path maps to an AD OU DN. An OU that does not exist is created if configured to, otherwise it is a clear per-row failure.
- Never set, generate or transmit a password. AD accounts are provisioned disabled-until-enabled without one; credentials remain Keycloak's.

**Tests that matter:** create then read back via a fresh LDAP bind; rename a user and confirm the `objectGUID` correlation survives; disable and confirm the account is disabled and **still present**; a connection failure mid-batch leaves no partially-applied user.

### Task 6: AD groups and membership

**Contract:**
- Groups create/update; membership add/remove as `member` DN edges.
- The app's nested groups flatten to AD's own nesting where the shape allows, and to effective membership where it does not. Choose one, document which, and make the choice legible in the console later.
- A group rename must not break membership — AD membership is DN-based and DNs move.

**Tests that matter:** nested membership resolves to the same effective set on both sides; renaming a group preserves every member; removing a member removes exactly one edge.

---

## Milestone 12 — Entra ID

### Task 7: Microsoft Graph adapter

**Contract:**
- OAuth 2.0 client credentials. Token cached in memory, refreshed before expiry, never logged, never persisted.
- Create/update users, `accountEnabled: false` to disable, group membership via `$ref`. Correlate on Graph `id`.
- Respect `Retry-After` on 429 and 503 — Graph throttles aggressively and ignoring it turns a sync into an outage.
- Contract fake per the spec: a real local HTTP server, pinned to recorded real payloads committed to the repo. Record what an unmodified real response looks like, including the error shapes.

**Tests that matter:** throttling is honoured rather than hammered; a 401 refreshes the token exactly once and does not loop; disable sets `accountEnabled: false` and issues no delete.

---

## Milestone 13 — Google Workspace

### Task 8: Admin SDK adapter

**Contract:**
- Service account with domain-wide delegation, impersonating an admin subject. Signed JWT assertion; the key resolves from the environment and is never persisted or logged.
- Create/update users, `suspended: true` to disable, group membership via the Members API. Correlate on Google `id`.
- Google requires a password on user creation. **Generate a high-entropy value, transmit it once, retain nothing** — no storage, no log, no response body, no return value. Immediately mark the account as requiring a change at next sign-in. Document this at the call site: it is the closest this system comes to its own binding constraint, and the only reason it is acceptable is that nothing is retained.
- Respect `Retry-After` and the Admin SDK's quota errors.

**Tests that matter:** the generated value appears in no log, no audit row, no response and no variable that outlives the call — assert it, do not assert the intent; disable suspends and issues no delete; membership changes are idempotent.

---

## Milestone 14 — Connector console

### Task 9: Target configuration, health and dead letters

**Contract:**
- Configure targets: enable/disable, non-secret config, blast-radius threshold. Secret **names** are shown; values are never fetched, so there is nothing to leak — the UI must state where a value comes from rather than implying it is stored.
- Per-target health, visible at a glance, with the last successful sync time.
- Per-target dead letters extending Milestone 8's view, with enough detail to act: which principal, which target, the last error, attempt count.
- Attribute mapping editor over `attribute_target_mappings`, showing plainly that an unmapped attribute does not leave the system.
- Dry-run a reconcile from the console and read the plan before anything applies.

`PRODUCT.md` and `DESIGN.md` are binding, including dark mode as amended in Milestone 9. A target that is failing must be visibly distinguishable from a healthy one, and "configured but never successfully synced" must not read as healthy.

**Prove it:** Playwright — configure the echo target, run a dry run, read the plan, apply, and see health go green. Assert the dry run wrote nothing.

---

## Definition of Done

- [ ] A stalled target never blocks another target for the same aggregate
- [ ] No code path issues a delete to any target
- [ ] No resolved secret appears in any response, log or audit row
- [ ] An unmapped attribute reaches no target, proven per target
- [ ] Blast-radius guard halts and applies nothing
- [ ] Dry run writes nothing, everywhere it is offered
- [ ] `objectGUID` correlation survives rename and OU move
- [ ] Graph and Admin SDK throttling honoured
- [ ] Google's creation password is retained nowhere, proven by assertion
- [ ] Suite, `verify`, `smoke:dev` and all Playwright E2E green

## Carried forward

- Hash-chained audit rows for tamper evidence.
- Inbound sync and AD-as-authentication-source remain out of scope by decision.
