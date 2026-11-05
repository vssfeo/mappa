import type { PointerEvent as ReactPointerEvent } from 'react'
import { Eye, EyeOff, GripVertical, PenLine, Star } from 'lucide-react'
import { useText } from './i18n'

interface LayerRowProps {
  id: string
  name: string
  kind: string
  badges?: string[]
  visible: boolean
  opacity: number
  dragging: boolean
  drop: 'before' | 'after' | null
  onToggle: () => void
  onOpacity: (value: number) => void
  onDragStart: (
    event: ReactPointerEvent<HTMLButtonElement>,
    id: string,
  ) => void
  onMove: (delta: number) => void
  pinned?: boolean
  onPin?: () => void
  selectable?: boolean
  selected?: boolean
  onSelect?: () => void
  onEdit?: () => void
}

/** One compact layer row shared by basemaps and custom sources. */
export function LayerRow({
  id,
  name,
  kind,
  badges = [],
  visible,
  opacity,
  dragging,
  drop,
  onToggle,
  onOpacity,
  onDragStart,
  onMove,
  pinned = false,
  onPin,
  selectable = false,
  selected = false,
  onSelect,
  onEdit,
}: LayerRowProps) {
  const tx = useText()
  return (
    <div
      className={`layer-row compact${selectable ? ' selectable' : ''}${
        visible ? ' is-visible' : ''
      }${
        dragging ? ' is-dragging' : ''
      }${drop ? ` drop-${drop}` : ''}`}
      data-layer-id={id}
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
        <button
          type="button"
          className="layer-grip"
          onPointerDown={(event) => onDragStart(event, id)}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              onMove(1)
            } else if (event.key === 'ArrowDown') {
              event.preventDefault()
              onMove(-1)
            }
          }}
          aria-label={`${tx('Перетащить слой', 'Drag layer')} ${name}`}
          title={tx('Перетащите или используйте ↑/↓', 'Drag or use ↑/↓')}
        >
          <GripVertical size={14} />
        </button>
        <strong title={name}>{name}</strong>
        <span className="layer-kind">{kind}</span>
        {badges.map((badge) => (
          <span key={badge} className="layer-badge">
            {badge}
          </span>
        ))}
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={opacity}
          onChange={(event) => onOpacity(Number(event.target.value))}
          aria-label={tx('Прозрачность {p0}', 'Opacity of {p0}', { p0: name })}
        />
        <span className="layer-opacity">{Math.round(opacity * 100)}%</span>
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
