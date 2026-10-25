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
  Waves,
  XCircle,
} from 'lucide-react'
import { FEATURE_COLORS } from './features.ts'
import { formatCount, formatDuration } from './format.ts'
import { formatCoordinatePair, formatDistance } from './geo.ts'
import {
  gpsTrackFeature,
  useGpsStore,
  type GpsError,
  type GpsSource,
} from './gps.ts'
import { useText } from './i18n.ts'
import { isNativeGnss } from './gnssTcp.ts'
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
    case 'nmea':
      return tx(
        'Не удалось открыть NMEA-поток. Проверьте адрес, порт и источник.',
        'Could not open the NMEA stream. Check the address, port and source.',
      )
    case 'gpsd':
      return tx(
        'Не удалось открыть gpsd. Проверьте, что демон запущен и доступен host:port.',
        'Could not open gpsd. Check that the daemon is running and host:port is reachable.',
      )
  }
}

export function GpsPanel({ map }: { map: MapLibreMap | null }) {
  const tx = useText()
  const locale = useAppStore((state) => state.locale)
  const coordinateFormat = useAppStore((state) => state.coordinateFormat)
  const showToast = useAppStore((state) => state.showToast)
  const supported = useGpsStore((state) => state.supported)
  const source = useGpsStore((state) => state.source)
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
  const setSource = useGpsStore((state) => state.setSource)
  const simulationSpeed = useGpsStore((state) => state.simulationSpeed)
  const setSimulationSpeed = useGpsStore(
    (state) => state.setSimulationSpeed,
  )
  const setSimulationStart = useGpsStore(
    (state) => state.setSimulationStart,
  )
  const nmeaHost = useGpsStore((state) => state.nmeaHost)
  const nmeaPort = useGpsStore((state) => state.nmeaPort)
  const gpsdHost = useGpsStore((state) => state.gpsdHost)
  const gpsdPort = useGpsStore((state) => state.gpsdPort)
  const streamStatus = useGpsStore((state) => state.streamStatus)
  const streamError = useGpsStore((state) => state.streamError)
  const setNmeaEndpoint = useGpsStore((state) => state.setNmeaEndpoint)
  const setGpsdEndpoint = useGpsStore((state) => state.setGpsdEndpoint)
  const nmeaLog = useGpsStore((state) => state.nmeaLog)
  const [clock, setClock] = useState(() => Date.now())
  const external = source === 'nmea-tcp' || source === 'gpsd'
  const nmeaSource =
    source === 'nmea' || source === 'nmea-tcp' || source === 'gpsd'
  const endpointHost = source === 'gpsd' ? gpsdHost : nmeaHost
  const endpointPort = source === 'gpsd' ? gpsdPort : nmeaPort
  const available =
    source === 'nmea' ||
    (external && endpointHost.trim().length > 0) ||
    supported

  const rememberMapCenter = () => {
    if (source !== 'nmea' || !map) return
    const center = map.getCenter()
    setSimulationStart([center.lng, center.lat])
  }

  const startWatchHere = () => {
    if (!fix) rememberMapCenter()
    startWatch()
  }

  const startRecordingHere = () => {
    if (!fix) rememberMapCenter()
    startRecording()
  }

  const changeSource = (next: GpsSource) => {
    if (next === 'nmea' && map) {
      const center = map.getCenter()
      setSimulationStart([center.lng, center.lat])
    }
    setSource(next)
  }

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
      tx(
        'GPS-трек {p0}',
        'GPS track {p0}',
        { p0: time },
      ),
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
        'GPS-трек сохранён: {p0} точек',
        'GPS track saved: {p0} points',
        { p0: formatCount(samples.length) },
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
              {source === 'browser' && !supported
                ? tx('Геолокация недоступна', 'Geolocation unavailable')
                : status === 'locating'
                  ? source === 'nmea'
                    ? tx('Запуск NMEA…', 'Starting NMEA…')
                    : source === 'nmea-tcp'
                      ? streamStatus === 'connected'
                        ? tx(
                            'NMEA TCP: ожидание данных',
                            'NMEA TCP: waiting for data',
                          )
                        : tx('Подключение к NMEA…', 'Connecting to NMEA…')
                      : source === 'gpsd'
                        ? streamStatus === 'connected'
                          ? tx('gpsd: ожидание данных', 'gpsd: waiting for data')
                          : tx('Подключение к gpsd…', 'Connecting to gpsd…')
                        : tx('Поиск позиции…', 'Finding position…')
                  : fix
                    ? source === 'nmea'
                      ? tx('NMEA-имитация активна', 'NMEA simulation active')
                      : source === 'nmea-tcp'
                        ? tx('NMEA TCP активен', 'NMEA TCP active')
                        : source === 'gpsd'
                          ? tx('gpsd активен', 'gpsd active')
                          : tx('GNSS активен', 'GNSS active')
                    : external && status === 'error'
                      ? source === 'gpsd'
                        ? tx('Ошибка gpsd', 'gpsd error')
                        : tx('Ошибка NMEA TCP', 'NMEA TCP error')
                      : tx('Ожидание сигнала', 'Waiting for a fix')}
            </strong>
          </div>
          <span
            className={`status-dot${fix ? ' is-live' : ''}`}
            title={fix ? tx('Есть позиция', 'Position available') : undefined}
          />
        </div>

        <div className="settings-field gps-source">
          <span className="gps-source-label">
            <Waves size={12} />
            {tx('Источник', 'Source')}
          </span>
          <select
            className="settings-input"
            value={source}
            onChange={(event) =>
              changeSource(event.target.value as GpsSource)
            }
            disabled={recording}
            aria-label={tx('Источник GNSS', 'GNSS source')}
          >
            <option value="browser">
              {tx('Системный GNSS', 'System GNSS')}
            </option>
            <option value="nmea">{tx('NMEA-имитация', 'NMEA simulation')}</option>
            <option value="nmea-tcp">{tx('NMEA TCP', 'NMEA TCP')}</option>
            <option value="gpsd">{tx('gpsd (JSON)', 'gpsd (JSON)')}</option>
          </select>
        </div>

        {source === 'nmea' && (
          <>
            <div className="settings-field gps-source">
              <span>{tx('Скорость', 'Speed')}</span>
              <input
                type="range"
                min="0"
                max="30"
                step="0.5"
                value={simulationSpeed}
                onChange={(event) =>
                  setSimulationSpeed(Number(event.target.value))
                }
                aria-label={tx(
                  'Скорость NMEA-имитации',
                  'NMEA simulation speed',
                )}
              />
              <span className="mono">
                {simulationSpeed.toFixed(1)} {tx('м/с', 'm/s')}
              </span>
            </div>
            <p className="settings-hint">
              {tx(
                'GGA, RMC, VTG и GSA раз в секунду по кругу радиусом 600 м от центра карты. Трек и запись работают так же, как с приёмником.',
                'GGA, RMC, VTG and GSA every second around a 600 m circle from the map centre. Recording and tracks behave exactly as with a receiver.',
              )}
            </p>
          </>
        )}

        {external && (
          <>
            <div className="settings-field gps-source">
              <span>{tx('Сервер', 'Host')}</span>
              <input
                className="settings-input"
                value={endpointHost}
                placeholder="127.0.0.1"
                onChange={(event) => {
                  if (source === 'gpsd') {
                    setGpsdEndpoint(event.target.value, gpsdPort)
                  } else {
                    setNmeaEndpoint(event.target.value, nmeaPort)
                  }
                }}
                disabled={recording}
                aria-label={tx('Адрес GNSS-сервера', 'GNSS server host')}
              />
            </div>
            <div className="settings-field gps-source">
              <span>{tx('Порт', 'Port')}</span>
              <input
                className="settings-input"
                type="number"
                min="1"
                max="65535"
                value={endpointPort}
                onChange={(event) => {
                  if (source === 'gpsd') {
                    setGpsdEndpoint(gpsdHost, Number(event.target.value))
                  } else {
                    setNmeaEndpoint(nmeaHost, Number(event.target.value))
                  }
                }}
                disabled={recording}
                aria-label={tx('Порт GNSS-сервера', 'GNSS server port')}
              />
            </div>
            <p className="settings-hint">
              {source === 'gpsd'
                ? tx(
                    'Подключение к gpsd по JSON-протоколу (TPV/SKY), обычно порт 2947. Демон сам работает с приёмником.',
                    'Connects to gpsd over its JSON protocol (TPV/SKY), usually port 2947. The daemon owns the receiver.',
                  )
                : tx(
                    'Подключение к источнику NMEA 0183 по TCP с автопереподключением. Приёмник можно отдать в сеть через socat или serial-to-TCP мост.',
                    'Connects to an NMEA 0183 source over TCP and reconnects automatically. Expose a receiver with socat or a serial-to-TCP bridge.',
                  )}
            </p>
            {streamStatus !== 'idle' && (
              <p className="settings-hint">
                {streamStatus === 'connected'
                  ? tx(
                      'TCP подключён: {p0}:{p1}',
                      'TCP connected: {p0}:{p1}',
                      { p0: endpointHost, p1: endpointPort },
                    )
                  : streamStatus === 'connecting'
                    ? tx('Подключение…', 'Connecting…')
                    : tx(
                        'Нет соединения, повтор через 3 с.',
                        'No connection, retrying in 3 s.',
                      )}
              </p>
            )}
            {streamError && (
              <p className="gps-error" role="status">
                {streamError}
              </p>
            )}
            {!isNativeGnss() && (
              <p className="settings-hint">
                {tx(
                  'TCP-поток доступен только в настольном приложении.',
                  'The TCP stream is available only in the desktop app.',
                )}
              </p>
            )}
          </>
        )}

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
            {nmeaSource && (
              <p className="gps-nmea-meta">
                {source === 'gpsd'
                  ? 'gpsd'
                  : source === 'nmea-tcp'
                    ? 'NMEA TCP'
                    : 'NMEA'}{' '}
                · {fix.satellites ?? '—'} {tx('спутников', 'satellites')} ·
                HDOP {fix.hdop === null || fix.hdop === undefined
                  ? '—'
                  : fix.hdop.toFixed(1)}
              </p>
            )}
          </>
        ) : (
          <p className="settings-hint">
            {source === 'nmea'
              ? tx(
                  'Нажмите «Найти меня» или «Начать запись» — имитатор начнёт выдавать NMEA-строки.',
                  'Press “Find me” or “Start recording” to start the NMEA simulator.',
                )
              : source === 'nmea-tcp'
                ? tx(
                    'Нажмите «Найти меня» или «Начать запись» — приложение подключится к TCP-источнику.',
                    'Press “Find me” or “Start recording” to connect to the TCP source.',
                  )
                : source === 'gpsd'
                  ? tx(
                      'Нажмите «Найти меня» или «Начать запись» — приложение подключится к gpsd и запросит JSON-отчёты TPV/SKY.',
                      'Press “Find me” or “Start recording” to connect to gpsd and request TPV/SKY JSON reports.',
                    )
                  : tx(
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
                onClick={startRecordingHere}
                disabled={!available}
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
                  onClick={startWatchHere}
                  disabled={!available}
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
        {nmeaSource && nmeaLog.length > 0 && (
          <pre
            className="nmea-log"
            aria-label={
              source === 'gpsd'
                ? tx('Поток gpsd', 'gpsd stream')
                : tx('Поток NMEA', 'NMEA stream')
            }
          >
            {nmeaLog.join('\n')}
          </pre>
        )}
        {source === 'browser' && !supported && (
          <p className="settings-hint">
            {tx(
              'В этой сборке WebView системная геолокация недоступна. Выберите NMEA-имитацию, NMEA TCP или gpsd.',
              'System location is unavailable in this WebView build. Choose the NMEA simulation, NMEA TCP or gpsd.',
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
