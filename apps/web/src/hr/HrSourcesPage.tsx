import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useAuth } from 'react-oidc-context'
import { ApiError } from '../api/client'
import { Field, fieldDescribedBy } from '../forms/Field'
import { formatDateTime } from '../format'
import { fetchOrganizationsPage, type Organization } from '../organizations/api'
import { useSelfPermissions } from '../shell/permissions'
import { useToast } from '../shell/ToastProvider'
import {
  createHrSource,
  fetchHrSourceRuns,
  fetchHrSources,
  runHrSourcePreview,
  updateHrSource,
  HR_SOURCE_KIND_LABEL,
  type HrJsonFeedConfig,
  type HrJsonPagination,
  type HrRunOutcome,
  type HrSourceKind,
  type HrSourceRunView,
  type HrSourceView,
  type HrSyncReport,
} from './api'
import './HrSources.css'

/**
 * docs/design-system.md: "word + optional shape, never colour alone." Seven
 * outcomes, three treatments: the two refusals and the two failures carry
 * their own words (danger/warn), a clean commit and a preview stay
 * uncoloured like "Active" elsewhere.
 */
const OUTCOME_WORD: Record<HrRunOutcome, string> = {
  fetch_failed: 'Fetch failed',
  preview_failed: 'Preview failed',
  previewed: 'Previewed',
  aborted_failures: 'Aborted: failing rows',
  aborted_blast_radius: 'Aborted: blast radius',
  committed: 'Committed',
  committed_partial: 'Committed (partial)',
}

const OUTCOME_VARIANT: Record<HrRunOutcome, 'neutral' | 'warn' | 'danger'> = {
  fetch_failed: 'danger',
  preview_failed: 'danger',
  previewed: 'neutral',
  aborted_failures: 'warn',
  aborted_blast_radius: 'warn',
  committed: 'neutral',
  committed_partial: 'warn',
}

function OutcomeBadge({ outcome }: { outcome: HrRunOutcome | null }) {
  if (outcome === null) {
    return <span className="badge badge--neutral">Never run</span>
  }
  const variant = OUTCOME_VARIANT[outcome]
  return (
    <span className={`badge badge--${variant}`} data-outcome={outcome}>
      {variant !== 'neutral' && <span className="badge__dot" aria-hidden="true" />}
      {OUTCOME_WORD[outcome]}
    </span>
  )
}

function EnabledBadge({ enabled }: { enabled: boolean }) {
  return (
    <span className={`badge badge--${enabled ? 'neutral' : 'warn'}`} data-enabled={enabled}>
      {!enabled && <span className="badge__dot" aria-hidden="true" />}
      {enabled ? 'Enabled' : 'Disabled'}
    </span>
  )
}

interface MappingRow {
  source: string
  target: string
}

function mappingToRows(mapping: Record<string, string>): MappingRow[] {
  const rows = Object.entries(mapping).map(([source, target]) => ({ source, target }))
  return rows.length > 0 ? rows : [{ source: '', target: '' }]
}

function rowsToMapping(rows: MappingRow[]): Record<string, string> {
  const mapping: Record<string, string> = {}
  for (const row of rows) {
    const source = row.source.trim()
    const target = row.target.trim()
    if (source !== '' && target !== '') mapping[source] = target
  }
  return mapping
}

/**
 * The column mapping editor: one row per feed column that crosses the
 * boundary. Stated plainly in the hint (docs/design-system.md: "state
 * plainly where a value comes from"): unmapped feed columns are DROPPED,
 * so the mapping is the explicit allowlist of what this system ingests.
 */
function MappingEditor({
  idPrefix,
  rows,
  onChange,
}: {
  idPrefix: string
  rows: MappingRow[]
  onChange: (rows: MappingRow[]) => void
}) {
  return (
    <div className="hr-mapping" role="group" aria-label="Column mapping">
      {rows.map((row, index) => (
        <div className="hr-mapping__row" key={index}>
          <input
            id={`${idPrefix}-source-${index}`}
            className="input hr-mapping__input"
            aria-label={`Feed column ${index + 1}`}
            placeholder="Feed column (e.g. EMP_ID)"
            value={row.source}
            onChange={(event) => {
              const next = rows.slice()
              next[index] = { ...row, source: event.target.value }
              onChange(next)
            }}
          />
          <span className="hr-mapping__arrow" aria-hidden="true">
            &rarr;
          </span>
          <input
            id={`${idPrefix}-target-${index}`}
            className="input hr-mapping__input"
            aria-label={`Import column ${index + 1}`}
            placeholder="Import column (e.g. employeeId)"
            value={row.target}
            onChange={(event) => {
              const next = rows.slice()
              next[index] = { ...row, target: event.target.value }
              onChange(next)
            }}
          />
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            aria-label={`Remove mapping row ${index + 1}`}
            onClick={() => onChange(rows.length > 1 ? rows.filter((_, i) => i !== index) : [{ source: '', target: '' }])}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn--secondary btn--sm"
        onClick={() => onChange([...rows, { source: '', target: '' }])}
      >
        Add column
      </button>
    </div>
  )
}

interface SourceDraft {
  name: string
  /** Fixed once created — the API does not accept a kind change, because a stored config validated for one kind is meaningless for the other. */
  kind: HrSourceKind
  url: string
  authHeaderName: string
  authSecretName: string
  mappingRows: MappingRow[]
  enabled: boolean
  blastRadiusThreshold: string
  blastRadiusFloor: string
  // ---- rest_json only. Held as flat strings (the shape an <input> gives
  // back) and assembled into the API's nested, closed-union config by
  // `configFromDraft`; ignored entirely for a csv_url source, which the API
  // requires to carry NO configuration at all.
  recordsPath: string
  paginationMode: HrJsonPagination['mode']
  pageParam: string
  sizeParam: string
  pageSize: string
  nextPath: string
  cursorParam: string
}

const EMPTY_JSON_DRAFT = {
  recordsPath: '',
  paginationMode: 'none' as HrJsonPagination['mode'],
  pageParam: 'page',
  sizeParam: '',
  pageSize: '',
  nextPath: '',
  cursorParam: '',
}

/**
 * Draft -> the API's `config`. Returns `{}` for `csv_url` — the API rejects
 * any key on one rather than accepting a setting that would silently do
 * nothing, so sending the JSON fields "just in case" would be a 400.
 *
 * Blank optional inputs become `null`, not `''`: the server's union types
 * them as nullable strings, and an empty string would be a real (invalid)
 * parameter name rather than "not set".
 */
function configFromDraft(draft: SourceDraft): Record<string, unknown> {
  if (draft.kind !== 'rest_json') return {}

  let pagination: HrJsonPagination
  if (draft.paginationMode === 'page') {
    pagination = {
      mode: 'page',
      pageParam: draft.pageParam.trim(),
      startPage: 1,
      sizeParam: draft.sizeParam.trim() === '' ? null : draft.sizeParam.trim(),
      pageSize: draft.pageSize.trim() === '' ? null : Number(draft.pageSize),
      maxPages: 100,
    }
  } else if (draft.paginationMode === 'cursor') {
    pagination = {
      mode: 'cursor',
      nextPath: draft.nextPath.trim(),
      cursorParam: draft.cursorParam.trim() === '' ? null : draft.cursorParam.trim(),
      maxPages: 100,
    }
  } else {
    pagination = { mode: 'none' }
  }

  return { recordsPath: draft.recordsPath.trim(), pagination } satisfies HrJsonFeedConfig
}

function draftFrom(source: HrSourceView): SourceDraft {
  // `config` is `Record<string, unknown>` over the wire; read it defensively
  // rather than asserting the JSON shape onto a csv_url source's `{}`.
  const config = source.config as Partial<HrJsonFeedConfig>
  const pagination = config.pagination
  return {
    name: source.name,
    kind: source.kind,
    url: source.url,
    authHeaderName: source.authHeaderName ?? '',
    authSecretName: source.authSecretName ?? '',
    mappingRows: mappingToRows(source.columnMapping),
    enabled: source.enabled,
    blastRadiusThreshold: String(source.blastRadiusThreshold),
    blastRadiusFloor: String(source.blastRadiusFloor),
    ...EMPTY_JSON_DRAFT,
    recordsPath: typeof config.recordsPath === 'string' ? config.recordsPath : '',
    paginationMode: pagination?.mode ?? 'none',
    pageParam: pagination?.mode === 'page' ? pagination.pageParam : 'page',
    sizeParam: pagination?.mode === 'page' ? (pagination.sizeParam ?? '') : '',
    pageSize: pagination?.mode === 'page' && pagination.pageSize !== null ? String(pagination.pageSize) : '',
    nextPath: pagination?.mode === 'cursor' ? pagination.nextPath : '',
    cursorParam: pagination?.mode === 'cursor' ? (pagination.cursorParam ?? '') : '',
  }
}

function draftValidationError(draft: SourceDraft): string | null {
  if (draft.name.trim() === '') return 'Name is required.'
  if (!draft.url.trim().startsWith('https://')) return 'The feed URL must start with https:// — a plain-HTTP feed would carry people data in cleartext.'
  const hasHeader = draft.authHeaderName.trim() !== ''
  const hasSecret = draft.authSecretName.trim() !== ''
  if (hasHeader !== hasSecret) return 'Auth header name and secret name go together — set both, or neither.'
  if (hasSecret && !/^CONNECTOR_[A-Za-z0-9_]+$/.test(draft.authSecretName.trim())) {
    return 'The secret name must name a CONNECTOR_* environment variable (e.g. CONNECTOR_HR_FEED_TOKEN).'
  }
  if (draft.kind === 'rest_json') {
    if (draft.paginationMode === 'page' && draft.pageParam.trim() === '') {
      return 'Page pagination needs the name of the page-number query parameter.'
    }
    if (draft.paginationMode === 'cursor' && draft.nextPath.trim() === '') {
      return 'Cursor pagination needs the path to the next-page field in the response.'
    }
    if (draft.pageSize.trim() !== '' && draft.sizeParam.trim() === '') {
      return 'A page size needs the name of the page-size query parameter to send it in.'
    }
  }
  const threshold = Number(draft.blastRadiusThreshold)
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100) {
    return 'Blast-radius threshold must be a whole number between 1 and 100.'
  }
  const floor = Number(draft.blastRadiusFloor)
  if (!Number.isInteger(floor) || floor < 0) return 'Blast-radius floor must be zero or a positive whole number.'
  return null
}

function PreviewResult({ report }: { report: HrSyncReport }) {
  return (
    <div className="hr-preview" data-testid="hr-preview-result">
      <div className="hr-preview__summary">
        <OutcomeBadge outcome={report.outcome} />
        {report.preview !== null && (
          <p>
            {report.preview.summary.total} row(s): {report.preview.summary.toCreate} to create,{' '}
            {report.preview.summary.toUpdate} to update, {report.preview.summary.failed} failing.
          </p>
        )}
        {report.blastRadius !== null && (
          <p className="cell-muted">
            Blast radius: {report.blastRadius.changedCount} update(s) against {report.blastRadius.populationSize}{' '}
            existing people (threshold {report.blastRadius.thresholdPercent}%, floor {report.blastRadius.floor})
            {report.blastRadius.tripped ? ' — would refuse to commit.' : '.'}
          </p>
        )}
        {report.reasons.map((reason, i) => (
          <p key={i} className="hr-preview__reason">
            {reason}
          </p>
        ))}
      </div>
      {report.preview !== null && report.preview.failures.length > 0 && (
        <div className="table-wrap">
          <table className="table" data-testid="hr-preview-failures">
            <thead>
              <tr>
                <th scope="col">Row</th>
                <th scope="col">Employee ID</th>
                <th scope="col">Why it fails</th>
              </tr>
            </thead>
            <tbody>
              {report.preview.failures.map((failure) => (
                <tr key={failure.row}>
                  <td>{failure.row}</td>
                  <td className="mono cell-muted">{failure.employeeId ?? '—'}</td>
                  <td>
                    <ul className="hr-preview__reasons">
                      {failure.reasons.map((reason, i) => (
                        <li key={i}>{reason}</li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function RunsTable({ runs }: { runs: HrSourceRunView[] }) {
  if (runs.length === 0) {
    return <p className="cell-muted">This source has never run.</p>
  }
  return (
    <div className="table-wrap">
      <table className="table" data-testid="hr-runs-table">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Outcome</th>
            <th scope="col">Counts</th>
            <th scope="col">Batch</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run, index) => {
            const detail = run.detail ?? {}
            const outcome = typeof detail.outcome === 'string' ? (detail.outcome as HrRunOutcome) : null
            const counts = ['toCreate', 'toUpdate', 'failed', 'created', 'updated', 'unchanged']
              .filter((key) => typeof detail[key] === 'number')
              .map((key) => `${key}: ${String(detail[key])}`)
              .join(', ')
            return (
              <tr key={index}>
                <td className="cell-muted">{formatDateTime(run.at)}</td>
                <td>
                  <OutcomeBadge outcome={outcome} />
                </td>
                <td className="cell-muted">{counts || '—'}</td>
                <td className="mono cell-muted">{run.batchId ?? '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * `/hr-sources` — the HR inbound feed console. Follows the connectors
 * pages' structure (list with status badges; per-source configuration form;
 * a preview-results table shaped like ImportPage's own). Visibility is
 * gated on `connector:read`, every mutating control on `connector:manage`
 * — and the API additionally requires that grant to be GLOBAL.
 *
 * Stated plainly, per docs/design-system.md and decision 4: the feed
 * credential is never stored or shown here. A source names the HEADER to
 * send and the CONNECTOR_* ENVIRONMENT VARIABLE the API host resolves at
 * fetch time; the secret-name input is a plain text input naming a
 * variable, not a masked credential box.
 *
 * Commits deliberately have no button here: a sync that WRITES people runs
 * through the `hr:sync` CLI (`--commit`), where dry-run is the default and
 * the operator owns the cadence — this page fetches, previews and reports.
 */

/**
 * The `rest_json` settings block, shared by the create and edit forms so the
 * two cannot drift. Renders nothing for a `csv_url` source, which takes no
 * configuration at all.
 *
 * `recordsPath` and the field paths are dot-paths into the response, matching
 * the server's own `readPath` (apps/api/src/hr/hr-fetch.ts). The column
 * mapping's SOURCE column is such a path for this kind — the hint says so
 * rather than leaving an operator to infer it from a CSV-shaped label.
 */
function JsonFeedFields({
  idPrefix,
  draft,
  onChange,
}: {
  idPrefix: string
  draft: SourceDraft
  onChange: (next: SourceDraft) => void
}) {
  if (draft.kind !== 'rest_json') return null

  const recordsHint = 'Dot-path to the array of people in the response, e.g. data.items. Leave blank if the response is itself an array.'

  return (
    <>
      <Field id={`${idPrefix}-records-path`} label="Records path" hint={recordsHint}>
        <input
          id={`${idPrefix}-records-path`}
          className="input"
          aria-describedby={fieldDescribedBy(`${idPrefix}-records-path`, null, recordsHint)}
          value={draft.recordsPath}
          onChange={(event) => onChange({ ...draft, recordsPath: event.target.value })}
        />
      </Field>
      <Field id={`${idPrefix}-pagination-mode`} label="Pagination">
        <select
          id={`${idPrefix}-pagination-mode`}
          className="input"
          value={draft.paginationMode}
          onChange={(event) =>
            onChange({ ...draft, paginationMode: event.target.value as HrJsonPagination['mode'] })
          }
        >
          <option value="none">None — one request</option>
          <option value="page">Page number</option>
          <option value="cursor">Cursor / next link</option>
        </select>
      </Field>
      {draft.paginationMode === 'page' && (
        <>
          <Field id={`${idPrefix}-page-param`} label="Page parameter" required>
            <input
              id={`${idPrefix}-page-param`}
              className="input"
              value={draft.pageParam}
              onChange={(event) => onChange({ ...draft, pageParam: event.target.value })}
            />
          </Field>
          <Field id={`${idPrefix}-size-param`} label="Page-size parameter">
            <input
              id={`${idPrefix}-size-param`}
              className="input"
              value={draft.sizeParam}
              onChange={(event) => onChange({ ...draft, sizeParam: event.target.value })}
            />
          </Field>
          <Field id={`${idPrefix}-page-size`} label="Page size">
            <input
              id={`${idPrefix}-page-size`}
              className="input"
              inputMode="numeric"
              value={draft.pageSize}
              onChange={(event) => onChange({ ...draft, pageSize: event.target.value })}
            />
          </Field>
        </>
      )}
      {draft.paginationMode === 'cursor' && (
        <>
          <Field
            id={`${idPrefix}-next-path`}
            label="Next-page path"
            required
            hint="Dot-path to the field naming the next page, e.g. meta.next."
          >
            <input
              id={`${idPrefix}-next-path`}
              className="input"
              aria-describedby={fieldDescribedBy(
                `${idPrefix}-next-path`,
                null,
                'Dot-path to the field naming the next page, e.g. meta.next.',
              )}
              value={draft.nextPath}
              onChange={(event) => onChange({ ...draft, nextPath: event.target.value })}
            />
          </Field>
          <Field
            id={`${idPrefix}-cursor-param`}
            label="Cursor parameter"
            hint="Leave blank if the next-page field is a whole URL rather than a token."
          >
            <input
              id={`${idPrefix}-cursor-param`}
              className="input"
              aria-describedby={fieldDescribedBy(
                `${idPrefix}-cursor-param`,
                null,
                'Leave blank if the next-page field is a whole URL rather than a token.',
              )}
              value={draft.cursorParam}
              onChange={(event) => onChange({ ...draft, cursorParam: event.target.value })}
            />
          </Field>
        </>
      )}
    </>
  )
}

export default function HrSourcesPage() {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const permissions = useSelfPermissions()
  const { showToast } = useToast()

  const canRead = permissions.status === 'ready' && permissions.actions.has('connector:read')
  const canManage = permissions.status === 'ready' && permissions.actions.has('connector:manage')

  const [sources, setSources] = useState<HrSourceView[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [organizationsList, setOrganizationsList] = useState<Organization[]>([])

  const [showCreate, setShowCreate] = useState(false)
  const [createDraft, setCreateDraft] = useState<SourceDraft>({
    name: '',
    kind: 'csv_url',
    url: '',
    authHeaderName: '',
    authSecretName: '',
    mappingRows: [{ source: '', target: '' }],
    enabled: false,
    blastRadiusThreshold: '20',
    blastRadiusFloor: '5',
    ...EMPTY_JSON_DRAFT,
  })
  const [createOrganizationId, setCreateOrganizationId] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const [editDraft, setEditDraft] = useState<SourceDraft | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const [previewReport, setPreviewReport] = useState<HrSyncReport | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)

  const [runs, setRuns] = useState<HrSourceRunView[] | null>(null)

  const reload = useCallback(() => {
    if (accessToken === undefined || !canRead) return
    fetchHrSources(accessToken)
      .then((res) => {
        setSources(res)
        setLoadError(null)
      })
      .catch((cause: unknown) => {
        setLoadError(cause instanceof ApiError ? cause.message : 'Check your connection and try again.')
      })
  }, [accessToken, canRead])

  useEffect(reload, [reload])

  useEffect(() => {
    if (accessToken === undefined || !canManage) return
    fetchOrganizationsPage(accessToken, { limit: 100, offset: 0 })
      .then((page) => setOrganizationsList(page.items))
      .catch(() => setOrganizationsList([]))
  }, [accessToken, canManage])

  const selected = sources?.find((source) => source.id === selectedId) ?? null

  useEffect(() => {
    setEditDraft(selected !== null ? draftFrom(selected) : null)
    setEditError(null)
    setPreviewReport(null)
    setPreviewError(null)
    setRuns(null)
    if (selected !== null && accessToken !== undefined) {
      fetchHrSourceRuns(accessToken, selected.id)
        .then(setRuns)
        .catch(() => setRuns(null))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, accessToken])

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    if (accessToken === undefined) return
    const validation =
      createOrganizationId === '' ? 'Pick the organization this feed belongs to.' : draftValidationError(createDraft)
    if (validation !== null) {
      setCreateError(validation)
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      const auth =
        createDraft.authHeaderName.trim() !== ''
          ? { headerName: createDraft.authHeaderName.trim(), secretName: createDraft.authSecretName.trim() }
          : null
      const created = await createHrSource(accessToken, {
        organizationId: createOrganizationId,
        name: createDraft.name.trim(),
        kind: createDraft.kind,
        url: createDraft.url.trim(),
        auth,
        columnMapping: rowsToMapping(createDraft.mappingRows),
        config: configFromDraft(createDraft),
      })
      showToast(`Created HR source "${created.name}". It starts disabled — preview it, then enable.`)
      setShowCreate(false)
      setCreateDraft({
        name: '',
        kind: 'csv_url',
        url: '',
        authHeaderName: '',
        authSecretName: '',
        mappingRows: [{ source: '', target: '' }],
        enabled: false,
        blastRadiusThreshold: '20',
        blastRadiusFloor: '5',
        ...EMPTY_JSON_DRAFT,
      })
      reload()
      setSelectedId(created.id)
    } catch (cause) {
      setCreateError(cause instanceof ApiError ? cause.message : 'Could not create this source. Try again.')
    } finally {
      setCreating(false)
    }
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault()
    if (accessToken === undefined || selected === null || editDraft === null) return
    const validation = draftValidationError(editDraft)
    if (validation !== null) {
      setEditError(validation)
      return
    }
    setSaving(true)
    setEditError(null)
    try {
      const auth =
        editDraft.authHeaderName.trim() !== ''
          ? { headerName: editDraft.authHeaderName.trim(), secretName: editDraft.authSecretName.trim() }
          : null
      await updateHrSource(accessToken, selected.id, {
        name: editDraft.name.trim(),
        url: editDraft.url.trim(),
        auth,
        columnMapping: rowsToMapping(editDraft.mappingRows),
        config: configFromDraft(editDraft),
        enabled: editDraft.enabled,
        blastRadiusThreshold: Number(editDraft.blastRadiusThreshold),
        blastRadiusFloor: Number(editDraft.blastRadiusFloor),
      })
      showToast(`Saved "${editDraft.name.trim()}".`)
      reload()
    } catch (cause) {
      setEditError(cause instanceof ApiError ? cause.message : 'Could not save this source. Try again.')
    } finally {
      setSaving(false)
    }
  }

  async function handlePreview() {
    if (accessToken === undefined || selected === null) return
    setPreviewing(true)
    setPreviewError(null)
    setPreviewReport(null)
    try {
      const report = await runHrSourcePreview(accessToken, selected.id)
      setPreviewReport(report)
      reload()
      fetchHrSourceRuns(accessToken, selected.id)
        .then(setRuns)
        .catch(() => undefined)
    } catch (cause) {
      setPreviewError(
        cause instanceof ApiError
          ? cause.message
          : 'Could not run the preview. Check the feed URL and your connection, then try again.',
      )
      reload()
    } finally {
      setPreviewing(false)
    }
  }

  if (permissions.status === 'ready' && !canRead) {
    return (
      <div className="page">
        <header className="page-header">
          <div className="page-header__text">
            <h1>HR sources</h1>
          </div>
        </header>
        <p className="cell-muted">
          You don&rsquo;t have access to HR sources — this area needs the connector-read permission.
        </p>
      </div>
    )
  }

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header__text">
          <h1>HR sources</h1>
          <p className="page-header__subtitle">
            Pull-based feeds this system fetches from an HR system and runs through the same
            preview-then-commit import pipeline as a CSV upload. Nothing pushes in; commits run
            through the <span className="mono">hr:sync</span> CLI.
          </p>
        </div>
        {canManage && (
          <div className="page__actions">
            <button type="button" className="btn btn--primary" onClick={() => setShowCreate((v) => !v)}>
              {showCreate ? 'Close' : 'New HR source'}
            </button>
          </div>
        )}
      </header>

      {loadError !== null && (
        <div className="error-panel" role="alert">
          <p className="error-panel__message">Could not load HR sources: {loadError}</p>
          <button type="button" className="btn btn--secondary" onClick={reload}>
            Try again
          </button>
        </div>
      )}

      {showCreate && canManage && (
        <section className="panel hr-panel" aria-label="New HR source">
          <div className="panel__body">
            <p className="hr-secret-note" role="note" data-testid="hr-secret-note">
              The feed credential is never stored or shown here. Name the HTTP header to send and the
              CONNECTOR_* environment variable set on the API host; the value is resolved there at
              fetch time.
            </p>
            <form onSubmit={(e) => void handleCreate(e)}>
              <Field id="hr-new-org" label="Organization" required>
                <select
                  id="hr-new-org"
                  className="input"
                  value={createOrganizationId}
                  onChange={(event) => setCreateOrganizationId(event.target.value)}
                >
                  <option value="">Choose…</option>
                  {organizationsList.map((organization) => (
                    <option key={organization.id} value={organization.id}>
                      {organization.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="hr-new-name" label="Name" required>
                <input
                  id="hr-new-name"
                  className="input"
                  value={createDraft.name}
                  onChange={(event) => setCreateDraft({ ...createDraft, name: event.target.value })}
                />
              </Field>
              <Field
                id="hr-new-kind"
                label="Kind"
                hint="Fixed once created — a stored configuration validated for one kind means nothing for the other."
              >
                <select
                  id="hr-new-kind"
                  className="input"
                  aria-describedby={fieldDescribedBy(
                    'hr-new-kind',
                    null,
                    'Fixed once created — a stored configuration validated for one kind means nothing for the other.',
                  )}
                  value={createDraft.kind}
                  onChange={(event) =>
                    setCreateDraft({ ...createDraft, kind: event.target.value as HrSourceKind })
                  }
                >
                  {(Object.keys(HR_SOURCE_KIND_LABEL) as HrSourceKind[]).map((kind) => (
                    <option key={kind} value={kind}>
                      {HR_SOURCE_KIND_LABEL[kind]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                id="hr-new-url"
                label="Feed URL"
                required
                hint={createDraft.kind === 'rest_json' ? 'An https:// URL serving JSON.' : 'An https:// URL serving CSV.'}
              >
                <input
                  id="hr-new-url"
                  className="input"
                  aria-describedby={fieldDescribedBy(
                    'hr-new-url',
                    null,
                    createDraft.kind === 'rest_json' ? 'An https:// URL serving JSON.' : 'An https:// URL serving CSV.',
                  )}
                  value={createDraft.url}
                  onChange={(event) => setCreateDraft({ ...createDraft, url: event.target.value })}
                />
              </Field>
              <JsonFeedFields idPrefix="hr-new" draft={createDraft} onChange={setCreateDraft} />
              <Field id="hr-new-auth-header" label="Auth header name" hint="e.g. Authorization. Leave both blank for an unauthenticated feed.">
                <input
                  id="hr-new-auth-header"
                  className="input"
                  value={createDraft.authHeaderName}
                  onChange={(event) => setCreateDraft({ ...createDraft, authHeaderName: event.target.value })}
                />
              </Field>
              <Field id="hr-new-auth-secret" label="Secret name" hint="The CONNECTOR_* environment variable holding the credential — a reference, not the value.">
                <input
                  id="hr-new-auth-secret"
                  className="input"
                  value={createDraft.authSecretName}
                  onChange={(event) => setCreateDraft({ ...createDraft, authSecretName: event.target.value })}
                />
              </Field>
              <Field
                id="hr-new-mapping"
                label="Column mapping"
                hint="Feed columns become import columns. Unmapped feed columns are dropped — this list is the allowlist of what crosses into the directory."
              >
                <MappingEditor
                  idPrefix="hr-new-mapping"
                  rows={createDraft.mappingRows}
                  onChange={(rows) => setCreateDraft({ ...createDraft, mappingRows: rows })}
                />
              </Field>
              {createError !== null && (
                <p className="field__error" role="alert">
                  {createError}
                </p>
              )}
              <div className="hr-form__actions">
                <button type="submit" className="btn btn--primary" disabled={creating}>
                  {creating ? 'Creating…' : 'Create source'}
                </button>
              </div>
            </form>
          </div>
        </section>
      )}

      <div className="table-wrap">
        <table className="table" data-testid="hr-sources-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Status</th>
              <th scope="col">Last run</th>
              <th scope="col">Finished</th>
            </tr>
          </thead>
          <tbody>
            {sources === null ? (
              <tr>
                <td colSpan={4} className="cell-muted">
                  Loading…
                </td>
              </tr>
            ) : sources.length === 0 ? (
              <tr>
                <td colSpan={4} className="cell-muted">
                  No HR sources yet.{canManage ? ' Create one to pull an HR feed into the directory.' : ''}
                </td>
              </tr>
            ) : (
              sources.map((source) => (
                <tr key={source.id} data-testid="hr-source-row">
                  <td>
                    <button
                      type="button"
                      className="row-link hr-source-link"
                      onClick={() => setSelectedId(source.id === selectedId ? null : source.id)}
                      aria-expanded={source.id === selectedId}
                    >
                      {source.name}
                    </button>
                  </td>
                  <td>
                    <EnabledBadge enabled={source.enabled} />
                  </td>
                  <td>
                    <OutcomeBadge outcome={source.lastRunOutcome} />
                  </td>
                  <td className="cell-muted">
                    {source.lastRunFinishedAt !== null
                      ? formatDateTime(source.lastRunFinishedAt)
                      : source.lastRunStartedAt !== null
                        ? `Started ${formatDateTime(source.lastRunStartedAt)} — never finished`
                        : '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {selected !== null && editDraft !== null && (
        <section className="panel hr-panel" aria-label={`HR source ${selected.name}`}>
          <div className="panel__body">
            <div className="hr-detail__header">
              <h2>{selected.name}</h2>
              <div className="hr-detail__actions">
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => void handlePreview()}
                  disabled={!canManage || previewing}
                  data-testid="hr-run-preview"
                >
                  {previewing ? 'Running preview…' : 'Run preview now'}
                </button>
              </div>
            </div>

            {previewError !== null && (
              <div className="error-panel" role="alert">
                <p className="error-panel__message">{previewError}</p>
              </div>
            )}
            {previewReport !== null && <PreviewResult report={previewReport} />}

            <h3>Configuration</h3>
            <form onSubmit={(e) => void handleSave(e)}>
              <Field id="hr-edit-name" label="Name" required>
                <input
                  id="hr-edit-name"
                  className="input"
                  value={editDraft.name}
                  disabled={!canManage}
                  onChange={(event) => setEditDraft({ ...editDraft, name: event.target.value })}
                />
              </Field>
              <Field id="hr-edit-kind" label="Kind">
                <input id="hr-edit-kind" className="input" value={HR_SOURCE_KIND_LABEL[editDraft.kind]} readOnly disabled />
              </Field>
              <Field id="hr-edit-url" label="Feed URL" required>
                <input
                  id="hr-edit-url"
                  className="input"
                  value={editDraft.url}
                  disabled={!canManage}
                  onChange={(event) => setEditDraft({ ...editDraft, url: event.target.value })}
                />
              </Field>
              <JsonFeedFields idPrefix="hr-edit" draft={editDraft} onChange={setEditDraft} />
              <Field id="hr-edit-auth-header" label="Auth header name">
                <input
                  id="hr-edit-auth-header"
                  className="input"
                  value={editDraft.authHeaderName}
                  disabled={!canManage}
                  onChange={(event) => setEditDraft({ ...editDraft, authHeaderName: event.target.value })}
                />
              </Field>
              <Field id="hr-edit-auth-secret" label="Secret name" hint="A CONNECTOR_* environment variable on the API host — a reference, never the credential itself.">
                <input
                  id="hr-edit-auth-secret"
                  className="input"
                  value={editDraft.authSecretName}
                  disabled={!canManage}
                  onChange={(event) => setEditDraft({ ...editDraft, authSecretName: event.target.value })}
                />
              </Field>
              <Field id="hr-edit-mapping" label="Column mapping">
                <MappingEditor
                  idPrefix="hr-edit-mapping"
                  rows={editDraft.mappingRows}
                  onChange={(rows) => setEditDraft({ ...editDraft, mappingRows: rows })}
                />
              </Field>
              <Field
                id="hr-edit-enabled"
                label="Enabled"
                hint="A disabled source can still be previewed, but refuses to commit. There is no delete — disable instead."
              >
                <input
                  id="hr-edit-enabled"
                  type="checkbox"
                  checked={editDraft.enabled}
                  disabled={!canManage}
                  onChange={(event) => setEditDraft({ ...editDraft, enabled: event.target.checked })}
                />
              </Field>
              <Field
                id="hr-edit-threshold"
                label="Blast-radius threshold (%)"
                hint="A commit that would update more than this percentage of existing people — and more than the floor — is refused."
              >
                <input
                  id="hr-edit-threshold"
                  className="input hr-input--narrow"
                  inputMode="numeric"
                  value={editDraft.blastRadiusThreshold}
                  disabled={!canManage}
                  onChange={(event) => setEditDraft({ ...editDraft, blastRadiusThreshold: event.target.value })}
                />
              </Field>
              <Field id="hr-edit-floor" label="Blast-radius floor">
                <input
                  id="hr-edit-floor"
                  className="input hr-input--narrow"
                  inputMode="numeric"
                  value={editDraft.blastRadiusFloor}
                  disabled={!canManage}
                  onChange={(event) => setEditDraft({ ...editDraft, blastRadiusFloor: event.target.value })}
                />
              </Field>
              {editError !== null && (
                <p className="field__error" role="alert">
                  {editError}
                </p>
              )}
              {canManage && (
                <div className="hr-form__actions">
                  <button type="submit" className="btn btn--primary" disabled={saving}>
                    {saving ? 'Saving…' : 'Save configuration'}
                  </button>
                </div>
              )}
            </form>

            <h3>Run history</h3>
            {runs === null ? <p className="cell-muted">Loading…</p> : <RunsTable runs={runs} />}
          </div>
        </section>
      )}
    </div>
  )
}
