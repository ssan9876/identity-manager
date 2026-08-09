# 14 — Roadmap and current state

An honest inventory: what is finished, what is half-built, and what is not built at all.

## Finished and in use

| Capability | Notes |
|---|---|
| People, org units, groups | Full CRUD except delete — nothing in this system is deleted |
| Nested groups | Transitive effective membership, cycle-safe under an advisory lock |
| RBAC with org-unit scoping | Five roles, fourteen actions, three independent dimensions |
| Append-only audit log | Two independent enforcement mechanisms |
| Transactional outbox + sync worker | Per-`(aggregate, target)` ordering, backoff, dead letters |
| Synchronous offboarding | Disable + session revocation inline, before the response returns |
| CSV bulk import | Preview then commit, idempotent on `employeeId`, one `batchId` per commit |
| Self-service portal | No id anywhere; default-deny on edits |
| Joiner/mover/leaver automation | Date-driven transitions + event rules, via the `jml:lifecycle` CLI |
| Keycloak connector | Users, attributes, group membership |
| Active Directory connector | LDAPS, `objectGUID` correlation, **native group nesting** |
| Entra ID connector | Graph v1.0, immutable `id` correlation, throttling |
| Google Workspace connector | Admin SDK, domain-wide delegation, throttling |
| Mail server connector | Keyed on **our** user id; full lifecycle status |
| Echo connector | In-repo target proving the whole spine |
| Connector admin console | Config, health, dead letters, dry run, attribute mappings |
| Admin console | People, groups, org units, roles, import, audit, connectors, self |
| Light and dark themes | Semantic tokens, verified contrast in both, resolved before first paint |
| Blast-radius guard | Percentage **and** floor, both required, force is audited |
| Two-role database separation | Runtime role structurally cannot violate append-only |
| CI gate | `pnpm verify` — typecheck, build, token check, full API suite |

## In progress — business roles and entitlements

Branch `feat/business-roles-entitlements`. **The schema and the pure evaluator have
landed; nothing reads the tables yet.** There is no reconciler, no API and no console
surface.

### The problem it solves

Nothing in the system today answers *who should have what*. Access is decided two ways:
someone is added to a group by hand, or a JML rule fires once on an event and adds them.
Both are imperative — they describe a moment, not a standing truth. Neither can answer
"why does this person have this?", and neither reacts when the answer should change. A
mover who transfers from Sales to Finance keeps every Sales group until a human notices.

A **business role** owns a membership formula and a set of entitlements, and an engine
continuously reconciles the two.

### Settled decisions

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
   `add_to_group`/`remove_from_group` move to roles. A start-date rule flips `status` and
   the role engine reacts to the result — so the temporal case still works without roles
   needing a scheduler.
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
8. **Offboarding never acquires a dependency on a formula being correct.** Deactivation
   keeps its existing unconditional path.
9. **Target-account provisioning changes per target, and opt-in.** `all_users` stays the
   default until an operator deliberately migrates one target to `entitled_only`, having
   first simulated the roles that will feed it. The alternative is a catastrophic silent
   regression: on the day this ships, if no role yet grants any target account, nobody
   would get an account in any system and fan-out would simply stop.

### Build order

| Milestone | Scope | State |
|---|---|---|
| **M15** — Schema and provenance | The five new tables, provenance columns on membership, `provisioning_mode` | **Landed** |
| **M16** — The evaluator | Pure, total, no database, no ambient clock. Ships first because a pure evaluator is provably correct on its own and every later milestone depends on it. | **In progress** — condition matching has landed (`business-roles/role-evaluator.ts`) |
| **M17** — Reconciler, gate, API | The repository, the draft/simulate/publish gate, the reconciliation pass | Not started |
| **M18** — Sync integration | Fan out by entitlement, per target, opt-in. Touches `OutboxWriter` — the most safety-critical shared code in the repository. | Not started |
| **M19** — JML cleanup and console | Remove JML's group actions; build the console surface | Not started |

### What has landed so far

The five tables (see [03 — Data model](03-data-model.md#business-roles--schema-landed-engine-not-yet-built)),
and `business-roles/role-evaluator.ts` — the pure condition matcher. Two properties of it
are worth knowing before anything is built on top:

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
  something dead-lettered" failure wearing a different hat.

The field allow-list must stay identical to the reconciler's trigger list (M17). A field
that can be named in a formula but does not trigger re-evaluation when it changes is a
mover whose access silently fails to follow them — the exact failure business roles exist
to prevent.

The full design is in
[`archive/specs/2026-08-08-business-roles-entitlements-design.md`](archive/specs/2026-08-08-business-roles-entitlements-design.md);
the task-level plan is in
[`archive/plans/2026-08-08-business-roles-entitlements.md`](archive/plans/2026-08-08-business-roles-entitlements.md).

## Built, but with no user-facing surface

| Capability | State |
|---|---|
| **Attribute definitions** | Read API and console rendering exist; **no write endpoint at all**. Managed directly in the database. Note the ReDoS finding in [12 — Security](12-security.md#known-open-items): the validator compiles a database-sourced regex, and it is only unreachable because no write path exists. |
| **JML rules** | Engine, applier and lifecycle job all work. **No HTTP surface.** Rules are database rows; the CLI runs them. Simulation exists at the repository level. |

## Not built

Deliberate absences, not oversights:

| Missing | Reason |
|---|---|
| User delete | `deactivated` is terminal, by design |
| Org unit update / delete | Never built; renaming or moving a subtree is a scope change |
| Group delete | Never built |
| Moving a person between org units | An authorization change wearing a profile edit's clothing |
| Suspend / activate over HTTP | Status is owned by lifecycle automation and deactivation |
| Dead-letter retry over HTTP | Reconciliation is the retry path; a retry endpoint would be an un-audited way to re-trigger arbitrary outbound calls |
| An in-process scheduler | Both recurring jobs are on-demand scripts, so the operator owns the cadence |
| Multi-forest / multi-domain AD | Explicitly out of scope; one domain per configured target |
| SCIM inbound | Nothing writes into this system except its own API |
| SAML applications | OIDC only. This is why Google Workspace SSO is still manual — Workspace federates over SAML |
| Identity brokering | External IdPs federating *into* Keycloak is out of scope |
| Segregation of duties, recertification campaigns, a request catalogue | All depend on business roles landing first — entitlements are what they operate on |

## Multi-tenancy — landed, with four deliberate deferrals

Organizations shipped: an `organizations` table, `organization_id` on every directory
row, composite foreign keys that make a cross-tenant reference impossible, a realm per
tenant provisioned by the sync worker, and `POST/GET/PATCH /organizations` with a
console page. Four things were deliberately left out of it.

| Deferred | Why, and what it would take |
|---|---|
| **Per-organization connector targets** | `connector_targets` is keyed by target alone, so there is one AD / Entra / Google / mail configuration for the whole system. Until that key includes an organization, a tenant reaches Keycloak only. This is the single largest remaining piece. |
| **A tenant-facing API** | Every administrator authenticates against the master realm as a platform operator; there is no route a tenant's own admin could call, and no scoping that would make one safe. Adding one means response DTOs and a second, tenant-scoped authorization model. |
| **Realm deletion** | There is none, on purpose: deleting a realm destroys every user, session, client and credential inside it irreversibly. A retired tenant is `suspended` — its realm disabled and still present — exactly as a terminated person is `deactivated`. |
| **Cross-tenant reporting** | Nothing aggregates across organizations. The audit log carries `organization_id` but nothing groups by it, and `GET /organizations` is a roster, not a dashboard. |

## Known limitations to plan around

- **Principal resolution is by `username`.** Renaming a user in this system renames their
  identity. `external_identities` stores the Keycloak subject and is intended to become
  the authoritative mapping; that swap has not happened.
- **The console's Keycloak issuer, client id and API base URL are compiled into the
  bundle.** Changing any of them requires a rebuild.
- **The API's CORS origin is hardcoded** to the Vite dev server, so production must be
  same-origin behind nginx.
- **`GET /audit` and dead letters require a *global* grant.** Per-scope audit reading
  needs its own design — payload redaction included — not a `WHERE` clause bolted on.
- **Group-rename fan-out re-syncs only current effective members.** Reconciliation is the
  backstop.
- **The security audit is incomplete.** Two dimensions never ran; roughly twenty findings
  are unverified. See [12 — Security](12-security.md).

## If you are picking this up

The highest-value next steps, in order:

1. **Finish the security audit** — it is the one thing standing between this and a real
   network.
2. **M16, the business-roles evaluator** — pure, testable, and everything after it
   depends on it being right.
3. **A write path for attribute definitions** — but fix the ReDoS first, because that
   path is what makes it reachable.
4. **A JML rules API and console** — the engine is done and proven; only the surface is
   missing.
