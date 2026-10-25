import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Compass, Download, Layers, MapPin, Mountain, X } from 'lucide-react'
import { useText } from './i18n'
import { useDialogFocus } from './useDialogFocus'

interface OnboardingProps {
  demoBusy: boolean
  demoAvailable: boolean
  onOpenDemo: () => void
  onDownload: () => void
  onClose: () => void
}

/** First-run tour: what the app does, the demo pack and the main shortcuts. */
export function Onboarding({
  demoBusy,
  demoAvailable,
  onOpenDemo,
  onDownload,
  onClose,
}: OnboardingProps) {
  const tx = useText()
  const dialogRef = useRef<HTMLElement | null>(null)
  const [step, setStep] = useState(0)
  const primaryRef = useRef<HTMLButtonElement | null>(null)
  useDialogFocus(dialogRef, onClose)

  // The tour starts on its primary action rather than on the close button.
  useEffect(() => {
    primaryRef.current?.focus()
  }, [])

  const steps = [
    <section key="welcome" className="onboarding-step">
      <h2>{tx('Добро пожаловать в Mappa', 'Welcome to Mappa')}</h2>
      <p className="onboarding-lead">
        {tx(
          'Офлайн-карты, паки и полевая работа на одном экране.',
          'Offline maps, packs and field work on one screen.',
        )}
      </p>
      <ul className="onboarding-list">
        <li>
          <Download size={16} />
          <span>
            {tx(
              'Скачайте район — тайлы и паки работают без сети',
              'Download a region — tiles and packs work without a network',
            )}
          </span>
        </li>
        <li>
          <Mountain size={16} />
          <span>
            {tx(
              'Рельеф, GPS и маршруты — DEM, NMEA и OSRM/BRouter',
              'Terrain, GPS and routes — DEM, NMEA and OSRM/BRouter',
            )}
          </span>
        </li>
        <li>
          <Layers size={16} />
          <span>
            {tx(
              'Полевой режим — крупные кнопки, контраст, экран не гаснет',
              'Field mode — larger controls, high contrast, the screen stays awake',
            )}
          </span>
        </li>
      </ul>
    </section>,

    <section key="demo" className="onboarding-step">
      <span className="eyebrow">{tx('Демо', 'Demo')}</span>
      <h2>{tx('Попробуйте демо-пак', 'Try the demo pack')}</h2>
      <p className="onboarding-lead">
        {tx(
          'Небольшая синтетическая карта южного берега Крыма встроена в приложение. На ней видно паки, рельеф, маршруты и профиль высот — без скачивания.',
          'A small synthetic map of the Crimean south coast is built into the app. It shows packs, terrain, routes and the elevation profile without downloading anything.',
        )}
      </p>
      <div className="onboarding-actions">
        <button
          type="button"
          className="onboarding-primary"
          onClick={onOpenDemo}
          disabled={demoBusy || !demoAvailable}
        >
          <MapPin size={16} />
          {demoBusy
            ? tx('Открываю демо-пак…', 'Opening the demo pack…')
            : tx('Открыть демо-пак', 'Open the demo pack')}
        </button>
        <button type="button" className="onboarding-secondary" onClick={onDownload}>
          <Download size={16} />
          {tx('Скачать свою область', 'Download my own area')}
        </button>
      </div>
      {!demoAvailable && (
        <p className="onboarding-hint">
          {tx(
            'Демо-пак доступен в настольном приложении',
            'The demo pack is available in the desktop app',
          )}
        </p>
      )}
    </section>,

    <section key="keys" className="onboarding-step">
      <span className="eyebrow">{tx('Клавиши', 'Keys')}</span>
      <h2>{tx('Клавиши и полевой режим', 'Keys and field mode')}</h2>
      <p className="onboarding-lead">
        {tx(
          'Всё управляется мышью и с клавиатуры. Основное:',
          'Everything works with a mouse and a keyboard. The essentials:',
        )}
      </p>
      <ul className="onboarding-keys">
        <li>
          <kbd>F</kbd>
          <span>{tx('полевой режим', 'field mode')}</span>
        </li>
        <li>
          <kbd>?</kbd>
          <span>{tx('все горячие клавиши', 'all keyboard shortcuts')}</span>
        </li>
        <li>
          <kbd>Ctrl</kbd>
          <kbd>K</kbd>
          <span>{tx('командная палитра', 'command palette')}</span>
        </li>
        <li>
          <kbd>D</kbd>
          <span>{tx('скачать район', 'download a region')}</span>
        </li>
      </ul>
    </section>,
  ]

  const last = step === steps.length - 1

  return (
    <div className="modal-backdrop onboarding-backdrop">
      <section
        ref={dialogRef}
        className="onboarding-modal"
        role="dialog"
        aria-modal="true"
        aria-label={tx('Знакомство с Mappa', 'Getting started with Mappa')}
        tabIndex={-1}
      >
        <header className="onboarding-head">
          <span className="onboarding-mark">
            <Compass size={15} /> Mappa
          </span>
          <div className="onboarding-dots" aria-hidden="true">
            {steps.map((_, index) => (
              <span
                key={index}
                className={index === step ? 'is-active' : undefined}
              />
            ))}
          </div>
          <button
            type="button"
            className="onboarding-close"
            onClick={onClose}
            aria-label={tx('Закрыть', 'Close')}
          >
            <X size={15} />
          </button>
        </header>

        {steps[step]}

        <footer className="onboarding-foot">
          <button type="button" className="onboarding-skip" onClick={onClose}>
            {tx('Пропустить', 'Skip')}
          </button>
          <div className="onboarding-nav">
            {step > 0 && (
              <button
                type="button"
                className="onboarding-secondary"
                onClick={() => setStep(step - 1)}
              >
                {tx('Назад', 'Back')}
              </button>
            )}
            <button
              ref={primaryRef}
              type="button"
              className="onboarding-primary"
              onClick={() => (last ? onClose() : setStep(step + 1))}
            >
              {last
                ? tx('Начать работу', 'Start working')
                : tx('Далее', 'Next')}
              <ArrowRight size={15} />
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}
