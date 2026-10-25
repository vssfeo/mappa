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
полевой режим, локализация RU/EN/DE/FR/ES, тур первого запуска со
встроенным демо-паком.

## Git

| Параметр | Значение |
|---|---|
| Ветка | `main`, HEAD — коммит «Release 1.0.0», тег `v1.0.0` |
| Коммитов | 35 (первый — 2026-10-24, «Initial Mappa 1.0 release candidate») |
| Рабочее дерево | чистое |
| `origin` | `/home/captry/Projects AI/git-backups/mappa.git` (локальный bare) |
| Бэкап | `/home/captry/Projects AI/git-backups/mappa-all-20261025.bundle` |
| GitHub | `github` → `git@github.com:vssfeo/mappa.git`, публичный, запушены `main` и `v1.0.0`; SSH-ключ `~/.ssh/mappa_github` (SHA256:92v6P3MSuarMj7igpoFegbaHuZVkvhlOXreNz6O1GLM) |

Публикация (подробно — [RELEASE.md](RELEASE.md) §«Публикация и зеркала»):
создать пустой публичный репозиторий `mappa`, затем

```bash
git push -u github main
git push github v1.0.0      # запускает release.yml
```

GitHub — зеркало, а не единственная копия: канонические источники —
локальный bare и bundle. Нужны зеркала на Codeberg/GitVerse. Токен —
только в credential helper. `repository` в `Cargo.toml` пока
`https://github.com/vssfeo/mappa`.

## Онбординг и демо-пак

- Тур на три шага (`ui/src/Onboarding.tsx`): возможности, демо-пак, клавиши.
  Закрывается «Пропустить», `Esc`, крестиком; флаг `onboardingDone` в
  `localStorage`. Повторно — «Настройки» → «Показать обучение заново».
- Демо-пак синтетический: 71 тайл z10–12 западного побережья Ирландии,
  ~1,1 МБ, лицензионно чистый. Архив `assets/demo/demo.mbtiles` встроен
  в бинарник (`include_bytes!`), команда `demo_pack` материализует его в
  `~/.local/share/dev.mappa.desktop/` и возвращает путь.
- Перерисовать: `make demo-pack` (`scripts/make_demo_pack.py`, только Pillow).
- Нажатие «Открыть демо-пак» подкладывает пак под экран (`fitBounds`) и
  помечает тур пройденным.

## Релиз 1.0.0

- Артефакты: `dist/release/Mappa_1.0.0_amd64.deb` (7,7 МиБ) и
  `Mappa_1.0.0_amd64.AppImage` (88,9 МиБ, самодостаточный: WebKitGTK,
  JavaScriptCore и GTK внутри).
- `SHA256SUMS` и `manifest.json` (версия, коммит, дата, размеры, хеши)
  лежат рядом; проверка `sha256sum -c SHA256SUMS` проходит.
- AppImage распакован и запущен: окно за 131 мс, процесс жив, PSS ~70 МиБ.
- `.deb`: `Version: 1.0.0`, `/usr/bin/mappa` на месте.
- **Подписано** ключом `B7A7 AA55 0705 C563 6D3A 9B20 4019 72C5 D5A0 5A14`
  (`SHA256SUMS.asc` проверена). Публичная часть — `docs/keys/mappa-release.asc`.
- Сборка одной командой: `make release`.

## Геореференсинг (T7, первый срез)

- `src-tauri/src/georef.rs`: GCP, МНК-аффинка и Гельмерт, RMSE, инверсия,
  билинейный пересэмплинг в GeoTIFF/COG EPSG:3857.
- `ui/src/GeorefPanel.tsx`: панель из командной палитры — открыть скан,
  кликать точки (берут координаты центра карты), править координаты,
  «Рассчитать», «Сохранить COG».
- Ограничения: только PNG/JPEG-сканы, без полинома/TPS и пакетной
  обработки; аффинное преобразование и Гельмерт уже есть.

## Радиолинк, зона видимости, миссии

- `src-tauri/src/viewshed.rs`: LOS-профиль, зона Френеля, кривизна
  Земли, viewshed по 720 лучам; команды `los_compute`,
  `viewshed_compute`; панель из командной палитры.
- `ui/src/mission.ts`: QGC `.plan`, KML, KMZ из меток; панель
  «Миссия из меток». 6 тестов в `ui/tests/mission.test.ts`.
- Ограничения: viewshed приближённый (один луч на азимут), миссии без
  геозон, полигонов-съёмки и телеметрии.

## Диагностика

- Отчёты о падениях opt-in: `src-tauri/src/crash.rs`, настройка
  `crashReports`, раздел «Отчёты о падениях» в настройках.
- Замеры: `make startup`, `make startup-cold`, `make leak`.
- 10-минутный прогон: PSS 300 → 301 МиБ; полный холодный старт и два
  часа — в чек-листе релиза.

## Проверено (2026-10-25)

- `make check` — зелёный: fmt, clippy `-D warnings`, 218 Rust-тестов,
  119 UI-тестов, unicode-scan, oxlint, production-сборка UI.
- `make smoke` — SMOKE OK; тур проверяется на первом запуске, после
  перезагрузки не появляется.
- `make bench-start`, `make bench-ui`, `make startup` — числа и методика
  в [PERFORMANCE.md](PERFORMANCE.md).
- `make release` — `.deb` 7,74 МиБ и AppImage 88,9 МиБ, checksums и
  manifest готовы, бинарник 17 МБ, ELF stripped.
- Открытие демо-пака в живом приложении кликом не автоматизировано
  (нет xdotool/wtype на машине); материализация и чтение архива
  покрыты юнит-тестами `src-tauri/src/demo.rs` через `mappa_storage::Mbtiles`.

## Производительность

| Метрика | Значение |
|---|---|
| Окно на экране | ~70 мс |
| Процесс WebKit запущен | ~330 мс |
| First contentful paint | 84 мс (было 780) |
| Канвас карты готов | ~760 мс |
| Панорамирование 2560×1440 | 60 fps |
| Суммарный PSS | ~315 МиБ |

## Что не проверено вживую

- Клик по демо-паку в собранном приложении (см. выше).
- СК-42/МСК на реальных выписках геодезистов (пресеты зависят от proj4).
- OSRM/BRouter и изохроны на реальной дорожной сети.
- Полевой режим: солнце, перчатки, расход батареи, `systemd-inhibit`
  на разных дистрибутивах.
- Экспорт большого пака: прогресс, ETA, отмена на сотнях тысяч тайлов.
- Интероп: MBTiles/GPX в QGIS, GPX в Garmin.
- ARM64 на Rock Pi 4A / NanoPi M4 (в CI сборка есть, железо — нет).
- Старт на холодном page cache и двухчасовой прогон на утечки.

## Предлагаемые следующие шаги

Полный список задач с критериями приёмки и оценкой объёма —
[ROADMAP.md §17](ROADMAP.md); оценки и позиционирование —
[COMPETITORS.md §3](COMPETITORS.md).

**P0 — внешний remote.** Сделано: публичный GitHub, `main` и `v1.0.0`
запушены, CI и Release запущены; осталось дождаться зелёного прогона и
поднять зеркало Codeberg/GitVerse.

**P1 — закрыть критерии 1.0 (Phase 7).**
- AppImage в дополнение к `.deb` (Flatpak — после).
- Crash reporting opt-in и release checklist; 10 внешних тестеров.
- Импорт кэша SAS.Planet (best-effort).
- Видео 90 секунд для релизной страницы (демо-пак уже есть).

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

Рациональный порядок: **внешний remote → AppImage и release checklist →
полевая приёмка → mission planning и телеметрия**.
