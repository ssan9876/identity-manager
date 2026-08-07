import { useCallback, useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { ApiError } from '../api/client'
import { fetchAttributeDefinitions } from '../attributes/api'
import { useToast } from '../shell/ToastProvider'
import {
  ALL_CONNECTOR_TARGETS,
  ALL_CORE_FIELDS,
  CONNECTOR_TARGET_LABEL,
  CORE_FIELD_LABEL,
  createAttributeTargetMapping,
  deleteAttributeTargetMapping,
  fetchAttributeTargetMappings,
  updateAttributeTargetMapping,
  type AttributeTargetMappingRow,
  type ConnectorTarget,
  type CoreProfileField,
} from './api'
import './Connectors.css'

interface FieldRow {
  source: 'custom' | 'core'
  key: string
  label: string
  attributeDefinitionId?: string
  coreField?: CoreProfileField
}

function cellKey(target: ConnectorTarget, source: 'custom' | 'core', localKey: string): string {
  return `${target}:${source}:${localKey}`
}

/**
 * Milestone 14, Task 9 — "Attribute mapping editor over
 * `attribute_target_mappings`." A grid, not a list: rows are every mappable
 * LOCAL field (the four fixed core fields, then every active custom user
 * attribute), columns are every target. This shape is what makes
 * default-deny LEGIBLE (this task's own core requirement) — an empty cell
 * is not a switch left off, it is the absence of a row, and the grid makes
 * that absence as visible as a filled-in one: no cell anywhere renders a
 * checkbox for a field that was never mapped, only for one that WAS (and
 * might now be enabled or disabled) — see the render below for exactly
 * where that line is drawn.
 */
export function AttributeMappingsEditor({ canManage }: { canManage: boolean }) {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const { showToast } = useToast()

  const [rows, setRows] = useState<FieldRow[] | null>(null)
  const [mappings, setMappings] = useState<AttributeTargetMappingRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)

  const [addingCell, setAddingCell] = useState<string | null>(null)
  const [draftRemoteName, setDraftRemoteName] = useState('')
  const [busyCell, setBusyCell] = useState<string | null>(null)
  const [cellError, setCellError] = useState<{ cell: string; message: string } | null>(null)

  const load = useCallback(() => {
    if (accessToken === undefined) return
    setLoadError(null)
    Promise.all([fetchAttributeDefinitions(accessToken, 'user'), fetchAttributeTargetMappings(accessToken)])
      .then(([definitions, mappingRows]) => {
        const fieldRows: FieldRow[] = [
          ...ALL_CORE_FIELDS.map((cf) => ({ source: 'core' as const, key: cf, label: CORE_FIELD_LABEL[cf], coreField: cf })),
          ...definitions
            .filter((d) => d.isActive)
            .map((d) => ({ source: 'custom' as const, key: d.key, label: d.label, attributeDefinitionId: d.id })),
        ]
        setRows(fieldRows)
        setMappings(mappingRows)
      })
      .catch((cause: unknown) => {
        setLoadError(
          cause instanceof ApiError
            ? `Could not load attribute mappings: ${cause.message}`
            : 'Could not load attribute mappings. Check your connection and try again.',
        )
      })
  }, [accessToken, retryToken])

  useEffect(load, [load])

  function findMapping(row: FieldRow, target: ConnectorTarget): AttributeTargetMappingRow | undefined {
    return mappings?.find((m) => m.target === target && m.source === row.source && m.localKey === row.key)
  }

  async function handleCreate(row: FieldRow, target: ConnectorTarget) {
    if (accessToken === undefined || draftRemoteName.trim() === '') return
    const cell = cellKey(target, row.source, row.key)
    setBusyCell(cell)
    setCellError(null)
    try {
      await createAttributeTargetMapping(accessToken, {
        attributeDefinitionId: row.attributeDefinitionId,
        coreField: row.coreField,
        target,
        remoteName: draftRemoteName.trim(),
      })
      setAddingCell(null)
      setDraftRemoteName('')
      showToast(`Mapped ${row.label} to ${CONNECTOR_TARGET_LABEL[target]}.`)
      load()
    } catch (cause) {
      setCellError({
        cell,
        message: cause instanceof ApiError ? cause.message : 'Could not create this mapping.',
      })
    } finally {
      setBusyCell(null)
    }
  }

  async function handleToggle(mapping: AttributeTargetMappingRow) {
    if (accessToken === undefined) return
    const cell = cellKey(mapping.target, mapping.source, mapping.localKey)
    setBusyCell(cell)
    setCellError(null)
    // Optimistic: a CONTROLLED checkbox (`checked={mapping.enabled}`) re-renders
    // from local state on every state change — without this, the `setBusyCell`
    // update above lands first, re-rendering with the OLD `enabled` value still
    // in `mappings`, so the checkbox visibly snaps back to its pre-click state
    // for the whole round trip before `load()` finally corrects it. Reconciled
    // with the real server state (success or failure alike) via `load()` right
    // after.
    setMappings((prev) => prev?.map((m) => (m.id === mapping.id ? { ...m, enabled: !m.enabled } : m)) ?? prev)
    try {
      await updateAttributeTargetMapping(accessToken, mapping.id, { enabled: !mapping.enabled })
    } catch (cause) {
      setCellError({ cell, message: cause instanceof ApiError ? cause.message : 'Could not update this mapping.' })
    } finally {
      load()
      setBusyCell(null)
    }
  }

  async function handleRemove(mapping: AttributeTargetMappingRow) {
    if (accessToken === undefined) return
    const cell = cellKey(mapping.target, mapping.source, mapping.localKey)
    setBusyCell(cell)
    setCellError(null)
    try {
      await deleteAttributeTargetMapping(accessToken, mapping.id)
      showToast(`Removed the mapping to ${CONNECTOR_TARGET_LABEL[mapping.target]}.`)
      load()
    } catch (cause) {
      setCellError({ cell, message: cause instanceof ApiError ? cause.message : 'Could not remove this mapping.' })
    } finally {
      setBusyCell(null)
    }
  }

  if (loadError !== null) {
    return (
      <div className="error-panel" role="alert">
        <p className="error-panel__message">{loadError}</p>
        <button type="button" className="btn btn--secondary" onClick={() => setRetryToken((t) => t + 1)}>
          Try again
        </button>
      </div>
    )
  }

  if (rows === null || mappings === null) {
    return (
      <div aria-hidden="true">
        <span className="skeleton" style={{ width: '16rem', height: '1rem', display: 'block', marginBottom: 'var(--space-4)' }} />
        <span className="skeleton" style={{ width: '100%', height: '18rem', display: 'block' }} />
      </div>
    )
  }

  return (
    <div className="mapping-editor">
      <p className="mapping-editor__intro">
        Which local field becomes which remote attribute, per target.{' '}
        <strong>An attribute with no cell filled in below never leaves the system for that target</strong> —
        absence of a row is the default, not a switch left off. Nothing propagates until a mapping is created.
      </p>

      <div className="table-wrap">
        <table className="table mapping-editor__table" data-testid="mapping-editor-table">
          <thead>
            <tr>
              <th scope="col">Field</th>
              {ALL_CONNECTOR_TARGETS.map((target) => (
                <th scope="col" key={target}>
                  {CONNECTOR_TARGET_LABEL[target]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.source}:${row.key}`} data-testid="mapping-editor-row">
                <td>
                  <div className="mapping-editor__field-name">{row.label}</div>
                  <div className="cell-muted mono mapping-editor__field-key">{row.key}</div>
                </td>
                {ALL_CONNECTOR_TARGETS.map((target) => {
                  const mapping = findMapping(row, target)
                  const cell = cellKey(target, row.source, row.key)
                  const isAdding = addingCell === cell
                  const isBusy = busyCell === cell
                  const error = cellError?.cell === cell ? cellError.message : null

                  return (
                    <td key={target} data-testid="mapping-editor-cell" data-mapped={mapping !== undefined}>
                      {mapping !== undefined ? (
                        <div className="mapping-editor__mapped">
                          <span className="mono mapping-editor__remote-name">{mapping.remoteName}</span>
                          <label className="mapping-editor__enabled-toggle">
                            <input
                              type="checkbox"
                              checked={mapping.enabled}
                              disabled={!canManage || isBusy}
                              onChange={() => void handleToggle(mapping)}
                              data-testid="mapping-enabled-toggle"
                            />
                            Enabled
                          </label>
                          {canManage && (
                            <button
                              type="button"
                              className="btn btn--ghost mapping-editor__remove"
                              onClick={() => void handleRemove(mapping)}
                              disabled={isBusy}
                              data-testid="mapping-remove-button"
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      ) : isAdding ? (
                        <form
                          className="mapping-editor__add-form"
                          onSubmit={(e) => {
                            e.preventDefault()
                            void handleCreate(row, target)
                          }}
                        >
                          <label className="sr-only" htmlFor={`mapping-add-${cell}`}>
                            Remote name for {row.label} on {CONNECTOR_TARGET_LABEL[target]}
                          </label>
                          <input
                            id={`mapping-add-${cell}`}
                            type="text"
                            className="input mapping-editor__add-input"
                            placeholder="Remote name"
                            value={draftRemoteName}
                            disabled={isBusy}
                            onChange={(e) => setDraftRemoteName(e.target.value)}
                            autoFocus
                            data-testid="mapping-add-input"
                          />
                          <div className="mapping-editor__add-actions">
                            <button
                              type="submit"
                              className="btn btn--primary"
                              disabled={isBusy || draftRemoteName.trim() === ''}
                              data-testid="mapping-add-save"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              className="btn btn--secondary"
                              disabled={isBusy}
                              onClick={() => {
                                setAddingCell(null)
                                setDraftRemoteName('')
                                setCellError(null)
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      ) : (
                        <div className="mapping-editor__unmapped">
                          <span className="cell-muted" data-testid="mapping-unmapped">
                            not mapped
                          </span>
                          {canManage && (
                            <button
                              type="button"
                              className="btn btn--ghost mapping-editor__map-button"
                              onClick={() => {
                                setAddingCell(cell)
                                setDraftRemoteName('')
                                setCellError(null)
                              }}
                              data-testid="mapping-add-button"
                            >
                              Map
                            </button>
                          )}
                        </div>
                      )}
                      {error !== null && (
                        <p className="field__error mapping-editor__cell-error" role="alert">
                          {error}
                        </p>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
