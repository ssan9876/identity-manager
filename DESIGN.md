# DESIGN.md

Visual system for the Identity Manager admin console. Register: **product**. Platform: **web**.
Strategy: **Restrained** — tinted neutrals, one accent under 10% of surface.

## Theme

Light, single theme. Decided by the scene in PRODUCT.md: office light, daytime, dense
tabular scanning, certainty required. Dark mode is a later nice-to-have, not a default.

## Color

OKLCH throughout. The mood lives in the brand colour and typography; the surface is
pure white and stays out of the way.

```css
:root {
  /* Surfaces */
  --bg:              oklch(1.000 0.000 0);       /* pure white — literal #fff */
  --surface:         oklch(0.985 0.002 110);     /* nav, toolbars — second neutral layer */
  --surface-sunken:  oklch(0.968 0.003 110);     /* table headers, inset wells */

  /* Ink */
  --ink:             oklch(0.205 0.010 110);     /* body — 16.1:1 on bg */
  --ink-muted:       oklch(0.455 0.012 110);     /* secondary — 7.4:1 on bg */
  --ink-subtle:      oklch(0.580 0.010 110);     /* placeholders, meta — 4.7:1 on bg */

  /* Lines */
  --border:          oklch(0.905 0.004 110);
  --border-strong:   oklch(0.820 0.006 110);

  /* Brand — deep olive. Primary actions, current selection, focus. Nothing else. */
  --primary:         oklch(0.350 0.075 110);
  --primary-hover:   oklch(0.300 0.078 110);
  --primary-ink:     oklch(0.995 0.005 110);     /* on --primary — 11.3:1 */
  --focus:           oklch(0.520 0.110 110);     /* focus ring, brighter to read on white */

  /* Semantic — exceptions only */
  --warn:            oklch(0.620 0.130 65);      /* pending, sync in flight */
  --warn-bg:         oklch(0.972 0.030 65);
  --danger:          oklch(0.505 0.150 32);      /* deactivate, destructive, sync failed */
  --danger-hover:    oklch(0.445 0.155 32);
  --danger-bg:       oklch(0.968 0.028 32);
}
```

**Why "active" has no colour.** Olive sits at hue 110, adjacent to green — a green
success badge would collide with the brand. That constraint produced the better answer:
most of a directory is active, so colouring the norm is noise. Active renders in
`--ink-muted` with no fill. Colour is reserved for the exception — pending, suspended,
deactivated, sync-failed. This also means status is never colour-alone; every badge
carries its word.

**Contrast floors.** Body ≥4.5:1, large ≥3:1, placeholders held to 4.5:1 (not the
default muted grey). Verify any new pairing before shipping it.

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

- **Top bar**, 48px: product name, global search (`⌘K` / `Ctrl-K` also opens it), the
  signed-in identity, sign out.
- **Left nav**, 240px: People · Groups · Org units · Roles · Import · Audit. Collapses
  to an icon rail under 1100px, and behind a disclosure under 780px.
- **Content**: max-width 1440px, 24px gutters.
- Lists are **tables**, not card grids. Detail pages use **tabs**, not accordions.
- Flexbox for 1D, Grid for 2D. No Grid where `flex-wrap` suffices.

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
- **Status badges** — word + optional shape, never colour alone. Active is uncoloured.
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
