import { useMemo, useRef, useState } from 'react'
import { Sun, X } from 'lucide-react'
import { moonPhase, solarDay, type MoonPhaseName } from './almanac'
import { useText } from './i18n'
import { useViewStore } from './viewStore'
import { useDialogFocus } from './useDialogFocus'

interface AlmanacPanelProps {
  onClose: () => void
}

const time = (value: Date | null, fallback: string): string =>
  value
    ? value.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : fallback

const duration = (minutes: number | null): string => {
  if (minutes === null) return '—'
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
}

/** Sun and moon almanac for the map centre. */
export function AlmanacPanel({ onClose }: AlmanacPanelProps) {
  const tx = useText()
  const center = useViewStore((state) => state.mapView.center)
  const dialogRef = useRef<HTMLElement | null>(null)
  useDialogFocus(dialogRef, onClose)
  const [dateText, setDateText] = useState(() => new Date().toISOString().slice(0, 10))
  const date = useMemo(() => new Date(`${dateText}T12:00:00Z`), [dateText])
  const valid = !Number.isNaN(date.getTime())
  const day = useMemo(
    () => (valid ? solarDay(date, center[1], center[0]) : null),
    [valid, date, center],
  )
  const moon = useMemo(() => (valid ? moonPhase(date) : null), [valid, date])
  const polar =
    day?.polar === 'day'
      ? tx('Полярный день', 'Polar day')
      : day?.polar === 'night'
        ? tx('Полярная ночь', 'Polar night')
        : null
  const phaseNames: Record<MoonPhaseName, string> = {
    new: tx('Новолуние', 'New moon'),
    'waxing-crescent': tx('Растущий серп', 'Waxing crescent'),
    'first-quarter': tx('Первая четверть', 'First quarter'),
    'waxing-gibbous': tx('Растущая Луна', 'Waxing gibbous'),
    full: tx('Полнолуние', 'Full moon'),
    'waning-gibbous': tx('Убывающая Луна', 'Waning gibbous'),
    'last-quarter': tx('Последняя четверть', 'Last quarter'),
    'waning-crescent': tx('Убывающий серп', 'Waning crescent'),
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="los-modal"
        role="dialog"
        aria-modal="true"
        aria-label={tx('Солнце и луна', 'Sun and moon')}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <span className="eyebrow">{tx('Поле', 'Field')}</span>
            <h2>{tx('Солнце и луна', 'Sun and moon')}</h2>
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

        <div className="los-grid">
          <label>
            <span>{tx('Дата', 'Date')}</span>
            <input
              type="date"
              value={dateText}
              onChange={(event) => setDateText(event.target.value)}
            />
          </label>
          <label>
            <span>{tx('Широта', 'Latitude')}</span>
            <input readOnly value={center[1].toFixed(4)} />
          </label>
          <label>
            <span>{tx('Долгота', 'Longitude')}</span>
            <input readOnly value={center[0].toFixed(4)} />
          </label>
          <label>
            <span>{tx('Часовой пояс', 'Time zone')}</span>
            <input
              readOnly
              value={Intl.DateTimeFormat().resolvedOptions().timeZone}
            />
          </label>
        </div>

        {day && moon ? (
          <>
            <div className="los-grid">
              <label>
                <span>{tx('Солнечный полдень', 'Solar noon')}</span>
                <strong>{time(day.solarNoon, '—')}</strong>
              </label>
              <label>
                <span>{tx('Восход', 'Sunrise')}</span>
                <strong>{time(day.sunrise, polar ?? '—')}</strong>
              </label>
              <label>
                <span>{tx('Закат', 'Sunset')}</span>
                <strong>{time(day.sunset, polar ?? '—')}</strong>
              </label>
              <label>
                <span>{tx('Долгота дня', 'Day length')}</span>
                <strong>{duration(day.dayLengthMinutes)}</strong>
              </label>
              <label>
                <span>{tx('Гражданские сумерки', 'Civil twilight')}</span>
                <strong>
                  {time(day.civilDawn, '—')} – {time(day.civilDusk, '—')}
                </strong>
              </label>
              <label>
                <span>{tx('Навигационные сумерки', 'Nautical twilight')}</span>
                <strong>
                  {time(day.nauticalDawn, '—')} – {time(day.nauticalDusk, '—')}
                </strong>
              </label>
              <label>
                <span>{tx('Астрономические сумерки', 'Astronomical twilight')}</span>
                <strong>
                  {time(day.astronomicalDawn, '—')} – {time(day.astronomicalDusk, '—')}
                </strong>
              </label>
              <label>
                <span>{tx('Фаза Луны', 'Moon phase')}</span>
                <strong>{phaseNames[moon.name]}</strong>
              </label>
              <label>
                <span>{tx('Освещённость', 'Illumination')}</span>
                <strong>{Math.round(moon.illumination * 100)}%</strong>
              </label>
              <label>
                <span>{tx('Возраст Луны', 'Moon age')}</span>
                <strong>{moon.ageDays.toFixed(1)} {tx('сут', 'd')}</strong>
              </label>
            </div>
            {polar && <p className="georef-ok">{polar}</p>}
            <p className="settings-hint">
              {tx(
                'Времена местные. Расчёт по NOAA, точность — минуты; для полярных широт восход и закат могут отсутствовать.',
                'Local times. NOAA equations, minute accuracy; at polar latitudes sunrise or sunset may not occur.',
              )}
            </p>
          </>
        ) : (
          <p className="georef-error">{tx('Некорректная дата', 'Invalid date')}</p>
        )}
        <p className="settings-hint">
          <Sun size={13} aria-hidden="true" />{' '}
          {tx(
            'Альманах работает офлайн: без сети, без API и без сторонних библиотек.',
            'The almanac works offline: no network, no API, no third-party libraries.',
          )}
        </p>
      </section>
    </div>
  )
}
