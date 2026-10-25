import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, CornerDownLeft, Loader2, Search } from 'lucide-react'
import type { Command } from './commands'
import { useT, useText } from './i18n'
import { useDialogFocus } from './useDialogFocus'

export interface PlaceSearchResult {
  commands: Command[]
  warning?: string
}

interface RemotePlaces extends PlaceSearchResult {
  query: string
}

interface CommandPaletteProps {
  commands: Command[]
  onClose: () => void
  /** Optional query interpreter, e.g. coordinates pasted into the field. */
  resolve?: (query: string) => Command | null
  /** Optional asynchronous place search (geocoder). */
  searchPlaces?: (query: string) => Promise<PlaceSearchResult>
}

export function CommandPalette({
  commands,
  onClose,
  resolve,
  searchPlaces,
}: CommandPaletteProps) {
  const t = useT()
  const tx = useText()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [remote, setRemote] = useState<RemotePlaces | null>(null)
  const [pendingQuery, setPendingQuery] = useState<string | null>(null)
  const trimmedQuery = query.trim()
  const activeRemote = remote?.query === trimmedQuery ? remote : null
  const remoteBusy = pendingQuery === trimmedQuery && trimmedQuery.length >= 2
  const inputRef = useRef<HTMLInputElement | null>(null)
  const selectedRef = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useRef<HTMLElement | null>(null)
  useDialogFocus(dialogRef, onClose)

  const dynamic = useMemo(() => {
    const trimmed = query.trim()
    return trimmed ? (resolve?.(trimmed) ?? null) : null
  }, [query, resolve])

  useEffect(() => {
    const trimmed = query.trim()
    if (!searchPlaces || dynamic || trimmed.length < 2) return
    let cancelled = false
    // Give the local command filter a head start, then ask the geocoder.
    const timer = window.setTimeout(() => {
      if (cancelled) return
      setPendingQuery(trimmed)
      void searchPlaces(trimmed)
        .then((result) => {
          if (cancelled) return
          setRemote({
            query: trimmed,
            commands: result.commands,
            warning: result.warning,
          })
        })
        .catch(() => {
          if (cancelled) return
          setRemote({
            query: trimmed,
            commands: [],
            warning: tx('Не удалось выполнить поиск', 'Place search failed'),
          })
        })
        .finally(() => {
          if (!cancelled) {
            setPendingQuery((current) => (current === trimmed ? null : current))
          }
        })
    }, 350)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      setPendingQuery((current) => (current === trimmed ? null : current))
    }
  }, [dynamic, query, searchPlaces, tx])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matches =
      needle.length === 0
        ? commands
        : commands.filter((command) => {
            const haystack = [
              command.label,
              command.group,
              command.hint ?? '',
              ...(command.keywords ?? []),
            ]
              .join(' ')
              .toLowerCase()
            return haystack.includes(needle)
          })
    const merged = [
      ...(dynamic ? [dynamic] : []),
      ...(activeRemote?.commands ?? []),
      ...matches,
    ]
    const seen = new Set<string>()
    return merged.filter((command) => {
      if (seen.has(command.id)) return false
      seen.add(command.id)
      return true
    })
  }, [activeRemote, commands, dynamic, query])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const run = (command: Command | undefined) => {
    if (!command) return
    onClose()
    command.action()
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelected((value) =>
        filtered.length === 0 ? 0 : (value + 1) % filtered.length,
      )
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected((value) =>
        filtered.length === 0
          ? 0
          : (value - 1 + filtered.length) % filtered.length,
      )
    } else if (event.key === 'Enter') {
      event.preventDefault()
      run(filtered[selected])
    }
  }

  return (
    <div className="cmdk-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-label={t('shortcuts.palette')}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="cmdk-input">
          <Search size={18} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setSelected(0)
            }}
            onKeyDown={onKeyDown}
            placeholder={tx(
              'Команда, место, слой или координаты…',
              'Command, place, layer or coordinates…',
            )}
            aria-label={tx('Поиск команды', 'Search commands')}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-list"
            aria-autocomplete="list"
            aria-activedescendant={
              filtered[selected]
                ? `command-${filtered[selected].id}`
                : undefined
            }
          />
          <kbd>Esc</kbd>
        </div>

        <div
          className="cmdk-list"
          role="listbox"
          id="command-list"
          aria-busy={remoteBusy}
        >
          {remoteBusy && filtered.length > 0 && (
            <div className="cmdk-status" role="status">
              <Loader2 size={12} className="spin" aria-hidden="true" />
              {tx('Ищем места…', 'Searching places…')}
            </div>
          )}
          {!remoteBusy && activeRemote?.warning && filtered.length > 0 && (
            <div className="cmdk-status" role="status">
              {activeRemote.warning}
            </div>
          )}

          {filtered.length === 0 && (
            <div className="cmdk-empty" role="status">
              <strong>
                {remoteBusy
                  ? tx('Ищем места…', 'Searching places…')
                  : tx('Ничего не найдено', 'Nothing found')}
              </strong>
              <span>
                {activeRemote?.warning ??
                  tx(
                    'Попробуйте «Москва», «скачать» или координаты.',
                    'Try “Moscow”, “download” or coordinates.',
                  )}
              </span>
            </div>
          )}

          {filtered.map((command, index) => {
            const Icon = command.icon
            const showGroup =
              index === 0 || filtered[index - 1].group !== command.group
            return (
              <div key={command.id}>
                {showGroup && (
                  <div className="cmdk-group">{command.group}</div>
                )}
                <button
                  type="button"
                  id={`command-${command.id}`}
                  ref={index === selected ? selectedRef : null}
                  role="option"
                  aria-selected={index === selected}
                  className={`cmdk-item${index === selected ? ' is-selected' : ''}`}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => run(command)}
                >
                  <span className="cmdk-icon">
                    <Icon size={16} aria-hidden="true" />
                  </span>
                  <span className="cmdk-label">{command.label}</span>
                  {command.hint && <kbd>{command.hint}</kbd>}
                </button>
              </div>
            )
          })}
        </div>

        <footer className="cmdk-footer">
          <span>
            <ArrowUp size={12} aria-hidden="true" />
            <ArrowDown size={12} aria-hidden="true" />
            {tx('навигация', 'navigate')}
          </span>
          <span>
            <CornerDownLeft size={12} aria-hidden="true" />
            {tx('выполнить', 'run')}
          </span>
          <span>
            <kbd>Esc</kbd>
            {tx('закрыть', 'close')}
          </span>
        </footer>
      </section>
    </div>
  )
}
