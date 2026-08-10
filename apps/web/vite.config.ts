import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

// @ts-expect-error — plain ESM helper, shared with scripts/check-csp.mjs so the
// generator and its independent checker cannot drift apart. No .d.ts by design:
// it is build tooling, not app code, and tsconfig only compiles src/ and e2e/.
import { extractInlineScripts, renderCspConf } from './scripts/csp.mjs'

/**
 * Emits `dist/csp.conf` — the Content-Security-Policy header that both nginx
 * vhosts include. Finding CS-M2; the reasoning lives in scripts/csp.mjs.
 *
 * Runs in `closeBundle`, i.e. after `dist/index.html` has been written, and
 * reads that file back off disk. It deliberately does NOT hash the source
 * index.html or the in-memory HTML: the bytes the browser receives are the
 * only bytes whose hash is correct, and they differ from source (line endings,
 * and vite's own rewriting of the module script tag).
 */
function cspPlugin(env: Record<string, string>): Plugin {
  let outDir = 'dist'
  return {
    name: 'idm-csp',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir
    },
    closeBundle() {
      const root = resolve(process.cwd(), outDir)
      const htmlPath = resolve(root, 'index.html')
      const html = readFileSync(htmlPath, 'utf8')

      const conf = renderCspConf({
        html,
        issuer: env.VITE_KEYCLOAK_ISSUER,
        apiBaseUrl: env.VITE_API_BASE_URL,
        generator: 'apps/web/vite.config.ts (idm-csp)',
      })
      writeFileSync(resolve(root, 'csp.conf'), conf, 'utf8')

      // Re-derive from the file just written, by a different route than the
      // generator took, and refuse to leave a mismatch on disk. A CSP whose
      // hash does not match the served script is indistinguishable from a
      // blank page, so this is the last place it can still be caught cheaply.
      const scripts: string[] = extractInlineScripts(html)
      for (const body of scripts) {
        // `\r\n` -> `\n` because that is what the HTML parser hands the CSP
        // check; see scriptSourceText() in scripts/csp.mjs for the Windows
        // CRLF trap this exists to close.
        const text = body.replace(/\r\n?/g, '\n')
        const hash = createHash('sha256').update(text, 'utf8').digest('base64')
        if (!conf.includes(`'sha256-${hash}'`)) {
          throw new Error(
            `[idm-csp] generated csp.conf does not carry sha256-${hash} for an ` +
              `inline script in ${htmlPath} — refusing to emit a policy that ` +
              `would block it`,
          )
        }
      }
      if (!env.VITE_KEYCLOAK_ISSUER) {
        this.warn(
          'VITE_KEYCLOAK_ISSUER is unset — the emitted CSP has no issuer ' +
            'origin in connect-src/frame-src and sign-in will be blocked by ' +
            'the browser. Set it in apps/web/.env and rebuild.',
        )
      }
      this.info?.(
        `[idm-csp] dist/csp.conf written (${scripts.length} inline script(s) hashed)`,
      )
    },
  }
}

export default defineConfig(({ mode }) => {
  // envDir defaults to the vite root (apps/web), which is where install.sh and
  // CI write .env. Same values the bundle itself is compiled against, so the
  // policy and the code can never disagree about which Keycloak this is.
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  return {
    plugins: [react(), cspPlugin(env)],
    server: { port: 5173, strictPort: true },
  }
})
