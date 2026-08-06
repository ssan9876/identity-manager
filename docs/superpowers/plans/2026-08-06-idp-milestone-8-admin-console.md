# Identity Provider — Milestone 8 (One-Command Install + Admin Console) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Make the system installable in one command with a working admin account, then build the directory-management console the API has been waiting for.

**Architecture:** The API is complete and audited — this milestone adds no new endpoints except where a screen genuinely needs one. The console is a conventional admin shell (top bar, left nav, tables, tabs) over the existing Keycloak OIDC session, and it hides what the caller cannot do while the server keeps enforcing it.

**Tech Stack:** React 18, Vite, react-router-dom 7, `react-oidc-context` (all already present). Plain CSS with custom properties — no UI framework, no CSS-in-JS.

**Builds on:** Milestones 1–7 plus the security remediation, all merged. 677 API tests + 4 Playwright E2E.

**Design context:** `PRODUCT.md` and `DESIGN.md` at the repo root are binding. Read both before writing any UI. They settle the theme, palette, type scale, layout shell, component states, motion, and the bans.

## Global Constraints

- Never generate, transmit or store a credential. Credential management **deep-links to Keycloak's Account Console** — no password field, no MFA UI, ever.
- Authorization is enforced in the API, never the UI. The console hides unavailable actions for clarity; it never relies on hiding for safety.
- Testcontainers, never mocks, for API tests. `strict: true`, no `any`/`@ts-ignore`.
- Any `package.json` change commits `pnpm-lock.yaml`; any schema change commits its migration and `meta/`.
- Every mutation the console triggers is already permission-checked, scope-narrowed, audited and outboxed server-side. Do not add a bypass.
- Audit rows pin users via a `restrict` FK and can never be deleted — new spec files that write audit rows must not `DELETE FROM users`.

---

### Task 1: One-command install and a bootstrapped admin

Nothing else in this milestone is testable by a human until this exists. Today a fresh
installer completes setup, signs in, and gets **403 on everything**, because
authorization needs a local user row matching their Keycloak username plus a role grant,
and a new install has neither.

**Contract:**
- `pnpm setup` — a single command that: runs preflight checks (Docker running, required
  ports free, Node ≥20, pnpm ≥9) and fails with a *specific, actionable* message when one
  is unmet; starts the compose stack and waits for Postgres healthy and the Keycloak realm
  discovery endpoint to answer; copies `.env.example` to `.env` if absent; installs
  dependencies; runs `db:migrate` (which provisions the runtime role).
- `pnpm bootstrap:admin` — creates the local user for a given Keycloak username, activates
  it, creates a root org unit if none exists, and grants global `super_admin`. Idempotent:
  running it twice must not fail or duplicate. Takes the username as an argument and
  defaults to the seeded dev user. This is the anti-lockout.
- `pnpm dev` — starts the API and the web console together, with clearly labelled output.
- Rewrite the README quickstart around these three commands. State plainly what a fresh
  clone must run, in order, and what they will see when it works.

**Prove it:** from a genuinely clean state — `docker compose down -v`, `.env` removed —
run the documented commands in order and reach a browser session that can list users.
Record the actual terminal output. If any step needs a human to read a doc, it has failed.

---

### Task 2: Console shell, design tokens, People list and detail

**Contract:**
- A single `tokens.css` implementing `DESIGN.md`'s palette, type scale, spacing and
  z-index scale as custom properties. Every later screen consumes these; no ad-hoc values.
- The app shell: 48px top bar (product name, global search, signed-in identity, sign out),
  240px left nav (People · Groups · Org units · Roles · Import · Audit), content region.
  Nav collapses to an icon rail under 1100px and behind a disclosure under 780px.
- **People list**: a real table over `GET /users` — paginated, searchable, filterable by
  status and org unit. Columns: name, username, org unit path (mono), status, sync state.
  Status badges follow `DESIGN.md` — active is uncoloured, exceptions carry colour *and* a
  word. Skeleton rows while loading. An empty state that teaches.
- **People detail**: tabs for Profile, Groups, Roles, Activity. Read-only in this task.
- Nav items the caller lacks permission for are hidden — derived from a new
  `GET /self/permissions` returning the caller's effective actions. That is the one new
  endpoint this milestone needs, and it must return only the caller's own permissions.

**Prove it:** Playwright — sign in, land on People, see a seeded user, open their detail,
see their groups. Plus a keyboard pass: reach and operate the table without a mouse.

---

### Task 3: People writes and Org units

**Contract:**
- Create user: a form driven by `attribute_definitions` (mirroring the self-service page's
  approach), validating inline, surfacing the API's field-named 400s against the right
  inputs rather than as a banner.
- Edit user; deactivate with a confirmation that states the consequence plainly — that
  live sessions are revoked — and a toast reporting what actually happened.
- **Org units**: a tree view, create child, and a detail pane. Paths render mono.
- A scoped operator sees only their subtree and gets an explanation rather than a bare
  403 — the boundary should be legible, not surprising.

**Prove it:** Playwright — create a user, see it in the list, deactivate it, see the
status and sync state change. Assert the confirmation names the session consequence.

---

### Task 4: Groups, membership, and role assignment

**Contract:**
- Groups list and detail; create and edit.
- **Membership**: add and remove users; nest and un-nest child groups. Direct and
  effective membership must be **visually distinct** — that is a spec requirement, not a
  nicety. A cycle attempt surfaces the API's 409 as a clear explanation of why.
- **Role assignment**: grant and revoke, with the scope picker constrained to what the
  caller may actually grant. A rejected grant explains which of the three checks failed
  in terms an admin understands, without disclosing anything about principals they cannot
  see.

**Prove it:** Playwright — add a user to a nested group, confirm they appear under
effective but not direct membership on the ancestor.

---

### Task 5: Bulk import, audit log, and sync visibility

**Contract:**
- **Import**: upload a CSV, run `POST /imports/preview`, and render the diff as three
  clear groups — will create, will update, will fail with reasons. Committing is a
  separate, deliberate action. The preview is the safety rail; it must read as one.
- **Audit log**: searchable and filterable by actor, action, resource and date, with
  before/after rendered readably. This is what the `auditor` role exists for.
- **Sync visibility**: surface dead-lettered outbox events. A user whose group sync
  failed must be visibly distinguishable from a healthy one — "looks synced but isn't" is
  the failure mode this whole read model exists to prevent.

**Prove it:** Playwright — import a two-row CSV, see the preview, commit, see both users.
Assert the preview wrote nothing before commit.

---

## Definition of Done

- [ ] A clean clone reaches a working admin session via three documented commands
- [ ] `bootstrap:admin` is idempotent and prevents first-run lockout
- [ ] Every screen consumes `tokens.css`; no ad-hoc colours or sizes
- [ ] Every interactive component has all seven states
- [ ] Active status is uncoloured; every badge carries a word, not just a hue
- [ ] Skeletons for loading tables; empty states that teach
- [ ] No password input or MFA UI anywhere in `apps/web/src` (existing test enforces this)
- [ ] Keyboard operable throughout; visible focus everywhere; contrast floors met
- [ ] `prefers-reduced-motion` alternative for every animation
- [ ] Suite, build, `smoke:dev` and all Playwright E2E green

## Carried forward

- No CI — the highest-leverage remaining gap.
- ReDoS gate stays closed only while `attribute_definitions` has no write path. **If a
  screen in this milestone adds one, that gate must close in the same task.**
- Hash-chained audit rows for tamper evidence.
- Sub-project 2: the Active Directory connector, still needing the on-prem-vs-Entra-ID
  decision.
