# Archive — historical record

**Nothing in here is authoritative.** The numbered chapters in [`../`](../) supersede it.
These files are not maintained and will drift from the code.

They are kept for two reasons:

1. **Source comments cite specific findings by identifier.** Dozens of comments across
   the codebase say things like "finding H1 (`docs/archive/audits/audit-integrity.md`)"
   or "finding M-2". Deleting the audits would leave those citations pointing at nothing.
2. **The design specs record *why* several decisions came out the way they did**, at more
   depth than a reference chapter should carry — including the alternatives that were
   considered and rejected.

## `specs/` — design documents

Written before each sub-project, and the source of its settled decisions.

| File | Covers |
|---|---|
| `2026-08-04-identity-provider-core-design.md` | The core system — schema, RBAC, audit, outbox, import, self-service, JML |
| `2026-08-06-directory-connectors-design.md` | The connector spine and the three vendor targets |
| `2026-08-06-mail-server-connector-design.md` | The mail server integration, first pass |
| `2026-08-07-mail-server-connector-implementation-design.md` | Its implementation design |
| `2026-08-08-business-roles-entitlements-design.md` | Business roles — **still the live design** for in-progress work; see [14 — Roadmap](../14-roadmap.md) |
| `2026-08-08-user-activate-endpoint-design.md` | `POST /users/:id/activate`, the `user:activate` action, and the console button — **not yet implemented** |
| `2026-08-08-organizations-multi-tenancy-design.md` | Organizations, a Keycloak realm per tenant, and the migration adopting existing data into master — **not yet implemented** |

## `plans/` — milestone build plans

Task-by-task implementation plans, one per milestone. Useful for archaeology ("why is
this shaped like that?") and, for the business-roles plan, for the work still to come.

Milestones 1–7 built the core; 8–9 the console and CI; 10–14 the connectors; then the
mail server; then 15–19 for business roles, of which only 15 has landed.

`2026-08-08-user-activate-endpoint.md` is not a milestone — it is a small, self-contained
plan for `POST /users/:id/activate`, built from the spec of the same date.

## `audits/` — the security audit

| File | Contents |
|---|---|
| `security-audit-input.md` | Known findings given to auditors as a starting point, plus the binding constraints the system claims to uphold and the defect classes it has actually hit |
| `audit-authz.md` | Authentication and authorization findings |
| `audit-injection.md` | Injection findings |
| `audit-integrity.md` | Integrity and concurrency findings |
| `audit-secrets.md` | Secret-handling findings |
| `fix-wave-a-report.md` … `fix-wave-e-report.md` | What each remediation wave actually changed, and how it was verified |

Findings are referenced throughout the source by identifier — `H1`, `M-2`, `C1`, `M6`,
and so on. Those identifiers are stable; the file paths are what moved.

**The audit is incomplete.** Two planned dimensions never ran and roughly twenty findings
are unverified. See [12 — Security model](../12-security.md) for the current position.
