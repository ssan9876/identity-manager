# Sub-project 2 — Directory Connectors (AD, Entra ID, Google Workspace) Design

**Status:** approved direction — build order M10 → M14.

## What this is

Sub-project 1 made this system the master directory: Postgres holds people, org units,
groups and roles; Keycloak holds credentials and issues tokens. This sub-project pushes
that mastered identity **outward** into three more directories, so the organisation can
keep using what those platforms are good at — Windows GPO, file shares, printers and
Kerberos from Active Directory; Microsoft 365 from Entra ID; Gmail, Drive and Calendar
from Google Workspace — without anyone maintaining a second copy of the org chart by hand.

## Settled decisions — do not re-litigate

1. **Direction is outbound only.** This app is master; every connector asserts desired
   state into its target. Nothing reads identity *back in* to overwrite local records.
   Inbound sync would contradict architecture C, settled in sub-project 1. A later
   "import from AD" is a bulk-import source, not a connector, and is out of scope.

2. **Reconcile to desired state; never replay deltas.** Same rule the Keycloak worker
   already follows: read the current row from Postgres, assert the whole desired state.
   The outbox says *what changed*, never *how to change it*. This is what makes the sync
   self-healing after any outage.

3. **Connectors never delete.** This system has no delete for users, and neither does any
   connector. A leaver is *disabled* in the target — AD `userAccountControl`, Entra
   `accountEnabled: false`, Google `suspended: true`. A connector bug that deletes is
   unrecoverable in a way a bug that disables is not; removing the capability removes the
   whole class of disaster.

4. **Service credentials come from the environment, never the database.** Connector
   *configuration* (host, base DN, tenant id, mappings) is admin-editable and lives in
   Postgres. The LDAP bind password, Graph client secret and Google service-account key
   are referenced **by name** and resolved from the environment at use. They are never
   stored in a table, never returned by any endpoint, never logged, and never rendered in
   the console. This extends binding constraint 1 rather than weakening it: the system
   still stores no credential.

5. **Mapping is data, not code.** Which local attribute becomes which remote attribute is
   a table, following the precedent set by JML rules. No expression language, no scripting.

6. **One event row per (mutation × target).** Fan-out happens at write time. Each target
   gets independent status, attempts and backoff, so a broken AD connection cannot stall
   Keycloak delivery.

7. **Every connector is dry-runnable.** A plan/diff mode that writes nothing to the target,
   mirroring the bulk-import preview. The preview is the safety rail.

## Architecture

### Multi-target outbox

`outbox_target` widens from `['keycloak']` to include `active_directory`, `entra_id` and
`google_workspace`. The writer emits one row per **enabled** target, inside the same
transaction as the mutation and its audit row — the existing atomicity guarantee extends
unchanged.

**The load-bearing detail is ordering.** The current worker enforces per-aggregate
ordering: never process an event for an aggregate that has an older pending event. With
multiple targets that predicate must become per **(aggregate, target)**. Left as-is, one
dead-lettered AD event would head-of-line block every subsequent Keycloak event for the
same user — the user would look synced, be stale, and nothing would report it. That is
precisely the failure mode this read model exists to prevent, so it gets an explicit test.

### The connector interface

One narrow interface, implemented three times:

- **plan(desired)** → the operations that would run, writing nothing.
- **apply(desired)** → assert desired state, returning the external id.
- **disable(externalId)** → the only removal-shaped operation that exists.
- **health()** → can we reach and authenticate to this target right now.

Correlation uses the existing `external_identities` table, one row per
(user, system) — already unique-indexed and already carrying the three system values.
Each target's immutable key: AD `objectGUID`, Entra `id`, Google `id`. Never the DN,
never the email — both move when a person is renamed or transferred.

### Attribute propagation, generalised

`attribute_definitions.sync_to_keycloak` becomes `attribute_target_mappings`
(attribute × target → remote name, enabled). Absence of a row means no propagation, so
**default-deny is preserved structurally** rather than by a default value. Existing
`sync_to_keycloak = true` rows migrate to `(attribute, 'keycloak', key, true)`.

This touches a binding security constraint, so the default-deny property is re-proven by
test for every target, not just assumed to have survived the migration.

### Safety rails

- **Blast-radius guard.** A reconcile run that would mutate more than a configured
  threshold of the target halts and reports instead of proceeding. Directory syncs that
  went wrong at scale are a well-known way to take down an organisation's logins; the
  guard is the difference between an incident and a catastrophe.
- **Disable-only**, per decision 3.
- **Per-target dead letters**, surfaced in the console alongside the existing ones.

## Testing

Real containers wherever one exists, per the project rule:

- **Active Directory** — a real Samba AD domain controller container. Real LDAP, real
  schema, real bind. No mocking.
- **Entra ID and Google Workspace** — no container exists for either. These use a
  **contract fake**: a real local HTTP server implementing the subset of Microsoft Graph
  and the Google Admin SDK that we call, whose responses are pinned to recorded real API
  payloads committed to the repo.

That is a deliberate, documented exception to the never-mock rule, made because the
alternative is no test at all. It is recorded here so a future auditor reads a decision
rather than discovering a shortcut. The fake's weakness is honest: it proves our request
shapes and our state machine, and cannot prove the vendor behaves as recorded.

## Build order

| Milestone | Scope |
|---|---|
| **M10** | Connector spine: multi-target outbox, interface, config + secret resolution, mappings table, per-target reconcile and dead letters, safety rails |
| **M11** | On-prem Active Directory adapter over LDAPS |
| **M12** | Entra ID adapter over Microsoft Graph |
| **M13** | Google Workspace adapter over the Admin SDK |
| **M14** | Connector admin console: configure targets, per-target health and dead letters, dry-run from the UI |

M10 ships with an in-repo echo target so the spine is provably correct before any vendor
protocol is involved. M11–M13 are then genuinely independent of each other.

## Out of scope

- Inbound sync, and AD/Entra as an *authentication* source (Keycloak already federates if
  that is ever wanted — a different feature).
- Password writeback. The system stores no credential; that is not negotiable.
- Exchange/mailbox provisioning, licence assignment, Teams and Drive resources.
- Multi-forest and multi-domain AD topologies. Single domain per configured target.
