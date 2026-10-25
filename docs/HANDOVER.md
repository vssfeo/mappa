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

## Git

| Параметр | Значение |
|---|---|
| Ветка | `main`, HEAD — коммит «Measure and speed up startup» |
| Коммитов | 30 (первый — 2026-10-24, «Initial Mappa 1.0 release candidate») |
| Рабочее дерево | чистое |
| `origin` | `/home/captry/Projects AI/git-backups/mappa.git` (локальный bare) |
| Бэкап | `/home/captry/Projects AI/git-backups/mappa-all-20261025.bundle` |
| GitHub | не подключён: на машине нет `gh`, GitHub-токена и SSH-ключа |

Работа двух суток (DEM, GNSS, геокодер, batch/QR, маршрутизация, полевой
режим, локализация, экспорт и векторные MBTiles) разложена на 10 тематических
коммитов. Всё запушено в локальный `origin`.

Подключение GitHub, когда появятся доступы:

```bash
gh repo create mappa --private --source . --remote github
git push -u github main
```

или вручную: создать пустой репозиторий и `git remote add github <url>`.
`repository` в `Cargo.toml` пока `https://example.invalid/mappa` — заменить.

## Проверено (2026-10-25)

- `make check` — зелёный: fmt, clippy `-D warnings`, 194 Rust-теста,
  113 UI-тестов, unicode-scan, oxlint, production-сборка UI.
- `make smoke` — SMOKE OK (EN/DE/RU, полевой режим).
- `make bench-start`, `make bench-ui`, `make startup` — числа и методика
  в [PERFORMANCE.md](PERFORMANCE.md).
- Собранные артефакты: `target/release/mappa` (16,2 МБ),
  `target/release/bundle/deb/Mappa_0.1.0_amd64.deb` (6,59 МиБ); `.deb`
  собран до правок производительности, перед релизом пересобрать.

## Производительность

| Метрика | Значение |
|---|---|
| Окно на экране | ~70 мс |
| Процесс WebKit запущен | ~330 мс |
| First contentful paint | 84 мс (было 780) |
| Канвас карты готов | ~760 мс |
| Панорамирование 2560×1440 | 60 fps |
| Суммарный PSS | ~309 МиБ |

Сделано: статический boot-экран в `ui/index.html` с темой из localStorage;
харнессы `ui/scripts/bench-start.mjs` и `scripts/measure-startup.sh`.

## Что не проверено вживую

- СК-42/МСК на реальных выписках геодезистов (пресеты зависят от proj4).
- OSRM/BRouter и изохроны на реальной дорожной сети.
- Полевой режим: солнце, перчатки, расход батареи, `systemd-inhibit`
  на разных дистрибутивах.
- Экспорт большого пака: прогресс, ETA, отмена на сотнях тысяч тайлов.
- Интероп: MBTiles/GPX в QGIS, GPX в Garmin.
- ARM64 на Rock Pi 4A / NanoPi M4 (в CI сборка есть, железо — нет).
- Старт на холодном page cache и двухчасовой прогон на утечки.

## Предлагаемые следующие шаги

**P0 — внешний remote.** Подключить GitHub (см. выше), заменить
`repository` в `Cargo.toml`, прогнать `.github/workflows/ci.yml`
на реальном runner (amd64 + ARM64).

**P1 — закрыть критерии 1.0 (Phase 7).**
- Онбординг первого запуска + демо-пак (сейчас пустой экран без подсказок).
- AppImage в дополнение к `.deb` (Flatpak — после).
- Crash reporting opt-in и release checklist; 10 внешних тестеров.
- Импорт кэша SAS.Planet (best-effort).
- Пересобрать `.deb` после правок производительности.

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

Рациональный порядок: **внешний remote → онбординг/демо-пак → полевая
приёмка → mission planning и телеметрия**.
