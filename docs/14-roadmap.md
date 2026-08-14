# 14 — Roadmap and current state

An honest inventory: what is finished, what is half-built, and what is not built at all.

> **Last audited against the tree at `600b44e`.** The previous revision of this file was
> written at `78a79c7`, before eight feature merges landed, and it had drifted badly: it
> described business roles as "schema only, nothing reads the tables", called
> per-organization connector targets "the single largest remaining piece", and listed
> SAML, segregation of duties, recertification and the request catalogue as not built.
> All of that was wrong. Every row below was re-checked against source or `git log` in
> that pass; where a claim could not be re-verified cheaply, it says so rather than
> asserting.

## Finished and in use

| Capability | Notes |
|---|---|
| People, org units, groups | Full CRUD except delete — nothing in this system is deleted |
| Nested groups | Transitive effective membership, cycle-safe under an advisory lock |
| RBAC with org-unit scoping | Five roles, **thirty** actions (it was fourteen, then twenty-four, when this file last claimed a number), three independent dimensions — action, scope, rank |
| Append-only audit log | Two independent enforcement mechanisms |
| Transactional outbox + sync worker | Per-`(aggregate, target)` ordering, backoff, dead letters |
| Synchronous offboarding | Disable + session revocation inline, before the response returns |
| CSV bulk import | Preview then commit, idempotent on `employeeId`, one `batchId` per commit |
| Self-service portal | No id anywhere; default-deny on edits |
| Joiner/mover/leaver automation | Date-driven transitions + event rules, via the `jml:lifecycle` CLI. **No longer grants group membership** — see below |
| **Business roles and entitlements** | Complete: schema, evaluator, reconciler, sweep job, draft/simulate/publish gate, API and console. See its own section |
| **Segregation of duties** | `role_conflicts` (0034), a preventive gate on publish, and a standing-violation report |
| **Request catalogue and approvals** | `GET /access-requests/catalogue`, request/cancel/approve/deny, a catalogue section in the self-service portal and an approvals inbox |
| **Recertification campaigns** | Campaigns and per-item reviews (0037-0038), API and console; a revoke re-reconciles the subject in the same transaction |
| **Role mining recommendations** | `role-miner.ts`, `GET /business-roles/mining/recommendations`, `POST /business-roles/mining/drafts`, and a console page |
| Keycloak connector | Users, attributes, group membership |
| Active Directory connector | LDAPS, `objectGUID` correlation, **native group nesting** |
| Entra ID connector | Graph v1.0, immutable `id` correlation, throttling |
| Google Workspace connector | Admin SDK, domain-wide delegation, throttling |
| Mail server connector | Keyed on **our** user id; full lifecycle status |
| **SCIM 2.0 connectors** | Six target values — Slack, Zoom, Atlassian, Box, Snowflake and a generic slot — sharing **one** adapter (`connectors/scim.connector.ts`). They are separate targets rather than rows of one `scim` target because `(organization_id, target)` is the primary key and `(user_id, system)` is unique in `external_identities`; naming each application is what lets one organization provision Slack *and* Zoom *and* Box |
| **SAML 2.0 applications** | `sso_app_protocol` gained `'saml'` (0039). The entity id lives in the existing `client_id` column, because Keycloak keys a SAML client by the SP entity id in that same field — one column, one uniqueness rule, no second value to drift |
| **HR inbound sources** | `hr_sources` (0040) plus REST/JSON feeds (0041). CSV-over-HTTPS and REST JSON, mapped onto the existing import pipeline, with fetch/preview/commit phases reported separately, a byte cap on the fetched body, a `hr:sync` CLI and a console page |
| **Per-organization connector targets** | `connector_targets`' primary key is `(organization_id, target)` (0033) |
| **Data-flow map** | `GET /data-flows` and a console page: one read-only view of an organization's inbound (HR) and outbound (connector) edges plus the attribute mappings riding each one. Deliberately no live health check — a map of the estate must stay available exactly when part of the estate is down |
| Echo connector | In-repo target proving the whole spine |
| Connector admin console | Config, health, dead letters, dry run, attribute mappings, per-organization selector |
| Admin console | People, groups, org units, admin roles, business roles, recertification, applications, organizations, import, audit, connectors, data flows, HR sources, approvals, self |
| Multi-tenancy (organizations) | See its own section below |
| Light and dark themes | Semantic tokens, verified contrast in both, resolved before first paint |
| Blast-radius guard | Percentage **and** floor, both required, force is audited |
| Two-role database separation | Runtime role structurally cannot violate append-only |
| CI gate | `pnpm verify` — typecheck, build, token check, full API suite |

## Business roles and entitlements — landed

Milestones **M15 through M19 are all in the tree.** The previous revision of this file
said "the schema and the pure evaluator have landed; nothing reads the tables yet. There
is no reconciler, no API and no console surface." Every clause of that is now false.

### The problem it solves

Nothing in the system used to answer *who should have what*. Access was decided two ways:
someone was added to a group by hand, or a JML rule fired once on an event and added them.
Both are imperative — they describe a moment, not a standing truth. Neither can answer
"why does this person have this?", and neither reacts when the answer should change. A
mover who transferred from Sales to Finance kept every Sales group until a human noticed.

A **business role** owns a membership formula and a set of entitlements, and an engine
continuously reconciles the two.

### Settled decisions

These are the decisions the built system holds to, not proposals. They are kept here
because the *reasons* are the expensive part, and code comments cite them.

1. **Membership is derived, with audited exceptions.** A role holds a formula over user
   fields; the engine computes its member set continuously. An admin may include or
   exclude a specific person, and every exception carries a **mandatory reason** and an
   optional expiry. Exceptions exist because they always happen: a model that cannot hold
   one gets a formula bent to cover a single person, which is how entitlement models rot.
2. **Two grant kinds, and no more** — group membership and target-account existence. Not
   licences, mailbox settings, or share permissions. Generic connector-declared
   entitlement types would require widening `DirectoryConnector`, which is a deliberately
   narrow, settled interface.
3. **Memberships carry provenance, and the engine only ever revokes what it granted.** A
   hand-added membership survives a role that says otherwise, and displays as manually
   granted with no role behind it.
4. **JML keeps state transitions; business roles own desired state.** JML retains
   `set_attribute` and `deactivate` plus the schedule-driven triggers.
   `add_to_group`/`remove_from_group` are **gone** (migration `0027`, and the closed
   `KNOWN_ACTIONS` set in `rule-engine.ts`). A start-date rule flips `status` and the role
   engine reacts to the result — so the temporal case still works without roles needing a
   scheduler.
5. **The formula is a flat AND-list over a closed vocabulary. There is no expression
   language.** Less limiting than it looks: `in` gives OR within a field,
   `in_org_subtree` covers department-and-below, and a person's entitlements are the
   **union** of every role they hold — so OR across fields is two roles granting the same
   set.
6. **The engine computes into existing tables.** No second authoritative ledger with
   `group_user_members` as its projection. A second writer on group membership would be a
   large disturbance to proven, audited code and buys only a query that a view over two
   provenance-carrying tables already answers.
7. **Nothing takes effect until that exact thing has been simulated.** Edits land in a
   draft affecting nobody; publishing requires a simulation of the precise draft being
   published, matched by hash — you cannot simulate something harmless and publish
   something else. Enforced in the repository, not by caller convention.
   (`PUT /business-roles/:id/draft`, `POST /:id/simulate`, `POST /:id/publish`.)
8. **Offboarding never acquires a dependency on a formula being correct.** Deactivation
   keeps its existing unconditional path.
9. **Target-account provisioning changes per target, and opt-in.** `provisioning_mode` is
   `('all_users', 'entitled_only')` and **`all_users` is still the default.** An operator
   migrates one target at a time, having first simulated the roles that will feed it. The
   alternative was a catastrophic silent regression: on the day this shipped, if no role
   yet granted any target account, nobody would get an account in any system and fan-out
   would simply stop. This is the one place where "landed" does not mean "in effect" —
   until a target is deliberately moved to `entitled_only`, business roles govern group
   membership only, and every user still gets an account everywhere.

### Build order — all landed

| Milestone | Scope | State |
|---|---|---|
| **M15** — Schema and provenance | The five new tables, provenance columns on membership, `provisioning_mode` | **Landed** |
| **M16** — The evaluator | Pure, total, no database, no ambient clock | **Landed** (`business-roles/role-evaluator.ts`) |
| **M17** — Reconciler, gate, API | `role-reconciler.ts`, the draft/simulate/publish gate, `business-roles.controller.ts` | **Landed** |
| **M18** — Sync integration | Fan out by entitlement, per target, opt-in. `provisioning_mode` is threaded through `outbox.writer.ts`, `sync.worker.ts` and `target-reconciliation.job.ts` | **Landed** |
| **M19** — JML cleanup and console | JML's group actions removed by `0027`; the console has a list, a detail page, a definition editor, a simulate panel, an exceptions tab, a conflicts section and a mining page | **Landed** |

### Two properties worth knowing before you change any of it

- **Conditions are data, never code.** No expression language, no `eval`, no
  `new Function`, no interpolation of a condition's own fields into anything executable.
  Matching is a closed comparison over a closed set of nameable fields, asserted by a
  static source scan over the whole directory. An identity provider that runs
  admin-supplied script against its own directory is a privilege-escalation vector by
  construction.
- **Matching is three-valued, not boolean.** `{ known: false }` is not "did not match".
  A condition this code cannot understand — an operator or field written by a migration
  newer than the running binary — must not fail *open* (grant access nobody intended)
  and must not fail *closed* (silently strip access). It refuses to answer, and the
  reconciler then refuses to act at all for that user: nothing granted, nothing revoked,
  error surfaced. An engine that quietly removes access is the "looks healthy while
  something dead-lettered" failure wearing a different hat. The sweep job carries
  refusals out as **data**, not as a `console.warn` in a log nobody reads.

The evaluator's field allow-list and the reconciler's trigger list are the same list by
construction — `REEVALUATION_FIELDS` is derived from the evaluator's own condition fields
rather than hand-copied. A field that can be named in a formula but does not trigger
re-evaluation when it changes is a mover whose access silently fails to follow them, which
is the exact failure business roles exist to prevent, so it is worth keeping that
derivation intact.

`RoleReconciler` is registered **without** `@Optional()`. A missing provider fails boot
rather than silently skipping re-evaluation.

The sweep (`role-reconciliation.job.ts`, `pnpm --filter @idm/api role-reconcile`) walks
**every** user status, not just `active`. A formula may condition on `status` itself, so a
person who stops being active stops matching — and the only thing that then revokes what
that role granted them is a pass that visits them.

The full design is in
[`archive/specs/2026-08-08-business-roles-entitlements-design.md`](archive/specs/2026-08-08-business-roles-entitlements-design.md);
the task-level plan is in
[`archive/plans/2026-08-08-business-roles-entitlements.md`](archive/plans/2026-08-08-business-roles-entitlements.md).
Both are archive material and are not maintained.

## Built, but with no user-facing surface

| Capability | State |
|---|---|
| **Attribute definitions** | Read API and console rendering exist; **still no write endpoint at all** — `attribute-definitions.controller.ts` carries a single `@Get()`. Managed directly in the database. **The ReDoS that used to block this is closed** (`6b75107`): `new RegExp(rules.pattern)` is gone, `validationRules.pattern` is now rejected outright with a message pointing at the closed `validationRules.format` vocabulary, and it fails *closed* rather than silently skipping a constraint an admin set. |
| **JML rules** | Engine, applier and lifecycle job all work. **Still no HTTP surface** — there is no controller anywhere under `apps/api/src/jml/`. Rules are database rows; the CLI runs them. Simulation exists at the repository level. |

## Not built

Deliberate absences, not oversights:

| Missing | Reason |
|---|---|
| User delete | `deactivated` is terminal, by design |
| Org unit update / delete | Never built; `org-units.controller.ts` has `@Get`/`@Post` only. Renaming or moving a subtree is a scope change |
| Group delete | Never built; `groups.controller.ts` can delete *memberships* and *child links*, never the group |
| Moving a person between org units | An authorization change wearing a profile edit's clothing. `orgUnitId` is deliberately absent from the `PATCH /users/:id` schema |
| **Suspend** over HTTP | Suspension of a *person* has no endpoint; status otherwise comes from lifecycle automation and deactivation. **Activation is no longer missing** — `POST /users/:id/activate` exists for the person created without a `start_date`, who would otherwise sit disabled in every connected directory forever with no console affordance to fix it. (Organizations are a separate thing: `PATCH /organizations/:id` does take `suspended`.) |
| Dead-letter retry over HTTP | Reconciliation is the retry path; a retry endpoint would be an un-audited way to re-trigger arbitrary outbound calls. `outbox.controller.ts` still exposes `GET /dead-letters` and nothing else |
| An in-process scheduler | There is no `ScheduleModule`, no `@Cron`, no `setInterval` anywhere in the API. There are now **five** on-demand scripts, not two — `reconcile`, `target-reconcile`, `role-reconcile`, `jml:lifecycle` and `hr:sync` — and the operator owns the cadence of all of them. That is a bigger crontab than this reason was written for; it is still a defensible position, but it is no longer a small one |
| Multi-forest / multi-domain AD | Explicitly out of scope; one domain per configured target |
| SCIM **inbound** | There is no SCIM *server*: nothing accepts SCIM writes into this system. The SCIM connectors above are strictly outbound. The old justification — "nothing writes into this system except its own API" — **is no longer true**: HR sources pull external feeds in and commit them through the import pipeline. The remaining reason is narrower and worth stating honestly: inbound SCIM would be a *push* surface with no preview step, where HR sources are a *pull* with fetch/preview/commit phases an operator can inspect before anything commits |
| Identity brokering | External IdPs federating *into* Keycloak is out of scope; nothing under `apps/api/src` touches Keycloak identity providers |

Removed from this table because they now exist: **SAML applications**, **segregation of
duties**, **recertification campaigns** and **the request catalogue**. The last three were
listed as blocked on business roles landing first, which was correct — entitlements are
what they operate on, and all three shipped in the weeks after the engine did.

One caveat on SAML: the protocol support is real and tested, but the old note "this is why
Google Workspace SSO is still manual" has **not** been re-verified end to end. SAML is no
longer the blocker; whether anyone has actually stood up a Workspace SP against it is
unknown from the source alone.

## Multi-tenancy — landed, with three deliberate deferrals

Organizations shipped: an `organizations` table, `organization_id` on every directory
row, composite foreign keys that make a cross-tenant reference impossible, a realm per
tenant provisioned by the sync worker, and `POST/GET/PATCH /organizations` with a
console page.

**The fourth deferral is gone.** `connector_targets` was rekeyed to
`(organization_id, target)` in migration `0033`, and per-organization scoping is now
explicit and absolute: an organization with no row for a target is not configured for it,
and *nothing* falls back to another organization's row. Resolution is threaded through the
sync worker and reconciliation, the admin API takes an `organizationId` scope, and the
connectors console has an organization selector. A tenant no longer reaches Keycloak only.

Three things are still deliberately left out.

| Deferred | Why, and what it would take |
|---|---|
| **A tenant-facing API** | Every administrator authenticates against the master realm as a platform operator; there is no route a tenant's own admin could call, and no scoping that would make one safe. Adding one means response DTOs and a second, tenant-scoped authorization model. **This is now the single largest remaining piece** — the connector-targets work took that title away from it |
| **Realm deletion** | There is none, on purpose: deleting a realm destroys every user, session, client and credential inside it irreversibly. A retired tenant is `suspended` — its realm disabled and still present — exactly as a terminated person is `deactivated`. `organizations.controller.ts` has no `@Delete` at all, and it refuses to suspend the master organization |
| **Cross-tenant reporting** | Nothing aggregates across organizations. The audit log carries `organization_id` but nothing groups by it, `GET /organizations` is a roster rather than a dashboard, and even the new data-flow map is scoped to one organization at a time |

## Known limitations to plan around

Re-verified in this pass unless marked otherwise.

- **Principal resolution is by `username`.** `jwt.guard.ts` builds the principal from
  `preferred_username`. Renaming a user in this system renames their identity.
  `external_identities` stores the Keycloak subject and is intended to become the
  authoritative mapping; that swap has not happened.
- **The console's Keycloak issuer, client id and API base URL are compiled into the
  bundle.** They are `import.meta.env.VITE_*` reads in `auth/oidc-config.ts`, so changing
  any of them requires a rebuild.
- **The API's CORS origin is hardcoded** — literally `['http://localhost:5173']` in
  `main.ts` — so production must be same-origin behind nginx.
- **`GET /audit` and dead letters require a *global* grant.** `requireGlobalAuditGrant`
  rejects a scoped `audit:read`. Per-scope audit reading needs its own design — payload
  redaction included — not a `WHERE` clause bolted on.
- **`POST /connector-targets/:target/reconcile` runs as the system actor from an HTTP
  handler.** The job walks the whole directory with `scopePaths: null`, writing
  `external_identities` and `user_target_accounts` and pushing state to a real target for
  every principal, none of those per-entity writes individually permission-checked,
  scope-narrowed or outboxed. What bounds it is authorization, not unreachability:
  `requireGlobalManageGrant` demands a global `connector:manage`, which the static catalog
  gives to `super_admin` alone. The invocation is audited; the individual writes are not.
  This is a genuine exception to "every mutation is permission-checked, scope-narrowed,
  audited and outboxed in one transaction", and it belongs on this list rather than only
  in the security chapter.
- **Group-rename fan-out re-syncs only current effective members.** Reconciliation is the
  backstop. *Carried forward from [12 — Security](12-security.md); not independently
  re-verified in this pass.*
- **The security audit's planned dimensions are done, and its backlog is counted.** All
  six ran, the sixth (tenant isolation) on 2026-08-14, and the carried findings were
  re-counted the same day: **fourteen open, four of them MEDIUM, nothing HIGH or
  CRITICAL**. See [12 — Security](12-security.md) for the dimensions by name and the
  four MEDIUMs by ID.

## If you are picking this up

The highest-value next steps, in order. **This ordering changed substantially**: the
previous list was written when business roles were the centre of gravity, and two of its
four items are now either done or unblocked.

1. **Close the four MEDIUM findings.** The counting is done (2026-08-14): fourteen
   open, four MEDIUM, nothing HIGH or CRITICAL. `SEC-L2` is the one to take first — a
   409 on `POST /users` still discloses another org unit's email and username, and the
   fix for the same disclosure landed only on the import path, so the shape of the fix
   is already known. Then `CAR-system-actor`'s open half, which is the only one that
   breaks a stated constraint.
2. ~~**A write path for attribute definitions**~~ — **shipped** 2026-08-12 (`5af373c`).
3. ~~**A JML rules API and console**~~ — **shipped** 2026-08-13 (`7ba274c`, `600fd55`).
   The ReDoS gate its plan was waiting on was confirmed closed before it was built.
4. **A tenant-facing API** — new to this list, and the largest remaining structural piece
   now that per-organization connector targets have landed. It is deliberately last of
   the four because it is not a missing endpoint; it is a second authorization model, and
   getting it wrong is a cross-tenant data leak rather than a bug.

**Removed from this list: "M16, the business-roles evaluator."** M15 through M19 are all
in the tree.

One smaller thing worth knowing, not large enough to rank:

- **No target has been moved to `entitled_only`.** Business roles govern group membership
  today; the account-provisioning half of the design is built but dormant by default, on
  purpose (decision 9). Migrating the first target is a deliberate operator act preceded
  by a simulation, not a code change.
