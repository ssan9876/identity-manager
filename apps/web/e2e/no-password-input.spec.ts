import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

// apps/web is an ESM package ("type": "module") — `__dirname` does not
// exist here, unlike apps/api (CommonJS). Derived from `import.meta.url`
// instead, the standard ESM equivalent.
const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = join(__dirname, '..', 'src')

function collectFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? collectFiles(full) : [full]
  })
}

/**
 * Milestone 6, Task 4 — credential management (password, MFA) is a deep
 * link to Keycloak's Account Console, never a reimplementation
 * (task-4-brief.md). That is a binding project constraint, not a
 * convention someone has to remember while reviewing a diff — this test
 * enforces it mechanically by scanning every TypeScript/TSX source file
 * under apps/web/src for a password-typed input, in any of the ways one
 * could be written: a raw HTML attribute (`type="password"`) or a JSX
 * expression prop (`type={"password"}` / `type={'password'}`).
 *
 * Runs as a plain Node-side check (no `page` fixture, no browser needed) —
 * it is still a Playwright test so it runs from the exact same
 * `pnpm --filter @idm/web test:e2e` command as every other e2e assertion
 * in this project, with no second test runner to configure.
 */
test('no password input exists anywhere in apps/web/src', () => {
  const files = collectFiles(SRC_DIR).filter((path) => /\.(ts|tsx)$/.test(path))
  expect(files.length).toBeGreaterThan(0)

  const passwordInputPattern = /type\s*=\s*(["']password["']|\{\s*["']password["']\s*\})/i
  const offenders = files.filter((path) => passwordInputPattern.test(readFileSync(path, 'utf8')))

  expect(offenders).toEqual([])
})
