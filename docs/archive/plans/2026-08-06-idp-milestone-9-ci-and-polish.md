# Identity Provider — Milestone 9 (CI, Dark Mode, Person Picker) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Close the three gaps carried out of Milestone 8 — no CI, no dark mode, and forms that ask a human to paste a UUID.

**Architecture:** No new API surface except one search endpoint the picker needs. CI is added twice over: a GitHub Actions workflow for when a remote exists, and a local `verify` gate that works today, because this repository has **no git remote** and a workflow file alone would protect nothing.

**Tech Stack:** GitHub Actions, TypeScript project references, plain CSS custom properties. All existing.

**Builds on:** Milestones 1–8 merged. 756 API tests + 22 Playwright E2E.

**Design context:** `PRODUCT.md` and `DESIGN.md` are binding. Task 2 **amends** `DESIGN.md` — see below.

## Global Constraints

- Never generate, transmit or store a credential. Credential management deep-links to Keycloak.
- Authorization is enforced in the API, never the UI.
- Testcontainers, never mocks, for API tests. `strict: true`, no `any`/`@ts-ignore`.
- Any `package.json` change commits `pnpm-lock.yaml`; any schema change commits its migration and `meta/`.
- Audit rows pin users via a `restrict` FK — new spec files that write audit rows must not `DELETE FROM users`.
- Every interactive component ships all seven states. Active status stays uncoloured. Every badge carries its word.
- Contrast floors — body ≥4.5:1, large ≥3:1, placeholders ≥4.5:1 — hold in **every** theme shipped.

---

### Task 1: CI, and a verify gate that works without a remote

No CI is the highest-leverage gap in the project: every compile-time guarantee
currently depends on a human remembering to run `build`. Two known defect classes —
`apps/api/scripts/` sitting outside the `tsc` program, and the `tsx` transform not
emitting decorator metadata — were both invisible to `pnpm test` by construction.

**Contract:**
- `pnpm verify` at the root: typecheck, lint if configured, build both packages, run the
  API suite, build the web app. One command, one exit code. This is the gate that works
  **today**, with no remote and no runner.
- `pnpm verify:quick` — typecheck and build only, no containers. Fast enough to run
  before every commit.
- **Bring `apps/api/scripts/` into the typecheck.** It is currently outside the `tsc`
  program, so `bootstrap:admin`, `reconcile-cli` and the scheduler are unchecked. Fix by
  including them in a tsconfig the verify step actually runs. Expect real errors when they
  are typechecked for the first time — fix them; do not widen types to silence them.
- `.github/workflows/ci.yml` — runs on push and PR: install with a frozen lockfile, the
  full `verify`, then Playwright E2E against the compose stack. Cache the pnpm store and
  the Playwright browsers. GitHub runners provide Docker, so Testcontainers works
  unmodified.
- The workflow must fail loudly rather than skip: a job that cannot start its services is
  a failure, never a pass. Do not add `continue-on-error` anywhere.
- Update `README.md` and the "no CI" line wherever it is carried in the docs.

**Prove it:** run `pnpm verify` on a clean tree and record the real output. Then break
something deliberately — a type error inside `apps/api/scripts/` — and prove `verify`
catches it. A gate that has never failed has not been tested.

---

### Task 2: Dark mode

`DESIGN.md` currently reads "Light, single theme … Dark mode is a later nice-to-have."
This task makes it real, so it **amends that section rather than contradicting it** —
update `DESIGN.md` in the same commit. A binding document that disagrees with the code is
worse than no document.

**Contract:**
- Restructure `apps/web/src/styles/tokens.css` into semantic tokens with light and dark
  palettes behind them. Screens consume semantic names only; no screen learns a theme.
- `prefers-color-scheme` is the default signal. An explicit toggle in the top bar
  overrides it and persists. Resolve the initial theme **before first paint** — a flash of
  the wrong theme on every load is the failure mode here.
- **The olive does not survive inversion.** `--primary` at L 0.350 is a dark ink; on a
  dark surface it fails contrast badly. Dark mode needs its own primary — same hue family,
  raised lightness — and its own `--primary-ink`. Verify every pairing you ship; do not
  assume a token that passed in light still passes in dark.
- Audit all nine existing CSS files for hardcoded colours and route them through tokens.
  The status-badge rule still holds: active uncoloured, colour marks exceptions, every
  badge carries its word.
- Skeletons, focus rings, table borders and the danger/warn tints all need dark values.
  Focus visibility in dark mode is a common miss — check it explicitly.

**Prove it:** a test that asserts no CSS file under `apps/web/src` contains a raw colour
literal outside `tokens.css`. Then look at every screen in both themes and fix what looks
wrong — including the states that only appear under interaction.

---

### Task 3: Person picker, and the end of UUID inputs

The manager field's own hint text is the defect: *"The manager's system ID — copy it from
the mono ID on their own profile page."* That is an admin leaving the form, navigating to
another record, copying a UUID, and coming back. On a Friday afternoon with someone on the
phone.

**Contract:**
- A reusable search-as-you-type picker component, used for the manager field. It searches
  people by name, username and email, and displays a person the way a human identifies
  one — name, then username and org path as secondary.
- On edit, an already-set manager renders as **that person's name**, not their UUID.
- Full WAI-ARIA combobox semantics: keyboard open/close, arrow-key navigation, Enter to
  select, Escape to dismiss, and results announced to screen readers. Clearable.
- Debounce input and cancel superseded requests — an admin typing fast must never see an
  earlier response overwrite a later one.
- The popup must not be clipped: native popover/`<dialog>` or `position: fixed`, never
  `position: absolute` inside an overflow container.
- **Sweep every form for remaining raw-identifier inputs** — org unit, group, and anywhere
  else a UUID is typed by hand — and give each the same treatment. Fixing only the manager
  field leaves the same defect elsewhere.
- The API already narrows results to the caller's scope. A picker must not become a way to
  discover principals outside it; confirm the endpoint it calls enforces scope, and if a
  new search endpoint is needed, it carries the same `@RequirePermission` as the list it
  searches.

**Prove it:** Playwright — create a user, set their manager by typing a name and choosing
from results, save, and see the manager's **name** on the detail page. Plus a keyboard-only
pass over the picker, and a test that a scoped operator's results stay inside their scope.

---

## Definition of Done

- [ ] `pnpm verify` exists, runs green on a clean tree, and demonstrably fails on a real error
- [ ] `apps/api/scripts/` is inside the typecheck
- [ ] CI workflow committed, with no `continue-on-error`
- [ ] Dark mode ships with `DESIGN.md` amended in the same commit
- [ ] No theme flash on load; contrast floors verified in both themes
- [ ] No raw colour literals outside `tokens.css`
- [ ] No hand-typed UUID remains in any form
- [ ] Picker is fully keyboard operable and scope-respecting
- [ ] Suite, build, `smoke:dev` and all Playwright E2E green

## Carried forward

- Hash-chained audit rows for tamper evidence.
- Sub-project 2: the directory connectors — spine plus AD/LDAP, Entra/Graph and Google
  adapters. Specced separately.
