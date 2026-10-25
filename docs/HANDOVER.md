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
| Ветка | `main`, HEAD — коммит «Refresh the competitor analysis and add 1.x tasks» |
| Коммитов | 32 (первый — 2026-10-24, «Initial Mappa 1.0 release candidate») |
| Рабочее дерево | чистое |
| `origin` | `/home/captry/Projects AI/git-backups/mappa.git` (локальный bare) |
| Бэкап | `/home/captry/Projects AI/git-backups/mappa-all-20261025.bundle` |
| GitHub | не подключён: на машине нет `gh`, GitHub-токена и SSH-ключа |

Подключение GitHub, когда появятся доступы:

```bash
gh repo create mappa --private --source . --remote github
git push -u github main
```

или вручную: создать пустой репозиторий и `git remote add github <url>`.
`repository` в `Cargo.toml` пока `https://example.invalid/mappa` — заменить.

## Онбординг и демо-пак

- Тур на три шага (`ui/src/Onboarding.tsx`): возможности, демо-пак, клавиши.
  Закрывается «Пропустить», `Esc`, крестиком; флаг `onboardingDone` в
  `localStorage`. Повторно — «Настройки» → «Показать обучение заново».
- Демо-пак синтетический: 119 тайлов z10–13 южного берега Крыма,
  ~1,3 МБ, лицензионно чистый. Архив `assets/demo/demo.mbtiles` встроен
  в бинарник (`include_bytes!`), команда `demo_pack` материализует его в
  `~/.local/share/dev.mappa.desktop/` и возвращает путь.
- Перерисовать: `make demo-pack` (`scripts/make_demo_pack.py`, только Pillow).
- Нажатие «Открыть демо-пак» подкладывает пак под экран (`fitBounds`) и
  помечает тур пройденным.

## Проверено (2026-10-25)

- `make check` — зелёный: fmt, clippy `-D warnings`, 198 Rust-тестов,
  113 UI-тестов, unicode-scan, oxlint, production-сборка UI.
- `make smoke` — SMOKE OK; тур проверяется на первом запуске, после
  перезагрузки не появляется.
- `make bench-start`, `make bench-ui`, `make startup` — числа и методика
  в [PERFORMANCE.md](PERFORMANCE.md).
- `make deb-check` — OK, `.deb` 7,74 МиБ (было 6,59 до демо-пака),
  бинарник 17 МБ, ELF stripped.
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

**P0 — внешний remote.** Подключить GitHub (см. выше), заменить
`repository` в `Cargo.toml`, прогнать `.github/workflows/ci.yml`
на реальном runner (amd64 + ARM64).

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
