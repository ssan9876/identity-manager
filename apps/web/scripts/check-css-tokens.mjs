#!/usr/bin/env node
// Fails if any CSS file under apps/web/src, OTHER than styles/tokens.css,
// contains a raw colour literal — a hex code, a CSS colour function
// (rgb/rgba/hsl/hsla/hwb/lab/lch/oklab/oklch/color()), or a standalone named
// CSS colour keyword — instead of a var(--token) reference.
//
// Milestone 9, Task 2's own "prove it": "a test that asserts no CSS file
// under apps/web/src contains a raw colour literal outside tokens.css."
//
// Deliberately a plain Node script, no test framework: apps/web had none
// wired up before this (package.json's own "test" script was a placeholder
// — "no unit tests yet"), and this check needs nothing a framework would
// add, just a filesystem walk and a few regexes. Wired into BOTH apps/web's
// own `test` script (so `pnpm --filter @idm/web test` runs it directly) and
// the root `pnpm verify` gate (scripts/verify.mjs) — so this is actually
// part of the gate the milestone plan's Task 1 established, not a script
// nobody runs.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(__dirname, '..')
const srcRoot = path.join(webRoot, 'src')
const allowedFile = path.join(srcRoot, 'styles', 'tokens.css')

// CSS Color Module Level 4's named colours — anything that encodes an
// actual fixed colour value. `transparent` and `currentcolor` are
// deliberately EXCLUDED: both are contextual keywords with no fixed colour
// of their own, and this codebase uses both legitimately (.btn--ghost's
// transparent background, .badge__dot's currentColor) — flagging them would
// be a false positive, not a caught defect.
const NAMED_COLORS = [
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black',
  'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse',
  'chocolate', 'coral', 'cornflowerblue', 'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan',
  'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey', 'darkkhaki', 'darkmagenta',
  'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen',
  'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink',
  'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen',
  'fuchsia', 'gainsboro', 'ghostwhite', 'gold', 'goldenrod', 'gray', 'green', 'greenyellow', 'grey',
  'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender', 'lavenderblush',
  'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan', 'lightgoldenrodyellow',
  'lightgray', 'lightgreen', 'lightgrey', 'lightpink', 'lightsalmon', 'lightseagreen',
  'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue', 'lightyellow', 'lime',
  'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine', 'mediumblue', 'mediumorchid',
  'mediumpurple', 'mediumseagreen', 'mediumslateblue', 'mediumspringgreen', 'mediumturquoise',
  'mediumvioletred', 'midnightblue', 'mintcream', 'mistyrose', 'moccasin', 'navajowhite', 'navy',
  'oldlace', 'olive', 'olivedrab', 'orange', 'orangered', 'orchid', 'palegoldenrod', 'palegreen',
  'paleturquoise', 'palevioletred', 'papayawhip', 'peachpuff', 'peru', 'pink', 'plum',
  'powderblue', 'purple', 'rebeccapurple', 'red', 'rosybrown', 'royalblue', 'saddlebrown',
  'salmon', 'sandybrown', 'seagreen', 'seashell', 'sienna', 'silver', 'skyblue', 'slateblue',
  'slategray', 'slategrey', 'snow', 'springgreen', 'steelblue', 'tan', 'teal', 'thistle', 'tomato',
  'turquoise', 'violet', 'wheat', 'white', 'whitesmoke', 'yellow', 'yellowgreen',
]

// CSS identifiers use hyphens as word-internal separators (e.g. the
// PROPERTY "white-space" is one ident, not the colour "white" followed by
// "space") — plain \b treats '-' as a boundary and would misread it as the
// literal colour white. These lookaround assertions treat '-' the same as
// a word character for boundary purposes, so a colour name only matches
// when it stands genuinely alone (not stitched to neighbouring text by a
// hyphen on either side).
const namedColorPattern = new RegExp(`(?<![\\w-])(${NAMED_COLORS.join('|')})(?![\\w-])`, 'gi')
const hexPattern = /#[0-9a-fA-F]{3,8}\b/g
// var(...) is exactly what screens SHOULD use, and calc()/minmax()/repeat()/
// cubic-bezier()/translateX()/linear-gradient()/etc. are all fine — only the
// actual colour-producing functions are forbidden here.
const funcPattern = /\b(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(/gi

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

function findCssFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...findCssFiles(full))
    } else if (entry.isFile() && entry.name.endsWith('.css')) {
      out.push(full)
    }
  }
  return out
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length
}

function checkFile(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const text = stripComments(raw)
  const violations = []

  for (const pattern of [hexPattern, funcPattern, namedColorPattern]) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(text)) !== null) {
      violations.push({ line: lineOf(text, match.index), text: match[0] })
    }
  }
  return violations
}

function main() {
  if (!fs.existsSync(allowedFile)) {
    console.error(`[check-css-tokens] FAILED: expected ${allowedFile} to exist.`)
    process.exitCode = 1
    return
  }

  const files = findCssFiles(srcRoot).filter((f) => f !== allowedFile)
  let failureCount = 0

  for (const file of files) {
    const violations = checkFile(file)
    if (violations.length > 0) {
      failureCount += violations.length
      const rel = path.relative(webRoot, file).split(path.sep).join('/')
      for (const v of violations) {
        console.error(
          `apps/web/${rel}:${v.line}: raw colour literal "${v.text}" — route it through a semantic token in styles/tokens.css instead.`,
        )
      }
    }
  }

  if (failureCount > 0) {
    console.error(`\n[check-css-tokens] FAILED: ${failureCount} raw colour literal(s) outside styles/tokens.css.`)
    process.exitCode = 1
    return
  }

  console.log(`[check-css-tokens] OK — ${files.length} CSS file(s) checked outside styles/tokens.css, no raw colour literals.`)
}

main()
