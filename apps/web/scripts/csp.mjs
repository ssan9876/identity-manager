/**
 * Content-Security-Policy generation — finding CS-M2.
 *
 * The console's `index.html` carries an INLINE pre-paint theme script (see the
 * comment above it in index.html: it must run before any bundled JS exists, so
 * it cannot be moved into a module). A CSP that omits its sha256 blocks it; a
 * CSP whose sha256 is stale blocks it just the same, and the only symptom is a
 * line in the browser console. So the hash is never written by hand and never
 * committed: it is derived from the BUILT `dist/index.html` on every build, by
 * the vite plugin in vite.config.ts, and written next to it as `dist/csp.conf`,
 * which both nginx vhosts `include`.
 *
 * Why derive it from the built file rather than from source: the two are not
 * the same bytes. This repo is developed on Windows and deployed on Linux, and
 * git's line-ending translation means the identical source file yields CRLF
 * inside the script on one and LF on the other — different bytes, different
 * sha256. A hash captured on a developer's machine and committed would be
 * wrong on the server. Deriving it from the artifact the server will actually
 * serve is the only version of this that cannot be wrong.
 */

import { createHash } from 'node:crypto'

/**
 * Every inline `<script>` in an HTML document, in source order, as raw text.
 *
 * Hand-written rather than regex-only because a regex for `<script>` also
 * matches one written inside an HTML comment, and index.html is heavily
 * commented. This scans the document, stepping OVER comments, so only real
 * elements are considered. Scripts carrying `src=` are external and are
 * covered by `script-src 'self'`, not by a hash, so they are skipped.
 */
export function extractInlineScripts(html) {
  const bodies = []
  let i = 0
  while (i < html.length) {
    const comment = html.indexOf('<!--', i)
    const open = findTagStart(html, i)
    if (open === -1) break
    if (comment !== -1 && comment < open) {
      const end = html.indexOf('-->', comment + 4)
      i = end === -1 ? html.length : end + 3
      continue
    }
    const tagEnd = html.indexOf('>', open)
    if (tagEnd === -1) break
    const attrs = html.slice(open + '<script'.length, tagEnd)
    const close = html.toLowerCase().indexOf('</script', tagEnd + 1)
    if (close === -1) break
    if (!/\bsrc\s*=/i.test(attrs)) bodies.push(html.slice(tagEnd + 1, close))
    const closeEnd = html.indexOf('>', close)
    i = closeEnd === -1 ? html.length : closeEnd + 1
  }
  return bodies
}

function findTagStart(html, from) {
  const lower = html.toLowerCase()
  let at = from
  for (;;) {
    at = lower.indexOf('<script', at)
    if (at === -1) return -1
    // `<scriptfoo` is not a script tag; the name must be followed by
    // whitespace, `>` or `/`.
    if (/[\s/>]/.test(lower[at + '<script'.length] ?? '')) return at
    at += '<script'.length
  }
}

/**
 * The text a browser hashes for an inline script — which is NOT the bytes on
 * the wire.
 *
 * The HTML parser normalizes newlines while preprocessing the input stream:
 * every CRLF and every lone CR becomes a single LF, before any element's text
 * content exists. CSP hashes the script's source text, i.e. the post-parse
 * text, so a hash taken over CRLF bytes matches nothing.
 *
 * This is not theoretical and it is not cosmetic. This repo is developed on
 * Windows, where git checks index.html out with CRLF; hashing the raw file
 * produced sha256-yH5Rqspb… while Chromium demanded sha256-0pH0FSFd… and
 * blocked the script — a blank-shell console, caught only because the policy
 * was loaded in a real browser. On the Linux deploy host the file is already
 * LF, so the mistake would have been INVISIBLE there and live on every
 * Windows-built artifact. Normalizing makes both platforms agree with the
 * browser, and with each other.
 */
export function scriptSourceText(body) {
  return body.replace(/\r\n?/g, '\n')
}

/** CSP hash-source for one script body, e.g. `'sha256-Abc…='`. */
export function hashSource(body) {
  const text = scriptSourceText(body)
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`
}

/** The origin of a URL, or null when it is absent or unparseable. */
export function originOf(url) {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * The policy, as a single-line header value.
 *
 * `hashes` are the hash-sources of the inline scripts actually present in the
 * built index.html. `issuer`/`apiBaseUrl` are the build-time VITE_* values;
 * only their ORIGINS enter the policy, and only when they are cross-origin
 * (a same-origin API is already covered by `'self'`).
 */
export function buildPolicy({ hashes, issuer, apiBaseUrl }) {
  const issuerOrigin = originOf(issuer)
  const apiOrigin = originOf(apiBaseUrl)
  const remote = [...new Set([issuerOrigin, apiOrigin].filter(Boolean))]
  const connect = ["'self'", ...remote]
  // The OIDC silent-renew iframe targets the issuer's authorize endpoint.
  const frame = ["'self'", ...(issuerOrigin ? [issuerOrigin] : [])]

  return [
    // Everything not named below falls back to same-origin only.
    `default-src 'self'`,
    // The bundle, plus the pre-paint theme script by hash. No 'unsafe-inline',
    // no 'unsafe-eval' — and note that a hash source in script-src makes
    // browsers ignore any 'unsafe-inline' that a future edit adds here.
    `script-src 'self' ${hashes.join(' ')}`.trimEnd(),
    // One linked stylesheet from /assets. React's `style={{…}}` props are set
    // through the CSSOM, which CSP does not police, so they survive this.
    //
    // MEASURED 2026-08-13, in Chromium, Firefox AND WebKit, against the real
    // policy as nginx serves it — this used to be reasoned about and true only
    // in a local Chromium run. All three engines agree:
    //   el.style.width = '123px'          -> APPLIED, no violation  (React's path)
    //   el.setAttribute('style', '…')     -> BLOCKED, style-src-attr
    //   document.head.append(<style>)     -> BLOCKED, style-src-elem
    // So the directive costs React nothing and still refuses both paths an
    // injection would actually use.
    `style-src 'self'`,
    // No images ship today; `data:` is here because inlined icons are the one
    // thing an SPA routinely adds, and a data: image cannot execute.
    `img-src 'self' data:`,
    `font-src 'self'`,
    // Same-origin /api, plus Keycloak: discovery, token, JWKS and revocation
    // are all cross-origin XHR to the issuer.
    `connect-src ${connect.join(' ')}`,
    // Keycloak's authorize endpoint would be framed by oidc-client-ts's silent
    // renew; nothing else is ever framed.
    //
    // KEPT, THOUGH MEASURED TO BE UNUSED. oidc-client-ts 3.5.0's
    // `signinSilent()` takes the REFRESH TOKEN branch whenever the stored user
    // has one and only falls back to an iframe otherwise, and `monitorSession`
    // defaults to false. A real signed-in session against the lab host, in all
    // three engines on 2026-08-13, held a refresh token and had ZERO iframes on
    // the page. The iframe fallback could not work here anyway: it needs
    // `silent_redirect_uri`, which this console does not set.
    // Left in place rather than tightened to 'none' because framing the ISSUER
    // is not a threat to this origin — `frame-ancestors 'none'` and
    // X-Frame-Options are what stop this console being framed — and removing it
    // would only trade a measured non-risk for a sign-in flow nobody can
    // re-test on every future oidc-client-ts upgrade.
    `frame-src ${frame.join(' ')}`,
    // Matches the X-Frame-Options: DENY already served alongside this.
    `frame-ancestors 'none'`,
    // No <object>/<embed>/<applet> anywhere in the console.
    `object-src 'none'`,
    // An injected <base> would otherwise repoint every relative asset URL.
    `base-uri 'self'`,
    // The console posts no forms cross-origin; OIDC leaves by redirect.
    `form-action 'self'`,
  ].join('; ')
}

/**
 * The nginx snippet included by both vhosts. Regenerated on every build, and
 * emitted into `dist/` so that it lives and dies with the `index.html` it
 * describes: a build that produces no index.html produces no csp.conf either,
 * and `nginx -t` then fails loudly instead of serving a stale hash.
 */
export function renderCspConf({ html, issuer, apiBaseUrl, generator }) {
  const hashes = extractInlineScripts(html).map(hashSource)
  const policy = buildPolicy({ hashes, issuer, apiBaseUrl })
  const issuerOrigin = originOf(issuer)
  return [
    '# GENERATED — do not edit, and do not commit.',
    `# Written by ${generator} from the built dist/index.html.`,
    '#',
    '# The sha256 below is the pre-paint theme script in that exact file. Edit',
    '# index.html and rebuild and this file changes with it; edit this file by',
    '# hand and the next build overwrites it. Included by deploy/nginx/idm.conf',
    '# and deploy/nginx/idm-tls.conf at every level that declares an add_header',
    '# of its own (ngx_http_headers_module does not inherit across such levels).',
    '#',
    `# Inline scripts hashed: ${hashes.length}`,
    `# Issuer origin: ${issuerOrigin ?? '(VITE_KEYCLOAK_ISSUER unset at build time)'}`,
    '',
    `add_header Content-Security-Policy "${policy}" always;`,
    '',
  ].join('\n')
}
