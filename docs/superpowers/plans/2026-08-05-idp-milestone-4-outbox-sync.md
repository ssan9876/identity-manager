# Identity Provider — Milestone 4 (Outbox + Keycloak Sync Worker) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Every mutation emits a transactional outbox event; a worker drains it into Keycloak, reconciling to desired state. This is the milestone that makes the system a working identity provider with SSO.

**Architecture:** Mutations write their row, their audit record, and an outbox event in **one** transaction — so nothing is ever half-recorded and no distributed transaction is needed. A worker claims events with `FOR UPDATE SKIP LOCKED`, applies them **in order per aggregate**, and pushes *desired state* rather than replaying deltas, which makes every retry idempotent and self-healing. Access revocation is the one deliberate exception: suspend and deactivate call Keycloak synchronously first, then fall back to the outbox for durability.

**Tech Stack:** TypeScript, NestJS 10, Drizzle ORM, Postgres 16, Keycloak 26 Admin REST, Zod, Vitest, Testcontainers.

**Builds on:** M1 `f00a61c`, M2 `a391570`, M3a `730aa13`, M3b `8244868` — all merged. 335 API tests green.

**Plan style:** contracts and decisions, not transcribed code. Implementers write the implementation following existing patterns.

## Global Constraints

- Never generate, transmit, or store a credential. Keycloak owns them — this milestone **pushes user records, never passwords**. Keycloak's required-action email flow handles credential setup.
- **Attribute propagation is default-deny.** Only attributes with `sync_to_keycloak = true` may leave this system. Anything sent to Keycloak can surface in a JWT claim, and JWTs get logged, cached and forwarded.
- No delete for users; `deactivated` is terminal.
- Deactivated users excluded from default list views.
- Authorization enforced in the API, never the UI.
- Testcontainers, never mocks — including a real Keycloak container for sync contract tests.
- Single tenant, no `tenant_id`. `strict: true`, no `any`/`@ts-ignore`.
- Explicit `@Inject(Token)` on every constructor dependency.
- Any `package.json` change commits `pnpm-lock.yaml`; any schema change runs `db:generate` and commits the migration + `meta/`.
- Audit rows pin users via a `restrict` FK and can never be deleted. New spec files that write audit rows must not `DELETE FROM users` — use unique fixture identities and scoped assertions.

---

## Key decisions (settled — do not re-litigate)

1. **Principal resolution stays on `username`.** `external_identities` is introduced for **sync correlation only** this milestone. Switching the authentication path to it would create a chicken-and-egg (a user cannot authenticate until sync has run) and is a security-path change not worth taking alongside a new worker. Username is genuinely stable here because *we* push it to Keycloak. Record this in the engine's comment, replacing the current "Milestone 4 will replace this" note.
2. **Reconcile to desired state, never apply the delta.** The worker reads the current row and asserts full desired state into Keycloak. Retries then converge instead of compounding, and a partially-applied change self-heals.
3. **`UNION`-style dedup is not relevant here, but ordering is:** events for one aggregate must apply in sequence. Out-of-order application lets a stale update silently clobber a rename.
4. **Suspend/deactivate is synchronous-first.** Attempt Keycloak disable + session revocation inline; on failure, still enqueue. Offboarding cannot wait for a queue to drain. Everything else is eventually consistent.
5. **A dead-lettered event is visible, never silent.** Silent sync failure — an admin believes access was revoked when it was not — is the worst failure mode in a directory product.

---

### Task 1: Outbox schema + emission from every existing mutation

**Files:** `db/schema/outbox-events.ts`, `db/schema/external-identities.ts`, `db/schema/index.ts`, `outbox/outbox.writer.ts`, all four write controllers, new `test/outbox-emission.spec.ts`

**Contract:**
- `outbox_events`: `id bigserial`, `aggregateType` (`'user' | 'group' | 'membership' | 'org_unit'`), `aggregateId uuid`, `eventType` (`'created' | 'updated' | 'status_changed' | 'membership_changed'`), `payload jsonb`, `target` (`'keycloak'`), `status` (`'pending' | 'processing' | 'done' | 'failed'`), `attempts int`, `nextAttemptAt timestamptz`, `lastError text`, `createdAt`. Index on `(status, nextAttemptAt)` and on `(aggregateType, aggregateId, id)`.
  There is **no** `deleted` event type — removal propagates as `status_changed` carrying `deactivated`.
- `external_identities`: `userId` FK, `system` (`'keycloak' | 'active_directory' | 'google_workspace'`), `externalId`, `lastSyncedAt`, `syncState`. Unique on `(userId, system)`. Nothing writes it yet beyond Task 3.
- `OutboxWriter.record(tx, event)` — **transaction handle only**, type-enforced exactly like `AuditWriter`. Same reasoning: the event and the mutation it describes commit together or not at all.
- Every existing write handler (users create/update/deactivate; groups create/update/membership; org-unit create; role assign/revoke) emits exactly one outbox event inside its existing transaction. Role assignment emits a `user`-aggregate `updated` event, since Keycloak cares about the user's group/role state, not our assignment row.

**Tests that matter:**
- Each mutation writes exactly one event, with the right aggregate and type.
- A rejected mutation (403, validation failure, cycle) writes **zero** events — same assertion shape already used for audit rows.
- A failed transaction rolls back the event with the mutation.
- `OutboxWriter.record` cannot be called with the pooled handle (compile error).

---

### Task 2: Keycloak Admin REST client

**Files:** `keycloak/keycloak-admin.client.ts`, `test/keycloak-admin.client.spec.ts`, `test/support/keycloak.ts` (extend)

**Contract:**
- Authenticates as a service account using client credentials against the realm, caching the token until shortly before expiry and refreshing on 401. Config comes from `loadEnv` — add `KEYCLOAK_ADMIN_CLIENT_ID` / `KEYCLOAK_ADMIN_CLIENT_SECRET`, and grant that client the `realm-management` roles it needs in the realm import.
- Methods: `findUserByUsername`, `createUser`, `updateUser`, `setEnabled`, `revokeSessions`, `ensureGroup`, `setUserGroups`. All express **desired state**.
- `createUser` sends `enabled`, `emailVerified: false`, and a required action for password setup. **It never sends a password.**
- Attribute payloads include only attributes whose definition has `sync_to_keycloak = true`. This is the default-deny constraint — enforce it in the client's payload builder, not at the call site, so it cannot be forgotten.
- 4xx that indicates a conflict maps to `ConflictError`; 404 to `NotFoundError`; everything else throws so the worker can retry.

**Tests that matter (against a real Keycloak Testcontainer, not a mock):**
- Create, then fetch, and confirm the user exists with `enabled: true` and **no credential** set.
- Update converges: applying the same desired state twice leaves identical results (idempotence).
- A non-`sync_to_keycloak` attribute never appears on the Keycloak user — assert on the fetched representation, not on the request body.
- `setEnabled(false)` + `revokeSessions` genuinely ends an active session: mint a token via direct grant, revoke, and confirm a refresh fails.

---

### Task 3: The sync worker

**Files:** `outbox/sync.worker.ts`, `outbox/outbox.repository.ts`, `test/sync.worker.spec.ts`

**Contract:**
- Claim with `SELECT … FOR UPDATE SKIP LOCKED` so multiple workers are safe and a crashed worker's lock releases for retry.
- **Strict per-aggregate ordering**: never process an event for an aggregate that has an older `pending`/`processing` event. Claim by lowest `id` per aggregate.
- **Reconcile to desired state**: read the current row from Postgres and assert full desired state into Keycloak. Do not replay `payload` as a delta — `payload` is for diagnostics and ordering only.
- Retries: exponential backoff with jitter written to `nextAttemptAt`, `attempts` incremented, `lastError` recorded. After a capped attempt count the event becomes `failed` (dead-letter) and stays visible.
- On success, write the Keycloak id into `external_identities` with `lastSyncedAt`.
- The worker is startable/stoppable and must not run automatically during tests.

**Tests that matter:**
- Applying the same event twice produces identical Keycloak state (the idempotence property the whole design rests on).
- Two workers racing the same backlog process each event exactly once.
- Out-of-order protection: given events 1 and 2 for one user, 2 is never applied before 1 — construct this deliberately.
- Keycloak unreachable → event stays `pending`, `attempts` increments, `nextAttemptAt` moves forward; when Keycloak returns, it drains.
- Exceeding the attempt cap → `failed`, with `lastError` populated and the event still queryable.

---

### Task 4: Synchronous revocation, reconciliation, and sync visibility

**Files:** `users.controller.ts` (deactivate/suspend path), `outbox/reconciliation.job.ts`, `users.controller.ts` read shape, `test/revocation.spec.ts`, `test/reconciliation.spec.ts`

**Contract:**
- Suspend and deactivate attempt Keycloak `setEnabled(false)` + `revokeSessions` **inline, before returning**. On failure, log and still enqueue — never fail the mutation because Keycloak is down, and never report success for access that is still live without also queuing the retry.
- Reconciliation job: walk users, compare to Keycloak, report and repair drift. Runnable on demand (a script, like `db:migrate`); no scheduler in this milestone.
- Sync visibility: `GET /users` and `GET /users/:id` include a `syncState` derived from `external_identities` and any `pending`/`failed` outbox events for that user. A user with a `failed` event must be visibly distinguishable.

**Tests that matter:**
- Deactivating a user with a live session ends that session **before** the HTTP response returns.
- Keycloak down during deactivate: the mutation still succeeds, an event is enqueued, and the response indicates the sync is pending.
- Reconciliation detects a user changed directly in Keycloak and re-asserts desired state.
- A user with a dead-lettered event surfaces as failed in the read model — not silently healthy.

---

## Definition of Done

- [ ] Every mutation emits exactly one outbox event in its own transaction; rejected mutations emit zero
- [ ] The worker is idempotent — applying an event twice converges
- [ ] Per-aggregate ordering holds under a deliberately out-of-order backlog
- [ ] Two concurrent workers process each event exactly once
- [ ] Keycloak outage queues rather than loses; recovery drains
- [ ] Dead-lettered events are visible in the read model
- [ ] Deactivation revokes live sessions synchronously
- [ ] **No attribute without `sync_to_keycloak = true` ever reaches Keycloak** — asserted on the fetched Keycloak representation
- [ ] **No credential is ever sent** — asserted, not assumed
- [ ] Suite, build, and `smoke:dev` green

## Carried forward, still open

- ReDoS gate on `new RegExp(rules.pattern)` — closes when `attribute_definitions` gets a write path.
- `apps/api/scripts/` outside the `tsc` program; no CI.
- Principal resolution deliberately stays on `username` (decision 1).
- The comprehensive adversarial security audit runs once at the end of sub-project 1.
