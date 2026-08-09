# PRODUCT.md

## Register

`product` — design serves the task. This is an authenticated administrative tool, not a marketing surface.

## Platform

`web`

## What this is

A self-hosted identity provider for a single organisation. Postgres is the system of
record for people, org units, groups and roles; Keycloak owns every credential and
issues the tokens. The admin console is the directory-management surface on top of an
API that is already complete and audited.

## Who uses it

**Primary — the IT administrator.** One to a handful of people at a single company.
They know what an org unit is. They are not learning identity management from this
tool; they are doing a job in it, repeatedly. Their day includes onboarding a starter,
moving someone between departments, adding people to groups, and — the operation that
matters most — offboarding a leaver while someone waits.

**Secondary — the help-desk operator.** Scoped to one part of the tree. Reads and makes
small changes. Must never be able to see or touch anything outside their scope, and the
interface should make that boundary legible rather than surprising.

**Tertiary — every employee**, who only ever sees `/self`: their own profile, their
groups, and a link out to Keycloak for password and MFA.

## The scene

An IT admin at a desk under office light on a Friday afternoon, offboarding someone
while a manager waits on the phone. They need to find one person among hundreds in
seconds, act, and be *certain* the action took effect — including that live sessions
are dead, not merely that a row changed.

That scene decides several things: a light theme, real information density, and state
feedback that is unambiguous about what actually happened.

## What it must do well

1. **Find a person fast.** Search and filter that survives hundreds of rows.
2. **Make consequence visible.** Deactivation revokes live sessions. The interface must
   say so, and must show when a sync to Keycloak is pending or has failed — a user who
   *looks* healthy while their group sync dead-lettered is the worst outcome this
   product can produce.
3. **Make scope legible.** A scoped operator should understand what they can see and
   why, without hitting an unexplained 403.
4. **Never lose an import.** Bulk import previews before it commits; the preview is the
   safety rail and must read as one.

## Brand personality

Institutional, unhurried, exact. The mood phrase: *a municipal records office at 4pm —
oak cabinets, brass fittings, the quiet authority of records that outlast the people
filing them.* This is a system of record. It should feel like one: considered, legible,
and slightly serious. Not playful. Not startup-bright.

## Anti-references

- **Okta / Azure / Google blue.** The category reflex. Avoided deliberately.
- **The SaaS dashboard opener** — a row of big-number stat tiles above the fold. This
  product opens onto a list of people, because that is the job.
- **Card grids for records.** People and groups are tabular data. Tables.
- **Modal-first flows.** Modals are usually laziness; prefer inline and progressive.
- **Colourful "active" badges.** Most of the directory is active; colouring the norm is
  noise. Colour marks the exception.

## Register-specific principles

- **Earned familiarity.** The chosen direction is a conventional admin shell — top bar,
  left nav, tables, tabs — because training cost matters more than distinctiveness
  here. Familiar structure is not permission to be sloppy: every interactive component
  ships all of default / hover / focus / active / disabled / loading / error.
- **Empty states teach.** "No users yet" is a failure. Say what this screen is for and
  what to do first.
- **Skeletons, not spinners**, for content that is loading into a known shape.
- **The API is the authority.** The UI hides what you cannot do; it never decides it.
  Every action the console offers is still enforced server-side.

## Accessibility

Body text ≥4.5:1, large text ≥3:1, placeholders held to the same 4.5:1. Full keyboard
operation including tables and menus. Visible focus on every interactive element. State
is never conveyed by colour alone — a status carries a label, not just a dot.
