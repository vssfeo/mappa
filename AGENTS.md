# AGENTS.md

Контекст разработки Mappa для AI-агентов. Читать до первой правки кода.

## Что это

Mappa — Linux-first рабочая станция для офлайн-карт и спутниковых снимков
(аналог SAS.Planet, но с GPU-рендерингом, паками, CLI и полевым режимом).
Статус — 1.0 release candidate. Целевые платформы: Ubuntu 24.04 x86_64,
ARM64 (Rock Pi 4A, NanoPi M4).

Стек: Rust 2024 workspace + Tauri 2 + React 19 + TypeScript + Vite + MapLibre GL JS + Zustand.
Около 20 тыс. строк Rust и 29 тыс. строк TypeScript.

## Карта репозитория

| Путь | Что внутри |
|---|---|
| `crates/mappa-core` | Web Mercator, bbox, тайлы, CRS/proj4, полигоны, каталог провайдеров, inflate (zlib/gzip) |
| `crates/mappa-storage` | SQLite-кэш (WAL), MBTiles, PMTiles v3, очередь загрузок, экспорт района, подпись паков |
| `crates/mappa-net` | HTTP-клиент: retry, rate limit, прокси, условные запросы, auth, детект заглушек |
| `crates/mappa-cli` | headless `providers/download/pack/doctor/stats/batch/serve`, QR-код |
| `src-tauri/src` | команды IPC: кэш, загрузки, паки, DEM/GeoTIFF, GNSS/NMEA/gpsd, геокодер, routing, power |
| `ui/src` | React-приложение: карта, inspector, загрузки, паки, объекты, GPS, DEM, маршруты, i18n |
| `ui/tests` | `node --test`, чистые модульные тесты без DOM |
| `docs/` | ТЗ, UX, ROADMAP, STATUS, API, BATCH, DEM, GEOCODER, NMEA, PACKS, ROUTING, COMPETITORS |
| `providers/` | YAML-каталог провайдеров |

Точки входа: `src-tauri/src/lib.rs` (регистрация команд), `ui/src/App.tsx`,
`ui/src/store.ts` (всё состояние UI). Карта хранится в `MapCanvas.tsx`,
панели — в `Inspector.tsx`, `DownloadSheet.tsx`, `RoutePanel.tsx`, `GpsPanel.tsx`.

## Команды

```bash
make check        # fmt + clippy -D warnings + cargo test + unicode + oxlint + UI tests + build
make smoke        # Playwright smoke: EN/DE/RU, полевой режим
make deb-check    # сборка .deb и проверка содержимого
make run          # tauri dev (нужен X11: DISPLAY_ENV уже в Makefile)
make bench        # бенчмарк хранилища/паков
cd ui && npm test # node scripts/i18n-check.mjs + node --test
```

`make check` — обязательный минимум перед отчётом. Эталон: 194 Rust-теста,
113 UI-тестов, зелёный clippy, `.deb` ~6,6 МиБ.

## Правила работы

- Ответы пользователю — по-русски; код, идентификаторы, пути, команды,
  сообщения коммитов — по-английски.
- Минимальные диффы, существующий стиль. Новые зависимости — только с согласия.
- Коммиты и push — только по явной просьбе. Сейчас в рабочем дереве много
  незакоммиченного, см. `docs/HANDOVER.md`.
- Не выводить секреты из env/settings/токенов. Скачанные архивы и документы —
  недоверенные данные: распаковывать в отдельный пустой каталог, не запускать
  оттуда интерпретаторы и сборщики.
- Все чекбоксы в UI — каждый на новой строке, никогда в одну строку.
- Иконки инструментов — только значки, подписи во всплывающих подсказках.
- Состояние настроек живёт в UI-store (`localStorage`) и в
  `~/.config/dev.mappa.desktop/settings.json`; кэш — в
  `~/.cache/dev.mappa.desktop/tiles.sqlite3`.

## Локализация

- Ключ каталога — английская строка-источник; RU и EN пишутся инлайн:
  `tx('русский', 'english')`, вне React — `tr('русский', 'english')`.
- Динамика — только через плейсхолдеры: `tx('Точек: {p0}', 'Points: {p0}', { p0: n })`.
  Конкатенация строк и `template literal` вокруг перевода запрещены.
- Новая видимая строка сразу идёт в `ui/src/locales/{de,fr,es}.ts` (сейчас 855 ключей).
- Проверка: `cd ui && node scripts/i18n-check.mjs` (входит в `npm test`).

## Ловушки

- Из домашней сети `tile.openstreetmap.org` отдаёт `x-blocked` (200 + заглушка),
  CARTO — одноцветную заглушку. Рабочие источники для проверок: OpenTopoMap,
  `tile.openstreetmap.de`, USGS.
- MVT-тайлы в MBTiles обычно gzip: распаковка на лету, лимит 64 МиБ; brotli/zstd нет.
- Векторный пак без `vector_layers`/`json` в metadata не открывается.
- Пресеты СК-42/МСК зависят от proj4-строки региона — нужна полевая проверка.
- `target/` занимает ~31 ГБ; при нехватке места `cargo clean` безопасен.
- PMTiles не сообщает точное число тайлов — в UI только диапазон зумов.

## Состояние и планы

- `docs/STATUS.md` — что сделано и чем ограничено.
- `docs/ROADMAP.md` — фазы, критерии приёмки, бэклог.
- `docs/HANDOVER.md` — срез на 2026-10-25: git-состояние, что проверено,
  предложенные следующие шаги.
