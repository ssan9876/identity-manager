import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'

/**
 * A reusable search-as-you-type picker — Milestone 9, Task 3: "the end of
 * UUID inputs." Built once, generic over the option type `T`, so any future
 * "find a record by typing its name" field (people today; org units or
 * groups if either ever outgrows its current `<select>` — see this task's
 * own report for why neither does yet) can reuse it rather than growing a
 * second bespoke implementation. `people/PersonPicker.tsx` is the first,
 * concrete instantiation.
 *
 * Implements the WAI-ARIA 1.2 "Editable Combobox With List Autocomplete"
 * pattern: `role="combobox"` lives on the INPUT itself (the current
 * recommended shape, not a wrapping div), the popup is a sibling
 * `role="listbox"` referenced via `aria-controls`/`aria-activedescendant`
 * rather than a DOM descendant — which is what lets it be rendered through a
 * portal (see below) without breaking the relationship a screen reader
 * relies on.
 *
 * Fully CONTROLLED: `value: T | null` is the single source of truth for what
 * is selected, owned by the caller. This component's own `query` text state
 * is purely a DRAFT — typing never commits anything by itself. A value only
 * ever changes via `onChange`, fired from exactly two places: selecting an
 * option (click or Enter) and the clear button. Blurring or pressing Escape
 * mid-edit REVERTS the draft text back to `value`'s own label, discarding
 * whatever was typed — this is the property that makes it structurally
 * impossible for this component to ever commit a raw, unresolved string as
 * if it were a real selection (the exact defect it replaces: PersonForm used
 * to accept a hand-typed, unvalidated-until-submit UUID).
 *
 * The popup renders `position: fixed`, through a `createPortal` to
 * `document.body` — docs/design-system.md bans `position: absolute` inside an
 * `overflow` container (it clips), and a portal additionally sidesteps any
 * ancestor that establishes its own containing block (`transform`,
 * `contain`, …) now or in the future, which `position: fixed` alone would
 * still be vulnerable to if it stayed a normal DOM descendant. Position is
 * computed from the input's own `getBoundingClientRect()` and FLIPS above
 * the input when there isn't room below — the "near the bottom of the
 * viewport" case this task's own brief calls out checking.
 *
 * Debounced search with real cancellation: a monotonically increasing
 * sequence number (`searchSeq`) is the actual correctness guarantee — a
 * response is applied only if it is still the MOST RECENT request issued,
 * checked at the moment it resolves, regardless of arrival order. An
 * `AbortController` is layered on top to actually cancel the superseded
 * network request (so a slow, discarded search does not keep doing work),
 * but the sequence check is what makes "an admin typing fast never sees an
 * earlier response overwrite a later one" true even if some future `search`
 * implementation ignores its `AbortSignal`. See
 * apps/web/e2e/person-picker.spec.ts's dedicated race-condition test, which
 * proves this against real, deliberately-reordered network responses rather
 * than asserting it as a hypothetical.
 */

const DEFAULT_DEBOUNCE_MS = 300
const DEFAULT_MIN_CHARS = 1
const POPUP_MAX_HEIGHT_PX = 256 // 16rem — long enough for ~6 two-line options
const POPUP_GAP_PX = 4
const POPUP_VIEWPORT_MARGIN_PX = 8
const POPUP_MIN_HEIGHT_PX = 120

type SearchState = 'idle' | 'loading' | 'error'

export interface ComboboxProps<T> {
  id: string
  value: T | null
  onChange: (value: T | null) => void
  /** Runs one search. Must honor `signal` for cancellation to actually free the network, though correctness does not depend on it — see file doc comment. */
  search: (term: string, signal: AbortSignal) => Promise<T[]>
  getOptionId: (option: T) => string
  /** Plain-text label — becomes the input's displayed value once `option` is selected, and its accessible description via `aria-activedescendant`. */
  getOptionLabel: (option: T) => string
  /** Rich rendering inside the listbox row — name first, secondary detail after, per docs/design-system.md. */
  renderOption: (option: T) => React.ReactNode
  placeholder?: string
  noResultsText?: string
  clearLabel?: string
  debounceMs?: number
  minChars?: number
  disabled?: boolean
  'aria-invalid'?: boolean
  'aria-describedby'?: string
  onBlur?: () => void
}

function optionDomId(id: string, index: number): string {
  return `${id}-option-${index}`
}

/** `top`/`bottom` (never both) plus `left`/`width`/`maxHeight`, all `position: fixed` — computed fresh from the trigger's own rect so the popup tracks it through scroll/resize, and flips above the input when the space below is tighter than what's above (the bottom-of-viewport case). */
function computePopupStyle(anchorRect: DOMRect): CSSProperties {
  const viewportHeight = window.innerHeight
  const spaceBelow = viewportHeight - anchorRect.bottom - POPUP_GAP_PX - POPUP_VIEWPORT_MARGIN_PX
  const spaceAbove = anchorRect.top - POPUP_GAP_PX - POPUP_VIEWPORT_MARGIN_PX
  const openUpward = spaceBelow < POPUP_MAX_HEIGHT_PX && spaceAbove > spaceBelow

  const base: CSSProperties = {
    position: 'fixed',
    left: anchorRect.left,
    width: anchorRect.width,
  }

  if (openUpward) {
    return {
      ...base,
      bottom: viewportHeight - anchorRect.top + POPUP_GAP_PX,
      maxHeight: Math.max(POPUP_MIN_HEIGHT_PX, Math.min(POPUP_MAX_HEIGHT_PX, spaceAbove)),
    }
  }
  return {
    ...base,
    top: anchorRect.bottom + POPUP_GAP_PX,
    maxHeight: Math.max(POPUP_MIN_HEIGHT_PX, Math.min(POPUP_MAX_HEIGHT_PX, spaceBelow)),
  }
}

export function Combobox<T>({
  id,
  value,
  onChange,
  search,
  getOptionId,
  getOptionLabel,
  renderOption,
  placeholder,
  noResultsText = 'No matches.',
  clearLabel = 'Clear',
  debounceMs = DEFAULT_DEBOUNCE_MS,
  minChars = DEFAULT_MIN_CHARS,
  disabled = false,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
  onBlur,
}: ComboboxProps<T>) {
  const valueId = value === null ? null : getOptionId(value)
  const [query, setQuery] = useState(value === null ? '' : getOptionLabel(value))
  const [open, setOpen] = useState(false)
  const [results, setResults] = useState<T[]>([])
  const [searchState, setSearchState] = useState<SearchState>('idle')
  const [activeIndex, setActiveIndex] = useState(-1)
  const [popupStyle, setPopupStyle] = useState<CSSProperties | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const searchSeq = useRef(0)

  const listboxId = `${id}-listbox`

  // The controlled value changed identity (a genuinely new/cleared
  // selection — e.g. PersonPicker just finished resolving an initial
  // managerId to a Person). Sync the draft text to match. Keyed on the
  // OPTION'S OWN id, not the `value` object reference or `query` itself —
  // this must NOT rerun while the admin is mid-typing against an unchanged
  // `value` (that would clobber their draft on every keystroke), which is
  // exactly why `query` is deliberately absent from this dependency list.
  useEffect(() => {
    setQuery(valueId === null ? '' : (value ? getOptionLabel(value) : ''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueId])

  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current)
      abortRef.current?.abort()
    }
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    function reposition() {
      const inputEl = inputRef.current
      if (inputEl === null) return
      setPopupStyle(computePopupStyle(inputEl.getBoundingClientRect()))
    }
    reposition()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open])

  function runSearch(term: string) {
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const mySeq = (searchSeq.current += 1)
    setSearchState('loading')

    search(term, controller.signal)
      .then((items) => {
        if (mySeq !== searchSeq.current) return // superseded — see file doc comment
        setResults(items)
        setSearchState('idle')
        setActiveIndex(items.length > 0 ? 0 : -1)
      })
      .catch((error: unknown) => {
        if (mySeq !== searchSeq.current) return
        if (error instanceof DOMException && error.name === 'AbortError') return
        setResults([])
        setSearchState('error')
        setActiveIndex(-1)
      })
  }

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const text = event.target.value
    setQuery(text)
    setActiveIndex(-1)
    if (debounceRef.current !== null) clearTimeout(debounceRef.current)

    const trimmed = text.trim()
    if (trimmed.length < minChars) {
      // Invalidate any request already in flight too, not just pending ones
      // — a keystroke that empties the field must win even against a
      // response that was already on the wire.
      searchSeq.current += 1
      abortRef.current?.abort()
      setOpen(false)
      setResults([])
      setSearchState('idle')
      return
    }

    setOpen(true)
    setSearchState('loading')
    debounceRef.current = setTimeout(() => runSearch(trimmed), debounceMs)
  }

  function openWithCurrentQuery() {
    const trimmed = query.trim()
    if (trimmed.length < minChars) return
    setOpen(true)
    runSearch(trimmed)
  }

  function commitSelection(option: T) {
    onChange(option)
    setQuery(getOptionLabel(option))
    setOpen(false)
    setResults([])
    setActiveIndex(-1)
    if (debounceRef.current !== null) clearTimeout(debounceRef.current)
    abortRef.current?.abort()
  }

  function revertToValue() {
    setQuery(value === null ? '' : getOptionLabel(value))
    setOpen(false)
    setResults([])
    setActiveIndex(-1)
    if (debounceRef.current !== null) clearTimeout(debounceRef.current)
    abortRef.current?.abort()
  }

  function handleClear() {
    onChange(null)
    setQuery('')
    setOpen(false)
    setResults([])
    setActiveIndex(-1)
    inputRef.current?.focus()
  }

  function handleBlur() {
    revertToValue()
    onBlur?.()
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (disabled) return
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault()
        if (!open) {
          openWithCurrentQuery()
        } else {
          setActiveIndex((i) => (results.length === 0 ? -1 : (i + 1) % results.length))
        }
        break
      }
      case 'ArrowUp': {
        event.preventDefault()
        if (!open) {
          openWithCurrentQuery()
        } else {
          setActiveIndex((i) => (results.length === 0 ? -1 : (i - 1 + results.length) % results.length))
        }
        break
      }
      case 'Home': {
        if (open && results.length > 0) {
          event.preventDefault()
          setActiveIndex(0)
        }
        break
      }
      case 'End': {
        if (open && results.length > 0) {
          event.preventDefault()
          setActiveIndex(results.length - 1)
        }
        break
      }
      case 'Enter': {
        if (open) {
          event.preventDefault()
          const active = activeIndex >= 0 ? results[activeIndex] : undefined
          if (active !== undefined) commitSelection(active)
        }
        break
      }
      case 'Escape': {
        // Always handled, even when already closed (a pending debounce with
        // typed-but-not-yet-searched text has no `open` state of its own
        // yet) — see file doc comment on why revert, not clear, is correct
        // here.
        event.preventDefault()
        event.stopPropagation()
        revertToValue()
        break
      }
      default:
        break
    }
  }

  const showClear = !disabled && (value !== null || query !== '')
  const activeOption = activeIndex >= 0 ? results[activeIndex] : undefined
  const liveMessage =
    searchState === 'loading'
      ? 'Searching…'
      : searchState === 'error'
        ? 'Could not search.'
        : !open
          ? ''
          : results.length === 0
            ? noResultsText
            : `${results.length} result${results.length === 1 ? '' : 's'} available.`

  return (
    <div className="combobox">
      <div className="combobox__control">
        <input
          ref={inputRef}
          id={id}
          role="combobox"
          type="text"
          autoComplete="off"
          className="input combobox__input"
          value={query}
          placeholder={placeholder}
          disabled={disabled}
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={open && activeOption !== undefined ? optionDomId(id, activeIndex) : undefined}
          aria-invalid={ariaInvalid || undefined}
          aria-describedby={ariaDescribedBy}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
        />
        {showClear && (
          <button
            type="button"
            className="combobox__clear"
            aria-label={clearLabel}
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleClear}
          >
            <span aria-hidden="true">&times;</span>
          </button>
        )}
      </div>

      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {liveMessage}
      </span>

      {open &&
        createPortal(
          <ul id={listboxId} role="listbox" className="combobox__listbox" style={popupStyle ?? undefined} data-testid="combobox-listbox">
            {searchState === 'loading' ? (
              <li className="combobox__status" aria-hidden="true">
                <span className="skeleton" style={{ height: '2.5rem', display: 'block', marginBottom: 'var(--space-1)' }} />
                <span className="skeleton" style={{ height: '2.5rem', display: 'block' }} />
              </li>
            ) : searchState === 'error' ? (
              <li className="combobox__status combobox__status--error" role="alert">
                Could not search — check your connection and try again.
              </li>
            ) : results.length === 0 ? (
              <li className="combobox__status" data-testid="combobox-no-results">
                {noResultsText}
              </li>
            ) : (
              results.map((option, index) => (
                <li
                  key={getOptionId(option)}
                  id={optionDomId(id, index)}
                  role="option"
                  aria-selected={index === activeIndex}
                  className={`combobox__option${index === activeIndex ? ' combobox__option--active' : ''}`}
                  data-testid="combobox-option"
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => commitSelection(option)}
                >
                  {renderOption(option)}
                </li>
              ))
            )}
          </ul>,
          document.body,
        )}
    </div>
  )
}
