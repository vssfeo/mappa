# Mappa — дорожная карта

**Версия:** 0.1  
**Дата:** 2026-10-23  
**Связанные документы:** [TZ.md](TZ.md), [UX.md](UX.md),
[COMPETITORS.md](COMPETITORS.md) — конкурентный анализ и бэклог функций.

---

## 1. Формат

- **Фаза** — крупный блок ценности.
- **Milestone** — то, что можно показать и проверить.
- **Срок** — один full-time разработчик + AI; дизайнер part-time.
- Если делать по вечерам — умножать на 1,8–2.
- Каждая фаза заканчивается демо и списком принятых/отложенных фич.

### Команда

| Роль | Загрузка |
|---|---|
| Product engineer (Rust + Tauri) | 1.0 FTE |
| UI/UX designer | 0.3–0.5 FTE |
| QA/field tester | 0.2 FTE, после Phase 2 |
| AI-ассистент | постоянно |

---

## 2. Обзор

| Milestone | Что | Срок | Критерий |
|---|---|---|---|
| M0 | Каркас и карта | 1 неделя | OSM открывается, тёмная тема, CI |
| M1 | Viewer | 3 недели | слои, координаты, команды, настройки |
| M2 | Downloader | 6 недель | 10k тайлов, pause/resume, MBTiles |
| M3 | Offline packs | 8 недель | PMTiles, импорт/экспорт, Cache Doctor |
| M4 | Pro tools | 11 недель | измерения, GPX, сравнение, печать |
| M5 | Automation | 14 недель | CLI, tile-server, REST |
| M6 | Field/Robot | 18 недель | ARM64, полевой режим, телеметрия |
| M7 | Beta / 1.0 | 24 недели | пакеты, документация, релиз |

---

## 3. Phase 0 — фундамент (неделя 1)

### Предпосылки

- [x] Rust stable + `cargo`.
- [x] Node.js 20+ и `npm` (Node 24).
- [x] WebKitGTK 4.1 dev-пакеты для Tauri.
- [x] Tauri CLI через `@tauri-apps/cli`.

### Задачи

- [x] Создать Rust workspace и каталоги `crates/`, `ui/`, `providers/`.
- [x] Tauri 2 + React + TypeScript + Vite.
- [x] MapLibre GL JS, тёмная тема, OSM-подложка.
- [x] Базовый layout: rail, top bar, inspector, status bar.
- [x] Командная палитра-скелет (`Ctrl+K`).
- [x] CI: `cargo fmt`, `cargo clippy`, `cargo test`, `npm lint`, `npm build`.
- [x] Логи `tauri-plugin-log`.
- [x] Кнопка «Открыть лог» (панель «Настройки» → «Открыть папку журнала»).
- [x] `README` и docs link.

### Демо

Запуск, карта OSM, зум/пан, `Ctrl+K` открывается, тема переключается.

### Критерий

- [x] Приложение собирается одной командой (`make build`, `make deb-check`).
- [x] Холодный старт ≤ 3 с: окно 0,07 с, canvas готов за 0,84 с.
- [x] Нет ошибок в консоли (Playwright smoke).
- [ ] CI зелёный: локальные `make check`, `make smoke`, `make deb-check` проходят; нужен первый push в GitHub.

---

## 4. Phase 1 — Viewer (недели 2–4)

### Задачи

- [x] `mappa-core`: Web Mercator, tile math, bbox, zoom ranges.
- [x] `mappa-net`: HTTP client, retry, timeout, User-Agent.
- [x] `mappa-storage`: SQLite cache (WAL), атомарная запись.
- [x] Провайдеры: YAML, 7 источников (OSM, OSM Germany, OpenTopoMap,
  CARTO, USGS, Esri World Imagery, NASA Blue Marble).
- [x] Пять встроенных источников; источники по ключу — через свои
  XYZ/WMS/WMTS с заголовками.
- [ ] JSON Schema каталога провайдеров.
- [x] Слои: добавление, удаление, порядок перетаскиванием
  (векторные слои и паки), видимость и прозрачность.
- [x] Координаты: DD/DMS/UTM, ввод и копирование.
- [x] Масштаб, атрибуция; линейка — Phase 4.
- [x] Настройки: тема, лимит кэша, очистка, HTTP-прокси.
- [x] Язык интерфейса RU/EN.
- [x] Сохранение view между запусками.
- [x] Клавиатурные сокращения v1.
- [x] Empty/error/offline состояния: пустые панели, toast ошибок карты,
  индикатор offline, встроенные сообщения валидации.

### Демо

Открыть карту, сменить 3 провайдера, добавить слой, скопировать
координаты, перезапустить — позиция сохранилась.

### Критерий

- [x] 60 fps pan/zoom на 1440p (60,0 fps, реальный GPU).
- [x] Тайл из кэша ≤ 16 мс (p50 5–13 мкс).
- [x] Новый провайдер через UI без перезапуска.
- [x] Ошибка URL показывает понятное сообщение: проверка абсолютного
  http(s)-URL и плейсхолдеров с подсветкой поля.

---

## 5. Phase 2 — Downloader (недели 5–7)

### Задачи

- [x] Выбор прямоугольника на карте (`R`, GeoJSON-подсветка).
- [x] Произвольный полигон/маска для скачивания.
- [x] Оценка тайлов/размера/времени.
- [x] Coverage map: карта уже скачанных тайлов по источникам.
- [x] Очередь: pause/resume/cancel (приоритеты позже).
- [x] Возобновление после перезапуска.
- [x] Per-provider concurrency и rate limit.
- [x] Retry с backoff, `Retry-After`.
- [x] Пропуск уже скачанных.
- [x] Экспорт MBTiles/PMTiles из UI и CLI.
- [x] Центр загрузок (`Ctrl+J`).
- [x] Уведомления о завершении задания в приложении (toast, `aria-live`).
- [x] Тесты mock HTTP/retry/rate limit; нагрузочный 10k — позже.
- [x] Legal-гейт `offline_allowed` для провайдеров.

### Демо

Нарисовать район, увидеть оценку, скачать 10k тайлов, поставить
на паузу, перезапустить приложение, продолжить, экспортировать MBTiles.

### Критерий

- [x] 10k тайлов без падений (бенч: вставка 9695 тайлов/с, чтение p50 5,4 мкс).
- [x] Пауза/продолжение не теряет прогресс.
- [x] UI не блокируется (60 fps, очередь 55k обновлений/с).
- [ ] MBTiles открывается в QGIS.

---

## 6. Phase 3 — Offline packs (недели 8–9)

### Задачи

- [x] PMTiles v3 writer/reader.
- [x] Манифест пака, SHA-256 и Ed25519-подпись.
- [x] Импорт PMTiles/MBTiles как слоя в UI.
- [x] Экспорт MBTiles/PMTiles из кэша с транскодингом PNG/JPEG.
- [x] Метаданные: bbox, zooms, provider, attribution.
- [x] License в метаданных пака и манифесте.
- [x] Cache Doctor: `quick_check`, `recount`, `vacuum`, `clear_expired`.
- [x] Ремонт битых тайлов.
- [x] Импорт папки XYZ.
- [x] Открытие пака без распаковки.

### Демо

Скачать район, собрать `moscow.pmtiles`, открыть в новом проекте
без сети, проверить SHA-256, открыть в QGIS.

### Критерий

- [x] Пак 2 ГБ открывается ≤ 1 с до первого тайла (0,26–0,34 мс).
- [x] Работает в офлайне (паки читаются без сети).
- [x] SHA-256 совпадает (манифест и подпись проверяются).
- [x] Cache Doctor находит искусственно битый тайл (тест ремонта).

---

## 7. Phase 4 — Pro tools (недели 10–12)

### Задачи

- [x] Линейка: посегментные расстояния, азимуты, сумма.
- [x] Площадь полигона и периметр (сферическая модель WGS84).
- [x] Метки: имя, описание, список, fly-to, перетаскивание, удаление,
  массовый импорт.
- [x] Импорт/экспорт GeoJSON/CSV: WGS84 DD, DMS, UTM.
- [x] Иконки/цвета/папки меток и поиск по ним.
- [x] GPX/KML импорт/экспорт меток; KMZ-экспорт и KMZ-импорт векторных слоёв.
- [x] Произвольные EPSG, СК-42/МСК через proj4rs.
- [x] Настраиваемые колонки CSV и разделитель в UI.
- [x] Трек: отображение и playback сохранённых линий (play/pause,
  перемотка, скорость, маркер).
- [x] Трек: график высоты/скорости и профиль GPX (`ele`/`time`),
  интерактивная перемотка, набор/сброс высоты и длительность.
- [x] Живое позиционирование и запись GPS/GNSS через системную
  геолокацию: точность, высота, скорость, курс, follow, пауза,
  сохранение трека в «Объекты» с профилем и GPX-экспортом.
- [ ] Внешний GNSS/gpsd/NMEA, off-route alerts.
- [x] Undo/redo для меток, линий/полигонов и импортированных слоёв (`Ctrl+Z`, `Ctrl+Shift+Z`).
- [x] Сравнение «шторка» (`C`, синхронный второй источник, граница
  мышью и стрелками).
- [x] Проекты `.mappa`: слои, вид, метки, объекты, паки, CRS.
- [x] Экспорт PNG + `.pgw`, GeoTIFF + `.tfw`, PDF с сеткой/легендой, KMZ.
  COG-тайлы и печать с полями — позже.
- [x] Векторные слои: KML/KMZ/GPX/GeoJSON/SHP/GeoPackage, стили,
  атрибутивная таблица и поиск по ней.
- [x] Рисование и редактирование линий/полигонов: вершины, цвета,
  автосохранение, GeoJSON import/export (`L`, `Shift+L`, `E`).
- [x] Snapping к вершинам и рёбрам при рисовании и измерении;
  автозакрытие колец, сборка полигонов с отверстиями.
- [x] Вставка вершины в произвольный сегмент.
- [x] Папки, иконки, цвета и поиск меток.
- [x] Проект `.mappa`: слои, вид, метки, объекты, паки, CRS.
- [x] Список недавних проектов; автосохранение проекта — позже.
- [x] Поиск координат в палитре: DD, DMS, UTM (`Ctrl+K`).

### Демо

Импортировать GPX, измерить маршрут, поставить метки, сравнить
две подложки, сохранить проект, экспортировать GeoJSON.

### Критерий

- [ ] Измерения совпадают с QGIS в пределах 0,1%.
- [ ] GPX открывается в Garmin/QGIS.
- [x] Undo/redo работает для меток и объектов; измерения имеют отдельный откат вершин.

---

## 8. Phase 5 — Automation (недели 13–15)

### Задачи

- [x] `mappa-cli download` без GUI.
- [x] `mappa-cli pack` (MBTiles/PMTiles).
- [x] Переименовать бинарник в `mappa` и включить в `.deb`.
- [x] Свои XYZ/TMS и WMS GetMap: headers/API keys, rate limit,
  офлайн-флаг, редактирование записей.
- [x] Менеджер источников 2.0: WMTS, GetCapabilities,
  регистрация auth query/basic, каталог пресетов.
- [x] CRS-движок: proj4rs, произвольные EPSG/proj4, СК-42/МСК, UTM,
  статус-бар и ввод координат в выбранной проекции.
- [x] CRS 2.0: MGRS, сетка координат на карте, сближение меридианов,
  СК-42 X/Y/Z в редакторе точек.
- [ ] Офлайн-геокодер Nominatim/Photon + online fallback.
- [ ] `mappa serve` — локальный tile-server и раздача паков по LAN/QR.
- [ ] REST API: статус, очередь, паки.
- [ ] Batch JSON jobs, JSON-вывод, идемпотентность.
- [x] Headless-режим для download/pack/doctor.
- [ ] Документация CLI и API (краткая в README есть).
- [x] Примеры для CI/роботов (USGS, public domain).

### Демо

```bash
mappa-cli download --provider usgs --bbox=-122.5,37.7,-122.4,37.8 --zoom 12-14
mappa-cli pack --provider usgs --bbox=-122.5,37.7,-122.4,37.8 --zoom 12-14 --output sf.mbtiles
mappa serve --pack sf.mbtiles --port 8080
curl http://127.0.0.1:8080/health
```

### Критерий

- [ ] CLI работает без GUI.
- [ ] Tile-server отдаёт тайлы MapLibre и QGIS.
- [ ] REST API документирован.
- [ ] Коды возврата и ошибки предсказуемы.

---

## 9. Phase 6 — Field / Robot (недели 16–19)

### Задачи

- [ ] Полевой режим: крупный UI, контраст, reduced motion.
- [x] GPS/GNSS-позиция, курс, скорость, высота, запись трека,
  playback и GPX-экспорт.
- [ ] Внешний GNSS/gpsd/NMEA, off-route alerts и запись при
  выключенном экране.
- [ ] DEM: SRTM/Copernicus, hillshade, contours, профиль высот, min AGL,
  slope; MapLibre terrain.
- [ ] Viewshed/LOS + Fresnel для радиолинков.
- [ ] Планирование миссий: waypoint/полигон/коридор/геозона, altitude
  modes, экспорт QGC `.plan`/MAVLink/DJI KMZ.
- [ ] Read-only телеметрия: MAVLink, ROS2 `/odom`/`/path`, MQTT.
- [x] ARM64-сборка в CI (`ubuntu-24.04-arm`, проверка бинарника и CLI).
- [ ] Smoke-тест на Rock Pi 4A и NanoPi M4.
- [ ] Tile-server на борту, раздача паков по LAN/QR.
- [ ] WebSocket-оверлей телеметрии (MVP).
- [ ] Экономия батареи.

### Демо

Запустить на Rock Pi 4A, открыть пак, раздать tile-server,
подключить телефон по QR, показать GPS-трек.

### Критерий

- [ ] ARM64 AppImage/deb запускается.
- [ ] Tile-server держит 3 клиента.
- [ ] Полевой режим читается на солнце.
- [ ] Нет утечек памяти за 2 часа.

---

## 10. Phase 7 — Beta / 1.0 (недели 20–24)

### Задачи

- [ ] Performance pass: старт, память, рендер.
- [x] Accessibility pass: контраст, клавиатура, focus trap, screen reader.
- [x] i18n RU/EN, переключение языка в настройках.
- [ ] Онбординг и демо-пак.
- [ ] Импорт SAS.Planet cache (best-effort).
- [x] Подпись паков (Ed25519).
- [ ] AppImage/deb/Flatpak.
- [x] Документация пользователя и разработчика.
- [ ] Crash reporting opt-in.
- [ ] Release checklist.

### Демо

Публичная beta: установка на чистой Ubuntu, первый пак за 3 минуты,
офлайн-работа, экспорт в QGIS.

### Критерий

- [ ] 95% сессий без crash.
- [ ] Startup ≤ 1,5 с.
- [ ] 60 fps на 1440p.
- [ ] 10 внешних тестеров прошли сценарий без подсказок.
- [ ] Все must-have FR из TZ закрыты.

---

## 11. После 1.0

| Направление | Что |
|---|---|
| Windows/macOS | сборки, подпись, автоапдейт |
| Плагины | WASM-провайдеры и трансформации |
| 3D Tiles | LiDAR, point clouds, фотограмметрия |
| Роботы | MAVLink, геозоны, миссии |
| Команда | общий кэш, реестр паков, SSO |
| Мобильное | PWA/field web |
| Форматы | GeoPackage, COG, WMS-T |
| Исторические снимки | легальные архивы, таймлайн |

---

## 12. Конкурентный бэклог

Полный разбор функций SAS.Planet, QGIS, Global Mapper, MapTiler, Felt,
QGC/Mission Planner, UgCS, CalTopo, Avenza и полевых приложений —
в [COMPETITORS.md](COMPETITORS.md). Ниже — сжатый приоритет.

### P0 — паритет с SAS.Planet и базовый GIS

- [x] Свои XYZ/TMS и WMS GetMap: headers/API keys, rate limit,
  attribution, hot-reload слоя, офлайн-флаг, редактирование.
- [x] WMTS, GetCapabilities, пресеты заголовков Bearer/X-Api-Key/Basic.
- [ ] Per-source policy и каталог пресетов источников.
- [x] CRS-движок: proj4rs, EPSG/proj4, СК-42/МСК, UTM, пересчёт
  статус-бара и ввод координат в выбранной проекции.
- [ ] CRS 2.0: MGRS, сетка координат, сближение меридианов,
  магнитное склонение.
- [x] Векторные слои: KML/KMZ/GPX/GeoJSON/SHP/GeoPackage, стили,
  attribute table, snapping; редактирование импортированных геометрий — позже.
- [x] GPX/KML/CSV/GeoJSON импорт-экспорт меток.
- [x] Папки, иконки, цвета и поиск меток.
- [ ] Шаблоны меток.
- [ ] DEM и рельеф: hillshade, contours, профиль высот, min AGL, slope,
  3D terrain.
- [ ] GPS и треки: позиция, запись, playback, маршруты, off-route alerts.
- [x] Экспорт: GeoTIFF + `.tfw`, PNG + `.pgw`, PDF с сеткой/легендой,
  KMZ. COG — позже.
- [x] Проект `.mappa` (JSON + паки; SQLite-хранилище — по мере роста).
- [x] Полигонная маска загрузки с подсчётом только пересекающихся
  тайлов.
- [ ] Download engine 2.0: мультиисточник, coverage map, менеджер
  кэша по источникам.

### P1 — дифференциаторы

- [ ] Геореференсинг сканов: GCP, affine/Helmert/poly/TPS, COG.
- [ ] Сетка MGRS/USNG, номенклатура листов, сближение.
- [ ] Viewshed/LOS + Fresnel, SAR-паттерны.
- [ ] Mission planning и экспорт QGC/MAVLink/DJI.
- [ ] Телеметрия MAVLink/ROS2/MQTT, replay.
- [ ] Офлайн-геокодер и routing OSRM/Valhalla/BRouter, изохроны,
  turn-by-turn, route-scoped download.
- [ ] Полевые формы, фото/аудио, geotagging.
- [ ] Safety: backtrack, proximity/geofence-алерты, live tracking.
- [ ] Внешний GNSS/NMEA/gpsd, барометр, BLE-датчики.
- [ ] Погода, солнце/луна, тренд давления; avalanche/fire-слои.
- [ ] Accessibility: screen reader, крупные цели, reduced motion.
- [ ] MGRS/USNG, Maidenhead, Plus Codes.
- [ ] SHP/DXF/GeoPackage/Excel, RMaps/OruxMaps.
- [ ] 3D buildings, COG overlay, vector tiles из своих данных.
- [ ] Self-hosted sync для команд/SAR.

### P2 — после 1.0

- [ ] LiDAR/LAS, point clouds, 3D Tiles, volume/cut-fill, watershed.
- [ ] Photogrammetry-интеграция (ODM/Metashape).
- [ ] Real-time multiplayer, комментарии, роли.
- [ ] Plugin API/WASM, MCP, Python scripting.
- [ ] Mobile companion/PWA.
- [ ] JNX/RMP — только после юридической проверки.

---

## 13. Backlog идей

- Импорт SAS.Planet marks.
- Сравнение 3+ подложек.
- Автоматическое обновление паков по bbox.
- «Map pack registry» с подписями.
- Планировщик ночных загрузок.
- Плагин QGIS для чтения паков.
- CLI `mappa doctor`.
- Поддержка тач-экрана и пера.
- Мини-карта и обзорная схема.
- Слой тайлов с офлайн-векторными подписями.
- Экспорт в печать с сеткой и легендой.
- Синхронизация закладок через файл.

---

## 14. Риски и gates

| Gate | Что проверяем | Если провал |
|---|---|---|
| G0 | Tauri + MapLibre + WebKitGTK | fallback на локальный HTTP/другой стек |
| G1 | 60 fps и кэш | оптимизация рендера/кэша, не добавлять фичи |
| G2 | 10k тайлов | пересмотр очереди/сети |
| G3 | PMTiles 2 ГБ | пересмотр формата/индексов |
| G4 | ARM64 | упростить UI/зависимости |
| G5 | Beta-тест | срезать C-фичи, не Must |

---

## 15. Метрики

- Time to first map.
- Time to first pack.
- Download success rate.
- Crash-free sessions.
- Cache hit rate.
- Провайдер добавлен за ≤ 2 мин.
- Пак открыт на ARM64.
- 10 тестеров без подсказок.

---

## 16. Definition of Release

- Все Must-требования TZ закрыты.
- Нет открытых P0/P1 багов.
- Есть установщики для Linux x86_64 и ARM64.
- Документация: быстрый старт, провайдеры, CLI, FAQ.
- Лицензии и attribution проверены.
- Есть демо-пак и видео 90 секунд.
- Есть план отката/экспорта данных.
