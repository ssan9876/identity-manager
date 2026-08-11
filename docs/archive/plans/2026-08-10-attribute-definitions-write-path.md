# Attribute Definitions Write Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `attribute_definitions` a real, audited, hardened write path — create, safe edits, deactivation, and a previewed-and-guarded `dataType` migration — so custom attributes stop being created with hand-written `INSERT`s.

**Architecture:** Two edit paths split by whether user data moves. Safe fields go through a synchronous audited `PATCH`. `dataType`/`appliesTo` changes go through `AttributeMigrationJob`, driven by both HTTP (preview → commit) and a CLI, blast-radius guarded on percentage **and** floor. Two refusals live in the repository so no caller can reach around them.

**Tech Stack:** NestJS controllers with `@RequirePermission`, Zod for request validation, Drizzle for schema and queries, `AuditWriter.record(tx, …)` inside the same transaction as the write, vitest with Testcontainers.

## Global Constraints

- **Security is the explicit priority for this plan.** Where a choice exists between a smaller change and a safer one, take the safer one and say why in the commit body.
- **Work in a worktree off `master`.** Never edit `D:\identity-manager` — other sessions share it.
- **Never run the full API suite** (`pnpm --filter @idm/api test`, bare `pnpm vitest run`, plain `pnpm verify`). It starts a Testcontainers Postgres per spec file and exhausts the disk. Run only the spec files you touch, always capped:
  `pnpm vitest run <file> --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3`
  **Both bounds are required** — `maxForks` alone aborts with `RangeError: options.minThreads and options.maxThreads must not conflict`, which vitest reports as `Test Files no tests`, reading like a filter problem when it is not.
- **Specs live in TWO directories:** `apps/api/src/**/*.spec.ts` and `apps/api/test/*.spec.ts`. Search both before adding one.
- **Test-first, always.** Every test must be observed failing before its implementation exists. A test that has never failed has proven nothing.
- **Audit writes go inside the transaction**, via `this.auditWriter.record(tx, { actorUserId, action, resourceType, resourceId, before, after })`.
- **Migrations from `0027` onward must be re-runnable** — `migrate.spec.ts` replays them. Enum and column DDL needs `IF NOT EXISTS`.
- **No raw colour literals** outside `apps/web/src/styles/tokens.css` — `check-css-tokens.mjs` fails the build.
- **The docs guard must stay at 0**: `node scripts/check-docs.mjs`. Adding a route means documenting it in `docs/10-api-reference.md` in the canonical `` `METHOD /path` `` form, or the guard fails.
- Commit convention: conventional-commit subject, body explaining WHY, ending `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## Security hardening this plan adds beyond the spec

Four vectors found while planning. Each has a task.

1. **`key` has no format constraint.** It is `varchar(64)` with no `CHECK`, and it becomes both a jsonb map key and the tail of a business-role condition (`attributes.<key>`). This codebase has been bitten by prototype-chain semantics four times, and its `__proto__` defences (`Object.create(null)`, `Object.hasOwn`) are **all read-side**, because there has never been a write path. This is the first opportunity to refuse a dangerous key at the source instead of relying on every future reader remembering the defence.
2. **`validationRules` is an open jsonb blob.** The ReDoS came from exactly there. The write path must accept a closed schema and reject unknown keys rather than storing them.
3. **`sensitive` can blind its own audit row.** Turning it on reduces what the audit log can see; the change must be recorded so that the record itself is not redacted by the change it describes.
4. **`enum` options are unbounded.** `options: string[]` with no length or count limit is a storage and rendering hazard.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/attributes/attribute-key.ts` | **Create.** The closed `key` vocabulary and its refusal reasons. Pure, no I/O. |
| `apps/api/src/attributes/attribute-definitions.controller.ts` | **Modify.** Add POST/PATCH/preview/commit; re-gate the existing GET. |
| `apps/api/src/attributes/attribute-definitions.repository.ts` | **Modify.** Create/update/deactivate plus the two refusals. |
| `apps/api/src/attributes/attribute-migration.job.ts` | **Create.** Preview and commit of a `dataType`/`appliesTo` change. |
| `apps/api/src/attributes/attribute-conversion.ts` | **Create.** Pure per-pair conversion rules. No database. |
| `apps/api/src/attributes/attribute-migrate-cli.ts` | **Create.** CLI driving the same job. |
| `apps/api/src/authz/actions.ts` | **Modify.** `attribute:read`, `attribute:manage`. |
| `apps/api/src/db/schema/attribute-definitions.ts` | **Modify.** `CHECK` constraint on `key`. |
| `apps/api/src/db/migrations/0043_attribute_key_check.sql` | **Create.** |
| `apps/web/src/attributes/AttributeDefinitionsPage.tsx` | **Create.** List + form + preview. |
| `docs/08-authorization.md`, `docs/10-api-reference.md`, `docs/07-admin-guide.md` | **Modify.** |

---

### Task 1: The closed `key` vocabulary

**Files:**
- Create: `apps/api/src/attributes/attribute-key.ts`
- Test: `apps/api/src/attributes/attribute-key.spec.ts`

**Interfaces:**
- Produces: `validateAttributeKey(key: unknown): string[]` — returns an array of human-readable problems, empty when the key is acceptable. Never throws.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/attributes/attribute-key.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { validateAttributeKey } from './attribute-key'

describe('validateAttributeKey', () => {
  it('accepts a plain identifier', () => {
    expect(validateAttributeKey('costCentre')).toEqual([])
    expect(validateAttributeKey('cost_centre')).toEqual([])
    expect(validateAttributeKey('a1')).toEqual([])
  })

  // The whole reason this module exists. These are legal jsonb keys and legal
  // varchar(64) values, so nothing downstream would have refused them.
  it.each(['__proto__', 'constructor', 'prototype'])('refuses %s', (key) => {
    const problems = validateAttributeKey(key)
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.join(' ')).toContain('reserved')
  })

  it('refuses a leading digit, so a key can never look like an index', () => {
    expect(validateAttributeKey('1st')).not.toEqual([])
  })

  it('refuses characters outside the closed class', () => {
    for (const key of ['has space', 'has.dot', 'has-dash', 'caf\u00e9', 'a$b', '']) {
      expect(validateAttributeKey(key), key).not.toEqual([])
    }
  })

  it('refuses anything longer than the column', () => {
    expect(validateAttributeKey('a'.repeat(65))).not.toEqual([])
    expect(validateAttributeKey('a'.repeat(64))).toEqual([])
  })

  it('refuses a non-string without throwing', () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      expect(() => validateAttributeKey(bad)).not.toThrow()
      expect(validateAttributeKey(bad)).not.toEqual([])
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run apps/api/src/attributes/attribute-key.spec.ts --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3`
Expected: FAIL — cannot resolve `./attribute-key`.

- [ ] **Step 3: Implement**

Create `apps/api/src/attributes/attribute-key.ts`:

```ts
/**
 * The closed vocabulary for `attribute_definitions.key`.
 *
 * WHY THIS EXISTS. `key` is `varchar(64)` with no CHECK, and it becomes two
 * things at once: a key in the `users.attributes` jsonb map, and the tail of a
 * business-role condition (`attributes.<key>` — see role-evaluator.ts). Until
 * this module there was no write path, so every defence against a hostile key
 * lived on the READ side: attribute-validator.ts builds its shape with
 * `Object.create(null)` and role-evaluator.ts reads through `Object.hasOwn`,
 * both specifically because a definition keyed `__proto__` would otherwise hit
 * Object.prototype's accessor instead of an own property.
 *
 * Those defences are correct and stay. But this project's own comments record
 * being bitten by prototype-chain semantics four times, and a write path is the
 * first chance to refuse the key at the source rather than requiring every
 * future reader to remember. Defence in depth, with the shallow end closed.
 *
 * The class is deliberately narrower than "what jsonb allows": ASCII letters,
 * digits and underscore, not starting with a digit. Dots are excluded even
 * though `extractField` parses them unambiguously (it slices after the first
 * `attributes.`), because a dotted key reads as a path and invites a future
 * reader to treat it as one.
 */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_LENGTH = 64

/**
 * Names that are legal jsonb keys and legal identifiers but that reach
 * Object.prototype. Compared case-sensitively: these are the exact property
 * names, and a `__PROTO__` key is inert.
 */
const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])

/** Problems with `key`, empty when acceptable. Never throws — callers aggregate. */
export function validateAttributeKey(key: unknown): string[] {
  if (typeof key !== 'string') {
    return ['key: must be a string']
  }
  const problems: string[] = []
  if (key.length === 0) {
    problems.push('key: must not be empty')
  }
  if (key.length > MAX_LENGTH) {
    problems.push(`key: must be at most ${MAX_LENGTH} characters`)
  }
  if (key.length > 0 && !KEY_PATTERN.test(key)) {
    problems.push(
      'key: must start with a letter or underscore and contain only letters, digits and underscores',
    )
  }
  if (RESERVED.has(key)) {
    problems.push(
      `key: "${key}" is reserved — it names a property on Object.prototype, and a definition ` +
        'keyed this way reaches an inherited accessor instead of an own property',
    )
  }
  return problems
}

/** The same rule as a SQL fragment, for the CHECK constraint. Kept beside the regex so the two cannot drift. */
export const ATTRIBUTE_KEY_SQL_PATTERN = '^[A-Za-z_][A-Za-z0-9_]*$'
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run apps/api/src/attributes/attribute-key.spec.ts --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/attributes/attribute-key.ts apps/api/src/attributes/attribute-key.spec.ts
git commit -m "feat(attributes): close the key vocabulary before a write path opens it

\`key\` is varchar(64) with no CHECK, and it becomes both a jsonb map key and
the tail of a business-role condition. Every existing defence against a hostile
key is read-side — Object.create(null) in the validator, Object.hasOwn in the
evaluator — because there has never been a write path to defend. Those stay;
this refuses the key at the source instead of relying on every future reader
remembering why they are there.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: A database CHECK behind the application rule

**Files:**
- Modify: `apps/api/src/db/schema/attribute-definitions.ts`
- Create: `apps/api/src/db/migrations/0043_attribute_key_check.sql`
- Test: `apps/api/test/attribute-key-constraint.spec.ts`

**Interfaces:**
- Consumes: `ATTRIBUTE_KEY_SQL_PATTERN` from Task 1.
- Produces: constraint `attribute_definitions_key_format`.

Application validation can be bypassed by a hand-written `INSERT` — which is precisely how every existing definition was created. The constraint is what makes the rule true of the data rather than of one code path.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/attribute-key-constraint.spec.ts`. Follow the container setup used by the sibling specs in `apps/api/test/` — read one first (`attribute-target-mappings` or similar) and copy its harness rather than inventing one.

```ts
import { describe, expect, it } from 'vitest'
// … container/db harness exactly as the sibling spec in apps/api/test/ does it

describe('attribute_definitions_key_format', () => {
  it('rejects a reserved key at the database level, not just in the API', async () => {
    await expect(
      db.execute(sql`
        INSERT INTO attribute_definitions (key, label, data_type, applies_to)
        VALUES ('__proto__', 'Proto', 'string', 'user')
      `),
    ).rejects.toThrow(/attribute_definitions_key_format/)
  })

  it('rejects a key with a space', async () => {
    await expect(
      db.execute(sql`
        INSERT INTO attribute_definitions (key, label, data_type, applies_to)
        VALUES ('has space', 'Spaced', 'string', 'user')
      `),
    ).rejects.toThrow(/attribute_definitions_key_format/)
  })

  it('accepts a plain identifier', async () => {
    await expect(
      db.execute(sql`
        INSERT INTO attribute_definitions (key, label, data_type, applies_to)
        VALUES ('cost_centre', 'Cost centre', 'string', 'user')
      `),
    ).resolves.toBeDefined()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run it with the capped-fork command. Expected: the two rejection cases FAIL, because no constraint exists yet and the inserts succeed.

- [ ] **Step 3: Add the constraint to the schema**

In `apps/api/src/db/schema/attribute-definitions.ts`, inside the table's second argument (beside the existing indexes), add:

```ts
    // Behind the application rule in attributes/attribute-key.ts, not instead
    // of it. Every attribute_definitions row on a deployed host today was
    // created by a hand-written INSERT — that is the problem this feature
    // exists to remove — so a rule enforced only in a controller would be a
    // rule the existing data has never been held to.
    keyFormat: check(
      'attribute_definitions_key_format',
      sql`${table.key} ~ '^[A-Za-z_][A-Za-z0-9_]*$' AND ${table.key} NOT IN ('__proto__', 'constructor', 'prototype')`,
    ),
```

Add `check` to the existing `drizzle-orm/pg-core` import if it is not already there.

- [ ] **Step 3a: Handle rows that already violate the rule**

Every row in this table was created by a hand-written `INSERT` with no
constraint, so a deployed host may hold a key the new `CHECK` rejects — and
`ALTER TABLE ... ADD CONSTRAINT` then fails with an error that names the
constraint but **not the offending row**, which is a miserable thing to hit
mid-upgrade.

Checked on the live host (ct:211) at plan time: 4 definitions, keys
`mail_admin_role`, `mail_aliases`, `mail_enabled`, `mail_quota_mb` — all valid.
So this is a hazard for other deployments, not this one.

Put the diagnostic query in `docs/11-operations.md`'s upgrade section so an
operator can run it *before* upgrading:

```sql
SELECT id, key FROM attribute_definitions
WHERE key !~ '^[A-Za-z_][A-Za-z0-9_]*$'
   OR key IN ('__proto__', 'constructor', 'prototype');
```

Do **not** make the migration auto-rename or auto-delete a violating row. A key
is referenced by every `users.attributes` blob that carries it; silently
renaming one orphans data, and deleting one destroys a definition an admin
created deliberately. Failing the upgrade with a query the operator can run is
the correct behaviour — the fix is theirs to choose.

- [ ] **Step 4: Write the migration**

Create `apps/api/src/db/migrations/0043_attribute_key_check.sql`:

```sql
-- Re-runnable: migrate.spec.ts replays every migration from 0027 onward.
ALTER TABLE "attribute_definitions"
  DROP CONSTRAINT IF EXISTS "attribute_definitions_key_format";

ALTER TABLE "attribute_definitions"
  ADD CONSTRAINT "attribute_definitions_key_format"
  CHECK (
    "key" ~ '^[A-Za-z_][A-Za-z0-9_]*$'
    AND "key" NOT IN ('__proto__', 'constructor', 'prototype')
  );
```

Then regenerate the drizzle journal/snapshot the way this repo does it (`pnpm --filter @idm/api db:generate`) and confirm it reports no unexpected drift. If generate produces a *different* migration number, keep generate's and delete yours — the journal's `when` values must stay strictly increasing or drizzle silently skips a migration.

- [ ] **Step 5: Run the test to verify it passes**

Run the capped-fork command on `apps/api/test/attribute-key-constraint.spec.ts`. Expected: all three pass.

- [ ] **Step 6: Verify the migration is re-runnable**

Run: `pnpm vitest run apps/api/test/migrate.spec.ts --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3`
Expected: PASS. If it fails on a replay, the `DROP CONSTRAINT IF EXISTS` is missing or misspelled.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/schema/attribute-definitions.ts apps/api/src/db/migrations apps/api/test/attribute-key-constraint.spec.ts
git commit -m "feat(db): constrain attribute_definitions.key at the database

Behind the application rule, not instead of it. Every row in this table on a
deployed host was created by a hand-written INSERT — the problem this feature
removes — so a rule enforced only in a controller is one the existing data has
never been held to.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The two new actions

**Files:**
- Modify: `apps/api/src/authz/actions.ts`
- Modify: `apps/api/test/guard-coverage.spec.ts`
- Test: `apps/api/test/authz-actions.spec.ts` (or the existing spec that asserts the catalogue — find it first)

**Interfaces:**
- Produces: `'attribute:read'`, `'attribute:manage'` in `ALL_ACTIONS`; `ALL_ACTIONS.length === 26`.

- [ ] **Step 1: Find what asserts the action count**

```bash
grep -rn "ALL_ACTIONS" apps/api/src apps/api/test --include=*.ts | grep -v "actions.ts"
```

Whatever asserts a count of 24 must be updated in this task, not later. Read it before changing anything.

- [ ] **Step 2: Write the failing test**

Add to the spec that owns the catalogue:

```ts
it('carries the attribute actions, and super_admin alone may manage', () => {
  expect(ALL_ACTIONS).toContain('attribute:read')
  expect(ALL_ACTIONS).toContain('attribute:manage')

  // Reading a definition is ordinary directory work.
  for (const role of ['super_admin', 'user_admin', 'auditor', 'read_only'] as const) {
    expect(ROLE_PERMISSIONS[role]).toContain('attribute:read')
  }
  // Managing one is schema work, and carries `sensitive` and `selfEditable`.
  expect(ROLE_PERMISSIONS.super_admin).toContain('attribute:manage')
  for (const role of ['user_admin', 'help_desk', 'auditor', 'read_only'] as const) {
    expect(ROLE_PERMISSIONS[role]).not.toContain('attribute:manage')
  }
})
```

- [ ] **Step 3: Run it to verify it fails**

Capped-fork command on that spec. Expected: FAIL — the actions do not exist.

- [ ] **Step 4: Add the actions**

In `apps/api/src/authz/actions.ts`, add `'attribute:read'` and `'attribute:manage'` to `ALL_ACTIONS`, and add `attribute:read` to `user_admin`, `auditor`, `read_only` (and `super_admin` gets both via `[...ALL_ACTIONS]`).

Add a comment recording the narrowing:

```ts
  // `attribute:read` replaces `user:read` on GET /attribute-definitions. That
  // is a deliberate NARROWING: help_desk holds user:read and therefore can
  // list definitions today, and will not after this. Help desk reads people,
  // not schema. Recorded here because a permission that quietly stops working
  // is worse than one that visibly never did.
```

- [ ] **Step 5: Run to verify it passes**

Capped-fork command. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/authz/actions.ts apps/api/test
git commit -m "feat(authz): add attribute:read and attribute:manage

attribute:manage is super_admin-only: a definition is schema rather than data,
and \`sensitive\` and \`selfEditable\` ride on it — one blinds the audit log for
a field, the other can open a self-service route to entitlements.

Records the narrowing: GET /attribute-definitions moves from user:read to
attribute:read, so help_desk loses access to it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Conversion rules, pure and total

**Files:**
- Create: `apps/api/src/attributes/attribute-conversion.ts`
- Test: `apps/api/src/attributes/attribute-conversion.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  type ConversionResult =
    | { ok: true; value: string | number | boolean }
    | { ok: false; reason: string }
  function convertValue(
    value: unknown,
    from: AttributeDataType,
    to: AttributeDataType,
    options?: readonly string[],
  ): ConversionResult
  ```
  where `AttributeDataType` is `'string' | 'number' | 'boolean' | 'date' | 'enum'`.
- Consumes: nothing. No database, no I/O — this is the piece that must be exhaustively testable.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/attributes/attribute-conversion.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { convertValue } from './attribute-conversion'

describe('convertValue', () => {
  it('round-trips string to number only when exact', () => {
    expect(convertValue('42', 'string', 'number')).toEqual({ ok: true, value: 42 })
    expect(convertValue('42.5', 'string', 'number')).toEqual({ ok: true, value: 42.5 })
    // Refused: these all coerce in JavaScript and would silently rewrite data.
    for (const bad of ['', ' ', '42abc', 'NaN', 'Infinity', '0x10', '1e999']) {
      expect(convertValue(bad, 'string', 'number').ok, bad).toBe(false)
    }
  })

  it('accepts only literal boolean spellings', () => {
    expect(convertValue('true', 'string', 'boolean')).toEqual({ ok: true, value: true })
    expect(convertValue('false', 'string', 'boolean')).toEqual({ ok: true, value: false })
    // Refused: truthiness is not a conversion rule.
    for (const bad of ['1', '0', 'yes', 'no', 'TRUE', '']) {
      expect(convertValue(bad, 'string', 'boolean').ok, bad).toBe(false)
    }
  })

  it('accepts only ISO-8601 for date', () => {
    expect(convertValue('2026-08-10', 'string', 'date').ok).toBe(true)
    for (const bad of ['10/08/2026', 'August 10 2026', '2026-13-01', '']) {
      expect(convertValue(bad, 'string', 'date').ok, bad).toBe(false)
    }
  })

  it('accepts an enum value only when it is in the allowed list', () => {
    expect(convertValue('red', 'string', 'enum', ['red', 'blue'])).toEqual({ ok: true, value: 'red' })
    expect(convertValue('green', 'string', 'enum', ['red', 'blue']).ok).toBe(false)
    // No options supplied is a refusal, never an accept-anything.
    expect(convertValue('red', 'string', 'enum').ok).toBe(false)
  })

  it('never throws, whatever it is handed', () => {
    for (const bad of [null, undefined, {}, [], Symbol('x'), 1n]) {
      expect(() => convertValue(bad, 'string', 'number')).not.toThrow()
      expect(convertValue(bad, 'string', 'number').ok).toBe(false)
    }
  })

  it('gives a reason on every refusal, for the preview to show', () => {
    const r = convertValue('42abc', 'string', 'number')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Capped-fork command. Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/api/src/attributes/attribute-conversion.ts`. The rules are deliberately strict: every refusal is a value an operator must look at, and every silent coercion is a value quietly rewritten.

```ts
export type AttributeDataType = 'string' | 'number' | 'boolean' | 'date' | 'enum'

export type ConversionResult =
  | { ok: true; value: string | number | boolean }
  | { ok: false; reason: string }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/

/**
 * Convert one stored value for a dataType change.
 *
 * STRICT ON PURPOSE. Every rule here refuses something JavaScript would happily
 * coerce — `Number('')` is 0, `Boolean('no')` is true, `new Date('10/08/2026')`
 * is a different day depending on locale. A migration that coerces is a
 * migration that rewrites data nobody looked at; a migration that refuses
 * produces a list an operator can read. The list is the product.
 */
export function convertValue(
  value: unknown,
  from: AttributeDataType,
  to: AttributeDataType,
  options?: readonly string[],
): ConversionResult {
  if (from === to) {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? { ok: true, value }
      : { ok: false, reason: `value is ${describe(value)}, which is not a storable scalar` }
  }

  const text = asText(value)
  if (text === null) {
    return { ok: false, reason: `value is ${describe(value)}, which cannot be read as text` }
  }

  switch (to) {
    case 'number': {
      // Deliberately not Number(): it accepts '', '0x10', 'Infinity'.
      if (!/^-?\d+(\.\d+)?$/.test(text)) {
        return { ok: false, reason: `"${text}" is not a plain decimal number` }
      }
      const n = Number(text)
      if (!Number.isFinite(n)) {
        return { ok: false, reason: `"${text}" is not finite` }
      }
      return { ok: true, value: n }
    }
    case 'boolean': {
      if (text === 'true') return { ok: true, value: true }
      if (text === 'false') return { ok: true, value: false }
      return { ok: false, reason: `"${text}" is not literally "true" or "false"` }
    }
    case 'date': {
      if (!ISO_DATE.test(text) || Number.isNaN(Date.parse(text))) {
        return { ok: false, reason: `"${text}" is not an ISO-8601 date` }
      }
      return { ok: true, value: text }
    }
    case 'enum': {
      if (!options || options.length === 0) {
        return { ok: false, reason: 'the target definition declares no allowed values' }
      }
      if (!options.includes(text)) {
        return { ok: false, reason: `"${text}" is not one of: ${options.join(', ')}` }
      }
      return { ok: true, value: text }
    }
    case 'string':
      return { ok: true, value: text }
  }
}

function asText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value === 'boolean') return String(value)
  return null
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return typeof value
}
```

- [ ] **Step 4: Run to verify it passes**

Capped-fork command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/attributes/attribute-conversion.ts apps/api/src/attributes/attribute-conversion.spec.ts
git commit -m "feat(attributes): strict, total conversion rules for a dataType change

Every rule refuses something JavaScript would coerce — Number('') is 0,
Boolean('no') is true, new Date('10/08/2026') is locale-dependent. A migration
that coerces rewrites data nobody looked at; one that refuses produces a list an
operator can read. The list is the product.

Pure and I/O-free so the rules can be exhausted in tests rather than exercised
through a database.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The two refusals, in the repository

**Files:**
- Modify: `apps/api/src/attributes/attribute-definitions.repository.ts`
- Test: `apps/api/test/attribute-definitions.repository.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  create(tx, input: CreateAttributeDefinitionInput): Promise<AttributeDefinition>
  updateSafeFields(tx, id: string, patch: SafeFieldPatch): Promise<AttributeDefinition>
  ```
  Both throw `DomainError` subclasses on refusal.
- Consumes: `validateAttributeKey` (Task 1).

These are the highest-value tests in the plan. Write them first and make them mean something.

- [ ] **Step 1: Write the failing tests**

```ts
describe('AttributeDefinitionsRepository refusals', () => {
  it('refuses selfEditable on an attribute a business-role formula references, naming the roles', async () => {
    // Seed a definition and a published business role whose condition is
    // `attributes.<key>` — read role-evaluator.ts's condition shape and the
    // business-roles fixtures before writing this; do not invent the shape.
    await expect(
      repo.updateSafeFields(db, definitionId, { selfEditable: true }),
    ).rejects.toThrow(/business role/i)

    const err = await repo.updateSafeFields(db, definitionId, { selfEditable: true }).catch((e) => e)
    // The operator must learn WHICH roles, or they cannot act on the refusal.
    expect(String(err.message)).toContain(roleName)
  })

  it('allows selfEditable when no formula references the attribute', async () => {
    await expect(
      repo.updateSafeFields(db, unreferencedId, { selfEditable: true }),
    ).resolves.toMatchObject({ selfEditable: true })
  })

  it('refuses a reserved key on create', async () => {
    await expect(
      repo.create(db, { key: '__proto__', label: 'x', dataType: 'string', appliesTo: 'user' }),
    ).rejects.toThrow(/reserved/)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Capped-fork command. Expected: FAIL — methods do not exist.

- [ ] **Step 3: Implement**

Add to the repository. The `selfEditable` check must query business-role conditions for `attributes.<key>` — read `role-evaluator.ts`'s `ATTRIBUTE_PREFIX` and the conditions table shape first, and reuse the constant rather than re-spelling `'attributes.'`.

Include this comment on the refusal:

```ts
  // REFUSED, not warned. role-evaluator.ts supports an open-ended
  // `attributes.<key>` condition, so a custom attribute can decide who holds a
  // business role — and therefore who holds its entitlements. Marking such an
  // attribute self-editable would let a user grant themselves access by
  // editing their own profile. That escalation route does not exist today and
  // this write path must not create it. Same posture as the SoD gate on
  // publish: the system refuses rather than recording a warning nobody reads.
```

- [ ] **Step 4: Run to verify they pass**

Capped-fork command. Expected: PASS.

- [ ] **Step 5: Prove the refusal is not vacuous**

Temporarily remove the `selfEditable` check, re-run, and confirm the first test fails. Restore. Paste both outputs into the commit body — a guard that has never been observed refusing is not a guard.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/attributes/attribute-definitions.repository.ts apps/api/test/attribute-definitions.repository.spec.ts
git commit -m "feat(attributes): refuse the selfEditable escalation route in the repository

A custom attribute can drive a business-role formula (attributes.<key>), so
marking one self-editable would let a user grant themselves entitlements by
editing their own profile. Refused, with the roles named so the operator can
act on it.

In the repository rather than the controller so a caller cannot reach around
it, matching how the SoD publish gate is enforced.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: `validationRules` as a closed schema

**Files:**
- Modify: `apps/api/src/attributes/attribute-definitions.repository.ts` (or a new `validation-rules.ts` if the schema grows past ~40 lines)
- Test: alongside Task 5's spec

**Interfaces:**
- Produces: a Zod schema accepting exactly `{ format?, min?, max?, options? }` with `.strict()`.

- [ ] **Step 1: Write the failing test**

```ts
it('rejects validationRules keys outside the closed vocabulary', async () => {
  await expect(
    repo.create(db, { key: 'k', label: 'l', dataType: 'string', appliesTo: 'user',
      validationRules: { pattern: '(a+)+$' } as never }),
  ).rejects.toThrow(/pattern/)

  await expect(
    repo.create(db, { key: 'k2', label: 'l', dataType: 'string', appliesTo: 'user',
      validationRules: { unknownKey: 1 } as never }),
  ).rejects.toThrow(/unknownKey|unrecognized/i)
})

it('bounds enum options', async () => {
  await expect(
    repo.create(db, { key: 'k3', label: 'l', dataType: 'enum', appliesTo: 'user',
      validationRules: { options: Array.from({ length: 1001 }, (_, i) => String(i)) } }),
  ).rejects.toThrow(/options/)
})

it('accepts a format from the closed vocabulary', async () => {
  await expect(
    repo.create(db, { key: 'k4', label: 'l', dataType: 'string', appliesTo: 'user',
      validationRules: { format: 'email' } }),
  ).resolves.toBeDefined()
})
```

- [ ] **Step 2: Run to verify it fails.** Capped-fork command.

- [ ] **Step 3: Implement**

Use `z.object({...}).strict()` so unknown keys are rejected rather than stored. `format` must be `z.enum()` over the vocabulary exported by `attribute-formats.ts` — import it, never re-list it. Bound `options` to at most 200 entries of at most 200 characters.

Comment:

```ts
  // .strict(), and `format` drawn from attribute-formats.ts rather than
  // re-listed here. validationRules is jsonb — an open blob — and that is
  // exactly where the ReDoS lived: `pattern` was a caller-supplied regular
  // expression compiled and run against user input. `pattern` is rejected by
  // name with a message pointing at the vocabulary that replaced it, and
  // anything else unrecognised is rejected too rather than stored for some
  // future reader to interpret.
```

- [ ] **Step 4: Run to verify it passes.** Capped-fork command.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/attributes
git commit -m "feat(attributes): accept validationRules as a closed schema

validationRules is jsonb, and that is where the ReDoS lived — a caller-supplied
regex compiled and run against user input. The write path accepts a strict
schema instead: \`format\` from attribute-formats.ts's vocabulary, bounded
options, and unknown keys rejected rather than stored for a future reader to
interpret.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Create, PATCH, and audit — including the `sensitive` ordering

**Files:**
- Modify: `apps/api/src/attributes/attribute-definitions.controller.ts`
- Test: `apps/api/test/attribute-definitions.controller.spec.ts`

**Interfaces:**
- Consumes: repository methods (Tasks 5-6), `AuditWriter`.
- Produces: `POST /attribute-definitions`, `PATCH /attribute-definitions/:id`, and the re-gated `GET`.

- [ ] **Step 1: Write the failing tests**

Cover, at minimum: create returns 201 and writes an audit row; `PATCH` with `dataType` present returns 400 naming the preview route; `PATCH` toggling `sensitive` writes a **distinct** audit action; `GET` now requires `attribute:read` and a `help_desk` principal is refused.

The `sensitive` ordering test is the subtle one:

```ts
it('records a sensitive flag change with the values that were visible before it', async () => {
  // Turning `sensitive` ON reduces what the audit log can show. If the row for
  // that change is written using post-change redaction, the change that blinds
  // the audit is itself blinded — the one event that most needs to be legible.
  const row = await auditRowFor('attribute_definition:sensitive_changed', definitionId)
  expect(row.before).toMatchObject({ sensitive: false })
  expect(row.after).toMatchObject({ sensitive: true })
})
```

- [ ] **Step 2: Run to verify they fail.** Capped-fork command.

- [ ] **Step 3: Implement**

Follow `attribute-target-mappings.controller.ts` exactly for the audited-write shape:

```ts
      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'attribute_definition:create',
        resourceType: 'attribute_definition',
        resourceId: row.id,
        before: null,
        after: snapshotDefinition(row),
      })
```

Audit actions: `attribute_definition:create`, `attribute_definition:update`, `attribute_definition:sensitive_changed`, `attribute_definition:deactivate`.

Re-gate the `GET` from `'user:read'` to `'attribute:read'`.

- [ ] **Step 4: Run to verify they pass.** Capped-fork command.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/attributes/attribute-definitions.controller.ts apps/api/test
git commit -m "feat(attributes): create and edit definitions over HTTP, audited

Safe fields only — dataType and appliesTo are 400 with a pointer to the preview
route, because they rewrite stored values.

\`sensitive\` gets its own audit action rather than folding into update: turning
it on reduces what the audit log can see, so the record of that change is the
one that most needs to survive it.

GET moves from user:read to attribute:read — a deliberate narrowing that
removes help_desk's access.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: The migration job — preview

**Files:**
- Create: `apps/api/src/attributes/attribute-migration.job.ts`
- Test: `apps/api/test/attribute-migration.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  interface AttributeMigrationReport {
    populationSize: number
    changedCount: number
    unconvertible: { userId: string; value: unknown; reason: string }[]
    blastRadius: BlastRadiusEvaluation
    previewHash: string
  }
  preview(definitionId: string, change: { dataType?: AttributeDataType; appliesTo?: 'user' | 'group' }): Promise<AttributeMigrationReport>
  ```
- Consumes: `convertValue` (Task 4), `evaluateBlastRadius` from `outbox/target-reconciliation.job.ts`.

- [ ] **Step 1: Write the failing test**

Cover: a population with some convertible and some unconvertible values reports both counts; `preview` writes nothing (assert the users table is byte-identical after); the unconvertible sample is bounded; `previewHash` differs when the change differs.

- [ ] **Step 2: Run to verify it fails.** Capped-fork command.

- [ ] **Step 3: Implement**

`previewHash` must cover the definition id, the exact change, **and** the set of affected user ids — so that a preview taken before someone else edits a user cannot authorise a commit afterwards.

The blast-radius call is the existing function, not a reimplementation. Import it and pass the real population:

```ts
import { evaluateBlastRadius } from '../outbox/target-reconciliation.job'

// populationSize is every user holding this attribute, NOT every user in the
// directory — a migration touching all 12 holders of a rare attribute is
// total for that attribute and must read as 100%, not as 0.03% of the tenant.
const blastRadius = evaluateBlastRadius(
  changedCount,
  populationSize,
  thresholdPercent,
  floor,
)
```

Read `evaluateBlastRadius`'s own signature before wiring it — it takes
`(changedCount, populationSize, thresholdPercent, floor)` and returns a
`BlastRadiusEvaluation`. Where `thresholdPercent` and `floor` come from is a
decision this task must make and record: `connector_targets` carries its own
columns (defaults 20 and 5), and this table has none. Either add them to
`attribute_definitions` or take the connector defaults as constants — say which
and why in the commit body, and do not leave it implicit.

- [ ] **Step 4: Run to verify it passes.** Capped-fork command.

- [ ] **Step 5: Commit** with a message explaining what the hash covers and why.

---

### Task 9: The migration job — commit

**Files:**
- Modify: `apps/api/src/attributes/attribute-migration.job.ts`
- Test: `apps/api/test/attribute-migration.spec.ts`

**Interfaces:**
- Produces: `commit(definitionId, change, previewHash, opts: { force?: boolean; actorUserId: string }): Promise<AttributeMigrationReport>`

- [ ] **Step 1: Write the failing tests**

The four that matter:

```ts
it('refuses when the preview hash does not match the change being committed', …)
it('refuses when any value is unconvertible, even with force', …)
it('refuses when the blast radius is exceeded, and allows it with force', …)
it('writes the before-values into the audit row, so the migration is reversible', …)
```

That last one is the most important test in the plan. A `dataType` migration overwrites values in place; without the before-values in the audit row the operation cannot be undone.

- [ ] **Step 2: Run to verify they fail.** Capped-fork command.

- [ ] **Step 3: Implement**

Whole migration in one transaction. `force` overrides the blast-radius refusal **only** — never an unconvertible value. Audit action `attribute_definition:migrate`, with `before` carrying the affected users' prior values.

- [ ] **Step 4: Run to verify they pass.** Capped-fork command.

- [ ] **Step 5: Prove non-vacuity.** Break each of the three refusals in turn, confirm the matching test fails, restore. Paste all of it.

- [ ] **Step 6: Commit.**

---

### Task 10: Preview and commit over HTTP, and the CLI

**Files:**
- Modify: `apps/api/src/attributes/attribute-definitions.controller.ts`
- Create: `apps/api/src/attributes/attribute-migrate-cli.ts`
- Modify: `apps/api/package.json` (add `attribute-migrate`)
- Test: alongside Task 7's controller spec

**Interfaces:**
- Consumes: `AttributeMigrationJob` (Tasks 8-9).
- Produces: `POST /attribute-definitions/:id/preview`, `POST /attribute-definitions/:id/commit`, `pnpm attribute-migrate`.

- [ ] **Step 1: Write the failing tests** — both routes require `attribute:manage`; commit without a preview hash is 400.

- [ ] **Step 2: Run to verify they fail.** Capped-fork command.

- [ ] **Step 3: Implement.** The CLI follows `role-reconcile-cli.ts`'s shape: strips a literal `--`, dry-run by default, `--commit` to apply, `--actor=` required.

- [ ] **Step 4: Run to verify they pass.** Capped-fork command.

- [ ] **Step 5: Commit.**

---

### Task 11: The console

**Files:**
- Create: `apps/web/src/attributes/AttributeDefinitionsPage.tsx`
- Modify: `apps/web/src/attributes/api.ts`, `apps/web/src/App.tsx`, `apps/web/src/shell/nav-items.tsx`

- [ ] **Step 1: Read three existing pages first** — `BusinessRolesPage.tsx` for the draft/simulate/publish shape, `ConnectorsListPage.tsx` for a list, and `ImportsPage.tsx` for a preview-before-commit flow. Match their conventions; do not invent a new one.

- [ ] **Step 2: Build the list page**, gated on `attribute:read`, with a nav entry.

- [ ] **Step 3: Build the create/edit form.** The commit button stays disabled while any value is unconvertible, and the refusal messages come from the API — the console renders them, it does not re-implement them.

- [ ] **Step 4: Verify**

```bash
pnpm --filter @idm/web build
pnpm --filter @idm/web test     # CSS tokens, connector-target drift, CSP hash
pnpm --filter @idm/web typecheck
```

- [ ] **Step 5: Commit.**

---

### Task 12: Documentation, and the final gate

**Files:**
- Modify: `docs/08-authorization.md`, `docs/10-api-reference.md`, `docs/07-admin-guide.md`, `docs/03-data-model.md`

- [ ] **Step 1: `docs/08-authorization.md`** — the two new actions with their roles, the count 24 → 26, and the `help_desk` narrowing stated explicitly.

- [ ] **Step 2: `docs/10-api-reference.md`** — all four new routes as canonical `` `METHOD /path` `` tokens, or the docs guard fails.

- [ ] **Step 3: `docs/07-admin-guide.md`** — a walkthrough for creating an attribute and for running a migration, matching the numbered style already there.

- [ ] **Step 4: `docs/03-data-model.md`** — the new CHECK constraint, and correct the comment describing `key` as "the mutable `key`", which this work makes false.

- [ ] **Step 5: Run every gate**

```bash
node scripts/extract-doc-facts.mjs && node scripts/check-docs.mjs   # must be 0
pnpm verify:quick                                                    # must pass
```

- [ ] **Step 6: Full API suite, once, capped**

```bash
pnpm vitest run --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3
```
Read the printed `Test Files` / `Tests` summary, not the exit code. `test/dev-environment.spec.ts` needs the dev Keycloak — `docker compose up -d` first, or it fails for an environmental reason unrelated to this work.

- [ ] **Step 7: Commit.**

---

## Notes for the executor

- Tasks 1-4 are independent of each other and of everything else; 5-6 depend on 1; 7 depends on 5-6; 8-9 depend on 4; 10 depends on 8-9; 11 depends on 10; 12 depends on all.
- The three highest-value tests in this plan are the `selfEditable` refusal (Task 5), the preview-hash mismatch (Task 9), and the before-values in the audit row (Task 9). If time is short anywhere, it is not there.
- When a refusal test passes on the first run, be suspicious. Break the guard and watch it fail before believing it.
