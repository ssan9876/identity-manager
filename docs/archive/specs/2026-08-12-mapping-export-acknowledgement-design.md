# Mapping Export Acknowledgement — Design

**Finding:** Security item 5, carried in `TODO.md` — "Enabling a propagation
mapping retroactively exports withheld values, and is now reachable. Needs a
confirmation step stating how many users' values a new mapping will newly
export. Interacts with item 4."

**Goal:** Make enabling an attribute→target mapping a decision someone takes
with the number of affected people in front of them, enforced by the API
rather than drawn on a screen.

---

## The exposure

`attribute_target_mappings` is the opt-in that turns default-deny into
propagation: `AttributeTargetMappingsRepository.listForTarget` filters on
`enabled = true`, so a field with no row, or a disabled one, never reaches
`buildTargetAttributes` at all. That structure is sound. What is missing is
any friction on the moment the opt-in is granted.

Two writes enable a mapping, and neither says anything about consequence:

- `POST /attribute-target-mappings` — `enabled` **defaults to `true`**, so
  creating a mapping *is* enabling it.
- `PATCH /attribute-target-mappings/:id` — toggles `enabled`.

Neither emits an outbox event. The values propagate on each affected user's
next sync, quietly and retroactively, for everyone who already holds one.

**The `sensitive` interaction (finding 4).** `sensitive` withholds an
attribute's values from audit-log snapshots. It was deliberately NOT applied
to outbox payloads, because connectors provision from those. The consequence
is stark when the two findings are read together: an attribute whose values
the audit log is forbidden to record can be pushed into Active Directory by
flipping one boolean, and afterwards the audit log cannot even show what was
sent.

Nothing here is a permission bug. `connector:manage`, held globally, is the
right gate for who may do this. The gap is that the person holding it cannot
see what the click costs.

---

## What this adds

### 1. A read endpoint that counts, and writes nothing

```
GET /attribute-target-mappings/export-impact
      ?target=<connector target>
      &attributeDefinitionId=<uuid>   # XOR
      &coreField=<given_name|surname|title|department>

-> { target, holderCount, sensitive }
```

`connector:read`, matching the sibling `GET` on this controller.

A **GET** rather than the migration route's POST, and the difference is
principled: the attribute migration's preview returns a sample of real stored
values, which is why it refuses to be a cacheable, prefetchable, fully-logged
URL. This returns a count and a boolean. No value ever crosses it.

`sensitive` is reported so the console and the CLI can say the sharper thing
without either re-deriving it from a second source.

### 2. Holder, defined

A user is a holder when the mapping would carry a real value for them.

| Source | Holder means |
|---|---|
| custom attribute | `users.attributes` carries the definition's `key` with a non-null value |
| `given_name` | `first_name` is non-null |
| `surname` | `last_name` is non-null |
| `title` | `job_title` is non-null |
| `department` | the user's org unit resolves to a name (`buildTargetAttributes` uses `orgUnit?.name ?? null`) |

In every case restricted to users in an organization that has an **enabled**
`connector_targets` row for that target — `(organization_id, target)` is that
table's natural key, and a tenant without an enabled row exports nothing.

That restriction is the whole point of the number. Counting the directory
would over-state it on any deployment where one tenant of twenty has the
target enabled, and an alarming number that is also wrong gets dismissed.

For `given_name`, `surname` and `department` the count will approach the whole
in-scope population, because nearly every user has those. That is accurate,
not alarmist, and it is exactly the sentence an admin should read before
exporting the directory's names to a third party.

### 3. The API enforces the acknowledgement

Both write bodies gain one optional field:

```ts
acknowledgedExportCount?: number
```

The rule, applied identically on `POST` and `PATCH`:

> When the write would leave the row `enabled: true`, the API re-derives the
> holder count **inside the writing transaction**. If that count is greater
> than zero, `acknowledgedExportCount` is REQUIRED and must equal it.

- Absent → **400**, naming the real number, so the message itself is the
  information the caller needed.
- Present but different → **409**, the same status and the same reasoning as a
  superseded `previewHash` on the attribute migration: the caller
  acknowledged a smaller export than the one they are about to perform.
- Count is zero → the field is not required, and existing callers that export
  nothing are unaffected.

Re-deriving inside the transaction is what makes this a guard rather than a
decoration. A bulk import landing between the read and the click invalidates
the acknowledgement instead of slipping under it.

**Guarded transitions** are any write ending in `enabled: true` where holders
exist:

| Transition | Guarded | Why |
|---|---|---|
| create with `enabled: true` | yes | the shortest path to exporting everything |
| create with `enabled: false` | no | exports nothing |
| `false → true` | yes | the export begins here |
| `true → true` (e.g. a no-op patch) | no | no new export; nothing changes |
| `true → false` | no | reduces exposure |
| `remoteName` rename while enabled | no | those values already flow; this relocates them |

### 4. The audit row records the number

`attribute_target_mapping:create` and `:update` already snapshot the row. The
snapshot gains the acknowledged count and the `sensitive` flag, so the audit
log answers "how many people's values did that click send outward, and was it
an attribute we are not allowed to log the values of" — which is precisely
what finding 4 leaves unanswerable afterwards.

### 5. The console

An inline confirmation in `AttributeMappingsEditor`, in the shape
`BusinessRolesPage` and `ImportPage` already use — not a modal, which
`docs/design-system.md` bans as a first thought.

Enabling a mapping fetches the impact, then states it plainly: how many people,
which target, and — when `sensitive` — that this attribute's values are
withheld from the audit log and will not be recoverable from it after export.
A second, deliberate click sends the count back. The console re-implements no
rule; a stale count earns the API's own 409 and is rendered verbatim.

---

## What this deliberately does not do

- **No retro-revocation.** Values already exported are gone; this is about the
  next irreversible step, not the last one.
- **No new permission.** `connector:manage`, globally held, stays the gate.
- **No blocking.** An admin who reads the number and means it proceeds. The
  design assumes competence and supplies information, rather than assuming
  malice and supplying obstruction.
- **`sensitive` still does not stop propagation.** Making it do so is a
  separate decision with real consequences for connectors that provision from
  those payloads, and it is not smuggled in here.

## Breaking change, stated plainly

A caller that today creates an enabled mapping for a field with existing
holders will begin receiving a 400 until it echoes the count. That is
deliberate: that caller is the risk this finding describes. Callers creating
disabled mappings, or enabled ones over an empty population, are untouched.

## Testing

- **Counting:** custom attribute and each core field; a holder in a tenant
  whose target is NOT enabled is excluded; a user with a null value is not a
  holder.
- **Enforcement:** 400 when absent with holders, naming the count; 409 when
  stale; success when it matches; unaffected when the count is zero.
- **Transitions:** `false→true` guarded; `true→true` and `true→false` not;
  create-disabled not.
- **Audit:** the acknowledged count and `sensitive` reach the audit row.
- **Non-vacuity:** each refusal broken in turn and observed to fail, per the
  standing rule in this project's plans — a refusal test that passes with its
  guard removed proves nothing.
