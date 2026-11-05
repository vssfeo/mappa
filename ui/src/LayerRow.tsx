import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Eye, EyeOff, PenLine, Star } from 'lucide-react'
import { useText } from './i18n'

interface LayerRowProps {
  id: string
  name: string
  visible: boolean
  opacity: number
  dragging: boolean
  drop: 'before' | 'after' | null
  onToggle: () => void
  onOpacity: (value: number) => void
  onDragStart: (
    event: ReactPointerEvent<HTMLElement>,
    id: string,
  ) => void
  pinned?: boolean
  onPin?: () => void
  selectable?: boolean
  selected?: boolean
  onSelect?: () => void
  onEdit?: () => void
}

/** One compact layer row; drag anywhere except its buttons. */
export function LayerRow({
  id,
  name,
  visible,
  opacity,
  dragging,
  drop,
  onToggle,
  onOpacity,
  onDragStart,
  pinned = false,
  onPin,
  selectable = false,
  selected = false,
  onSelect,
  onEdit,
}: LayerRowProps) {
  const tx = useText()
  const [opacityHint, setOpacityHint] = useState(false)
  const hideTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    return () => window.clearTimeout(hideTimer.current)
  }, [])

  const showOpacity = (value: number) => {
    onOpacity(value)
    setOpacityHint(true)
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setOpacityHint(false), 900)
  }

  return (
    <div
      className={`layer-row compact${selectable ? ' selectable' : ''}${
        visible ? ' is-visible' : ''
      }${dragging ? ' is-dragging' : ''}${drop ? ` drop-${drop}` : ''}`}
      data-layer-id={id}
      onPointerDown={(event) => {
        const target = event.target as HTMLElement
        if (target.closest('button, input, label')) return
        onDragStart(event, id)
      }}
    >
      {selectable && (
        <input
          type="checkbox"
          className="layer-select"
          checked={selected}
          onChange={onSelect}
          aria-label={tx('Выбрать {p0}', 'Select {p0}', { p0: name })}
        />
      )}
      <button
        type="button"
        className="layer-eye"
        onClick={onToggle}
        aria-label={
          visible
            ? `${tx('Скрыть', 'Hide')} ${name}`
            : `${tx('Показать', 'Show')} ${name}`
        }
        aria-pressed={visible}
      >
        {visible ? <Eye size={15} /> : <EyeOff size={15} />}
      </button>
      <div className="layer-line">
        <strong title={name}>{name}</strong>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={opacity}
          onChange={(event) => showOpacity(Number(event.target.value))}
          title={`${Math.round(opacity * 100)}%`}
          aria-label={tx('Прозрачность {p0}', 'Opacity of {p0}', { p0: name })}
        />
        {opacityHint && (
          <span className="layer-opacity">{Math.round(opacity * 100)}%</span>
        )}
      </div>
      {(onEdit || onPin) && (
        <div className="layer-actions">
          {onPin && (
            <button
              type="button"
              className="icon-button"
              onClick={onPin}
              aria-pressed={pinned}
              aria-label={tx('Закрепить {p0}', 'Pin {p0}', { p0: name })}
              title={tx('Закрепить слой', 'Pin layer')}
            >
              <Star size={14} fill={pinned ? 'currentColor' : 'none'} />
            </button>
          )}
          {onEdit && (
            <button
              type="button"
              className="icon-button"
              onClick={onEdit}
              aria-label={tx('Изменить {p0}', 'Edit {p0}', { p0: name })}
              title={tx('Параметры слоя', 'Layer settings')}
            >
              <PenLine size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  )
}
