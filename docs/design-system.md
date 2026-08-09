# DESIGN.md

Visual system for the **Keystone** admin console (previously "Identity Manager" —
see `docs/brand.md` for the name, the mark, and where the single source of truth
for both lives). Register: **product**. Platform: **web**.
Strategy: **Restrained** — tinted neutrals, one accent under 10% of surface —
with exactly **one Committed surface**: the sign-in gate. That screen is the only
moment a visitor is not mid-task, so it is the only place a drenched brand panel
(`--brand-panel` and its own ink pair) and the two display type steps are
allowed. Everywhere inside the console, Restrained still governs.

## Depth

Added with the rebrand, and the thing that most separates this console from
default admin chrome: there are now two surface ROLES, not one.

- `--canvas` is the ground: the page behind the content, and nothing else.
- `--panel` is the raised content surface: tables, toolbars, form cards, the
  sign-in card, dialogs, toasts.
- Chrome (top bar, left nav) sits on `--panel` too, so the frame reads as one
  continuous surface around a recessed work area.

In light that is a faintly olive-tinted ground with true-white panels; in dark
the same relationship inverted (ground *deeper* than `--bg`, panels *above* it).
`--shadow-sm` confirms the lift; the border does the edge work. `--bg` is
unchanged and still what `body` paints, so the pre-paint theme contract is
untouched.

## Theme

Light is the default. Decided by the scene in PRODUCT.md: office light, daytime, dense
tabular scanning, certainty required — that scene is still exactly why light stays what
a first visit sees. What has changed since the last revision of this document is the
word "single": this console now ships a real dark theme too (Milestone 9, Task 2),
built the same way light was — semantic tokens, verified contrast, no colour picked by
eye. Dark is not the *default*; it is not a lesser theme either. `prefers-color-scheme`
is the signal that picks between them for a first visit; an explicit toggle in the top
bar overrides it and persists (`localStorage`), and the choice resolves before first
paint — see `apps/web/index.html`'s inline script and `styles/tokens.css`'s own header
comment for the precedence between "OS says", "user chose", and "no signal at all"
(light wins that last case, for the same office-light reasoning as before).

**The olive does not survive inversion.** `--primary` at L 0.350 is a dark ink, built to
sit on white at 11:1. On a dark surface it is nearly invisible — raising a token's
lightness for one theme is not optional polish, it is the difference between a visible
brand colour and a bug. Dark mode therefore defines its own `--primary` (same hue
family, raised lightness) and its own `--primary-ink`, and every other token below it —
`--danger`, `--warn`, borders, skeletons, the focus ring — got the same treatment: a
distinct value, computed and verified against dark's own three backgrounds, never
assumed to inherit light's numbers.

## Color

OKLCH throughout, in both themes. The mood lives in the brand colour and typography;
the surface — white in light, a near-black warm neutral in dark — stays out of the way
in either case. Screens never reference light or dark directly: every component
consumes the semantic names below (`--bg`, `--ink`, `--primary`, …), and
`styles/tokens.css` is the only file that knows two palettes exist.

```css
/* LIGHT — the default */
:root {
  /* Surfaces */
  --bg:              oklch(1.000 0.000 0);       /* pure white — literal #fff */
  --surface:         oklch(0.985 0.002 110);     /* nav, toolbars — second neutral layer */
  --surface-sunken:  oklch(0.968 0.003 110);     /* table headers, inset wells */

  /* Ink */
  --ink:             oklch(0.205 0.010 110);     /* body — 17.9:1 on bg */
  --ink-muted:       oklch(0.455 0.012 110);     /* secondary — 7.3:1 on bg */
  --ink-subtle:      oklch(0.540 0.010 110);     /* placeholders, meta — 5.1:1 on bg */

  /* Lines */
  --border:          oklch(0.905 0.004 110);
  --border-strong:   oklch(0.820 0.006 110);

  /* Brand — deep olive. Primary actions, current selection, focus. Nothing else. */
  --primary:         oklch(0.350 0.075 110);
  --primary-hover:   oklch(0.300 0.078 110);
  --primary-ink:     oklch(0.995 0.005 110);     /* on --primary — 11.0:1 */
  --focus:           oklch(0.520 0.110 110);     /* focus ring, brighter to read on white */

  /* Semantic — exceptions only */
  --warn:            oklch(0.620 0.130 65);      /* pending, sync in flight */
  --warn-bg:         oklch(0.972 0.030 65);
  --danger:          oklch(0.505 0.150 32);      /* deactivate, destructive, sync failed */
  --danger-hover:    oklch(0.445 0.155 32);
  --danger-bg:       oklch(0.968 0.028 32);
}

/* DARK — prefers-color-scheme, or the top-bar toggle */
:root[data-theme='dark'] {
  /* Surfaces — each step lighter, not darker: in a dark theme, "closer to
     the reader" reads as lighter, the mirror of light theme's bg-brightest
     ordering. */
  --bg:              oklch(0.160 0.004 110);
  --surface:         oklch(0.210 0.005 110);
  --surface-sunken:  oklch(0.260 0.006 110);

  /* Ink */
  --ink:             oklch(0.900 0.004 110);     /* body — 11.5:1 worst case */
  --ink-muted:       oklch(0.730 0.008 110);     /* secondary — 6.5:1 worst case */
  --ink-subtle:      oklch(0.670 0.010 110);     /* placeholders — 5.2:1 worst case */

  /* Lines */
  --border:          oklch(0.360 0.008 110);
  --border-strong:   oklch(0.460 0.010 110);

  /* Brand — same hue (110), raised lightness so it reads on a dark surface.
     --primary-ink flips dark: it now sits ON a light fill, not under one. */
  --primary:         oklch(0.780 0.110 110);     /* 7.9:1 worst case, as text */
  --primary-hover:   oklch(0.830 0.110 110);     /* brighter on hover, not
                                                     darker — see prose below */
  --primary-ink:     oklch(0.180 0.020 110);     /* on --primary — 9.5:1 */
  --focus:           oklch(0.800 0.170 110);     /* higher chroma than
                                                     --primary so a ring reads
                                                     as its own signal, not
                                                     "primary but lighter" */

  /* Semantic — exceptions only, same hue families as light (65 warn, 32 danger) */
  --warn:            oklch(0.750 0.140 65);
  --warn-bg:         oklch(0.280 0.045 65);
  --danger:          oklch(0.700 0.140 32);
  --danger-hover:    oklch(0.760 0.140 32);
  --danger-bg:       oklch(0.280 0.050 32);
}
```

**Why "active" has no colour.** Olive sits at hue 110, adjacent to green — a green
success badge would collide with the brand. That constraint produced the better answer:
most of a directory is active, so colouring the norm is noise. Active renders in
`--ink-muted` with no fill. Colour is reserved for the exception — pending, suspended,
deactivated, sync-failed. This also means status is never colour-alone; every badge
carries its word. Unchanged in dark: the rule is about what colour *means*, not which
theme is on screen.

**Hover gets brighter in dark, darker in light.** Light's `--primary-hover` deepens
(L 0.350 → 0.300) because on a white surface, "more emphasis" reads as pressing the ink
darker. Dark's `--primary-hover` and `--danger-hover` do the opposite (L 0.780 → 0.830,
0.700 → 0.760) — on a dark surface, "more emphasis" reads as brightening toward the
reader. Same intent, opposite direction, because the backgrounds are opposite.

**Contrast floors.** Body ≥4.5:1, large ≥3:1, placeholders held to 4.5:1 (not the
default muted grey) — in **both** themes. Verify any new pairing before shipping it;
never assume a value that passed in one theme passes in the other. (Auditing this for
Task 2 also caught a pre-existing miss: light's own `--ink-subtle` measured ~4.27:1 at
its old L 0.580, despite a comment claiming 4.7:1 — corrected above to L 0.540, ~5.1:1.)
The full measured table for every pairing this console ships, in both themes, lives in
`.superpowers/sdd/2026-08-06-idp-milestone-9-ci-and-polish/task-2-report.md`.

## Typography

One family. No display/body pairing — product UI does not need it.

```css
--font-sans: 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
--font-mono: ui-monospace, 'SF Mono', 'Cascadia Mono', 'Roboto Mono', monospace;
```

**Fixed rem scale**, ratio ≈1.15. Not fluid — clamp-sized headings make a sidebar-
adjacent h1 worse, not better.

| Token | Size | Use |
|---|---|---|
| `--text-xs` | 0.75rem / 12px | badges, table meta |
| `--text-sm` | 0.8125rem / 13px | dense table cells, form labels |
| `--text-base` | 0.875rem / 14px | UI default, body |
| `--text-md` | 1rem / 16px | section headings, prose |
| `--text-lg` | 1.25rem / 20px | page title |
| `--text-xl` | 1.5rem / 24px | detail-page subject name |

**Mono is functional, not decorative.** UUIDs, ltree org paths (`acme.sales.emea`),
Keycloak ids, and `batch_id` render in `--font-mono` — they are strings to compare
character by character, and proportional type makes that harder.

Line length capped at 65–75ch for prose. Tables may run denser.

## Layout

Conventional admin shell, per the chosen direction.

- **Top bar**, 56px (was 48px): the brand lockup, global search (`⌘K` / `Ctrl-K`
  also opens it, and the field carries a leading glyph plus an inline shortcut
  hint that clears on focus), the signed-in identity as a monogram chip, sign
  out. It sheds ornament as the viewport narrows in a fixed order — shortcut
  hint, then the "Signed in as" caption, then the My Profile link, then the
  search field — and the monogram survives longest, because at that width it is
  the only thing left saying who is signed in.
- **Left nav**, 248px, grouped into **Directory · Access · Operations**. A group
  whose every item is hidden by `GET /self/permissions` renders nothing at all,
  heading included. The current item takes a filled `--primary-soft` pill, never
  a side stripe (banned). In the icon rail the headings are dropped and the
  grouping survives as spacing plus a hairline. Collapses to the rail under
  1100px, and behind a disclosure under 780px.
- **Content**: max-width 1440px, 24px gutters.
- Lists are **tables**, not card grids. Detail pages use **tabs**, not accordions.
- Flexbox for 1D, Grid for 2D. No Grid where `flex-wrap` suffices.

**Cascade order matters here.** `main.tsx`'s `import App` is hoisted above its
own `import './styles/components.css'`, so every feature stylesheet is injected
*before* the shared one. A single-class rule in a feature file therefore LOSES to
an equally-specific rule in `components.css` — which is how `.input`'s `padding`
shorthand silently beat the top-bar search field's `padding-left` and hid the
search glyph under the placeholder. Where a feature file must override a shared
component, double the class (`.input.topbar__search-input`) rather than relying
on source order.

**z-index scale** — semantic, never arbitrary:
`--z-dropdown: 10; --z-sticky: 20; --z-backdrop: 30; --z-modal: 40; --z-toast: 50; --z-tooltip: 60;`

## Components

Every interactive component ships **all seven states**: default, hover, focus, active,
disabled, loading, error. Shipping half is not shipping.

- **Buttons** — one shape across the whole surface. Primary (olive fill), secondary
  (bordered), ghost, danger. Loading replaces the label with a spinner *and* keeps the
  button's width, so layout does not jump.
- **Tables** — sticky header on `--surface-sunken`, zebra-free (borders instead),
  row hover, keyboard-navigable rows, sortable columns where sorting is real.
- **Status badges** — word + optional shape, never colour alone. Active is
  uncoloured: no fill, `--ink-muted`, and a hairline border so it still has a
  shape. Pill radius; the exceptions add a tint, a matching border and a dot.
- **Forms** — labels above inputs, inline validation on blur, error text under the
  field naming the field. Attribute-driven fields render by `dataType`, mirroring the
  existing self-service page.
- **Skeletons** for loading tables and detail panes. Spinners only for in-button work.
- **Empty states** teach: what this screen is for, and the one action to take.
- **Toasts** for the result of an action, especially the ones with consequence
  ("Deactivated — 2 active sessions revoked").

Dropdowns use the native popover/`<dialog>` API or `position: fixed` — never
`position: absolute` inside an `overflow` container, which clips them.

## Motion

150–200ms, `ease-out` (quart/quint). Motion conveys state — change, feedback, loading,
reveal — never decoration. No page-load choreography; the console loads into a task.

Every animation needs a `prefers-reduced-motion: reduce` alternative, typically a
crossfade or an instant transition.

## Bans (on top of the shared absolute bans)

- Side-stripe borders on rows, cards or alerts.
- Gradient text. Glassmorphism. Stat-tile hero rows.
- Green "active" badges (see Color).
- Modal as first thought — exhaust inline and progressive alternatives.
- Display type in labels, buttons, or data.
- Custom scrollbars or reinvented form controls.
