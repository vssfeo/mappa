import { useRef } from 'react'
import { X } from 'lucide-react'
import { useT, type MessageKey } from './i18n'
import { useDialogFocus } from './useDialogFocus'

const shortcuts: { keys: string[]; label: MessageKey }[] = [
  { keys: ['Ctrl', 'K'], label: 'shortcuts.palette' },
  { keys: ['D'], label: 'shortcuts.download' },
  { keys: ['R'], label: 'shortcuts.select' },
  { keys: ['M'], label: 'shortcuts.ruler' },
  { keys: ['Shift', 'M'], label: 'shortcuts.area' },
  { keys: ['P'], label: 'shortcuts.markers' },
  { keys: ['L'], label: 'shortcuts.line' },
  { keys: ['Shift', 'L'], label: 'shortcuts.polygon' },
  { keys: ['O'], label: 'shortcuts.circle' },
  { keys: ['E'], label: 'shortcuts.vertices' },
  { keys: ['Enter'], label: 'shortcuts.finish' },
  { keys: ['Delete'], label: 'shortcuts.delete' },
  { keys: ['Backspace'], label: 'shortcuts.backspace' },
  { keys: ['C'], label: 'shortcuts.compare' },
  { keys: ['G'], label: 'shortcuts.gps' },
  { keys: ['F'], label: 'shortcuts.field' },
  { keys: ['Ctrl', 'J'], label: 'shortcuts.jobs' },
  { keys: ['Ctrl', 'S'], label: 'shortcuts.save' },
  { keys: ['Ctrl', 'Shift', 'S'], label: 'shortcuts.saveAs' },
  { keys: ['Ctrl', 'O'], label: 'shortcuts.open' },
  { keys: ['Ctrl', 'Z'], label: 'shortcuts.undo' },
  { keys: ['Ctrl', 'Shift', 'Z'], label: 'shortcuts.redo' },
  { keys: ['+', '−'], label: 'shortcuts.zoom' },
  { keys: ['0'], label: 'shortcuts.world' },
  { keys: ['Esc'], label: 'shortcuts.escape' },
  { keys: ['?'], label: 'shortcuts.help' },
]

interface ShortcutsProps {
  onClose: () => void
}

export function Shortcuts({ onClose }: ShortcutsProps) {
  const t = useT()
  const dialogRef = useRef<HTMLElement | null>(null)
  useDialogFocus(dialogRef, onClose)
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="shortcuts-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('shortcuts.title')}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <span className="eyebrow">Mappa</span>
            <h2>{t('shortcuts.title')}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
          >
            <X size={16} />
          </button>
        </header>
        <div className="shortcuts-grid">
          {shortcuts.map((shortcut) => (
            <div className="shortcut-row" key={shortcut.label}>
              <span>{t(shortcut.label)}</span>
              <span className="shortcut-keys">
                {shortcut.keys.map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
        <p className="modal-note">
          {t('shortcuts.note')} <kbd>Ctrl</kbd> <kbd>K</kbd>.
        </p>
      </section>
    </div>
  )
}
