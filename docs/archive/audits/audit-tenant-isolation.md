# Security audit — TENANT ISOLATION

**Ran:** 2026-08-14 · **Against:** `master` at `60474ec` · **Status:** complete, one finding, fixed

---

## Read this before trusting the number "six"

This pass is being recorded as the **sixth** of the six planned adversarial
dimensions. That claim needs a caveat, because the honest position is not that
a lost list was recovered.

**No enumeration of the six planned dimensions by name has ever existed.**
`docs/12-security.md` said so explicitly ("no enumeration of the planned
dimensions by *name* exists anywhere"), `docs/14-roadmap.md` carried only the
total, and `docs/archive/README.md` carried an older and differently-wrong
figure ("two never ran"). What existed was a count, drifting, in three places.

So the sixth dimension was **chosen**, not recovered. The reasoning is below,
and the enumeration is now written down in `docs/12-security.md` so that the
next person inherits a list rather than an argument.

### Why tenant isolation

The five that ran, by their own file titles:

| # | Dimension | Report |
|---|---|---|
| 1 | Authentication and authorization | `audit-authz.md` |
| 2 | Injection (and input validation) | `audit-injection.md`, `security-audit-input.md` |
| 3 | Integrity, concurrency, **availability** | `audit-integrity.md` |
| 4 | Secret handling | `audit-secrets.md` |
| 5 | Client-side and supply chain | `audit-client-supply-chain.md` |

Availability is inside dimension 3's own title, which rules out the otherwise
obvious guess. What is left uncovered, for a system whose entire purpose is
holding several organizations' directories in one database, is the boundary
between them.

Three further reasons it is the right choice rather than merely an unclaimed
one:

- Multi-tenancy **landed after the audit plan was written**. Whatever the
  original sixth was, this is the dimension the system grew and never had
  examined.
- The two findings the earlier passes carried about data exposure (attribute
  values in the audit log; a propagation mapping retroactively exporting
  withheld values) arrived as *carried* findings from elsewhere, not as the
  product of a dedicated pass.
- `docs/12-security.md` constraint 12 makes the strongest and most falsifiable
  claim in the document, and names the exact edges to attack. An unattacked
  claim of that shape is the most valuable thing an audit can spend its time
  on.

---

## What was attacked

Constraint 12, verbatim:

> every reference that could cross a tenant boundary — a user's org unit and
> manager, a group's org unit, an org unit's parent, both endpoints of every
> membership and nesting edge — is a **composite foreign key** including that
> column, so a cross-tenant row cannot be inserted by any writer: not the API,
> not a CSV import, not a connector write-back, **not a future endpoint**, not
> a bug.

"Not a future endpoint" is the part with the shortest half-life, because
endpoints keep being added. Three landed between that sentence and this pass:
`POST /users/:id/transfer`, `PATCH`/`DELETE /org-units/:id`, and the
`DirectoryOrgUnitConnector` write-back.

The pass is `apps/api/test/tenant-isolation.audit.spec.ts`, and it is
deliberately split:

- **Through HTTP**, where an endpoint could plausibly aim a write across the
  boundary — transfer, create, manager assignment.
- **Through the repository, with no application check in front**, for the
  remaining edges. This is the harder test. Going through the controllers
  would mostly prove that authorization happens to refuse first, which is a
  weaker property than the one claimed: the claim is that the *database*
  refuses, so that no future endpoint, import or connector write-back can
  produce the row either.

---

## Finding

### TI-1 — `POST /users/:id/transfer` refused a cross-tenant move with a 500 · **fixed**

A globally-granted `super_admin` passes every authorization check on both ends
of a transfer — that is what a platform operator *is* — so nothing in the
application had an opinion about the destination's tenant. The composite key
`(org_unit_id, organization_id) → org_units` refused the UPDATE.

**The constraint held.** No cross-tenant row was written, and the user did not
move. The defect is entirely in *how* it held:

- A 500 tells an operator nothing they can act on.
- It is indistinguishable from a genuine fault to anything watching 5xx rates.
- It is the exact shape of failure that gets "fixed" later by catching the
  exception and carrying on — at which point the constraint is still enforced
  by the database but nobody knows it is load-bearing.

**Fixed** by refusing before the write, naming the reason: moving a person
between tenants is not a transfer. Their groups, memberships, business roles
and manager are all tenant-local, so none of it would follow them across. It
is a leave and a join, and half-performing it is worse than refusing.

---

## Confirmed, not findings

Worth recording, because a pass that reports only faults gives no signal about
what it actually exercised.

- **Administrators cannot live in a tenant.** `PermissionEngine.resolveActor`
  joins `organizations.isMaster = true`, so a principal inside a tenant does
  not resolve at all — it is refused as an unknown principal. Design decision
  3 is enforced in code, not merely documented. This pass discovered it the
  useful way round: the first fixture put its actor in a tenant and could not
  authenticate.
- **Creating a user into another tenant is not an attack**, and is not
  refused. A platform operator legitimately does this; the user simply belongs
  to that tenant, and `organization_id` is derived from the destination org
  unit rather than taken from the caller. What must not happen — a row whose
  `organization_id` disagrees with its org unit's — cannot.
- **Assigning a manager from another tenant already refused cleanly**, before
  this pass.
- **Every edge constraint 12 names refuses at the database**, with no
  application check in front: a group's org unit, an org unit's parent, and
  both endpoints of a membership.

---

## Scope, and what this pass did NOT cover

Stated plainly, because an audit that overstates its reach is worse than one
that admits a gap.

- **Read-side exposure was not audited, and is not a claim the system makes.**
  Constraint 12 ends "Tenant isolation here is about the DATA, not about who
  may see it." Administrators are platform operators and a global grant spans
  every organization by design. Auditing "can org A's admin read org B" would
  be auditing against a requirement this system deliberately does not have.
  **If a tenant-facing API is ever built** — it is item 4 on the roadmap's own
  list — that is a second authorization model, and it needs its own pass. This
  one says nothing about it.
- **The ~20 unverified findings figure was not re-counted here.** It predates
  several closures and remains an upper bound, exactly as the banner says.
- **Connector write-back was not exercised against a live directory** in this
  pass. The repository-level tests cover the constraint the write-back would
  hit, but the AD connector's own behaviour on a cross-tenant payload is
  untested.
