# Brand

The product is **Keystone**.

## Where the name lives

`apps/web/src/brand/index.tsx` is the single source of truth. It exports:

| Export | What it is |
|---|---|
| `BRAND.name` | The product name. **Renaming the product is this one line.** |
| `BRAND.tagline` | One line, used under the wordmark on the sign-in gate. |
| `BRAND.longName` | Derived (`` `${name} Identity` ``), for prose that needs a fuller subject. |
| `BrandMark` | The mark, inline SVG, `currentColor`, theme-aware, no external asset. |
| `BrandLockup` | Mark + wordmark, `size="sm" \| "lg"`. The only sanctioned pairing. |

Everything that shows the name imports from there — the sign-in gate
(`src/App.tsx`), the top bar and narrow-nav menu (`src/shell/AppShell.tsx`), the
Applications page prose (`src/sso-apps/SsoAppsListPage.tsx`), and
`src/main.tsx`, which writes `BRAND.name` into `document.title` before the first
render.

**One hand-synced copy exists:** `apps/web/index.html`'s `<title>`. That tag is
parsed before any bundle exists, so it cannot import the module; it is a
placeholder visible for the few milliseconds before boot, and `main.tsx`
overwrites it. If `BRAND.name` changes, change that line too. Both places carry
a comment saying so.

Lockup styling lives in `apps/web/src/styles/components.css` under
`.brand-lockup` — shared by the top bar and the sign-in gate so the only thing
that ever differs between them is scale.

## What the brand is NOT allowed to touch

This is a UI change. The following are configuration wired into a deployed
system and were deliberately left alone:

- the Keycloak realm name (`identity-manager`)
- client ids: `idm-console`, `idm-api`, `idm-sync-service`
- package names (`@idm/web`, `@idm/api`), env var names, service names,
  database identifiers, repository/directory names

## The mark

An architectural **keystone** — the wedge at the crown of an arch that every
other stone leans on — with a **keyhole** cut through it. Identity is the stone
the rest of the access model rests on; pull it and the arch falls. The keyhole
is what makes it read as access rather than masonry.

Drawn as one path with `fill-rule="evenodd"`, so the keyhole is knocked out of
the wedge rather than painted over it. That keeps it a true silhouette at any
size and over any background, and means it needs exactly one colour —
`currentColor`. In the top bar it inherits `--primary`; on the sign-in panel the
whole lockup inherits `--brand-panel-ink`. No external asset, no icon font,
nothing fetched at runtime.

## The other two candidates

Kept here so swapping is cheap: change `BRAND.name` (and `index.html`'s
`<title>`), and nothing else moves.

**Warden** — the one who holds the keys and answers for who is inside. The
coolest of the three and the most security-native; it also reads as the most
ownable. Rejected because the tone is custodial bordering on punitive: this
product's daily job is joiners and movers, not gatekeeping, and a console
called Warden frames every routine change as a permission being policed. Mark
would have been a shield or a keyhole — both more generic than the keystone.

**Lodestar** — the fixed star you steer by; downstream systems steer by this
directory the same way. Captures "system of record" better than either
alternative, and gives an easy compass-star mark. Rejected as slightly
literary and soft for a security console, three syllables where the others are
two, and the star mark is the single most common shape in enterprise software.

**Keystone** — chosen. It says "everything else rests on this" without saying
"identity", it carries *key* quietly, and it yields a mark that is
geometric, unusual, and legible at 20px. The known cost is that Keystone is a
common name in fintech and mortgage branding; in the IAM category it is
distinctive, and nothing here depends on the name being globally unique.
