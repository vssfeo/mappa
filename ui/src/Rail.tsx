import {
  Download,
  FolderOpen,
  HelpCircle,
  Layers3,
  Map,
  MapPin,
  Settings2,
  Spline,
  type LucideIcon,
} from 'lucide-react'
import { useT, type MessageKey } from './i18n'
import { useAppStore, type Panel } from './store'

const items: {
  id: Panel | 'map' | 'settings'
  label: MessageKey
  icon: LucideIcon
}[] = [
  { id: 'map', label: 'nav.map', icon: Map },
  { id: 'layers', label: 'nav.layers', icon: Layers3 },
  { id: 'downloads', label: 'nav.downloads', icon: Download },
  { id: 'markers', label: 'nav.markers', icon: MapPin },
  { id: 'features', label: 'nav.features', icon: Spline },
  { id: 'projects', label: 'nav.projects', icon: FolderOpen },
]

export function Rail() {
  const t = useT()
  const panel = useAppStore((state) => state.panel)
  const setPanel = useAppStore((state) => state.setPanel)
  const togglePanel = useAppStore((state) => state.togglePanel)
  const setShortcutsOpen = useAppStore((state) => state.setShortcutsOpen)

  return (
    <nav className="rail" aria-label={t('nav.main')}>
      <div className="rail-group">
        {items.map((item) => {
          const Icon = item.icon
          const label = t(item.label)
          const active =
            item.id === 'map' ? panel === null : panel === item.id
          return (
            <button
              key={item.id}
              type="button"
              className={`rail-button${active ? ' is-active' : ''}`}
              title={label}
              aria-label={label}
              aria-pressed={active}
              onClick={() => {
                if (item.id === 'map') {
                  setPanel(null)
                } else {
                  togglePanel(item.id as Exclude<Panel, null>)
                }
              }}
            >
              <Icon size={19} aria-hidden="true" />
              <span className="rail-tooltip">{label}</span>
            </button>
          )
        })}
      </div>

      <div className="rail-spacer" />

      <div className="rail-group">
        <button
          type="button"
          className="rail-button"
          title={t('nav.shortcuts')}
          aria-label={t('nav.shortcuts')}
          onClick={() => setShortcutsOpen(true)}
        >
          <HelpCircle size={19} aria-hidden="true" />
          <span className="rail-tooltip">{t('nav.shortcutsShort')}</span>
        </button>
        <button
          type="button"
          className={`rail-button${panel === 'settings' ? ' is-active' : ''}`}
          title={t('nav.settings')}
          aria-label={t('nav.settings')}
          aria-pressed={panel === 'settings'}
          onClick={() => togglePanel('settings')}
        >
          <Settings2 size={19} aria-hidden="true" />
          <span className="rail-tooltip">{t('nav.settings')}</span>
        </button>
      </div>
    </nav>
  )
}
