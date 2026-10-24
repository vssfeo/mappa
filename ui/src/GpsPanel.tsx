/** GPS/GNSS panel: live fix, recorder controls and the saved track. */

import { useEffect, useMemo, useState } from 'react'
import type { Map as MapLibreMap } from 'maplibre-gl'
import {
  CircleDot,
  LocateFixed,
  Pause,
  Play,
  Save,
  Satellite,
  Trash2,
  XCircle,
} from 'lucide-react'
import { FEATURE_COLORS } from './features.ts'
import { formatCount, formatDuration } from './format.ts'
import { formatCoordinatePair, formatDistance } from './geo.ts'
import { gpsTrackFeature, useGpsStore, type GpsError } from './gps.ts'
import { useText } from './i18n.ts'
import { useAppStore } from './store.ts'
import { buildTrackProfile } from './trackProfile.ts'

const headingLabel = (heading: number | null): string => {
  if (heading === null) return '—'
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return `${Math.round(heading)}° ${directions[Math.round(heading / 45) % 8]}`
}

const speedLabel = (speed: number | null): string =>
  speed === null ? '—' : `${formatCount(Math.round(speed * 3.6))} km/h`

const errorLabel = (
  code: GpsError,
  tx: (ru: string, en: string) => string,
): string => {
  switch (code) {
    case 'denied':
      return tx(
        'Доступ к геолокации запрещён. Разрешите его в настройках системы.',
        'Location access is denied. Allow it in the system settings.',
      )
    case 'unavailable':
      return tx(
        'GNSS недоступен. Проверьте приёмник и системную геолокацию.',
        'GNSS is unavailable. Check the receiver and system location.',
      )
    case 'timeout':
      return tx(
        'Нет ответа от GNSS. Попробуйте ещё раз на открытом месте.',
        'GNSS did not respond. Try again with a clear view of the sky.',
      )
    case 'watch':
      return tx(
        'Не удалось запустить geolocation API.',
        'Could not start the geolocation API.',
      )
  }
}

export function GpsPanel({ map }: { map: MapLibreMap | null }) {
  const tx = useText()
  const locale = useAppStore((state) => state.locale)
  const coordinateFormat = useAppStore((state) => state.coordinateFormat)
  const showToast = useAppStore((state) => state.showToast)
  const supported = useGpsStore((state) => state.supported)
  const status = useGpsStore((state) => state.status)
  const error = useGpsStore((state) => state.error)
  const fix = useGpsStore((state) => state.fix)
  const recording = useGpsStore((state) => state.recording)
  const paused = useGpsStore((state) => state.paused)
  const samples = useGpsStore((state) => state.samples)
  const startedAt = useGpsStore((state) => state.startedAt)
  const follow = useGpsStore((state) => state.follow)
  const startWatch = useGpsStore((state) => state.startWatch)
  const stopWatch = useGpsStore((state) => state.stopWatch)
  const startRecording = useGpsStore((state) => state.startRecording)
  const pauseRecording = useGpsStore((state) => state.pauseRecording)
  const resumeRecording = useGpsStore((state) => state.resumeRecording)
  const resetRecording = useGpsStore((state) => state.resetRecording)
  const setFollow = useGpsStore((state) => state.setFollow)
  const [clock, setClock] = useState(() => Date.now())

  useEffect(() => {
    if (!recording || paused) return
    const timer = setInterval(() => setClock(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [recording, paused])

  const model = useMemo(
    () =>
      buildTrackProfile(
        samples.map((sample) => [sample.lon, sample.lat]),
        {
          elevations: samples.map((sample) => sample.altitude),
          times: samples.map((sample) =>
            new Date(sample.timestamp).toISOString(),
          ),
        },
      ),
    [samples],
  )
  const elapsed =
    startedAt === null
      ? null
      : Math.max(0, (clock - startedAt) / 1000)
  const liveSpeed =
    fix?.speed ?? model.samples[model.samples.length - 1]?.speed ?? null

  const save = () => {
    const time = new Date(startedAt ?? Date.now()).toLocaleTimeString(
      locale === 'ru' ? 'ru-RU' : 'en-US',
      { hour: '2-digit', minute: '2-digit' },
    )
    const feature = gpsTrackFeature(
      samples,
      tx(`GPS-трек ${time}`, `GPS track ${time}`),
      FEATURE_COLORS[1],
    )
    if (!feature) {
      showToast(
        tx(
          'Для трека нужно минимум две точки',
          'A track needs at least two points',
        ),
      )
      return
    }
    const state = useAppStore.getState()
    state.addFeatures([feature])
    state.selectFeature(feature.id)
    state.setPanel('features')
    state.showToast(
      tx(
        `GPS-трек сохранён: ${formatCount(samples.length)} точек`,
        `GPS track saved: ${formatCount(samples.length)} points`,
      ),
    )
    resetRecording()
    stopWatch()
  }

  return (
    <div className="inspector-body">
      <section className="card gps-card">
        <div className="card-heading">
          <span className="card-icon">
            <Satellite size={15} />
          </span>
          <div>
            <span className="eyebrow">
              {tx('Текущая позиция', 'Current position')}
            </span>
            <strong>
              {!supported
                ? tx('Геолокация недоступна', 'Geolocation unavailable')
                : status === 'locating'
                  ? tx('Поиск позиции…', 'Finding position…')
                  : fix
                    ? tx('GNSS активен', 'GNSS active')
                    : tx('Ожидание сигнала', 'Waiting for a fix')}
            </strong>
          </div>
          <span
            className={`status-dot${fix ? ' is-live' : ''}`}
            title={fix ? tx('Есть позиция', 'Position available') : undefined}
          />
        </div>

        {error && (
          <p className="gps-error" role="alert">
            {errorLabel(error, tx)}
          </p>
        )}

        {fix ? (
          <>
            <div className="gps-coordinates mono">
              {formatCoordinatePair(fix.lon, fix.lat, coordinateFormat)}
            </div>
            <div className="gps-metrics">
              <div>
                <span>{tx('Точность', 'Accuracy')}</span>
                <strong>± {formatCount(Math.round(fix.accuracy))} m</strong>
              </div>
              <div>
                <span>{tx('Высота', 'Altitude')}</span>
                <strong>
                  {fix.altitude === null
                    ? '—'
                    : `${formatCount(Math.round(fix.altitude))} m`}
                </strong>
              </div>
              <div>
                <span>{tx('Скорость', 'Speed')}</span>
                <strong>{speedLabel(liveSpeed)}</strong>
              </div>
              <div>
                <span>{tx('Курс', 'Heading')}</span>
                <strong>{headingLabel(fix.heading)}</strong>
              </div>
            </div>
          </>
        ) : (
          <p className="settings-hint">
            {tx(
              'Разрешите доступ к геолокации и включите GNSS. Позиция появится на карте автоматически.',
              'Allow location access and enable GNSS. The position will appear on the map automatically.',
            )}
          </p>
        )}

        <div className="gps-actions">
          {!recording && (
            <>
              <button
                type="button"
                className="primary-button"
                onClick={startRecording}
                disabled={!supported}
              >
                <CircleDot size={14} />
                {tx('Начать запись', 'Start recording')}
              </button>
              {status === 'watching' || status === 'locating' ? (
                <button
                  type="button"
                  className="ghost-button"
                  onClick={stopWatch}
                >
                  <XCircle size={14} />
                  {tx('Остановить приём', 'Stop receiving')}
                </button>
              ) : (
                <button
                  type="button"
                  className="ghost-button"
                  onClick={startWatch}
                  disabled={!supported}
                >
                  <LocateFixed size={14} />
                  {tx('Найти меня', 'Find me')}
                </button>
              )}
            </>
          )}
          {recording && (
            <>
              <button
                type="button"
                className="ghost-button is-active"
                onClick={paused ? resumeRecording : pauseRecording}
              >
                {paused ? <Play size={14} /> : <Pause size={14} />}
                {paused ? tx('Продолжить', 'Resume') : tx('Пауза', 'Pause')}
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={save}
                disabled={samples.length < 2}
                title={
                  samples.length < 2
                    ? tx(
                        'Нужно минимум две точки',
                        'At least two points are required',
                      )
                    : undefined
                }
              >
                <Save size={14} />
                {tx('Сохранить трек', 'Save track')}
              </button>
              <button
                type="button"
                className="ghost-button is-danger"
                onClick={resetRecording}
              >
                <Trash2 size={14} />
                {tx('Сбросить', 'Discard')}
              </button>
            </>
          )}
        </div>

        <label className="source-check">
          <input
            type="checkbox"
            checked={follow}
            onChange={(event) => setFollow(event.target.checked)}
          />
          {tx('Следить за позицией на карте', 'Follow the position on the map')}
        </label>
        {follow && fix && (
          <button
            type="button"
            className="ghost-button"
            onClick={() =>
              map?.easeTo({
                center: [fix.lon, fix.lat],
                zoom: Math.max(map.getZoom(), 15),
                duration: 500,
              })
            }
          >
            <LocateFixed size={14} />
            {tx('Центрировать', 'Center on map')}
          </button>
        )}
        {!supported && (
          <p className="settings-hint">
            {tx(
              'В этой сборке WebView системная геолокация недоступна. Для внешнего GNSS на Linux нужен приёмник и gpsd.',
              'System location is unavailable in this WebView build. External GNSS on Linux needs a receiver and gpsd.',
            )}
          </p>
        )}
      </section>

      {recording && (
        <section className="section">
          <div className="section-heading">
            <span>{tx('Запись трека', 'Track recording')}</span>
            <span className="mono">
              {paused ? tx('пауза', 'paused') : tx('идёт', 'live')}
            </span>
          </div>
          <div className="gps-metrics is-recording">
            <div>
              <span>{tx('Точек', 'Points')}</span>
              <strong>{formatCount(samples.length)}</strong>
            </div>
            <div>
              <span>{tx('Дистанция', 'Distance')}</span>
              <strong>{formatDistance(model.stats.distance)}</strong>
            </div>
            <div>
              <span>{tx('Время', 'Time')}</span>
              <strong>{elapsed === null ? '—' : formatDuration(elapsed)}</strong>
            </div>
            <div>
              <span>{tx('Набор', 'Ascent')}</span>
              <strong>{formatCount(Math.round(model.stats.ascent))} m</strong>
            </div>
          </div>
          <p className="settings-hint">
            {tx(
              'Пропускаются точки ближе 2 м и с точностью хуже 100 м; неподвижный трек получает точку раз в 30 секунд.',
              'Fixes closer than 2 m or worse than 100 m accuracy are skipped; a stationary track gets one point every 30 seconds.',
            )}
          </p>
        </section>
      )}
    </div>
  )
}
