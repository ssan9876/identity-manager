/**
 * The brand — the single source of truth for what this product is called
 * and what its mark looks like.
 *
 * Renaming the product is a ONE-LINE edit: change `BRAND.name` below.
 * Nothing else in the console spells the name out. Every screen that shows
 * it (the sign-in gate, the top bar, prose on the Applications page) reads
 * it from here, and `main.tsx` writes it into `document.title` at boot so
 * even the browser tab follows — `index.html`'s own <title> is only the
 * pre-hydration placeholder and is kept in sync by hand (it cannot import
 * a module; see the comment there).
 *
 * What this file deliberately does NOT touch: the Keycloak realm, the
 * client ids (`idm-console`, `idm-api`, `idm-sync-service`), package names,
 * env vars, service names, database identifiers. Those are wired into a
 * deployed system and are configuration, not brand. See docs/brand.md.
 */

export const BRAND = {
  /** The product name. Change this line to rename the product. */
  name: 'Keystone',
  /** One line, used under the wordmark on the sign-in gate. */
  tagline: 'Identity, governed at the source.',
  /**
   * Used where the sentence needs the product to be a subject with a bit
   * more formality than the bare name ("… is the system of record for …").
   * Derived, not a second hard-coded string, so renaming stays one edit.
   */
  get longName(): string {
    return `${this.name} Identity`
  },
} as const

/**
 * The mark: a keystone — the wedge at the crown of an arch that every
 * other stone leans on, with a keyhole cut through it. Identity is the
 * stone the rest of the access model rests on; pull it and the arch
 * falls. It is drawn once, here, as inline SVG:
 *
 *  - `currentColor` throughout, so it is theme-aware for free — it
 *    inherits whatever ink the surrounding context uses (brand olive in
 *    the top bar, `--primary-ink` on the drenched sign-in panel) without
 *    this component knowing a single colour token.
 *  - `fill-rule="evenodd"` knocks the keyhole out of the wedge rather
 *    than painting a second shape over it, so the mark stays a true
 *    silhouette at any size and over any background.
 *  - No external asset, no runtime fetch, no icon font.
 *  - `aria-hidden` by default: it always sits next to the name in text,
 *    so announcing it again is noise. `title` opts into a labelled
 *    standalone use.
 */
export function BrandMark({
  className,
  title,
}: {
  className?: string
  title?: string
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      role={title === undefined ? undefined : 'img'}
      aria-hidden={title === undefined ? true : undefined}
      aria-label={title}
      focusable="false"
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M3.9 3.4 L20.1 3.4 L17.05 20.6 L6.95 20.6 Z M14.2 9.9 A2.2 2.2 0 1 0 9.8 9.9 L10.65 16.8 H13.35 Z"
      />
    </svg>
  )
}

/**
 * Mark + name, locked up. The one component screens should reach for when
 * they want to show "the brand" — nobody composes their own pairing, which
 * is what keeps the lockup consistent between the top bar and the sign-in
 * gate (`size` only changes the scale, never the relationship).
 */
export function BrandLockup({
  size = 'sm',
  className,
}: {
  size?: 'sm' | 'lg'
  className?: string
}) {
  return (
    <span className={`brand-lockup brand-lockup--${size}${className === undefined ? '' : ` ${className}`}`}>
      <BrandMark className="brand-lockup__mark" />
      <span className="brand-lockup__name">{BRAND.name}</span>
    </span>
  )
}
