import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link } from 'react-router-dom'
import { ApiError } from '../api/client'
import { Field } from '../forms/Field'
import { fetchPeople, fetchPeopleByIds, type Person } from '../people/api'
import { StatusBadge, SyncBadge } from '../people/badges'
import { useToast } from '../shell/ToastProvider'
import { addGroupMember, fetchEffectiveMembers, fetchGroupMembers, removeGroupMember } from './api'

const SEARCH_DEBOUNCE_MS = 300
const SEARCH_RESULT_LIMIT = 8

/**
 * Progressive-disclosure "add a member" form — a debounced live search
 * (`GET /users?search=`, the same endpoint and debounce interval
 * PeopleListPage already uses) rather than a raw-UUID text input, unlike
 * `PersonForm`'s deliberately minimal `managerId` field: adding people to a
 * group is a FAR more frequent, repeated action than setting a manager once,
 * so the extra mechanism earns its keep here specifically (a disclosed scope
 * call, not a silent inconsistency). Results render as a plain block-flow
 * list UNDER the input, never an absolutely-positioned floating dropdown —
 * docs/design-system.md bans `position: absolute` dropdowns inside an overflow
 * container, and the simplest way to never collide with that ban is to not
 * float at all.
 */
function AddMemberForm({
  groupId,
  excludeIds,
  onAdded,
  onCancel,
}: {
  groupId: string
  excludeIds: readonly string[]
  onAdded: (person: Person) => void
  onCancel: () => void
}) {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const [term, setTerm] = useState('')
  const [results, setResults] = useState<Person[]>([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<Person | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current)
    }
  }, [])

  function onTermChange(value: string) {
    setTerm(value)
    setSelected(null)
    setError(null)
    if (debounceRef.current !== null) clearTimeout(debounceRef.current)

    const trimmed = value.trim()
    if (trimmed === '') {
      setResults([])
      setSearching(false)
      return
    }

    debounceRef.current = setTimeout(() => {
      if (accessToken === undefined) return
      setSearching(true)
      fetchPeople(accessToken, { limit: SEARCH_RESULT_LIMIT, offset: 0, search: trimmed })
        .then((res) => setResults(res.items.filter((p) => !excludeIds.includes(p.id))))
        .catch(() => setResults([]))
        .finally(() => setSearching(false))
    }, SEARCH_DEBOUNCE_MS)
  }

  function selectResult(person: Person) {
    setSelected(person)
    setTerm(person.displayName)
    setResults([])
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (selected === null || accessToken === undefined) return
    setSubmitting(true)
    setError(null)
    try {
      await addGroupMember(accessToken, groupId, selected.id)
      onAdded(selected)
    } catch (cause) {
      setSubmitting(false)
      setError(cause instanceof ApiError ? cause.message : 'Could not add this member.')
    }
  }

  const showResults = term.trim() !== '' && selected === null

  return (
    <form className="group-member-add" onSubmit={(e) => void handleSubmit(e)}>
      <Field id="group-add-member-search" label="Add a member" hint="Search by name, username, or email.">
        <input
          id="group-add-member-search"
          className="input"
          type="text"
          autoComplete="off"
          value={term}
          onChange={(e) => onTermChange(e.target.value)}
          placeholder="Search people…"
          data-testid="group-add-member-input"
        />
      </Field>

      {showResults && (
        <ul className="group-member-add__results" data-testid="group-add-member-results">
          {searching ? (
            <li className="group-member-add__result-note">Searching…</li>
          ) : results.length === 0 ? (
            <li className="group-member-add__result-note">No matches.</li>
          ) : (
            results.map((person) => (
              <li key={person.id}>
                <button
                  type="button"
                  className="group-member-add__result"
                  onClick={() => selectResult(person)}
                  data-testid="group-add-member-result"
                >
                  <span>{person.displayName}</span>
                  <span className="cell-muted">{person.username}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}

      {error !== null && (
        <p className="error-panel__message" role="alert">
          {error}
        </p>
      )}

      <div className="group-member-add__actions">
        <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn btn--primary"
          disabled={submitting || selected === null}
          data-loading={submitting ? 'true' : undefined}
          data-testid="group-add-member-submit"
        >
          <span className="btn__label">Add</span>
          <span className="btn__spinner" aria-hidden="true" />
        </button>
      </div>
    </form>
  )
}

interface MemberRow {
  id: string
  person: Person | undefined
}

function MemberList({
  title,
  note,
  rows,
  emptyMessage,
  onRemove,
  removingId,
  testId,
}: {
  title: string
  note?: string
  rows: MemberRow[]
  emptyMessage: string
  onRemove?: (row: MemberRow) => void
  removingId: string | null
  testId: string
}) {
  return (
    // data-testid lives on this always-rendered section, not conditionally
    // on the <ul> below — a caller (test or otherwise) targeting "the
    // direct members section" must be able to find it, and assert it's
    // empty, without the container itself vanishing the moment there is
    // nothing to list.
    <section className="group-members__section" data-testid={testId}>
      <h3 className="text-title">
        {title} ({rows.length})
      </h3>
      {note !== undefined && rows.length > 0 && <p className="group-members__note">{note}</p>}
      {rows.length === 0 ? (
        <p className="cell-muted">{emptyMessage}</p>
      ) : (
        <ul className="group-member-list">
          {rows.map((row) => (
            <li key={row.id} className="group-member-list__row" data-testid={`${testId}-row`}>
              {row.person !== undefined ? (
                <>
                  <Link to={`/people/${row.person.id}`} className="group-member-list__name">
                    {row.person.displayName}
                  </Link>
                  <span className="cell-muted">{row.person.username}</span>
                  <StatusBadge status={row.person.status} />
                  <SyncBadge state={row.person.syncState} />
                </>
              ) : (
                <span className="cell-muted">
                  Member outside what your role can see <span className="mono">({row.id})</span>
                </span>
              )}
              {onRemove && row.person !== undefined && (
                <button
                  type="button"
                  className="btn btn--ghost group-member-list__remove"
                  onClick={() => onRemove(row)}
                  disabled={removingId === row.id}
                  data-loading={removingId === row.id ? 'true' : undefined}
                  data-testid={`${testId}-remove`}
                >
                  <span className="btn__label">Remove</span>
                  <span className="btn__spinner" aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

type MembersState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; directIds: string[]; effectiveIds: string[]; people: Map<string, Person> }

/**
 * The Members tab — task-4-brief.md's headline requirement: "Direct and
 * effective membership must be visually distinct... structural, not a
 * tooltip." Implemented as two entirely separate `<section>`s with their own
 * heading and their own list (`MemberList` above, called twice) — never one
 * list with a badge or a tooltip distinguishing rows within it. "Members via
 * nested groups" is `effective MINUS direct` (an inherited member is never
 * ALSO shown as direct — the two sections partition the effective set, they
 * don't overlap), each row resolved to a real Person via ONE combined `GET
 * /users?ids=` call (see people/api.ts's fetchPeopleByIds) rather than one
 * request per id.
 *
 * Milestone 8, Task 5: each row also carries the SAME `SyncBadge` the
 * People list/detail already show — `fetchPeopleByIds` already returns
 * `syncState` per person, so this costs no extra request. This is precisely
 * the screen the security remediation's own motivating finding was about
 * (docs/archive/audits/audit-integrity.md, finding H3): a user removed from a
 * group whose removal event dead-lettered would otherwise look like an
 * ordinary, healthy member right here, on the one screen an admin would
 * check to confirm who is actually still in a group.
 */
export function GroupMembersTab({
  groupId,
  groupName,
  canManageMembers,
}: {
  groupId: string
  groupName: string
  canManageMembers: boolean
}) {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const { showToast } = useToast()

  const [state, setState] = useState<MembersState>({ status: 'loading' })
  const [showAdd, setShowAdd] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)

  const load = useCallback(() => {
    if (accessToken === undefined) return
    setState({ status: 'loading' })

    Promise.all([fetchGroupMembers(accessToken, groupId), fetchEffectiveMembers(accessToken, groupId)])
      .then(async ([direct, effectiveIds]) => {
        const unionIds = Array.from(new Set([...direct.users, ...effectiveIds]))
        const peoplePage = await fetchPeopleByIds(accessToken, unionIds)
        const people = new Map(peoplePage.items.map((p) => [p.id, p]))
        setState({ status: 'ready', directIds: direct.users, effectiveIds, people })
      })
      .catch((cause: unknown) => {
        setState({
          status: 'error',
          message: cause instanceof ApiError ? cause.message : 'check your connection and try again',
        })
      })
  }, [accessToken, groupId])

  useEffect(load, [load])

  async function handleRemove(row: MemberRow) {
    if (accessToken === undefined || row.person === undefined) return
    setRemovingId(row.id)
    try {
      await removeGroupMember(accessToken, groupId, row.id)
      showToast(`Removed ${row.person.displayName} from ${groupName}.`)
      load()
    } catch (cause) {
      showToast(
        cause instanceof ApiError ? cause.message : 'Could not remove this member — check your connection and try again.',
        'danger',
      )
    } finally {
      setRemovingId(null)
    }
  }

  function handleAdded(person: Person) {
    showToast(`Added ${person.displayName} to ${groupName}.`)
    setShowAdd(false)
    load()
  }

  if (state.status === 'error') {
    return (
      <div className="error-panel" role="alert">
        <p className="error-panel__message">Could not load this group's members: {state.message}</p>
      </div>
    )
  }

  if (state.status === 'loading') {
    return (
      <div aria-hidden="true">
        <span className="skeleton" style={{ width: '10rem', height: '1rem', display: 'block' }} />
        <span className="skeleton" style={{ width: '100%', height: '4rem', display: 'block', marginTop: 'var(--space-3)' }} />
      </div>
    )
  }

  const directRows: MemberRow[] = state.directIds.map((id) => ({ id, person: state.people.get(id) }))
  const effectiveOnlyIds = state.effectiveIds.filter((id) => !state.directIds.includes(id))
  const effectiveRows: MemberRow[] = effectiveOnlyIds.map((id) => ({ id, person: state.people.get(id) }))

  return (
    <div className="group-members">
      <MemberList
        title="Direct members"
        rows={directRows}
        emptyMessage="No one is a direct member of this group yet."
        onRemove={canManageMembers ? handleRemove : undefined}
        removingId={removingId}
        testId="group-direct-members"
      />
      <MemberList
        title="Members via nested groups"
        note={`These people are not direct members of ${groupName} — they belong through a child group nested underneath it. Remove them from that child group, or un-nest it, to change this.`}
        rows={effectiveRows}
        emptyMessage="No one else is reachable through a nested group."
        removingId={removingId}
        testId="group-effective-members"
      />

      {canManageMembers &&
        (showAdd ? (
          <AddMemberForm
            groupId={groupId}
            excludeIds={state.directIds}
            onAdded={handleAdded}
            onCancel={() => setShowAdd(false)}
          />
        ) : (
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => setShowAdd(true)}
            data-testid="group-show-add-member"
          >
            Add member
          </button>
        ))}
    </div>
  )
}
