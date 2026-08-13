# Mapping Export Acknowledgement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make enabling an attribute→target mapping require the caller to acknowledge, by number, how many people's values it newly exports — enforced by the API, not drawn on a screen.

**Architecture:** One new read method on the existing `AttributeTargetMappingsRepository` counts holders scoped to organizations that actually have the target enabled. One `GET` exposes that count plus the attribute's `sensitive` flag. `POST` and `PATCH` gain an optional `acknowledgedExportCount` which becomes REQUIRED, and must match a count re-derived inside the writing transaction, whenever the write would leave the row enabled over a non-empty population. The console renders an inline confirmation; it re-implements no rule.

**Tech Stack:** NestJS, Drizzle (raw `sql` tag for the count), zod DTOs, Vitest + Testcontainers, React 18 + plain CSS. All existing.

**Spec:** `docs/archive/specs/2026-08-12-mapping-export-acknowledgement-design.md`

## Global Constraints

- Authorization is enforced in the API, never the UI.
- Testcontainers, never mocks, for API tests. `strict: true`, no `any`/`@ts-ignore`.
- Run API tests with BOTH fork bounds or vitest errors out:
  `npx vitest run <files> --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3`
- Never embed a raw control byte (NUL) in a source file — use the escape.
- No CSS colour literals outside `styles/tokens.css`.
- No database migration is needed: every column this reads already exists.
- When a refusal test passes on the first run, be suspicious. Break the guard and watch it fail before believing it.

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/attributes/attribute-target-mappings.repository.ts` (modify) | gains `countExportImpact` — the only place the holder rule lives |
| `apps/api/src/attributes/attribute-target-mappings.controller.ts` (modify) | the `GET`, the two DTO fields, the enforcement, the audit snapshot |
| `apps/api/test/attribute-target-mappings.repository.spec.ts` (create) | counting rules against a real Postgres |
| `apps/api/test/attribute-target-mappings.controller.spec.ts` (modify) | the endpoint, the 400/409, the transition matrix |
| `apps/web/src/connectors/api.ts` (modify) | `fetchExportImpact`, and the new field on the two write inputs |
| `apps/web/src/connectors/AttributeMappingsEditor.tsx` (modify) | the inline confirmation |
| `apps/web/src/connectors/Connectors.css` (modify) | styles for it |
| `docs/10-api-reference.md`, `docs/12-security.md`, `TODO.md` (modify) | the route, the finding's closure, the ledger |

---

### Task 1: Count the holders

**Files:**
- Modify: `apps/api/src/attributes/attribute-target-mappings.repository.ts`
- Test: `apps/api/test/attribute-target-mappings.repository.spec.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  export interface ExportImpactQuery {
    target: ConnectorTarget
    attributeDefinitionId?: string | null
    coreField?: CoreProfileField | null
  }
  export interface ExportImpact {
    holderCount: number
    sensitive: boolean
  }
  // on AttributeTargetMappingsRepository:
  async countExportImpact(query: ExportImpactQuery, db?: DbHandle): Promise<ExportImpact>
  ```
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/attribute-target-mappings.repository.spec.ts`. Follow
`attribute-definitions.repository.spec.ts` for the `withTestDatabase()` shape,
per-call unique keys and `OrganizationsRepository.findMaster()`.

```ts
describe('countExportImpact', () => {
  it('counts only users holding a non-null value for the custom attribute', async () => {
    const key = uniqueKey('exp')
    const definition = await seedDefinition({ key, appliesTo: 'user' })
    await enableTarget('active_directory')

    await seedUserWithAttributes({ [key]: 'yes' })
    await seedUserWithAttributes({ [key]: null })   // holds the key, value null
    await seedUserWithAttributes({})                // does not hold it

    await expect(
      repo().countExportImpact({ target: 'active_directory', attributeDefinitionId: definition.id }),
    ).resolves.toMatchObject({ holderCount: 1 })
  })

  it('excludes a holder whose organization does not have that target enabled', async () => {
    const key = uniqueKey('exp')
    const definition = await seedDefinition({ key, appliesTo: 'user' })
    // deliberately NOT enabling the target for this org
    await seedUserWithAttributes({ [key]: 'yes' })

    await expect(
      repo().countExportImpact({ target: 'active_directory', attributeDefinitionId: definition.id }),
    ).resolves.toMatchObject({ holderCount: 0 })
  })

  it('reports the definition sensitive flag, so a caller need not re-derive it', async () => {
    const definition = await seedDefinition({ key: uniqueKey('exp'), sensitive: true })
    await enableTarget('active_directory')

    await expect(
      repo().countExportImpact({ target: 'active_directory', attributeDefinitionId: definition.id }),
    ).resolves.toMatchObject({ sensitive: true })
  })

  it('counts a core title only where a job title is actually set', async () => {
    await enableTarget('active_directory')
    await seedUser({ jobTitle: 'Engineer' })
    await seedUser({ jobTitle: null })

    const { holderCount } = await repo().countExportImpact({
      target: 'active_directory',
      coreField: 'title',
    })
    expect(holderCount).toBe(1)
  })

  it('reports a core field as never sensitive — there is no definition to flag', async () => {
    await enableTarget('active_directory')
    await expect(
      repo().countExportImpact({ target: 'active_directory', coreField: 'given_name' }),
    ).resolves.toMatchObject({ sensitive: false })
  })
})
```

- [ ] **Step 2: Run to verify they fail.**
`npx vitest run test/attribute-target-mappings.repository.spec.ts --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3`
Expected: FAIL — `countExportImpact is not a function`.

- [ ] **Step 3: Implement**

Add to the repository. Raw `sql`, matching `listForTarget`'s own precedent in
this file.

```ts
/**
 * How many people a mapping would newly export, and whether the attribute is
 * one the audit log is forbidden to record.
 *
 * SCOPED TO ORGANIZATIONS THAT ACTUALLY HAVE THE TARGET ENABLED.
 * `connector_targets` is keyed `(organization_id, target)`, and a tenant with
 * no enabled row exports nothing, so counting the whole directory would
 * over-state this on any deployment where one tenant of twenty is
 * configured — and an alarming number that is also wrong is one people learn
 * to dismiss.
 *
 * Deliberately NOT filtered by user status. A deactivated account keeps its
 * stored value and exports it on reactivation, so excluding it would
 * under-state what enabling this mapping ultimately sends.
 */
async countExportImpact(query: ExportImpactQuery, db: DbHandle = this.db): Promise<ExportImpact> {
  const scoped = sql`
    FROM users u
    JOIN connector_targets ct
      ON ct.organization_id = u.organization_id
     AND ct.target = ${query.target}
     AND ct.enabled = true
  `

  if (query.attributeDefinitionId != null) {
    const [definition] = await db
      .select({ key: attributeDefinitions.key, sensitive: attributeDefinitions.sensitive })
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.id, query.attributeDefinitionId))
    if (!definition) throw new NotFoundError('attribute definition', query.attributeDefinitionId)

    // `? key` is "has this key at all"; the jsonb_typeof guard excludes a key
    // explicitly set to JSON null, which holds no value to export.
    const rows = await db.execute(sql`
      SELECT COUNT(*)::int AS count ${scoped}
      WHERE u.attributes ? ${definition.key}
        AND jsonb_typeof(u.attributes -> ${definition.key}) <> 'null'
    `)
    return { holderCount: Number(rows.rows[0]?.count ?? 0), sensitive: definition.sensitive }
  }

  // A core field has no definition row, so nothing can flag it sensitive.
  // `first_name`, `last_name` and `org_unit_id` are NOT NULL, so every
  // in-scope user holds them; only `job_title` is nullable.
  const predicate =
    query.coreField === 'title' ? sql`WHERE u.job_title IS NOT NULL` : sql``
  const rows = await db.execute(sql`SELECT COUNT(*)::int AS count ${scoped} ${predicate}`)
  return { holderCount: Number(rows.rows[0]?.count ?? 0), sensitive: false }
}
```

- [ ] **Step 4: Run to verify they pass.** Same command as Step 2.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/attributes/attribute-target-mappings.repository.ts apps/api/test/attribute-target-mappings.repository.spec.ts
git commit -m "feat(mappings): count what enabling a mapping would export"
```

---

### Task 2: Expose the count

**Files:**
- Modify: `apps/api/src/attributes/attribute-target-mappings.controller.ts`
- Test: `apps/api/test/attribute-target-mappings.controller.spec.ts`

**Interfaces:**
- Consumes: `countExportImpact` from Task 1.
- Produces: `GET /attribute-target-mappings/export-impact` → `{ target, holderCount, sensitive }`.

- [ ] **Step 1: Write the failing tests**

```ts
it('reports the export impact for a custom attribute', async () => {
  await actAs('super_admin')
  const res = await request(app.getHttpServer())
    .get(`/attribute-target-mappings/export-impact?target=active_directory&attributeDefinitionId=${definition.id}`)
    .expect(200)
  expect(res.body).toMatchObject({ target: 'active_directory', holderCount: 1, sensitive: false })
})

it('rejects a request naming both an attribute and a core field', async () => {
  await actAs('super_admin')
  await request(app.getHttpServer())
    .get('/attribute-target-mappings/export-impact?target=active_directory&coreField=title&attributeDefinitionId=' + definition.id)
    .expect(400)
})

it('allows connector:read — it returns a count, never a value', async () => {
  await actAs('auditor')
  await request(app.getHttpServer())
    .get('/attribute-target-mappings/export-impact?target=active_directory&coreField=title')
    .expect(200)
})
```

- [ ] **Step 2: Run to verify they fail.** Expected: 404, the route does not exist.

- [ ] **Step 3: Implement**

Declare the query schema beside the existing ones:

```ts
const exportImpactQuerySchema = z
  .object({
    target: connectorTargetSchema,
    attributeDefinitionId: z.string().uuid().optional(),
    coreField: coreFieldSchema.optional(),
  })
  .strict()
  .refine((q) => (q.attributeDefinitionId !== undefined) !== (q.coreField !== undefined), {
    message: 'exactly one of attributeDefinitionId or coreField is required, never both, never neither',
  })
```

Then the route. **Declare it BEFORE `@Get()`** is not required (this path is
static, not a parameter), but keep it above the write methods for readability.

```ts
/**
 * What enabling this mapping would newly export, as a number.
 *
 * `connector:read`, and a GET, because this returns a COUNT and a boolean —
 * never a stored value. The attribute migration's preview is a POST precisely
 * because it returns real values out of `users.attributes`, and a GET is the
 * shape of a thing browsers prefetch and proxies log whole. Nothing crossing
 * this route is worth that care.
 */
@Get('export-impact')
@RequirePermission('connector:read')
async exportImpact(@Query() query: unknown): Promise<{ target: string } & ExportImpact> {
  const parsed = parseBody(exportImpactQuerySchema, query)
  const impact = await this.mappings.countExportImpact(parsed)
  return { target: parsed.target, ...impact }
}
```

Add `Query` to the `@nestjs/common` import and `ExportImpact` to the
repository import.

- [ ] **Step 4: Run to verify they pass.**
`npx vitest run test/attribute-target-mappings.controller.spec.ts --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3`

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(mappings): GET export-impact reports the count, never a value"
```

---

### Task 3: Require the acknowledgement

**Files:**
- Modify: `apps/api/src/attributes/attribute-target-mappings.controller.ts`
- Test: `apps/api/test/attribute-target-mappings.controller.spec.ts`

**Interfaces:**
- Consumes: `countExportImpact` (Task 1).
- Produces: `acknowledgedExportCount?: number` on both write bodies; 400 when
  absent with holders, 409 when stale.

- [ ] **Step 1: Write the failing tests**

```ts
it('refuses to create an enabled mapping without the acknowledgement, naming the count', async () => {
  await actAs('super_admin')
  const res = await post({ attributeDefinitionId: definition.id, target: 'active_directory', remoteName: 'ext1' })
    .expect(400)
  expect(res.body.code).toBe('VALIDATION_FAILED')
  expect(JSON.stringify(res.body.issues)).toContain('1')
})

it('refuses a stale acknowledgement with 409', async () => {
  await actAs('super_admin')
  const res = await post({
    attributeDefinitionId: definition.id, target: 'active_directory', remoteName: 'ext1',
    acknowledgedExportCount: 0,
  }).expect(409)
  expect(res.body.code).toBe('CONFLICT')
})

it('creates when the acknowledgement matches', async () => {
  await actAs('super_admin')
  await post({
    attributeDefinitionId: definition.id, target: 'active_directory', remoteName: 'ext1',
    acknowledgedExportCount: 1,
  }).expect(201)
})

it('needs no acknowledgement when nothing would be exported', async () => {
  await actAs('super_admin')  // no users hold this attribute
  await post({ attributeDefinitionId: empty.id, target: 'active_directory', remoteName: 'ext2' }).expect(201)
})

it('needs no acknowledgement to create a DISABLED mapping', async () => {
  await actAs('super_admin')
  await post({
    attributeDefinitionId: definition.id, target: 'active_directory', remoteName: 'ext3', enabled: false,
  }).expect(201)
})

it('requires the acknowledgement when a PATCH turns a mapping on', async () => {
  await actAs('super_admin')
  const created = await createDisabled()
  await patch(created.id, { enabled: true }).expect(400)
  await patch(created.id, { enabled: true, acknowledgedExportCount: 1 }).expect(200)
})

it('requires nothing to turn a mapping OFF — that reduces exposure', async () => {
  await actAs('super_admin')
  const enabled = await createEnabled()
  await patch(enabled.id, { enabled: false }).expect(200)
})

it('requires nothing to rename remoteName on an already-enabled mapping', async () => {
  await actAs('super_admin')
  const enabled = await createEnabled()
  await patch(enabled.id, { remoteName: 'renamed' }).expect(200)
})

it('records the acknowledged count and the sensitive flag in the audit row', async () => {
  await actAs('super_admin')
  await post({
    attributeDefinitionId: sensitiveDefinition.id, target: 'active_directory', remoteName: 'ext4',
    acknowledgedExportCount: 1,
  }).expect(201)
  const [row] = await auditRowsFor('attribute_target_mapping:create')
  expect(row.after).toMatchObject({ acknowledgedExportCount: 1, sensitive: true })
})
```

- [ ] **Step 2: Run to verify they fail.** Expected: the 400/409 tests get 201.

- [ ] **Step 3: Implement**

Add the field to both schemas:

```ts
// The count the caller was shown. Required only when the write would leave
// the row enabled over a non-empty population — see `assertAcknowledged`.
acknowledgedExportCount: z.number().int().nonnegative().optional(),
```

Add the shared guard, and call it inside BOTH transactions before the write:

```ts
/**
 * The acknowledgement, re-derived INSIDE the caller's transaction.
 *
 * Re-deriving is what makes this a guard rather than a decoration: a bulk
 * import landing between the caller's GET and their POST invalidates the
 * number instead of slipping under it.
 *
 * A count of zero requires nothing, so callers that export nothing are
 * untouched. Absent is a 400 that NAMES the real number — the message is the
 * information the caller was missing. A mismatch is a ConflictError, the same
 * status and the same reasoning as a superseded `previewHash` on the
 * attribute migration: they acknowledged a smaller export than the one they
 * are about to perform.
 */
private async assertAcknowledged(
  tx: DbHandle,
  query: ExportImpactQuery,
  acknowledged: number | undefined,
): Promise<ExportImpact> {
  const impact = await this.mappings.countExportImpact(query, tx)
  if (impact.holderCount === 0) return impact

  if (acknowledged === undefined) {
    throw new ValidationError([
      `acknowledgedExportCount: enabling this mapping exports ${impact.holderCount} ` +
        `people's values to ${query.target}` +
        (impact.sensitive
          ? ', and this attribute is marked sensitive, so the audit log will not record what was sent'
          : '') +
        `. Send acknowledgedExportCount: ${impact.holderCount} to confirm.`,
    ])
  }
  if (acknowledged !== impact.holderCount) {
    throw new ConflictError(
      `acknowledgedExportCount ${acknowledged} no longer matches: this mapping now exports ` +
        `${impact.holderCount} people's values. Re-read the impact and confirm the current number.`,
    )
  }
  return impact
}
```

In `create`, before `this.mappings.create`, when `enabled` is true:

```ts
const impact = (parsed.enabled ?? true)
  ? await this.assertAcknowledged(tx, {
      target: parsed.target,
      attributeDefinitionId: parsed.attributeDefinitionId ?? null,
      coreField: parsed.coreField ?? null,
    }, parsed.acknowledgedExportCount)
  : null
```

In `update`, guard only a transition INTO enabled:

```ts
// `true -> true` is not a new export, and `-> false` reduces exposure.
const turningOn = parsed.enabled === true && !before.enabled
const impact = turningOn
  ? await this.assertAcknowledged(tx, {
      target: before.target,
      attributeDefinitionId: before.attributeDefinitionId,
      coreField: before.coreField,
    }, parsed.acknowledgedExportCount)
  : null
```

Extend the audit snapshot so the number reaches the log:

```ts
function snapshotMapping(row: MappingRecord, impact: ExportImpact | null): Record<string, unknown> {
  return {
    attributeDefinitionId: row.attributeDefinitionId,
    coreField: row.coreField,
    target: row.target,
    remoteName: row.remoteName,
    enabled: row.enabled,
    // Present only when this write turned propagation ON, which is the only
    // moment the number means anything.
    ...(impact === null ? {} : { acknowledgedExportCount: impact.holderCount, sensitive: impact.sensitive }),
  }
}
```

Update the three existing `snapshotMapping(...)` call sites to pass `null`
where no impact was derived (`before` snapshots, and `remove`).

Import `ConflictError` and `ValidationError` from `../common/errors`.

- [ ] **Step 4: Run to verify they pass.** Same command as Task 2.

- [ ] **Step 5: Prove non-vacuity.** Break each refusal in turn — force
  `holderCount` to 0; drop the `acknowledged === undefined` branch; make the
  mismatch comparison always true — confirm the matching test fails each time,
  restore, and paste all of it.

- [ ] **Step 6: Commit**

```bash
git commit -am "feat(mappings): require an acknowledged export count to enable a mapping"
```

---

### Task 4: The console says the number

**Files:**
- Modify: `apps/web/src/connectors/api.ts`, `apps/web/src/connectors/AttributeMappingsEditor.tsx`, `apps/web/src/connectors/Connectors.css`

**Interfaces:**
- Consumes: `GET /attribute-target-mappings/export-impact` (Task 2), the new
  body field (Task 3).
- Produces: `fetchExportImpact(accessToken, query)`, and
  `acknowledgedExportCount?: number` on `CreateMappingInput` /
  `UpdateMappingInput`.

- [ ] **Step 1: Add the client functions**

```ts
export interface ExportImpact {
  target: ConnectorTarget
  holderCount: number
  sensitive: boolean
}

export function fetchExportImpact(
  accessToken: string,
  query: { target: ConnectorTarget; attributeDefinitionId?: string; coreField?: string },
): Promise<ExportImpact> {
  return authorizedRequest<ExportImpact>(
    `/attribute-target-mappings/export-impact${buildQuery({ ...query })}`,
    accessToken,
  )
}
```

Add `acknowledgedExportCount?: number` to both input interfaces.

- [ ] **Step 2: Build the inline confirmation**

In `AttributeMappingsEditor`, enabling (creating enabled, or toggling on)
first calls `fetchExportImpact`. If `holderCount === 0`, proceed with no
ceremony. Otherwise render an inline panel — NOT a modal
(`docs/design-system.md` bans "modal as first thought") — in the shape
`ImportPage`'s safety note uses:

```tsx
<div className="mappings__confirm" role="note" data-testid="mapping-export-confirm">
  <p>
    <strong>
      This exports {impact.holderCount} {impact.holderCount === 1 ? "person's" : "people's"} values
      to {CONNECTOR_TARGET_LABEL[impact.target]}.
    </strong>{' '}
    Values already held are sent on each person's next sync. Nothing recalls them afterwards.
  </p>
  {impact.sensitive && (
    <p data-testid="mapping-export-sensitive">
      This attribute is marked <strong>sensitive</strong>: its values are withheld from the audit
      log, so after export the log cannot show what was sent.
    </p>
  )}
  <button
    type="button"
    className="btn btn--primary"
    onClick={() => void confirmEnable(impact.holderCount)}
    data-testid="mapping-export-confirm-button"
  >
    Export {impact.holderCount} {impact.holderCount === 1 ? 'value' : 'values'}
  </button>
  <button type="button" className="btn btn--secondary" onClick={cancelEnable}>
    Cancel
  </button>
</div>
```

`confirmEnable` sends `acknowledgedExportCount`. A 409 is rendered verbatim
from `ApiError.message`; the console re-derives nothing.

- [ ] **Step 3: Style it** in `Connectors.css`, reusing `--warn` / `--warn-bg`
  with a FULL border (side stripes are banned) — mirror
  `.attr-migration__safety` in `AttributeDefinitionsPage.css`.

- [ ] **Step 4: Verify**

```bash
pnpm --filter @idm/web typecheck
pnpm --filter @idm/web build
pnpm --filter @idm/web test
```

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(web): confirm what enabling a mapping exports, with the number"
```

---

### Task 5: Documentation, and the gates

**Files:**
- Modify: `docs/10-api-reference.md`, `docs/12-security.md`, `TODO.md`

- [ ] **Step 1: `docs/10-api-reference.md`** — document
  `GET /attribute-target-mappings/export-impact` as a canonical
  `` `METHOD /path` `` token or the docs guard fails, and add
  `acknowledgedExportCount` to the two write entries, including which
  transitions require it.

- [ ] **Step 2: `docs/12-security.md`** — record finding 5 as closed, stating
  what is and is not closed: enabling now costs an acknowledged number;
  `sensitive` still does not stop propagation, deliberately.

- [ ] **Step 3: `TODO.md`** — tick finding 5. While there, correct two entries
  this repository has already falsified: finding 4 still says "the
  `attribute_definitions` write path has NOT merged", and the SSO section still
  lists "Run `apps/web/e2e/sso-apps.spec.ts` — it has never executed", which it
  now has, twice.

- [ ] **Step 4: Run every gate**

```bash
node scripts/extract-doc-facts.mjs && node scripts/check-docs.mjs   # must be 0
pnpm verify:quick
cd apps/api && npx vitest run --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3
```

Read the printed `Test Files` / `Tests` summary, not the exit code.
`test/dev-environment.spec.ts` needs the dev Keycloak — `docker compose up -d`
first, or it fails for an environmental reason unrelated to this work.

- [ ] **Step 5: Commit.**
