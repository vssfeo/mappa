# Передача контекста

**Дата:** 2026-10-25  
**Источник:** сессии Claude Code (`~/.claude/projects/-home-captry/a63e85bd-*.jsonl`,
проект `/home/captry/Projects AI/mappa`)  
**Для чего:** новый агент/разработчик должен войти в курс без чтения истории чата.

## Где мы находимся

Mappa — 1.0 release candidate. Реализованы: кэш тайлов, MBTiles/PMTiles
(растр и вектор), загрузчик с очередью и полигонной маской, экспорт паков
с подписью, CLI (`download/pack/doctor/batch/serve` + QR), DEM (SRTM, ASC,
GeoTIFF/COG, горизонтали, профиль, min AGL), GNSS (имитатор NMEA, внешний
TCP, gpsd), офлайн- и онлайн-маршруты (OSRM/BRouter, изохроны, коридор),
полевой режим, локализация RU/EN/DE/FR/ES.

Последний функциональный блок — пять пунктов, выполненных подряд:
векторные `.mbtiles`, прогресс/отмена экспорта, маршрутизация, полевой
режим, локализация. Отчёт по ним уже отдан пользователю.

## Git: главное

| Параметр | Значение |
|---|---|
| Ветка | `main`, HEAD `8f745e7 Add mappa serve tile server and REST API` |
| Коммитов | 19 (первый — 2026-10-24, «Initial Mappa 1.0 release candidate») |
| Remote | отсутствует |
| Рабочее дерево | 56 изменённых + 32 неотслеживаемых файла |

Незакоммиченные файлы — это не мелочь, а целые подсистемы:
`src-tauri/src/{dem,geotiff,gnss,geocode,routing,power,inflate}.rs`,
`crates/mappa-cli/src/{batch,qr}.rs`, `crates/mappa-core/src/inflate.rs`,
`ui/src/{RoutePanel.tsx,routing.ts,dem.ts,nmea.ts,gpsd.ts,gnssTcp.ts,geocode.ts,
useScreenAwake.ts,locales/}`, `ui/tests/{routing,nmea,gpsd,gnssTcp,geocode}.test.ts`,
`docs/{BATCH,DEM,GEOCODER,NMEA,PACKS,ROUTING}.md`, `ui/scripts/i18n-check.mjs`.

То есть история последних ~двух суток работы существует только на диске.
Резервной копии и remote нет.

## Проверено (2026-10-25, этот прогон)

- `make check` — зелёный: fmt, clippy `-D warnings`, 194 Rust-теста,
  113 UI-тестов, unicode-scan, oxlint, production-сборка UI.
- Собранные артефакты: `target/release/mappa` (16,2 МБ),
  `target/release/bundle/deb/Mappa_0.1.0_amd64.deb` (6,59 МиБ).
- `make smoke` и `make deb-check` в этом прогоне не повторялись;
  по отчёту предыдущей сессии — проходили (EN/DE/RU, полевой режим).

## Что не проверено вживую

- СК-42/МСК на реальных выписках геодезистов (пресеты зависят от proj4).
- OSRM/BRouter и изохроны на реальной дорожной сети.
- Полевой режим: солнце, перчатки, расход батареи, `systemd-inhibit`
  на разных дистрибутивах.
- Экспорт большого пака: прогресс, ETA, отмена на сотнях тысяч тайлов.
- Интероп: MBTiles/GPX в QGIS, GPX в Garmin.
- ARM64 на Rock Pi 4A / NanoPi M4 (в CI сборка есть, железо — нет).

## Предлагаемые следующие шаги

**P0 — сохранить работу (сделать первым).**
1. Разложить рабочее дерево на логические коммиты: DEM, NMEA/gpsd,
   геокодер, batch+QR, маршрутизация, полевой режим, i18n, документы.
2. Сделать бэкап: `git bundle create ~/Projects\ AI/git-backups/mappa-*.bundle --all`
   (рядом уже лежат бандлы других проектов).
3. Создать репозиторий на GitHub, запушить `main`, проверить
   `.github/workflows/ci.yml` (Linux amd64 + ARM64) на реальном runner.
   `repository` в `Cargo.toml` пока `https://example.invalid/mappa`.

**P1 — закрыть критерии 1.0 (Phase 7).**
- Performance pass: старт ≤1,5 с, 60 fps на 1440p, профиль памяти
  (`make bench`, `make bench-ui`, `make bench-large`).
- Онбординг первого запуска + демо-пак (сейчас пустой экран без подсказок).
- AppImage в дополнение к `.deb` (Flatpak — после).
- Crash reporting opt-in и release checklist; 10 внешних тестеров.
- Импорт кэша SAS.Planet (best-effort) — заметный магнит для аудитории.

**P1 — полевая приёмка (можно параллельно).**
- СК-42/МСК на 3–5 реальных выписках, сверить с proj4/геодезистом.
- Реальный GNSS-приёмник: NMEA по TCP/serial, трек при погашенном экране.
- Экспорт пака на 100–300 тыс. тайлов: ETA, отмена, свободное место.

**P2 — Phase 6 (дифференциаторы).**
- Viewshed/LOS + зона Френеля для радиолинков.
- Планирование миссий: waypoint/полигон/коридор/геозона, altitude modes,
  экспорт QGC `.plan`, DJI KMZ.
- Телеметрия MAVLink/ROS2/MQTT + WebSocket-оверлей (read-only).
- Прямой serial-порт GNSS, барометр, BLE-датчики.

**P2 — крупное после 1.0.**
Геореференсинг сканов (GCP, affine/Helmert/TPS → COG), полностью офлайн
дорожный граф с профилями и голосовыми подсказками, выбор объектов и
атрибуты внутри векторных паков, self-hosted sync для групп.

Рациональный порядок: **P0 → performance pass + онбординг/демо-пак →
полевая приёмка → mission planning и телеметрия**.
