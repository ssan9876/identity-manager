import { useCallback, useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { ApiError } from '../api/client'
import { fetchAttributeDefinitions } from '../attributes/api'
import { useToast } from '../shell/ToastProvider'
import {
  DIRECTORY_TARGETS,
  ALL_CORE_FIELDS,
  CONNECTOR_TARGET_LABEL,
  CORE_FIELD_LABEL,
  createAttributeTargetMapping,
  deleteAttributeTargetMapping,
  fetchAttributeTargetMappings,
  fetchExportImpact,
  updateAttributeTargetMapping,
  type AttributeTargetMappingRow,
  type ConnectorTarget,
  type CoreProfileField,
  type ExportImpact,
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

  /**
   * An enable that is waiting on the admin reading what it costs.
   *
   * Security finding 5: enabling a mapping exports every existing holder's
   * value on their next sync, retroactively, and nothing recalls it. The
   * write is therefore deferred until the count has been on screen and
   * acknowledged — and the acknowledgement is the API's rule, not this
   * component's: it sends the number back and the API re-derives and compares
   * it inside the writing transaction.
   */
  const [pendingExport, setPendingExport] = useState<
    | { cell: string; impact: ExportImpact; label: string; run: (count: number) => Promise<void> }
    | null
  >(null)

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
    const remoteName = draftRemoteName.trim()

    // A new mapping is created ENABLED, so this is an enable — the shortest
    // path to exporting everything, and the one the finding is about.
    const write = async (acknowledgedExportCount?: number) => {
      await createAttributeTargetMapping(accessToken, {
        attributeDefinitionId: row.attributeDefinitionId,
        coreField: row.coreField,
        target,
        remoteName,
        acknowledgedExportCount,
      })
      setAddingCell(null)
      setDraftRemoteName('')
      showToast(`Mapped ${row.label} to ${CONNECTOR_TARGET_LABEL[target]}.`)
    }

    await guardedEnable(cell, row, target, row.label, write, 'Could not create this mapping.')
  }

  /**
   * Reads what an enable would export, and either performs it or parks it
   * behind the confirmation.
   *
   * A population of nobody gets no ceremony: a confirmation that usually says
   * "this affects 0 people" is one admins learn to click through, which would
   * cost more than it buys on the day the number is not zero.
   */
  async function guardedEnable(
    cell: string,
    row: Pick<FieldRow, 'attributeDefinitionId' | 'coreField'>,
    target: ConnectorTarget,
    label: string,
    write: (acknowledgedExportCount?: number) => Promise<void>,
    failureMessage: string,
  ) {
    if (accessToken === undefined) return
    setBusyCell(cell)
    setCellError(null)
    try {
      const impact = await fetchExportImpact(accessToken, {
        target,
        attributeDefinitionId: row.attributeDefinitionId,
        coreField: row.coreField,
      })

      if (impact.holderCount === 0) {
        await write()
        load()
        return
      }

      setPendingExport({
        cell,
        impact,
        label,
        run: async (count: number) => {
          await write(count)
          load()
        },
      })
    } catch (cause) {
      setCellError({ cell, message: cause instanceof ApiError ? cause.message : failureMessage })
    } finally {
      setBusyCell(null)
    }
  }

  /** Sends the number back. A 409 means it moved while the panel was open, and the API's own sentence says so. */
  async function confirmPendingExport() {
    if (pendingExport === null) return
    const { cell, impact, run } = pendingExport
    setBusyCell(cell)
    setCellError(null)
    try {
      await run(impact.holderCount)
      setPendingExport(null)
    } catch (cause) {
      setCellError({
        cell,
        message: cause instanceof ApiError ? cause.message : 'Could not enable this mapping.',
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

  /**
   * Turning a mapping ON is guarded; turning it OFF is not, because disabling
   * reduces exposure. The API applies exactly the same asymmetry, so this is
   * which door the console knocks on, never a second copy of the rule.
   */
  async function handleToggleGuarded(mapping: AttributeTargetMappingRow) {
    if (mapping.enabled) {
      await handleToggle(mapping)
      return
    }

    const cell = cellKey(mapping.target, mapping.source, mapping.localKey)
    await guardedEnable(
      cell,
      {
        attributeDefinitionId: mapping.attributeDefinitionId ?? undefined,
        coreField: mapping.coreField ?? undefined,
      },
      mapping.target,
      mapping.label ?? mapping.localKey,
      async (acknowledgedExportCount) => {
        await updateAttributeTargetMapping(accessToken as string, mapping.id, {
          enabled: true,
          acknowledgedExportCount,
        })
      },
      'Could not update this mapping.',
    )
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

      {pendingExport !== null && (
        <div className="mapping-editor__confirm" role="note" data-testid="mapping-export-confirm">
          <p className="mapping-editor__confirm-lead">
            <strong>
              This exports {pendingExport.impact.holderCount}{' '}
              {pendingExport.impact.holderCount === 1 ? "person's" : "people's"} {pendingExport.label}{' '}
              to {CONNECTOR_TARGET_LABEL[pendingExport.impact.target]}.
            </strong>{' '}
            Values already held are sent on each person&rsquo;s next sync, and nothing recalls them
            afterwards.
          </p>
          {pendingExport.impact.sensitive && (
            <p className="mapping-editor__confirm-sensitive" data-testid="mapping-export-sensitive">
              This attribute is marked <strong>sensitive</strong>: its values are withheld from the
              audit log, so once exported the log cannot show what was sent.
            </p>
          )}
          <div className="mapping-editor__confirm-actions">
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => setPendingExport(null)}
              disabled={busyCell === pendingExport.cell}
              data-testid="mapping-export-cancel"
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void confirmPendingExport()}
              disabled={busyCell === pendingExport.cell}
              data-loading={busyCell === pendingExport.cell ? 'true' : undefined}
              data-testid="mapping-export-confirm-button"
            >
              <span className="btn__label">
                Export {pendingExport.impact.holderCount}{' '}
                {pendingExport.impact.holderCount === 1 ? 'value' : 'values'}
              </span>
              <span className="btn__spinner" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table className="table mapping-editor__table" data-testid="mapping-editor-table">
          <thead>
            <tr>
              <th scope="col">Field</th>
              {DIRECTORY_TARGETS.map((target) => (
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
                {DIRECTORY_TARGETS.map((target) => {
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
                              onChange={() => void handleToggleGuarded(mapping)}
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
