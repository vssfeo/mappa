import {
  ChevronDown,
  Download,
  Globe2,
  MapPin,
  Maximize2,
  Minimize2,
  Moon,
  Search,
  Settings2,
  Sun,
} from 'lucide-react'
import { useT } from './i18n'
import { LOCALES, LOCALE_NAMES, type Locale } from './locale.ts'
import { PROVIDERS, type ProviderId } from './providers'
import { useAppStore } from './store'

export function TopBar() {
  const t = useT()
  const theme = useAppStore((state) => state.theme)
  const toggleTheme = useAppStore((state) => state.toggleTheme)
  const providerId = useAppStore((state) => state.providerId)
  const setProviderId = useAppStore((state) => state.setProviderId)
  const setCommandOpen = useAppStore((state) => state.setCommandOpen)
  const setDownloadOpen = useAppStore((state) => state.setDownloadOpen)
  const locale = useAppStore((state) => state.locale)
  const setLocale = useAppStore((state) => state.setLocale)
  const panel = useAppStore((state) => state.panel)
  const togglePanel = useAppStore((state) => state.togglePanel)
  const fieldMode = useAppStore((state) => state.fieldMode)
  const toggleFieldMode = useAppStore((state) => state.toggleFieldMode)

  return (
    <header className="topbar">
      <div className="brand" aria-label="Mappa">
        <span className="brand-mark">M</span>
        <span className="brand-name">Mappa</span>
        <span className="preview-pill">{t('brand.preview')}</span>
      </div>

      <button
        type="button"
        className="search-trigger"
        onClick={() => setCommandOpen(true)}
        aria-label={t('top.searchLabel')}
      >
        <Search size={16} aria-hidden="true" />
        <span>{t('top.search')}</span>
        <kbd>Ctrl K</kbd>
      </button>

      <label className="provider-select">
        <MapPin size={14} aria-hidden="true" />
        <select
          value={providerId}
          onChange={(event) =>
            setProviderId(event.target.value as ProviderId)
          }
          aria-label={t('top.basemap')}
        >
          {PROVIDERS.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label}
            </option>
          ))}
        </select>
        <ChevronDown size={14} aria-hidden="true" />
      </label>

      <div className="topbar-actions">
        <label
          className="provider-select language-select"
          title={LOCALE_NAMES[locale]}
        >
          <Globe2 size={14} aria-hidden="true" />
          <select
            value={locale}
            onChange={(event) => setLocale(event.target.value as Locale)}
            aria-label={t('settings.language')}
          >
            {LOCALES.map((value) => (
              <option key={value} value={value}>
                {value.toUpperCase()}
              </option>
            ))}
          </select>
          <ChevronDown size={13} aria-hidden="true" />
        </label>
        <button
          type="button"
          className={`icon-button${fieldMode ? ' is-active' : ''}`}
          onClick={toggleFieldMode}
          aria-pressed={fieldMode}
          aria-label={t('field.mode')}
          title={t('field.mode')}
        >
          {fieldMode ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? t('top.lightTheme') : t('top.darkTheme')}
          title={theme === 'dark' ? t('top.lightTheme') : t('top.darkTheme')}
        >
          {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
        </button>
        <button
          type="button"
          className={`icon-button${panel === 'settings' ? ' is-active' : ''}`}
          onClick={() => togglePanel('settings')}
          aria-label={t('top.settings')}
          aria-pressed={panel === 'settings'}
          title={t('top.settings')}
        >
          <Settings2 size={17} />
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={() => setDownloadOpen(true)}
        >
          <Download size={15} aria-hidden="true" />
          {t('top.download')}
        </button>
      </div>
    </header>
  )
}
