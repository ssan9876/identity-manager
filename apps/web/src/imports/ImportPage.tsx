import { useRef, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link } from 'react-router-dom'
import { ApiError } from '../api/client'
import { useSelfPermissions } from '../shell/permissions'
import { useToast } from '../shell/ToastProvider'
import {
  commitImport,
  estimateDataRowCount,
  IMPORT_MAX_ROWS,
  MAX_CSV_FILE_BYTES,
  OPTIONAL_CSV_COLUMNS,
  previewImport,
  REQUIRED_CSV_COLUMNS,
  type ImportCommitResponse,
  type ImportPreviewResponse,
  type ImportRowFailure,
} from './api'
import './ImportPage.css'

interface ChosenFile {
  name: string
  sizeBytes: number
  csvText: string
  rowEstimate: number
}

type PreviewPhase =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; result: ImportPreviewResponse }

type CommitPhase =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; result: ImportCommitResponse }

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

function FailuresTable({ failures, testId }: { failures: ImportRowFailure[]; testId: string }) {
  if (failures.length === 0) {
    return <p className="cell-muted">None.</p>
  }
  return (
    <div className="table-wrap">
      <table className="table" data-testid={testId}>
        <thead>
          <tr>
            <th scope="col">Row</th>
            <th scope="col">Employee ID</th>
            <th scope="col">Why it will fail</th>
          </tr>
        </thead>
        <tbody>
          {failures.map((failure) => (
            <tr key={failure.row} data-testid={`${testId}-row`}>
              <td>{failure.row}</td>
              <td className="mono cell-muted">{failure.employeeId ?? '—'}</td>
              <td>
                <ul className="import-page__reasons">
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
  )
}

/**
 * `/import` — Milestone 8, Task 5. Upload a CSV, run `POST /imports/preview`
 * (writes nothing about a user — see imports/api.ts's own doc comment),
 * review the diff as three clear groups, then COMMIT as a separate,
 * deliberate click (task-5-brief.md: "Committing is a separate, deliberate
 * action — never automatic after preview"). The preview is the safety rail
 * ("Never lose an import," docs/product-brief.md #4) — the banner above the diff and
 * the fact that nothing here auto-advances to commit are what make that
 * legible rather than merely true.
 */
export default function ImportPage() {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const permissions = useSelfPermissions()
  const { showToast } = useToast()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const canImport = permissions.status === 'ready' && permissions.actions.has('user:create')

  const [file, setFile] = useState<ChosenFile | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewPhase>({ status: 'idle' })
  const [commit, setCommit] = useState<CommitPhase>({ status: 'idle' })

  async function handleFileSelected(selected: File | undefined) {
    setFile(null)
    setFileError(null)
    setPreview({ status: 'idle' })
    setCommit({ status: 'idle' })
    if (selected === undefined) return

    if (selected.size > MAX_CSV_FILE_BYTES) {
      setFileError(
        `This file is ${formatBytes(selected.size)} — the maximum per import is ${formatBytes(MAX_CSV_FILE_BYTES)}. Split it into smaller files and import each separately.`,
      )
      return
    }

    const text = await selected.text()
    const rowEstimate = estimateDataRowCount(text)
    if (rowEstimate > IMPORT_MAX_ROWS) {
      setFileError(
        `This file has approximately ${rowEstimate.toLocaleString()} data rows — the maximum per import is ${IMPORT_MAX_ROWS.toLocaleString()}. Split it into smaller files and import each separately.`,
      )
      return
    }

    setFile({ name: selected.name, sizeBytes: selected.size, csvText: text, rowEstimate })
  }

  async function handlePreview() {
    if (file === null || accessToken === undefined) return
    setPreview({ status: 'loading' })
    setCommit({ status: 'idle' })
    try {
      const result = await previewImport(accessToken, file.csvText)
      setPreview({ status: 'ready', result })
    } catch (cause) {
      setPreview({
        status: 'error',
        message:
          cause instanceof ApiError ? cause.message : 'Could not preview this file. Check your connection and try again.',
      })
    }
  }

  async function handleCommit() {
    if (file === null || accessToken === undefined || preview.status !== 'ready') return
    setCommit({ status: 'loading' })
    try {
      const result = await commitImport(accessToken, file.csvText)
      setCommit({ status: 'done', result })
      const parts = [`created ${result.created}`, `updated ${result.updated}`]
      if (result.unchanged > 0) parts.push(`${result.unchanged} unchanged`)
      if (result.failed > 0) parts.push(`${result.failed} failed`)
      showToast(`Committed import batch ${result.batchId.slice(0, 8)}… — ${parts.join(', ')}.`, result.failed > 0 ? 'warn' : 'neutral')
    } catch (cause) {
      setCommit({
        status: 'error',
        message:
          cause instanceof ApiError ? cause.message : 'Could not commit this import. Check your connection and try again.',
      })
    }
  }

  function startOver() {
    setFile(null)
    setFileError(null)
    setPreview({ status: 'idle' })
    setCommit({ status: 'idle' })
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  if (permissions.status === 'loading') {
    return (
      <div className="import-page" aria-hidden="true">
        <span className="skeleton" style={{ width: '10rem', height: '1.5rem' }} />
        <span className="skeleton" style={{ width: '100%', height: '8rem', marginTop: 'var(--space-5)' }} />
      </div>
    )
  }

  if (!canImport) {
    return (
      <div className="import-page">
        <h1 className="text-title">Import</h1>
        <p className="cell-muted" data-testid="import-permission-note">
          You don&rsquo;t hold the user:create permission, so bulk import isn&rsquo;t available to you. Ask an
          administrator if you need this.
        </p>
      </div>
    )
  }

  const showUploadForm = commit.status !== 'done'

  return (
    <div className="import-page">
      <h1 className="text-title">Import</h1>
      <p className="import-page__intro">
        Bring people into the directory from a CSV file. Every upload runs as a preview first — nothing is
        written until you review the diff below and commit it deliberately.
      </p>

      {showUploadForm && (
        <>
          <div className="import-page__format" data-testid="import-format-help">
            <h2 className="text-title">CSV format</h2>
            <p>
              <strong>Required columns:</strong>{' '}
              <span className="mono">{REQUIRED_CSV_COLUMNS.join(', ')}</span>
            </p>
            <p>
              <strong>Optional columns:</strong>{' '}
              <span className="mono">{OPTIONAL_CSV_COLUMNS.join(', ')}</span>
            </p>
            <p>
              Any other column becomes a custom attribute. Rows are matched to existing people by{' '}
              <span className="mono">employeeId</span> — a match updates that person, otherwise a new person is
              created. Up to {IMPORT_MAX_ROWS.toLocaleString()} data rows and {formatBytes(MAX_CSV_FILE_BYTES)} per
              file.
            </p>
          </div>

          <div className="import-page__upload">
            <div className="field">
              <label className="field__label" htmlFor="import-file-input">
                CSV file
              </label>
              <input
                ref={fileInputRef}
                id="import-file-input"
                type="file"
                accept=".csv,text/csv"
                className="file-input"
                data-testid="import-file-input"
                onChange={(e) => void handleFileSelected(e.target.files?.[0])}
              />
            </div>

            {fileError !== null && (
              <p className="error-panel__message" role="alert" data-testid="import-file-error">
                {fileError}
              </p>
            )}

            {file !== null && fileError === null && (
              <div className="import-page__chosen-file" data-testid="import-chosen-file">
                <p>
                  <span className="mono">{file.name}</span> — {file.rowEstimate.toLocaleString()} data row
                  {file.rowEstimate === 1 ? '' : 's'} (approx.), {formatBytes(file.sizeBytes)}
                </p>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void handlePreview()}
                  disabled={preview.status === 'loading'}
                  data-loading={preview.status === 'loading' ? 'true' : undefined}
                  data-testid="import-preview-button"
                >
                  <span className="btn__label">Preview import</span>
                  <span className="btn__spinner" aria-hidden="true" />
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {preview.status === 'error' && (
        <div className="error-panel" role="alert">
          <p className="error-panel__message">{preview.message}</p>
          <button type="button" className="btn btn--secondary" onClick={() => void handlePreview()}>
            Try again
          </button>
        </div>
      )}

      {preview.status === 'ready' && commit.status !== 'done' && (
        <div className="import-page__preview" data-testid="import-preview-results">
          <p className="import-page__safety-note" role="note" data-testid="import-safety-note">
            <strong>This is a preview only.</strong> Nothing has been written to the directory yet — review the
            rows below, then commit when you&rsquo;re ready.
          </p>

          <section className="import-page__group">
            <h3 className="text-title">Will create ({preview.result.summary.toCreate})</h3>
            {preview.result.toCreate.length === 0 ? (
              <p className="cell-muted">None.</p>
            ) : (
              <div className="table-wrap">
                <table className="table" data-testid="import-create-table">
                  <thead>
                    <tr>
                      <th scope="col">Row</th>
                      <th scope="col">Employee ID</th>
                      <th scope="col">Name / email</th>
                      <th scope="col">Username</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.result.toCreate.map((row) => (
                      <tr key={row.row} data-testid="import-create-row">
                        <td>{row.row}</td>
                        <td className="mono cell-muted">{row.employeeId}</td>
                        <td>{row.primaryEmail}</td>
                        <td className="cell-muted">{row.username}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="import-page__group">
            <h3 className="text-title">Will update ({preview.result.summary.toUpdate})</h3>
            {preview.result.toUpdate.length === 0 ? (
              <p className="cell-muted">None.</p>
            ) : (
              <div className="table-wrap">
                <table className="table" data-testid="import-update-table">
                  <thead>
                    <tr>
                      <th scope="col">Row</th>
                      <th scope="col">Employee ID</th>
                      <th scope="col">Existing person</th>
                      <th scope="col">Username</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.result.toUpdate.map((row) => (
                      <tr key={row.row} data-testid="import-update-row">
                        <td>{row.row}</td>
                        <td className="mono cell-muted">{row.employeeId}</td>
                        <td>
                          <Link to={`/people/${row.userId}`} className="row-link">
                            {row.primaryEmail}
                          </Link>
                        </td>
                        <td className="cell-muted">{row.username}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="import-page__group">
            <h3 className="text-title">Will fail ({preview.result.summary.failed})</h3>
            <FailuresTable failures={preview.result.failures} testId="import-preview-failures" />
          </section>

          <div className="import-page__commit-bar">
            {preview.result.summary.toCreate === 0 && preview.result.summary.toUpdate === 0 ? (
              <p className="cell-muted">
                Nothing to commit — every row failed. Fix the issues above and choose the file again.
              </p>
            ) : (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void handleCommit()}
                disabled={commit.status === 'loading'}
                data-loading={commit.status === 'loading' ? 'true' : undefined}
                data-testid="import-commit-button"
              >
                <span className="btn__label">
                  Commit import — create {preview.result.summary.toCreate}, update{' '}
                  {preview.result.summary.toUpdate}
                </span>
                <span className="btn__spinner" aria-hidden="true" />
              </button>
            )}
            <button type="button" className="btn btn--secondary" onClick={startOver} disabled={commit.status === 'loading'}>
              Choose a different file
            </button>
          </div>

          {commit.status === 'error' && (
            <div className="error-panel" role="alert">
              <p className="error-panel__message">{commit.message}</p>
              <button type="button" className="btn btn--secondary" onClick={() => void handleCommit()}>
                Try again
              </button>
            </div>
          )}
        </div>
      )}

      {commit.status === 'done' && (
        <div className="import-page__result" data-testid="import-commit-result">
          <h2 className="text-title">Import committed</h2>
          <dl className="detail-grid">
            <div>
              <dt>Batch</dt>
              <dd>
                <Link to={`/audit?batchId=${commit.result.batchId}`} className="mono" data-testid="import-batch-link">
                  {commit.result.batchId}
                </Link>
              </dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd data-testid="import-result-created">{commit.result.created}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd data-testid="import-result-updated">{commit.result.updated}</dd>
            </div>
            <div>
              <dt>Unchanged</dt>
              <dd>{commit.result.unchanged}</dd>
            </div>
            <div>
              <dt>Failed</dt>
              <dd data-testid="import-result-failed">{commit.result.failed}</dd>
            </div>
          </dl>

          {commit.result.failed > 0 && (
            <section className="import-page__group">
              <h3 className="text-title">Rows that failed ({commit.result.failed})</h3>
              <p className="cell-muted">
                Every other row above was still committed — a partial failure never blocks the rows that succeeded.
              </p>
              <FailuresTable failures={commit.result.failures} testId="import-commit-failures" />
            </section>
          )}

          <div className="import-page__commit-bar">
            <Link to="/people" className="btn btn--secondary">
              Go to People
            </Link>
            <button type="button" className="btn btn--primary" onClick={startOver} data-testid="import-start-over">
              Start a new import
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
