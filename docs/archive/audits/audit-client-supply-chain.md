# Security Audit — Admin Console (Client-Side) & Supply Chain

**Auditor lens:** browser-side attack surface of `apps/web` — token storage and lifetime,
XSS sinks, user-controlled URL sinks, UI-vs-API authorization, edge security headers,
identity data leaking into history/logs/error surfaces — plus the dependency supply chain
across both apps: known-vulnerable packages and their *reachability*, version-range
hygiene, install-time script execution, and CI/installer trust.
**Date:** 2026-08-08 · **Branch:** `audit/client-supply-chain` @ `da74d6d` ·
**Method:** static read of `apps/web/src`, `deploy/`, `scripts/`, `.github/`;
`pnpm audit --json` against the committed `pnpm-lock.yaml` (registry query only — no
install, no lockfile write); upstream `oidc-client-ts@3.5.0` and
`react-oidc-context@3.3.1` source read directly from the tagged releases to settle
storage/lifecycle defaults rather than assert them from memory.

**No browser was driven and no build was run** (Docker and the test suite were off-limits
for this pass). Every claim below is marked **confirmed** (verifiable from source or from
upstream library source) or **suspected** (requires a build or a live browser). Nothing is
asserted as reproduced that was not.

**Identifier convention.** This report prefixes identifiers with `CS-` (`CS-H1`, `CS-M1`,
`CS-L1`). The four prior audits independently used bare `H1`/`H-1`/`M1`/`L1`, which now
collide across four files; source comments disambiguate only by also naming the report
file. New citations from source should read *"finding CS-M1,
docs/archive/audits/audit-client-supply-chain.md"* and are unambiguous without the path.

---

## Summary

| # | Severity | Reachability | Finding |
|---|---|---|---|
| CS-M1 | **MEDIUM** | Confirmed present; exploitation currently blocked by an unrelated setting | nginx's `add_header` inheritance rule silently discards **all three** security headers on every console response. Only `/api/` — the one location that needs them least — actually receives them. |
| CS-M2 | **MEDIUM** | Defence-in-depth gap; no live XSS found | There is **no Content-Security-Policy** anywhere, and the access *and refresh* token live in `sessionStorage`. One script-injection anywhere becomes total admin session theft with nothing in the way. |
| CS-M3 | **MEDIUM** | Reachable by a network-position attacker | No `Strict-Transport-Security` on the TLS vhost. The 301 from :80 protects nothing on the first request. |
| CS-H1 | **HIGH** | Reachable at every install and upgrade | Dependency lifecycle scripts execute unsandboxed as the service user on the identity-provider host, and `pnpm` itself is fetched through an unpinned, integrity-unverified `corepack prepare pnpm@9`. |
| CS-M4 | **MEDIUM** | Reachable at every fresh install | `scripts/install.sh` pipes a remote script into `bash` as **root** with no pinning or checksum. |
| CS-M5 | **MEDIUM** | Latent — repo has no remote yet | CI pins actions to mutable tags, declares no `permissions:` block, and leaves the checkout token on disk while arbitrary install scripts run in the same job. |
| CS-M6 | **MEDIUM** | Developer workstations only | `vite@5.4.21` + `esbuild@0.21.5` dev-server advisories are unfixed on the 5.x line. On Windows — this project's dev platform — a malicious page visited while `pnpm dev` runs can read files outside the project root. |
| CS-L1 | LOW | Reachable by any signed-in user | Sign-out failure is swallowed silently: the button re-enables and the session survives, with no error shown. Same defect class `App.tsx` documents at length for sign-**in**, unfixed on the sign-**out** side. |
| CS-L2 | LOW | Reachable post-logout | `revokeTokensOnSignout` is left at its `false` default; the access token stays valid until `exp` after the user signs out. |
| CS-L3 | LOW | Reachable by anyone reading logs or the browser | People's names and email addresses are placed in the URL query string, so they land in browser history and in nginx's access log in plaintext. The OIDC `code`/`state` land there too. |
| CS-L4 | LOW | Not exploitable in the documented topology | **Documented item, verified and re-assessed downward.** The API's hardcoded `http://localhost:5173` CORS origin costs essentially nothing here — but not for the reason the docs give. |
| CS-L5 | LOW | Reachable by a local user on the Proxmox host | `GITHUB_TOKEN` is embedded in a clone URL passed on a command line, exposing it in `ps`. |
| CS-I1 | INFO | — | **Documented item, verified.** Build-time-inlined `VITE_*` config is confirmed present and confirmed harmless: all three values are public by OIDC design and no secret is compiled in. |
| CS-I2 | INFO | — | Compose images are pinned to floating minor tags, not digests. Dev-only; production does not use Compose. |

**No CRITICAL finding.** **No XSS was found** — the console contains zero HTML-injection
sinks and exactly one `href`, which is not data-derived. **No place was found where the
console is the only thing preventing an action.**

**Confirmed: 13. Suspected: 0 findings** — but three *sub-claims* inside confirmed findings
could not be verified without a build or a browser, and are flagged inline as such
(CS-M1's exploitability, CS-M2's exact CSP hash set, CS-M2's `style-src` compatibility).

Of the **32 advisories** `pnpm audit` reports against the lockfile (1 critical, 9 high, 19
moderate, 3 low), **zero are reachable in the deployed production system**. Reachability
analysis is in Part B; it is the substance of this half of the report, not a footnote.

---

# Part A — the admin console

## CS-M1 (MEDIUM) — nginx silently drops every security header on every console response

### What

Both vhosts end with three headers that the config's own comment calls "free defence in
depth for the console's own responses" — `deploy/nginx/idm.conf:53-57`, and identically
`deploy/nginx/idm-tls.conf:73-77`:

```nginx
    # Not a security control on its own — the API enforces authorization
    # itself — but free defence in depth for the console's own responses.
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "same-origin" always;
```

They are at `server` level. Both locations that serve console content declare an
`add_header` of their own — `idm.conf:40-51`:

```nginx
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }

    location / {
        add_header Cache-Control "no-store";
        try_files $uri $uri/ /index.html;
    }
```

`ngx_http_headers_module`'s inheritance rule is the whole finding, verbatim from nginx's
documentation:

> These directives are inherited from the previous configuration level **if and only if
> there are no `add_header` directives defined on the current level.**

Because `location /` and `location /assets/` each define one `add_header`, **all three
server-level headers are discarded for both**. `always` does not change this — it governs
whether a header is emitted on error responses, not inheritance.

The result is exactly inverted from the intent:

| Response | `X-Frame-Options` | `nosniff` | `Referrer-Policy` |
|---|---|---|---|
| `/`, `/people`, `/people/:id`, every SPA route → `index.html` (`location /`) | **absent** | **absent** | **absent** |
| `/assets/*.js`, `/assets/*.css` (`location /assets/`) | **absent** | **absent** | **absent** |
| `/api/*` (no `add_header` of its own → inherits) | present | present | present |

Every SPA route falls through `try_files $uri $uri/ /index.html`, and that internal
redirect re-matches `location /` — so there is no console HTML response anywhere that
carries an anti-framing header. The only responses that do are the JSON API responses,
which nobody frames.

**Confirmed** by reading the config against the documented inheritance rule. Not verified
against a running nginx (no nginx in this worktree).

### Who can reach it, and what it costs

Any origin that can get an authenticated administrator to visit a page. The obvious attack
is clickjacking an admin console: frame `https://idm.example.com/people/<victim>`, overlay
bait, harvest clicks on **Deactivate**, **Revoke role**, **Remove member**, or a connector
**Disable** toggle. `ConfirmDialog.tsx` puts a second click in the way, which raises the bar
but has never been a defence against multi-step clickjacking.

**The attack does not currently work, for a reason unrelated to this config.** The OIDC
user is stored in `sessionStorage` (`apps/web/src/auth/oidc-config.ts:36`), and
`sessionStorage` is scoped per-origin **per top-level browsing context**. A framed instance
of the console inside an attacker's tab gets a *fresh, empty* store for the console's
origin — not the administrator's session — so it renders the "Sign in" gate, not an
authenticated page. Nothing re-authenticates it silently either: `signinSilent` needs a
`silent_redirect_uri`, which is not configured, and `automaticSilentRenew` only fires when
a user already exists in the store.

So the honest severity is: **the headers are definitively not being sent, and the
protection the operator believes is in place is absent — but the exploit is blocked by an
incidental property of a different setting.** That coupling is the real hazard. The moment
anyone moves `userStore` to `localStorage` — the single most commonly requested change in
any console ("keep me signed in"), and a one-line diff in a file whose comment says nothing
about this — clickjacking against an identity provider's admin console becomes live, with
no other control in the path and nothing in either file to warn them.

`nosniff` being dropped on `/assets/` and on the HTML is a smaller, independent loss.

**Suspected, not verified:** the non-exploitability argument above is reasoned from the
HTML Storage spec, not confirmed in a browser. It should be confirmed before anyone relies
on it.

### Fix direction

Move the three headers into every location block that serves console content (nginx has no
inheriting alternative — `add_header` does not merge), and take the opportunity to add
CS-M2 and CS-M3 in the same place. A shared snippet keeps them from drifting:

```nginx
# deploy/nginx/security-headers.conf
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Content-Security-Policy "default-src 'none'; script-src 'self' 'sha256-…'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://kc.example.com; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" always;
add_header Referrer-Policy "same-origin" always;
```

```nginx
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        include /etc/nginx/snippets/security-headers.conf;   # re-declared, not inherited
        try_files $uri =404;
    }

    location / {
        add_header Cache-Control "no-store";
        include /etc/nginx/snippets/security-headers.conf;
        try_files $uri $uri/ /index.html;
    }
```

Add a regression check to `scripts/verify.mjs` asserting `curl -sI https://host/` actually
returns the headers. A config that silently means the opposite of what it says is precisely
the "vacuous test" defect class `docs/12-security.md` already lists — the assertion has to
be against the response, never against the config text.

---

## CS-M2 (MEDIUM) — no Content-Security-Policy, and the refresh token is in `sessionStorage`

### What

No `Content-Security-Policy` header is set in `deploy/nginx/idm.conf` or
`deploy/nginx/idm-tls.conf`, and no `<meta http-equiv="Content-Security-Policy">` exists in
`apps/web/index.html`. **Confirmed** — the string does not occur anywhere in the repository.

What sits behind that absent control, `apps/web/src/auth/oidc-config.ts:29-37`:

```ts
export const oidcConfig: AuthProviderProps = {
  authority: keycloakIssuer,
  client_id: import.meta.env.VITE_KEYCLOAK_CLIENT_ID,
  ...
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
}
```

The `oidc.user:<issuer>:idm-console` entry that `WebStorageStateStore` writes holds the
serialized `User` — `access_token`, `id_token` **and `refresh_token`**. Any script running
on the console's origin can read all three synchronously. `automaticSilentRenew` is `true`
(confirmed from `UserManagerSettings.ts@v3.3.1`/`v3.5.0` — the app does not override it),
so the refresh token is a live, renewable grant, not a spent artefact.

`sessionStorage` is the right choice among web-storage options and is materially better
than `localStorage` — it dies with the tab and, per CS-M1, it is what currently blocks
framing. It is not a defence against script execution on the origin. Nothing is.

### Who can reach it

Nobody, today, by injection. This is a defence-in-depth finding and I want to be exact
about that: **I found no XSS sink in this console at all.** See "What did not work" below —
zero `dangerouslySetInnerHTML`, zero `innerHTML`, zero `eval`, zero data-derived URLs. The
directory data the brief flags as attacker-influenced (display name, job title, attribute
values, CSV-imported fields, audit `before`/`after`) all render as JSX text children and
are escaped by React.

The exposure is what happens *if* that ever stops being true — a future `href={person.url}`,
a markdown renderer for a description field, or a compromised release of any of the 627
packages in the graph. With no CSP, the step from "one injected script" to "attacker holds a
super-admin refresh token" is a single `sessionStorage.getItem`, with no `connect-src` to
stop the exfiltration either. With a CSP, that step costs the attacker real work.

### Would the bundle survive a CSP?

Nearly. There is exactly one obstacle, `apps/web/index.html:28-41` — the pre-paint theme
script:

```html
    <script>
      (function () {
        try {
          var stored = window.localStorage.getItem('idm-theme')
          if (stored === 'light' || stored === 'dark') {
            document.documentElement.setAttribute('data-theme', stored)
          }
        } catch (e) {
```

It is deliberately inline and synchronous (its own comment explains why: it must run before
first paint, and it cannot import `shell/theme.ts` because no bundled JS exists yet). Under
`script-src 'self'` it would be blocked and the documented theme flash would return. The fix
is a `'sha256-…'` hash in the policy, not `'unsafe-inline'` — the script has no dynamic
content, so its hash is stable across builds until someone edits it.

Everything else looks compatible: the only other script is the module entry
(`index.html:45`), there are no inline event handlers (React uses synthetic events), and
there are no `<style>` blocks in the source.

**Suspected, not verified — I could not run `pnpm build`:**
- whether Vite emits any *additional* inline script into `dist/index.html` (the
  modulepreload polyfill is bundled into the entry chunk rather than inlined, but I did not
  confirm this for `vite@5.4.21`). The exact hash set for the policy therefore has to be
  read off a real build.
- the 50 `style={{…}}` props in `apps/web/src` are React style-object writes, which go
  through CSSOM and are outside CSP's `style-src` scope; a strict `style-src 'self'` should
  not break them. Believed correct, not browser-verified.

Deploy the policy in `Content-Security-Policy-Report-Only` first for exactly these reasons.

### Fix direction

Add the CSP shown in CS-M1's fix, via the same shared snippet, with the theme script's real
hash. `frame-ancestors 'none'` there also makes CS-M1's clickjacking gap defence-in-depth
rather than a single point of failure. `connect-src` must list the Keycloak origin —
oidc-client-ts fetches `.well-known/openid-configuration` and the token endpoint directly
from the browser.

---

## CS-M3 (MEDIUM) — no HSTS on the TLS vhost

`deploy/nginx/idm-tls.conf:19-24` redirects :80 → :443:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name @IDM_HOSTNAME@;
    return 301 https://$host$request_uri;
}
```

and `idm-tls.conf:73-77` adds three headers, none of which is
`Strict-Transport-Security`. **Confirmed** — the string does not occur in the repository.

**Who can reach it:** anyone with a network position between an administrator and the
console — hostile Wi-Fi, a compromised router, ARP/DNS spoofing on the internal network
this product is documented as deployed on.

**Mechanism and impact.** A 301 only protects requests that reach it. An administrator who
types the hostname, follows an `http://` bookmark, or clicks a plain link makes one
cleartext request first; an attacker in path answers it themselves and never redirects.
Without an HSTS entry the browser has no prior knowledge that this host is HTTPS-only. What
is then stripped is a session against an identity provider — the bearer token on every
`Authorization` header (`apps/web/src/api/client.ts:33`) and the OIDC flow itself.

This vhost's own header comment argues TLS is *not optional here* because `crypto.subtle`
is unavailable outside a secure context, so `signinRedirect()` cannot even work over plain
HTTP. That is an argument for HSTS, not a substitute: it means a stripped session fails in
confusing ways rather than safely, and it says nothing about the first request.

**Fix:** add to the shared snippet, on the :443 server only —

```nginx
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
```

Add `preload` and submit the domain only once the operator is certain every subdomain is
HTTPS. Worth adding to the `docs/12-security.md` hardening checklist beside "TLS on both
the console and Keycloak", which currently stops one step short.

---

## CS-L1 (LOW) — a failed sign-out fails silently, and the session survives

`apps/web/src/shell/AppShell.tsx:180-187`:

```ts
  async function handleSignOut() {
    setSigningOut(true)
    try {
      await auth.signoutRedirect()
    } catch {
      setSigningOut(false)
    }
  }
```

The `catch` binds nothing, reports nothing, and renders nothing. If `signoutRedirect()`
rejects — Keycloak unreachable, discovery fetch failing, an untrusted certificate, exactly
the conditions `App.tsx` enumerates for sign-**in** — the spinner stops, the button
re-enables, and the console stays exactly as it was. A user who clicks "Sign out", sees the
button return to normal, and walks away from a shared machine has every reason to believe
they signed out.

This is the *same defect* `App.tsx:81-102` documents at length and fixed on the sign-in
path — the comment there says a discarded sign-in failure was "the least diagnosable
failure a login screen can have, and it cost a full debugging session against real
hardware to find." That lesson was not carried across to sign-out.

Whether the local token survives depends on where the rejection happens:
`UserManager._signoutStart` calls `removeUser()` *before* navigating (confirmed from
`oidc-client-ts@3.5.0` source), so a failure in the navigator itself leaves the store
cleared but the React tree unaware, while a failure earlier — loading the user, building
the request — leaves the token in `sessionStorage` intact. Either way the UI misreports.

**Fix:** mirror `App.tsx`'s pattern — capture the error into state, render it in an
`role="alert"` block, and tell the user their session may still be open. Consider calling
`auth.removeUser()` in the failure path so the local session is destroyed even when the IdP
round-trip cannot complete.

---

## CS-L2 (LOW) — tokens are not revoked at sign-out

`revokeTokensOnSignout` defaults to `false` (confirmed from `UserManagerSettings.ts@v3.5.0`)
and is not overridden in `apps/web/src/auth/oidc-config.ts`.

`signoutRedirect()` does send `id_token_hint` to Keycloak's `end_session_endpoint`, which
ends the SSO session and, in Keycloak, invalidates refresh tokens bound to it. The **access
token is a stateless JWT** and `JwtGuard` verifies it by signature and `exp` against JWKS —
so a token captured before sign-out keeps working until it expires, regardless of the
logout. Standard OIDC behaviour, bounded by token lifetime, and it only matters if a token
already leaked.

**Fix:** set `revokeTokensOnSignout: true` so the refresh token is explicitly revoked at
Keycloak rather than relying on session teardown, and keep access-token lifetime short in
the realm config. Note this does not and cannot revoke an already-issued access token.

---

## CS-L3 (LOW) — people's names and emails go into the URL, and therefore into history and access logs

Global search, `apps/web/src/shell/AppShell.tsx:172-178`:

```ts
  function handleSearchSubmit(event: FormEvent) {
    event.preventDefault()
    const value = searchInputRef.current?.value.trim() ?? ''
    navigate(value.length > 0 ? `/people?q=${encodeURIComponent(value)}` : '/people')
```

and the People/Groups list filters via `setSearchParams` (`people/PeopleListPage.tsx:113`,
`groups/GroupsListPage.tsx:112`).

Search terms in this product are people's names, usernames and email addresses. Putting
them in the query string means:

- they enter **browser history**, and persist on the machine after sign-out;
- nginx writes the full request line, query string included, to `access.log` in plaintext
  by default. Neither vhost configures `log_format` or disables logging for `location /`.
  Anyone with read access to `/var/log/nginx/` — an ops role that does not require any
  grant in the directory — gets a running record of who is looking up whom. That is
  authorization-relevant metadata about an identity system, retained outside the audit log
  that `docs/12-security.md` goes to considerable lengths to make append-only and
  privilege-separated;
- the OIDC redirect lands the same way. `redirect_uri` is `${window.location.origin}/`
  (`oidc-config.ts:32`), so Keycloak returns to `/?code=…&state=…` and nginx logs the code
  and state. `AuthRoot`'s `onSigninCallback` strips them from history correctly with
  `navigate(…, { replace: true })` (`auth/AuthRoot.tsx:46`) — the browser side is handled —
  but the access-log entry is already written. The code is single-use and PKCE-bound, so
  this is disclosure, not a usable credential.

Keeping filters in the URL is a deliberate and good UX property (shareable, bookmarkable,
survives reload) and I am not suggesting removing it.

**Fix:** the cheap, targeted change is at the edge — exclude query strings from the console
vhost's access log, or define a `log_format` that omits `$query_string` for `location /`,
while keeping full logging for `/api/`. If search-term retention matters more than
shareable URLs for the *global* search box specifically, route it through state rather than
the query string. Worth a line in `docs/11-operations.md` about log retention either way.

---

## CS-L4 (LOW) — the hardcoded CORS origin: verified, and it costs less than documented

**Verified against current code.** `apps/api/src/main.ts:45`, unchanged:

```ts
  app.enableCors({ origin: ['http://localhost:5173'], credentials: true })
```

`docs/02-architecture.md:50`, `docs/05-installation.md:276`, `docs/14-roadmap.md:160` and
both nginx configs' header comments all describe this accurately. It is a real, current
condition, not stale documentation.

**What it actually costs in the documented topology: essentially nothing — but the reason
given in the docs is not the load-bearing one.** The docs argue it is fine because nginx
serves console and API from one origin, so CORS never applies. True, and sufficient for the
console. It leaves the harder question unanswered: a production API *also* answers
credentialed cross-origin preflights for `http://localhost:5173`, forever, in every
deployment. Why is that not a hole?

Because **this API has no ambient credential**. Authentication is a bearer token read from
`sessionStorage` and attached explicitly (`apps/web/src/api/client.ts:29-35`); there is no
session cookie, so `credentials: true` grants a cross-origin page nothing to send. A page
on `http://localhost:5173` gets a permissive CORS response and an unauthenticated **401**,
because it cannot read the token out of the console origin's `sessionStorage` and the
browser attaches nothing on its behalf. The allow-listed origin is also plain `http` on
`localhost`, so reaching it at all requires already running code on the administrator's
machine.

Two genuine residual costs, neither a vulnerability:

1. **A deployment footgun.** A split-origin deployment — console and API on different hosts,
   an entirely reasonable topology — fails in the browser with an opaque CORS error and no
   server-side signal. The nginx comments exist precisely to warn about this, which is a
   documentation patch over a configuration defect.
2. **A latent coupling, again.** The safety argument above rests entirely on "no cookie
   auth". If the API ever adds a cookie — a session cookie, a CSRF cookie, anything —
   `origin: ['http://localhost:5173'], credentials: true` in production stops being inert on
   that same day, and nothing in `main.ts` says so.

**Fix:** make it configuration, defaulting to same-origin. Something like

```ts
app.enableCors({ origin: env.corsOrigins, credentials: true })
```

with `CORS_ORIGINS` defaulting to `[]` (same-origin only) and the dev `.env` setting
`http://localhost:5173`. That removes the production allowance, unbreaks split-origin
deployments, and deletes the caveat from three docs and two nginx files.

---

## CS-L5 (LOW) — `GITHUB_TOKEN` is passed on a command line

`scripts/proxmox-create-lxc.sh:110-112`:

```bash
CLONE_URL="$REPO_URL"
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  CLONE_URL="https://${GITHUB_TOKEN}@${REPO_URL#https://}"
fi
```

used at line 127 inside `pct exec "$CTID" -- bash -lc "git clone … '$CLONE_URL' …"`.

The script **does** handle the durable half correctly — line 131 scrubs it:

```bash
# Never leave a token embedded in the checkout's remote.
pct exec "$CTID" -- bash -lc "cd '$INSTALL_DIR' && git remote set-url origin '$REPO_URL'"
```

What remains is the transient half. The token appears in the argument vector of both `pct`
and the container's `bash -lc`, so it is readable in `/proc/<pid>/cmdline` and in plain
`ps aux` output by **any local user on the Proxmox host** for the duration of the clone,
and it may land in root's shell history depending on how the operator invoked the script.

**Who can reach it:** a local unprivileged user on the virtualisation host. Bounded, but a
repo-scoped GitHub token is a supply-chain credential — write access to it is write access
to the code this identity provider is built from.

**Fix:** pass the token through git's credential helper on stdin, or write a short-lived
`~/.git-credentials` inside the container and delete it after the clone, rather than
interpolating it into a URL that becomes an argv element.

---

## CS-I1 (INFO) — build-time-inlined console config: verified, and confirmed harmless

**Verified against current code.** `apps/web/src/auth/oidc-config.ts:4-5,17,31`:

```ts
export const apiBaseUrl =
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000'
...
export const keycloakIssuer: string = import.meta.env.VITE_KEYCLOAK_ISSUER
...
  client_id: import.meta.env.VITE_KEYCLOAK_CLIENT_ID,
```

Vite inlines these at build time, so all three are literals in the shipped bundle, exactly
as `docs/05-installation.md:92` describes. Confirmed.

**Security cost: none.** All three are public by construction. The issuer is fetched by
every client from `.well-known`; `idm-console` is a *public* OIDC client id with PKCE and no
client secret, and its confidentiality is not part of any OIDC security property; the API
base URL is the address the browser must connect to anyway. `.env.example` and
`apps/web/.env.example` define exactly these three `VITE_` variables and nothing else, so
**no secret is compiled into the bundle** — I checked for a fourth. `git ls-files` confirms
only `.env.example` files are tracked; `.gitignore` covers `.env` and `.env.local`.

The real cost is operational and already documented: reconfiguring requires a rebuild
(`docs/05-installation.md`'s `reconfigure`), and the nginx comment about rebuilding with
`IDM_SCHEME=https` after certbot exists for this reason. Recorded here only so a future
reader does not re-flag it as a leak — it is not one.

---

## CS-I2 (INFO) — Compose images are tag-pinned, not digest-pinned

`docker-compose.yml:15,31`: `postgres:16-alpine` and `quay.io/keycloak/keycloak:26.0`. Both
are floating minor tags — the content behind them changes. There is no digest pin and no
verification step.

Low impact: this Compose stack is development and CI only. Production deploys through
`scripts/install.sh` (systemd + nginx + host Postgres) and **there are no Dockerfiles in
this repository at all** — confirmed. Noted for completeness; digest-pinning would make CI
reproducible but is not a production exposure.

---

# Part B — supply chain

## Version-range hygiene: clean

**Confirmed clean, all three checks:**

- **No wildcard, `latest`, `next` or `beta` ranges** anywhere. Every dependency in
  `package.json`, `apps/api/package.json` and `apps/web/package.json` uses a caret range
  against a concrete version.
- **No non-registry sources.** No `git+`, no GitHub URL, no tarball URL, no `file:`/`link:`
  dependency anywhere in `pnpm-lock.yaml`. Every one of the 627 packages resolves to the
  public npm registry with an `integrity` hash. The only two URLs in the entire lockfile are
  inside `deprecated:` message strings (lines 248, 252).
- **`lockfileVersion: '9.0'`**, with `pnpm install --frozen-lockfile` enforced in both CI
  (`.github/workflows/ci.yml:82`) and the production installer
  (`scripts/install.sh:187`) — so the lockfile is authoritative in both paths and cannot be
  silently rewritten mid-install.

`settings.autoInstallPeers: true` is set. It is convenient and it is also a small
supply-chain surface — an unsatisfied peer range is resolved and installed automatically
rather than failing loudly. Worth knowing; not a finding.

## CS-H1 (HIGH) — install-time script execution on the identity-provider host, with an unverifiable package manager

### What

Two problems that compound, both in `scripts/install.sh`.

**First**, `install.sh:101-102`:

```bash
corepack enable >/dev/null 2>&1 || npm install -g corepack >/dev/null
corepack prepare pnpm@9 --activate >/dev/null
```

`pnpm@9` is a **range**, resolved at install time to whatever the newest 9.x is on that day.
Different hosts installed a week apart get different package managers. Corepack *can*
verify a package manager against an integrity hash — that is the entire point of the
`packageManager` field's `+sha512.…` suffix — but `package.json:4` carries no hash:

```json
  "packageManager": "pnpm@9.12.0",
```

and `corepack prepare pnpm@9` does not consult that field anyway. So the tool that resolves,
downloads and executes all 627 dependencies is itself fetched over the network with **no
integrity verification**, into a root shell.

**Second**, `install.sh:187`:

```bash
su -s /bin/bash "$IDM_USER" -c "cd '$REPO_ROOT' && pnpm install --frozen-lockfile" >/dev/null
```

`--frozen-lockfile` guarantees *which versions* are installed. It does nothing about *what
those versions execute*. **pnpm 9 runs dependency lifecycle scripts (`preinstall`,
`install`, `postinstall`) by default** — the block-by-default behaviour with an explicit
`onlyBuiltDependencies` allow-list arrived in pnpm **10**. There is **no `.npmrc` anywhere
in this repository** (confirmed) and no `--ignore-scripts`, so nothing overrides that
default.

### Who can reach it, and the impact

Whoever controls any of 627 packages, or any npm account that publishes one, at any point
between now and the next install or upgrade. A single malicious `postinstall` runs
arbitrary code as `idm` — the service account — on the machine that holds
`RUNTIME_DATABASE_URL`, `KEYCLOAK_ADMIN_CLIENT_SECRET`, every `CONNECTOR_*` secret, and the
`.env` file `docs/12-security.md` requires to be mode 0640 owned by exactly that user.

That is the full compromise the rest of the security model is built to prevent, reached
without touching the API. `docs/12-security.md`'s own argument for why `bootstrap:admin` is
not a backdoor — *"anyone able to run it already holds `RUNTIME_DATABASE_URL`, or a shell on
the box that has it"* — describes precisely what a `postinstall` script obtains. This is the
single highest-leverage supply-chain exposure in the system, and it is reachable on a
schedule (every install, every upgrade) rather than requiring an attacker to find anything.

The same exposure exists in CI (`ci.yml:82`), where it compounds with CS-M5.

### Fix direction

Three changes, all small and none of which requires touching a dependency version:

1. **Pin the package manager with its hash.** `"packageManager": "pnpm@9.12.0+sha512.…"`
   in `package.json`, and change `install.sh:102` to
   `corepack prepare pnpm@9.12.0 --activate` so the installer and the repo agree on one
   exact version that corepack can verify.
2. **Block lifecycle scripts by default.** Commit an `.npmrc` at the repo root. On pnpm 9
   the direct lever is `enable-pre-post-scripts=false` plus running installs with
   `--ignore-scripts`; the durable fix is upgrading to pnpm 10 and declaring
   `onlyBuiltDependencies` with the short explicit list this tree actually needs
   (`@swc/core`, `esbuild`, and — in CI only — Playwright's browser download). Determining
   that list requires an install, which this pass could not run.
3. Once (2) is in place, re-run a clean install in a container and diff the result, because
   a package that genuinely needs a build step will fail loudly rather than silently.

**Recommended, not applied** — as instructed, no dependency or lockfile was modified.

---

## CS-M4 (MEDIUM) — `curl … | bash` as root during production install

`scripts/install.sh:97-100`:

```bash
if ! command -v node >/dev/null || [[ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]]; then
  info "installing Node 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
```

`install.sh` runs as root. This fetches a remote shell script and executes it as root with
no pinning, no checksum, and no signature check. It is NodeSource's documented installation
method and the transport is HTTPS with `-f` (fail on HTTP error), so this is not unusual —
but "industry-normal" and "verified" are different things. A NodeSource compromise, a
registry-side content swap, or a CA-level MITM yields root on the identity-provider host at
install time. Output is sent to `/dev/null`, so an operator watching the install sees
nothing of what ran.

The *package* installed afterwards is verified — the setup script adds a GPG-signed apt repo
and `apt-get` checks signatures. It is the bootstrap script itself that is unverified, and
it is the part that runs as root first.

**Fix:** replace the pipe with the explicit, auditable form — add NodeSource's GPG key to
`/etc/apt/keyrings/` and write the `deb [signed-by=…]` source list directly, which is
NodeSource's own documented alternative and removes remote code execution from the path
entirely. Failing that, download to a file, verify a pinned checksum, then execute.

---

## CS-M5 (MEDIUM) — CI: mutable action tags, no token permissions, credentials on disk beside arbitrary scripts

`.github/workflows/ci.yml`. Three related gaps:

**Actions are pinned to mutable tags**, lines 65, 70, 73, 91:

```yaml
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
      - uses: actions/cache@v4
```

A git tag is a movable pointer. `@v4` resolves to whatever that tag currently points at, so
compromising an action's repository — or its maintainer's account — silently changes what
runs in this workflow. The mitigation is SHA pinning: `uses: actions/checkout@<40-char-sha>
# v4.2.2`.

**No `permissions:` block** exists at workflow or job level (confirmed — the keyword does
not appear in the file). `GITHUB_TOKEN` therefore receives the repository's default scope,
which for repositories created before the default changed, or in organisations that set it
so, is **read/write across contents, packages, actions, issues and pull-requests**. A CI job
whose only job is to typecheck, build and test needs `contents: read` and nothing else.

**These compound with CS-H1.** `actions/checkout` defaults to `persist-credentials: true`,
leaving the token in `.git/config` for the rest of the job — and `pnpm install
--frozen-lockfile` (line 82) then runs dependency lifecycle scripts in that same working
directory. A malicious `postinstall` reads the token off disk and, with default write
permissions, pushes to the repository.

**Reachability: latent, not live.** The file's own header states this repository has no git
remote yet and that "a workflow file alone protects nothing until something pushes to a
remote that actually runs it." Nothing is exposed today. This should be fixed *before* the
first push to a remote, because after that it is live on the first CI run.

**Fix:**

```yaml
permissions:
  contents: read

jobs:
  verify:
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@<sha>   # v4.2.2
        with:
          persist-credentials: false
```

plus SHA pins on the other three actions, and Dependabot or Renovate configured to bump the
pins so they do not rot. Note `on: pull_request` (not `pull_request_target`) is already
correct — fork PRs run without access to secrets. That was the right choice and is worth
keeping.

Separately: `ci.yml:97,101` run `playwright install-deps chromium` (apt as root) and
`playwright install chromium` (browser binary download from a CDN). Both are remote fetches
at CI time. Standard for Playwright and CI-only; noted, not a finding.

---

## CS-M6 (MEDIUM) — Vite/esbuild dev-server advisories, unfixed on the 5.x line, reachable on developer machines

The only advisories in the entire set that are reachable by anyone in this project's actual
workflow. `apps/web/package.json` pins `vite: ^5.4.9`, resolved to **`vite@5.4.21`**
(`pnpm-lock.yaml:2925`), which pulls **`esbuild@0.21.5`** (`pnpm-lock.yaml:2043`).

| Advisory | Severity | Affects | Patched in |
|---|---|---|---|
| CVE-2026-53571 — `server.fs.deny` bypass on Windows alternate paths | HIGH | `vite <=6.4.2` | `>=6.4.3` |
| CVE-2026-39365 — path traversal in optimized-deps `.map` handling | MODERATE | `vite <=6.4.1` | `>=6.4.2` |
| CVE-2026-53632 — `launch-editor` NTLMv2 hash disclosure via UNC paths on Windows | MODERATE | `vite <=6.4.2` | `>=6.4.3` |
| GHSA-67mh-4wv8-2f99 — any website can send requests to the dev server and read the response | MODERATE | `esbuild <=0.24.2` | `>=0.25.0` |

**Not reachable in production.** No Vite process runs in the deployed system. `install.sh`
builds the bundle (`pnpm build`, line 189) and nginx serves the resulting static files from
`apps/web/dist` (`idm.conf:36`). All four are dev-server issues.

**Reachable on developer workstations**, and the platform matters. Two of these are
Windows-specific, and this project's development platform is Windows (this audit ran on
Windows 11; `scripts/setup.mjs:151` and `scripts/dev.mjs:37` shell out to `netstat`/
`findstr`, and `scripts/dev.mjs:60` to `taskkill`). The combination is what makes it real:
the esbuild advisory means **any web page** the developer visits can issue requests to
`localhost:5173` and read the responses, and the Vite `fs.deny` bypass means those requests
can escape the project root. Together, browsing to a malicious page while `pnpm dev` is
running is a file-read primitive against the developer's machine — including
`apps/web/.env`, the repo root `.env` with `KEYCLOAK_ADMIN_CLIENT_SECRET` and every
`CONNECTOR_*` secret, and SSH keys.

`apps/web/vite.config.ts:6` is `server: { port: 5173, strictPort: true }` — no `host`
override, so the dev server binds localhost only and is not exposed to the LAN. That
correctly limits this to the developer's own browser as the attack vector. It does not
close it.

**Upgrade target: `vite@7` (or `>=6.4.3` at minimum).** Note that **no fix exists on the 5.x
line** — every patched version is 6.4.3+. This is therefore a major-version upgrade that
also moves `@vitejs/plugin-react` (currently `^4.3.2`) and raises the minimum Node version.
It is the largest of the recommended upgrades and the one most likely to need real work.

Interim mitigation costing nothing: do not browse the web in the same browser profile while
`pnpm dev` is running, and prefer `pnpm build && pnpm preview` when a browser session is
needed alongside general browsing.

**Recommended, not applied.**

---

## Reachability analysis — the other 28 advisories

`pnpm audit --json` against the committed lockfile reports **32 advisories: 1 critical, 9
high, 19 moderate, 3 low**, across 627 packages. Every one was traced to a call site or the
absence of one. **None is reachable in the deployed production system.**

**A caveat on the tool's own output:** pnpm 9 labels *every* path `"dev": false`, including
`apps__api>vitest` and `apps__api>testcontainers>undici`, which are unambiguously
devDependencies in `apps/api/package.json`. Its `metadata` block likewise claims
`"devDependencies": 0`. This is a workspace-importer labelling artifact and it is wrong.
Every dev-vs-production classification below is taken from the `package.json` manifests, not
from that flag. Anyone re-running `pnpm audit` here should not trust it either.

### Production dependencies — present, not reachable

| Package | Version | Advisory | Why it is not reachable | Upgrade target |
|---|---|---|---|---|
| `drizzle-orm` | 0.36.4 | **HIGH** CVE-2026-39356 — SQL injection via improperly escaped SQL identifiers | The advisory requires untrusted input reaching `sql.identifier()` or `.as()`. **There is not one `sql.identifier(` call, one `sql.raw(` call, or one dynamic `.as(` alias anywhere in `apps/api/src`** — every identifier comes from the compiled Drizzle schema, and every user value is a bound parameter. Verified by grep across the whole API tree. | `>=0.45.2` |
| `@nestjs/core` | 10.4.22 | **MODERATE** CVE-2026-35515 — CRLF injection into the SSE text protocol via `SseStream._transform` | Requires a Server-Sent Events endpoint. **No `@Sse()` decorator, no `SseStream`, no `text/event-stream` response exists in `apps/api/src`.** The HTTP surface is 28 conventional JSON routes. | `>=11.1.18` — **no fix on the 10.x line**; this is a NestJS major upgrade |
| `multer` | via `@nestjs/platform-express` | **4× HIGH + 1 MODERATE** (CVE-2026-3304, -2359, -3520, -5079, -5038) — DoS via malformed/aborted/deeply-nested multipart | Multer is a transitive dependency of `@nestjs/platform-express` but **is never mounted**: no `FileInterceptor`, no `MulterModule`, no `@UploadedFile`, no multipart route. The CSV import — the one file-upload-shaped feature — reads the file **in the browser** (`imports/ImportPage.tsx:119`, `await selected.text()`) and posts it as a JSON string field validated by `importBodySchema`. No multipart body ever reaches the server. | `>=2.2.0`, via `@nestjs/platform-express` |
| `file-type` | via `@nestjs/common` | **2× MODERATE** CVE-2026-31808 (infinite loop, ASF parser), CVE-2026-32630 (ZIP decompression bomb) | Reached only through Nest's file-validation pipes. **No `StreamableFile`, `ParseFilePipe`, `FileTypeValidator` or `MaxFileSizeValidator` anywhere in `apps/api/src`.** Nothing calls it. | `>=21.3.2`, via `@nestjs/common` |
| `body-parser` | 1.20.4 | **LOW** CVE-2026-12590 — an *invalid* `limit` makes `bytes.parse()` return `null` and silently disables size enforcement | Not reachable, and specifically **because of this codebase's own discipline**. `main.ts:41-42` passes `limit: env.bodyLimitBytes`, and `config/env.ts:63` is `BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024)` — always a positive integer, never a string, so `bytes.parse()` is never consulted and the null path cannot be entered. The advisory describes exactly the failure mode `docs/12-security.md` set `BODY_LIMIT_BYTES` up to prevent, and the Zod schema is what closes it. | `>=1.20.6`, via `@nestjs/platform-express` |
| `qs` | via `body-parser` | **MODERATE** CVE-2026-8723 — `qs.stringify` crashes on null entries in comma-format arrays with `encodeValuesOnly` | The vulnerable function is `stringify`. Express calls **`qs.parse`** for query strings and never `stringify`; nothing in `apps/api/src` imports `qs`. | `>=6.15.2`, transitive |
| `uuid` | via `ldapts` | **MODERATE** CVE-2026-41907 — missing buffer bounds check in `v3()`/`v5()`/`v6()` when `buf` is supplied | Requires calling v3/v5/v6 with a caller-provided output buffer. The API never imports `uuid` directly; `ldapts` uses it for message identifiers and does not pass `buf`. `v4()`/`v1()`/`v7()` are unaffected by design. | `>=11.1.1`, via `ldapts` |

### Development and build dependencies — no production process runs them

| Package | Version | Advisory | Why it is not reachable |
|---|---|---|---|
| `vitest` | 2.x | **CRITICAL** CVE-2026-47429 — arbitrary file read and execution when the Vitest **UI** server is listening | The UI server only runs with `--ui`. `apps/api/package.json` runs `vitest run`; no script, config or CI step passes `--ui`. The only critical in the set, and it requires a flag this project never uses. Upgrade target `>=3.2.6`. |
| `esbuild` | 0.18.20, 0.19.12 (via `drizzle-kit`) | **MODERATE** GHSA-67mh-4wv8-2f99 | `drizzle-kit` is a devDependency run manually for migration generation; it starts no long-lived server. (The `vite`-side copy is CS-M6.) |
| `undici` | 5.29.0 via `testcontainers` | **3× HIGH, 7× MODERATE, 2× LOW** (WebSocket memory exhaustion, request smuggling, CRLF injection, response desync, cookie handling) | `testcontainers` is a devDependency of `apps/api`, used only by the Testcontainers-backed test suite. It never ships and never runs in production. Every advisory concerns an HTTP/WebSocket **client** talking to an attacker-controlled server; testcontainers talks to the local Docker socket. Note these are all patched in the 6.x line — `undici@5.29.0` has no fix available, so this resolves by upgrading `testcontainers`, not `undici`. |
| `uuid` | via `testcontainers>dockerode` | MODERATE CVE-2026-41907 | Same mechanism as above; dev-only. |

### Recommended upgrades — none applied

Ordered by value. Nothing in this list was applied and no lockfile or manifest was modified.

1. **`vite` → 7.x** (with `@vitejs/plugin-react`). The only reachable advisories in the set
   (CS-M6). Largest effort; also the only one protecting anything today.
2. **`drizzle-orm` 0.36.4 → `>=0.45.2`.** Unreachable now, but it is a HIGH SQL-injection
   advisory in a *production* dependency, and its reachability depends on a coding
   convention ("never build a dynamic identifier") that nothing mechanically enforces. One
   future dynamic `ORDER BY` column or table alias makes it live silently. Consider adding
   `sql.identifier`/`sql.raw` to the static source scan the test suite already runs for JML
   rules.
3. **`vitest` → `>=3.2.6`.** Clears the only CRITICAL from the report so the next reader is
   not desensitised by it.
4. **`testcontainers` → latest**, to move `undici` onto the 6.x line and clear 12 advisories
   that are noise but crowd out signal.
5. **`@nestjs/*` 10.x → 11.1.18+.** Lowest urgency (SSE-only, and there is no SSE route),
   highest disruption. Schedule it; do not rush it.
6. **`@nestjs/platform-express` bump** to pull `multer >=2.2.0`, `body-parser >=1.20.6` and
   `qs >=6.15.2` — all unreachable, all free once the Nest version moves.

---

## What did not work — the console held

Documented so a later auditor does not re-cover it, and so the negative results are on the
record with their method.

### XSS — no sink exists

Grepped the entire `apps/web` tree (`src`, `index.html`, `scripts`) for
`dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `eval(`, `new Function`,
`document.write`, `insertAdjacentHTML`, `createContextualFragment`: **zero hits, all
patterns.** There is no HTML-injection sink in this console.

Every attacker-influenced value the brief names — display name, job title, attribute values,
CSV-imported fields, group and org-unit names — reaches the DOM as a JSX text child and is
escaped by React. The most exposed renderer is `audit/AuditDiff.tsx`, which displays
`before`/`after` snapshots of directory rows including imported data; it routes every value
through `formatDiffValue` (`audit/api.ts:124-129`), which returns `'—'`, `'Yes'`/`'No'`,
`String(value)`, or `JSON.stringify(value)` — a string, never markup — and renders it as
`{formatDiffValue(entry.before)}` inside `<td>`. `humanizeFieldKey` (`audit/api.ts:117-121`)
only re-cases the key.

### User-controlled URLs — there are none

Grepped for `href=`, `src=`, `window.open`, `location.href`, `location.assign`,
`location.replace` across `apps/web/src`. **Exactly one hit:**
`self-service/SelfServicePage.tsx:254`, `href={accountConsoleUrl()}`. That value comes from
`auth/account-console.ts:16-21`, derived from the build-time `VITE_KEYCLOAK_ISSUER` with a
trailing-slash trim and `/account` appended — build-time configuration, not data. No
`javascript:` URL is constructible because no directory value reaches any URL sink at all.
Navigation is entirely react-router `Link to=` with literal paths and `navigate()` with
template literals over UUIDs.

### Data leaking into console or error surfaces

`grep -rn "console\.(log|error|warn|info|debug|trace)" apps/web/src`: **zero hits.** The only
`console.*` calls in `apps/web` are in `e2e/support/` and `scripts/check-css-tokens.mjs`,
neither of which ships. No analytics, no error-reporting SDK, no Sentry — nothing exfiltrates
an error containing directory data to a third party. Error rendering goes through `ApiError`
(`api/client.ts:12-22`), which carries `status`, `code`, `issues` and `message` from the
API's own response, so what a user sees is bounded by what the API chose to return — the
surface the secrets audit already covered.

### The UI-authorization claim held everywhere I could check it

`docs/12-security.md`'s claim 6 — *"the console hides what you cannot do; it never decides
it"* — survived. I found **no client-side-only gate**.

- `shell/permissions.ts:52-80` reads `GET /self/permissions` and holds the result in a
  `Set<Action>`. It never computes a permission and never infers one from a role name. It
  **fails closed**: a fetch or parse error resolves to `{status: 'error'}`, and
  `AppShell.tsx:67` filters nav items with `perms.status !== 'error' && hasAction(...)`, so a
  broken permissions fetch shows *nothing* gated rather than everything.
- Nav items are **hidden, not disabled** (`AppShell.tsx:92-108`), which is the correct
  posture — a disabled control leaks the existence of the capability. Typing the URL
  directly still renders the route, and each page gates its own content and still calls the
  API, which decides.
- The most likely place for a client-side allow-list to hide is self-service, given the
  narrow `location`-only editable set. It is **server-driven**: the form iterates
  `profile.editable.coreFields` and `profile.editable.attributes`
  (`self-service/SelfServicePage.tsx:22,166,291`), a shape the API returns
  (`self-service/api.ts:41-44`), with the comment at line 31 stating it is "read generically
  by key rather than a hard-coded `profile.location`". The console renders what the server
  says is editable; it does not hold its own copy of the rule.
- Connector configuration — the highest-privilege screen — never handles a secret **value**.
  `connectors/config-fields.ts:4-15` types credential fields as `secret-name` and renders
  them as plain text inputs *by explicit design*, with the reasoning recorded in the source:
  a password-style input "visually promises 'a secret lives here' — this console never makes
  that promise". `ConfigurationTab.tsx:120-121` states the same to the user.

**Scope caveat, stated plainly:** I verified this from the console side — what it sends, what
it gates on, and where that gate's data comes from. I did not re-probe the API to confirm it
independently enforces each action, because server-side authorization is another dimension's
scope and was audited in `audit-authz.md`. "The API decides" rests on that report, not on
this one.

### Token handling — where it actually is

- **Access, ID and refresh tokens:** `sessionStorage`, key `oidc.user:<issuer>:idm-console`,
  via the explicit `userStore` at `oidc-config.ts:36`. This also matches oidc-client-ts's
  own default. Per-tab, cleared when the tab closes.
- **Never in a URL.** The token is attached as an `Authorization: Bearer` header
  (`api/client.ts:29-35`) on every call, and the header is spread *after* `init.headers`, so
  a caller cannot accidentally override it. No `access_token` query parameter anywhere.
- **Never logged** (zero `console.*`), never sent to a third party.
- **On logout:** `UserManager._signoutStart` calls `removeUser()` before navigating to the
  `end_session_endpoint` (confirmed in `oidc-client-ts@3.5.0` source), so the store is
  cleared. See CS-L1 for the failure path and CS-L2 for revocation.
- **PKCE `code_verifier` in `localStorage`** — already reported as **L1 in
  `audit-secrets.md`** and **confirmed still unfixed** at this tip: `oidc-config.ts` sets
  `userStore` but still no `stateStore`, and oidc-client-ts defaults `stateStore` to
  `window.localStorage` (confirmed from `OidcClientSettings.ts@v3.5.0`:
  `const store = typeof window !== "undefined" ? window.localStorage : new InMemoryWebStorage();`).
  Not re-raised as a new finding. **One correction to that report, in the harsher
  direction:** it states stale entries "are cleared only by `clearStaleState`, default 900 s,
  and only on a later sign-in/out." In fact **`clearStaleState()` is never called at all** in
  this system — not by the app (zero hits in `apps/web/src`) and not by the library, since
  `react-oidc-context@3.3.1`'s `AuthProvider` exposes `clearStaleState` on its context but
  never invokes it (confirmed from upstream source). Abandoned sign-in states therefore
  accumulate in `localStorage` **indefinitely**, across browser restarts, with no sweeper.
  The fix in `audit-secrets.md` L1 — set `stateStore` to `sessionStorage` — resolves this
  too.

---

## Out of dimension, noticed anyway

- `drizzle-orm@0.36.4` carries a HIGH SQL-injection advisory (CVE-2026-39356) in a
  production dependency. Currently unreachable — no dynamic identifiers exist — but it is an
  injection-class exposure that a source-level injection audit structurally could not see.
- `@nestjs/core` is on 10.4.22 and the fix for CVE-2026-35515 lands only in `>=11.1.18`, so
  the 10.x line is permanently unpatched for it. Operational planning item, not a
  vulnerability here (no SSE route exists).
- `.github/workflows/ci.yml` has no `permissions:` block — borders on the secrets dimension;
  covered above as CS-M5 because it compounds with install-time script execution.
- `docs/12-security.md`'s hardening checklist has no entry for security headers, CSP, or
  HSTS. Three of this report's findings would have been caught by a checklist line and a
  `curl -I`.

---

## Environment hygiene

- **Worktree:** `D:/identity-manager-audit-client` only, branch `audit/client-supply-chain`
  @ `da74d6d`. No sibling worktree was read, written, or entered. No `git checkout`,
  `switch`, `reset`, `commit -a`, `add -A`, `worktree remove`, or `push` was run.
- **No dependency or lockfile was modified.** `pnpm-lock.yaml` and all three `package.json`
  files are byte-identical to the tip. No `pnpm install` was run; `node_modules` does not
  exist in this worktree and was never created. Every upgrade above is a recommendation.
- **`pnpm audit` was read-only** — it queries the registry advisory API from the committed
  lockfile and writes nothing. Its JSON output went to the session scratchpad, outside the
  repository.
- **No Docker.** No container was started, stopped, or inspected. No test suite, no
  `pnpm test`, no `pnpm vitest`, no `pnpm build`, no dev server. The Docker-holding session
  was not disturbed.
- **Network use** was three read-only fetches of tagged upstream source on
  `raw.githubusercontent.com` (`oidc-client-ts` v3.5.0 `OidcClientSettings.ts` and
  `UserManagerSettings.ts`, `react-oidc-context` v3.3.1 `AuthProvider.tsx`) plus the
  `pnpm audit` registry query — undertaken specifically so the storage and logout-lifecycle
  defaults in this report are quoted from the shipped library rather than recalled.
- **The only file added is this report.** No probe file, no temporary spec, no scratch file
  inside the repository.
