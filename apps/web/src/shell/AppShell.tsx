import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { useAuth } from 'react-oidc-context'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { BRAND, BrandLockup } from '../brand'
import { GroupsProvider } from '../groups/GroupsContext'
import { OrgUnitsProvider } from '../org-units/OrgUnitsContext'
import { NAV_GROUP_LABELS, NAV_GROUP_ORDER, NAV_ITEMS } from './nav-items'
import { useSelfPermissions, type Action } from './permissions'
import { ThemeToggle } from './ThemeToggle'
import { useNavMode } from './useMediaQuery'
import './AppShell.css'

function hasAction(
  perms: ReturnType<typeof useSelfPermissions>,
  action: Action,
): boolean {
  return perms.status === 'ready' && perms.actions.has(action)
}

/**
 * `⌘K`/`Ctrl-K` focuses the global search input, from anywhere in the
 * console (docs/design-system.md). Deliberately NOT guarded against firing while focus
 * is already inside another field: unlike a bare-letter shortcut, this one
 * requires a modifier key, so it cannot collide with ordinary typing
 * (the same reasoning command palettes in Slack/Linear/GitHub rely on) —
 * always intercepting it, regardless of current focus, is what makes it
 * reachable "from anywhere" in the first place.
 */
function useGlobalSearchShortcut(inputRef: React.RefObject<HTMLInputElement>) {
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return
      event.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [inputRef])
}

/**
 * `/` and `/people` both render PeopleListPage (docs/product-brief.md bans a
 * dashboard-opener landing page — this product opens straight onto the
 * People list, so `/` IS that screen, not a separate thing that redirects
 * to it — see App.tsx's own doc comment for why a client-side redirect was
 * deliberately avoided). react-router's own NavLink `isActive` only
 * matches `to="/people"` against literal `/people*` paths, so landing on
 * bare `/` would otherwise show NO nav item as current — the one case this
 * function exists to special-case. Every other item matches an exact path
 * or one of its sub-routes (e.g. `/people/:id` still highlights People).
 */
function isNavItemActive(pathname: string, itemPath: string): boolean {
  if (itemPath === '/people' && pathname === '/') return true
  return pathname === itemPath || pathname.startsWith(`${itemPath}/`)
}

/**
 * A search icon and the keyboard hint that goes with it. Both are
 * decorative (`aria-hidden`) — the input's own <label> and `title` already
 * carry the meaning to assistive tech, and the shortcut hint is a
 * discoverability affordance for sighted pointer users, not information.
 */
function SearchIcon() {
  return (
    <svg
      className="topbar__search-icon"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="8.75" cy="8.75" r="5.25" />
      <path d="M12.6 12.6 16.5 16.5" />
    </svg>
  )
}

/**
 * The signed-in identity renders as a chip: a monogram disc plus the
 * username. The monogram is DERIVED from the username, never stored — this
 * console has no avatar concept and inventing one would be a feature, not
 * a polish pass. Two characters max; three starts to look like a word.
 */
function monogramOf(username: string | undefined): string {
  if (username === undefined || username.length === 0) return '?'
  const parts = username.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).filter((x) => x.length > 0)
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
  return username.slice(0, 2).toUpperCase()
}

function NavList({ variant, onNavigate }: { variant: 'full' | 'rail' | 'dialog'; onNavigate?: () => void }) {
  const perms = useSelfPermissions()
  const location = useLocation()
  // An item with no `action` is visible to every authenticated user — see
  // NavItem.action's own comment (today: Recertification, whose reviewer
  // queue belongs to people holding no role at all).
  const visibleItems = NAV_ITEMS.filter(
    (item) => perms.status !== 'error' && (item.action === undefined || hasAction(perms, item.action)),
  )

  if (perms.status === 'loading') {
    return (
      <ul className="nav__list" aria-label="Primary" data-testid="nav-loading">
        {Array.from({ length: 6 }).map((_, i) => (
          <li key={i} className="nav-link nav-link--skeleton" aria-hidden="true">
            <span className="skeleton" style={{ width: '1.25rem', height: '1.25rem', borderRadius: '4px' }} />
            {variant !== 'rail' && <span className="skeleton" style={{ width: '5rem', height: '0.8rem' }} />}
          </li>
        ))}
      </ul>
    )
  }

  if (perms.status === 'error') {
    return <p className="nav__message" role="alert">Could not load navigation.</p>
  }

  if (visibleItems.length === 0) {
    return <p className="nav__message">No sections available for your account.</p>
  }

  function renderItem(item: (typeof NAV_ITEMS)[number]) {
    const active = isNavItemActive(location.pathname, item.path)
    return (
      <li key={item.key}>
        <Link
          to={item.path}
          onClick={onNavigate}
          className={`nav-link${active ? ' nav-link--active' : ''}`}
          aria-current={active ? 'page' : undefined}
          title={variant === 'rail' ? item.label : undefined}
        >
          <item.icon className="nav-link__icon" />
          <span className={variant === 'rail' ? 'sr-only' : 'nav-link__label'}>{item.label}</span>
        </Link>
      </li>
    )
  }

  /*
   * Eight flat links read as a list of features; three named groups read
   * as a product with a shape. The icon rail has no room for a heading —
   * one would either truncate to noise or force the rail past the 64px
   * docs/design-system.md allows — so in `rail` the grouping survives as
   * SPACING between runs of icons and the label is dropped from the
   * accessibility tree too (each link still carries its own name via
   * .sr-only, which is what a screen reader reads in that mode).
   *
   * A group whose every item was filtered out by GET /self/permissions
   * renders nothing at all: an auditor never sees an empty "Directory"
   * heading advertising links they cannot use.
   */
  return (
    <div className="nav__groups">
      {NAV_GROUP_ORDER.map((group) => {
        const items = visibleItems.filter((item) => item.group === group)
        if (items.length === 0) return null
        const labelId = `nav-group-${group}`
        return (
          <div className="nav__group" key={group}>
            {variant !== 'rail' && (
              <h2 className="nav__group-label" id={labelId}>
                {NAV_GROUP_LABELS[group]}
              </h2>
            )}
            <ul className="nav__list" aria-labelledby={variant === 'rail' ? undefined : labelId}>
              {items.map(renderItem)}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Both session-cached reference-data providers this shell's screens share,
 * combined into one so AppShell's own return only nests one extra element
 * (not two) around its actual markup. Order between the two is arbitrary —
 * neither depends on the other's data.
 */
function ShellProviders({ children }: { children: ReactNode }) {
  return (
    <OrgUnitsProvider>
      <GroupsProvider>{children}</GroupsProvider>
    </OrgUnitsProvider>
  )
}

/**
 * The console shell — Milestone 8, Task 2. 48px top bar, 240px left nav
 * (collapsing to a 64px icon rail under 1100px, and behind a `<dialog>`
 * disclosure under 780px — see useNavMode), content region capped at
 * docs/design-system.md's 1440px. Nav items are hidden, not merely disabled, for
 * anything the caller's own GET /self/permissions doesn't grant
 * (docs/product-brief.md: "The API is the authority. The UI hides what you cannot
 * do; it never decides it" — every route behind these links still checks
 * for itself).
 *
 * Wraps its content in OrgUnitsProvider and GroupsProvider (ShellProviders,
 * above): every screen this shell renders needs the same id -> org-unit-path
 * and id -> group lookups, fetched once per session here rather than once
 * per screen.
 */
export default function AppShell() {
  const auth = useAuth()
  const navigate = useNavigate()
  const navMode = useNavMode()
  const isDisclosure = navMode === 'disclosure'

  const searchInputRef = useRef<HTMLInputElement>(null)
  useGlobalSearchShortcut(searchInputRef)

  const dialogRef = useRef<HTMLDialogElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState<string | null>(null)

  // A dialog left open while the viewport grows past the disclosure
  // breakpoint (e.g. rotating a tablet, or a live resize during a demo)
  // would otherwise strand an invisible modal blocking the page under
  // its own inert full-width nav — close it the moment disclosure mode
  // is no longer active.
  useEffect(() => {
    if (!isDisclosure) dialogRef.current?.close()
  }, [isDisclosure])

  function openMenu() {
    dialogRef.current?.showModal()
  }
  function closeMenu() {
    dialogRef.current?.close()
    menuButtonRef.current?.focus()
  }

  function handleSearchSubmit(event: FormEvent) {
    event.preventDefault()
    const value = searchInputRef.current?.value.trim() ?? ''
    navigate(value.length > 0 ? `/people?q=${encodeURIComponent(value)}` : '/people')
    if (searchInputRef.current) searchInputRef.current.value = ''
    searchInputRef.current?.blur()
  }

  /**
   * The original handler discarded the failure entirely — a bare `catch {}`
   * that reported nothing and rendered nothing. On a failed sign-out the
   * spinner stopped, the button re-enabled, and the console sat there looking
   * exactly as it does when signed in. Someone clicking "Sign out" on a shared
   * machine, seeing the button return to normal, and walking away had every
   * reason to believe they had signed out. This is the same defect App.tsx
   * documents at length for sign-IN; the lesson had not been carried across
   * (finding CS-L1, docs/archive/audits/audit-client-supply-chain.md).
   *
   * `try`/`catch` alone cannot fix it, for the reason App.tsx already records:
   * react-oidc-context wraps every navigator method (`signoutRedirect` is in
   * its `navigatorKeys`), catches internally, dispatches its own ERROR state
   * and returns `null` rather than rethrowing. So the catch below never runs
   * for the common failure. `auth.error` is the path that actually carries it,
   * narrowed here by its `source` discriminant so an unrelated failure — a
   * silent-renew error, say — cannot render as a sign-out failure.
   *
   * Nothing after the `await` runs on SUCCESS: oidc-client-ts's
   * RedirectNavigator resolves its promise only on `pageshow`, so a successful
   * redirect unloads the page first. Reaching the line after it means the
   * sign-out did not happen.
   *
   * `removeUser()` runs on the failure path so the local session is destroyed
   * even when the IdP round-trip cannot complete — the user asked to be signed
   * out, and the one thing this app can always honour is dropping its own
   * tokens. UserManager clears the store before navigating anyway, so this only
   * covers failures that happen earlier, before that point.
   */
  async function handleSignOut() {
    setSignOutError(null)
    setSigningOut(true)
    try {
      await auth.signoutRedirect()
    } catch (error) {
      setSignOutError(error instanceof Error ? error.message : String(error))
    }
    try {
      await auth.removeUser()
    } catch {
      // Best-effort: the redirect already failed, and there is nothing further
      // this app can do about a store it cannot write.
    }
    setSigningOut(false)
  }

  const username = auth.user?.profile.preferred_username

  const signOutFailure =
    signOutError ?? (auth.error?.source === 'signoutRedirect' ? auth.error.message : null)

  return (
    <ShellProviders>
      <div className={`shell shell--${navMode}`}>
        <header className="topbar">
          {isDisclosure && (
            <button
              ref={menuButtonRef}
              type="button"
              className="btn btn--ghost topbar__menu-toggle"
              onClick={openMenu}
              aria-haspopup="dialog"
            >
              <span aria-hidden="true">&#9776;</span>
              <span className="sr-only">Open navigation menu</span>
            </button>
          )}

          <Link to="/people" className="topbar__brand" aria-label={`${BRAND.name} — home`}>
            <BrandLockup />
          </Link>

          <form className="topbar__search-form" role="search" onSubmit={handleSearchSubmit}>
            <label htmlFor="global-search" className="sr-only">
              Search people
            </label>
            <SearchIcon />
            <input
              ref={searchInputRef}
              id="global-search"
              type="search"
              className="input topbar__search-input"
              placeholder="Search people…"
              title="Search people (Ctrl+K / Cmd+K)"
              data-testid="global-search"
            />
            <kbd className="topbar__search-hint" aria-hidden="true">
              ⌘K
            </kbd>
          </form>

          <div className="topbar__identity">
            <ThemeToggle />
            <Link className="topbar__profile-link" to="/self" data-testid="topbar-my-profile">
              My Profile
            </Link>
            <span className="topbar__divider" aria-hidden="true" />
            <span className="topbar__user">
              <span className="topbar__monogram" aria-hidden="true">
                {monogramOf(username)}
              </span>
              <span className="topbar__user-text">
                <span className="topbar__user-caption">Signed in as</span>
                <strong className="topbar__user-name" data-testid="signed-in-as">
                  {username}
                </strong>
              </span>
            </span>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              data-loading={signingOut ? 'true' : undefined}
              disabled={signingOut}
              onClick={() => void handleSignOut()}
            >
              <span className="btn__label">Sign out</span>
              <span className="btn__spinner" aria-hidden="true" />
            </button>
          </div>
        </header>

        {signOutFailure !== null && (
          <div className="error-panel" role="alert" data-testid="signout-error">
            <p className="error-panel__message">
              Sign-out failed — <strong>your session may still be open</strong> at the
              identity provider. This browser&rsquo;s tokens have been discarded, but close
              the browser to be certain, especially on a shared machine.
            </p>
            <p className="error-panel__message">{signOutFailure}</p>
          </div>
        )}

        {!isDisclosure && (
          <nav className="nav">
            <NavList variant={navMode === 'rail' ? 'rail' : 'full'} />
          </nav>
        )}

        {isDisclosure && (
          <dialog
            ref={dialogRef}
            className="nav-dialog"
            aria-label="Navigation menu"
            onClose={() => menuButtonRef.current?.focus()}
            onClick={(event) => {
              if (event.target === dialogRef.current) closeMenu()
            }}
            onKeyDown={(event: ReactKeyboardEvent<HTMLDialogElement>) => {
              // Escape is handled natively by <dialog>; nothing to do here —
              // present only so the handler's intent is documented in one
              // place alongside the click-outside-to-close handler above.
              void event
            }}
          >
            <div className="nav-dialog__header">
              <BrandLockup />
              <button type="button" className="btn btn--ghost" onClick={closeMenu}>
                Close
              </button>
            </div>
            <NavList variant="dialog" onNavigate={closeMenu} />
          </dialog>
        )}

        <main className="shell__content">
          <div className="shell__content-inner">
            <Outlet />
          </div>
        </main>
      </div>
    </ShellProviders>
  )
}
