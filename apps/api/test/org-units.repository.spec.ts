import { beforeEach, describe, expect, it } from 'vitest'
import { OrgUnitsRepository, toLabel } from '../src/org-units/org-units.repository'
import { orgUnits } from '../src/db/schema/org-units'
import { withTestDatabase } from './support/pg'

describe('toLabel', () => {
  it('lowercases and replaces unsafe characters with underscores', () => {
    expect(toLabel('Research & Development')).toBe('research_development')
  })

  it('collapses runs of separators', () => {
    expect(toLabel('Sales   ---  EMEA')).toBe('sales_emea')
  })

  it('strips diacritics via NFKD normalization', () => {
    expect(toLabel('Café')).toBe('cafe')
  })

  it('no longer collides "Café" and "Caf!" on the same label', () => {
    expect(toLabel('Café')).not.toBe(toLabel('Caf!'))
  })

  it('returns a valid label instead of throwing for a name with no usable characters', () => {
    expect(() => toLabel('!!!')).not.toThrow()
    expect(toLabel('!!!')).toMatch(/^[A-Za-z0-9_]+$/)
  })

  it('returns a valid non-empty label for a purely non-Latin name instead of throwing', () => {
    expect(() => toLabel('北京事业部')).not.toThrow()
    expect(toLabel('北京事业部')).toMatch(/^[A-Za-z0-9_]+$/)
  })

  it('is deterministic for the same non-Latin input', () => {
    expect(toLabel('北京事业部')).toBe(toLabel('北京事业部'))
  })

  it('produces different labels for different non-Latin names', () => {
    expect(toLabel('北京事业部')).not.toBe(toLabel('日本語'))
  })
})

describe('OrgUnitsRepository', () => {
  const ctx = withTestDatabase()
  let repo: OrgUnitsRepository

  beforeEach(async () => {
    await ctx.pool.query('TRUNCATE TABLE org_units CASCADE')
    repo = new OrgUnitsRepository(ctx.db)
  })

  it('creates a root whose path is its own label', async () => {
    const root = await repo.createRoot('Acme Corp')
    expect(root.parentId).toBeNull()
    expect(root.path).toBe('acme_corp')
  })

  it('creates a child whose path extends the parent path', async () => {
    const root = await repo.createRoot('Acme Corp')
    const sales = await repo.createChild(root.id, 'Sales')
    const emea = await repo.createChild(sales.id, 'EMEA')

    expect(sales.path).toBe('acme_corp.sales')
    expect(emea.path).toBe('acme_corp.sales.emea')
    expect(emea.parentId).toBe(sales.id)
  })

  it('returns the whole subtree including its root', async () => {
    const root = await repo.createRoot('Acme Corp')
    const sales = await repo.createChild(root.id, 'Sales')
    await repo.createChild(sales.id, 'EMEA')
    await repo.createChild(root.id, 'Engineering')

    const subtree = await repo.findSubtree(sales.id)
    expect(subtree.map((u) => u.path).sort()).toEqual([
      'acme_corp.sales',
      'acme_corp.sales.emea',
    ])
  })

  it('rejects two siblings that resolve to the same label', async () => {
    const root = await repo.createRoot('Acme Corp')
    await repo.createChild(root.id, 'Sales')
    await expect(repo.createChild(root.id, 'sales')).rejects.toThrow()
  })

  it('rejects a child of a nonexistent parent', async () => {
    await expect(
      repo.createChild('00000000-0000-0000-0000-000000000000', 'Orphan'),
    ).rejects.toThrow(/parent org unit not found/)
  })

  it('reports containment for scope checks', async () => {
    const root = await repo.createRoot('Acme Corp')
    const sales = await repo.createChild(root.id, 'Sales')
    const emea = await repo.createChild(sales.id, 'EMEA')
    const eng = await repo.createChild(root.id, 'Engineering')

    expect(await repo.isWithinScope(sales.path, emea.path)).toBe(true)
    expect(await repo.isWithinScope(sales.path, sales.path)).toBe(true)
    expect(await repo.isWithinScope(sales.path, eng.path)).toBe(false)
  })

  it('creates a root with a non-Latin name, preserving the original name and deriving a valid path', async () => {
    const root = await repo.createRoot('北京事业部')
    expect(root.name).toBe('北京事业部')
    expect(root.path).toMatch(/^[A-Za-z0-9_]+$/)

    const child = await repo.createChild(root.id, 'Sales')
    expect(child.path).toBe(`${root.path}.sales`)
    expect(child.path.split('.')).toHaveLength(2)
  })
})
