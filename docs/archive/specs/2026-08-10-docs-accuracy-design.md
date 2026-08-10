# Docs accuracy pass — design

**Date:** 2026-08-10
**Status:** approved, not yet implemented

## The problem

`docs/` is 19 files and 5,784 lines, and parts of it are false. Not vague or
dated — false in ways that would send a reader to do the wrong work.

Confirmed before writing this:

| File | Claim | Reality |
|---|---|---|
| `12-security.md:200` | ReDoS in the attribute validator: "`new RegExp(rules.pattern)` compiles an…" | Closed by `6b75107`. `new RegExp` is gone and `validationRules.pattern` is rejected outright, failing closed. |
| `03-data-model.md:356` | Heading: "Business roles — schema landed, engine not yet built" | Engine, API and console are all merged. |
| `03`, `06`, `11` | Connector target lists | Zero mentions of SCIM across all three; six `scim_*` targets are live. |
| `10-api-reference.md` | — | No `/health/ready`, shipped 2026-08-10. |
| `11-operations.md` | CLI list | Missing `role-reconcile` and `hr:sync`. |

Two things make this worse than a normal doc-rot problem.

The false entry is in the **security** document, which is the one place a
reader is least able to verify independently and most likely to trust.

And `14-roadmap.md` currently contains sentences like *"[12 — Security] still
lists this as open; that entry is stale."* One document publicly correcting
another is a stopgap. It was the right call when the roadmap was rewritten
today — better than silently disagreeing — but it is not an end state.

### Why it keeps happening

The recurring failure is not one wrong sentence. It is **one fact stated in
several files**, updated in some and not others. Connector targets appear in
`03`, `06`, `09` and `11`; three missed SCIM. That is not three mistakes. It is
one fact with four chances to go stale, and nothing that notices when they
disagree.

This is the same class of defect the connector-target drift guard was built for
on 2026-08-10: the console hand-maintained a copy of the API's target list, and
because a narrower literal list is assignable to a wider union, the type system
could not see the drift. A live target became invisible to the console. The fix
was not "be more careful" — it was a check that fails.

## Scope

**In scope:** correcting every factual claim across `docs/*.md`, keeping the
existing structure, voice and reasoning; plus an automated guard for the subset
of claims a machine can verify.

**Explicitly not in scope:** restructuring the information architecture,
changing the voice, or rewriting for a different audience. The prose contains
reasoning that has already proven load-bearing — the `Referrer-Policy` analysis
that stopped a bad "fix" on 2026-08-10, the `ngx_http_headers_module`
inheritance trap, the two-role database separation rationale. A rewrite that
discarded that would destroy the most valuable content in the set to fix the
least valuable.

## Design

### 1. A generated fact base

`scripts/extract-doc-facts.mjs` derives the checkable facts from the code once
and writes `docs/.facts.json`.

Eight families, each selected because it has already gone stale, is stated in
more than one file, or both:

| Fact | Source | Documents that assert it |
|---|---|---|
| Routes (method + path) | 22 `*.controller.ts` | `10` |
| Connector targets (13) | `ALL_CONNECTOR_TARGETS` in `connectors/connector.ts` | `03`, `06`, `09`, `11` |
| CLI scripts (17) | `apps/api/package.json` | `11`, `13` |
| Migrations (43) + latest | `db/migrations/*.sql` | `03` |
| Actions (24), roles (5) | `authz/actions.ts` | `08` |
| Environment variables | the env schema | `06` |
| systemd units (7) | `deploy/systemd/` | `05`, `11` |
| `docs/*.md` paths cited from code (28) | `apps/`, `deploy/`, `scripts/` | all |

The value is that the correcting agents **copy** these rather than each
deriving them. Independent derivation of a shared fact is exactly how the
four-way connector-target split happened.

`ALL_CONNECTOR_TARGETS` is read through the same anchored-parse approach
`apps/web/scripts/check-connector-targets.mjs` already uses, and must fail
loudly when its anchor is missing rather than silently yielding an empty set.

### 2. The guard

`scripts/check-docs.mjs`, wired into `pnpm verify` beside the existing web
checks. It asserts only the mechanically checkable:

- every route in the code appears in `10-api-reference.md`, and every route
  documented there exists in the code — both directions, because a documented
  endpoint that does not exist is as harmful as a missing one
- every connector target appears in each list that presents itself as complete
- every `docs/*.md` path cited from `apps/`, `deploy/` or `scripts/` resolves
- documented CLI lists match `apps/api/package.json`

**It deliberately does not police prose.** It would not have caught the ReDoS
entry, which needed a human reading a claim against an implementation. A guard
that is narrow and trusted is worth more than one that is broad and noisy —
a noisy guard gets suppressed, and then catches nothing.

Failure messages must name the file, the specific claim, and the fix, in the
style of the connector-target guard. The audience is someone who has just added
a route and has no idea this document exists.

### 3. Correction, in six groups

Grouped by shared subject rather than one agent per file, so co-dependent facts
move together and cannot diverge:

| Group | Files |
|---|---|
| Connectors & sync | `06`, `09`, connector sections of `03` |
| API surface | `10`, `08` |
| Install & operate | `05`, `11` |
| Orientation | `01`, `02`, `04`, `README` |
| Admin & development | `07`, `13` |
| Security | `12` alone |

`12-security.md` gets its own group: it holds the worst known error, and it is
the document where being wrong is most costly.

Each group is given the fact base, must verify every claim against code or git
history, must cite what it checked, and **must flag anything it cannot
determine rather than guess**. That last rule is what made the roadmap audit on
2026-08-10 trustworthy — it returned two items marked explicitly uncertain
instead of inventing answers, and those two were genuinely undecidable from
source.

### 4. Cleanup

- `14-roadmap.md` — rewritten 2026-08-10 and substantially correct. It needs
  only its "that entry is stale" cross-references removed, **after** `12` is
  fixed. Ordering matters: removing the warning first would leave a window in
  which nothing flags the false entry.
- `03-data-model.md:356` — the business-roles heading, fixed by the connectors
  group.
- `TODO-business-roles.md` — moved to `docs/archive/`. It is a working
  scratchpad, not documentation; `TODO.md` already records that parts of it are
  history. Correcting a dead scratchpad is wasted effort, and leaving it in
  `docs/` implies a currency it does not have.

## Verification

1. **The guard must fail before the corrections and pass after.** Run it on the
   current tree first and record the output in the implementation notes. A
   guard that passes on a tree we know is broken is not a guard.
2. Non-vacuity, the same way the connector-target guard was proven: introduce a
   fake route and a fake target, confirm the guard fails on each, revert.
3. `pnpm verify` clean.
4. Every `docs/*.md` internal link resolves, including anchors — the roadmap
   already had to drop a link to a heading that no longer said what it claimed.
5. Spot-check the corrections against the live deployment (ct:211, serving
   `df50174`) where a claim is about runtime behaviour rather than source.

## Risks

- **An agent "corrects" something that was right.** Mitigated by requiring a
  citation for every change and by grouping, so the same fact is not touched by
  two agents.
- **Prose drift is not covered.** Accepted. The guard covers what it can prove;
  the rest depends on the audit being thorough now.
- **The fact base itself goes stale.** It is generated, never committed as a
  hand-edited file, and regenerated by the guard on every run — the same
  property that makes the CSP hash mechanism trustworthy.
- **Quota.** Five concurrent agents exhausted a session quota on 2026-08-10.
  Six groups should run in two batches of three, not all at once.
