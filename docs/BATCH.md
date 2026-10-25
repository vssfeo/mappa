# Batch JSON jobs

`mappa-cli batch` выполняет список заданий `download` и `pack` из одного
JSON-файла. Задания идут по порядку, делят общий кэш и могут быть
повторены без повторной загрузки уже сохранённых тайлов.

```bash
mappa-cli batch jobs.json
mappa-cli batch jobs.json --json
mappa-cli batch jobs.json --fail-fast
```

`--json` печатает только итоговый отчёт в stdout (progress и ошибки
тайлов подавляются). `--fail-fast` останавливает очередь после первого
неудачного задания; оставшиеся задания получают статус `notRun`.
Код возврата — `1`, если хотя бы одно задание завершилось ошибкой.

## Формат

```json
{
  "version": 1,
  "cache": "state/tiles.sqlite3",
  "providersDir": "providers",
  "jobs": [
    {
      "type": "download",
      "id": "sf-usgs",
      "provider": "usgs",
      "bbox": [-122.50, 37.70, -122.40, 37.80],
      "zoom": [12, 14],
      "maxTiles": 10000,
      "limitMb": 2048
    },
    {
      "type": "pack",
      "id": "sf-pack",
      "provider": "usgs",
      "bbox": [-122.50, 37.70, -122.40, 37.80],
      "zoom": "12-14",
      "output": "out/san-francisco.mbtiles",
      "name": "San Francisco",
      "license": "public-domain"
    }
  ]
}
```

Поля верхнего уровня:

| Поле | Обязательно | Значение |
|---|---|---|
| `version` | нет | версия формата, сейчас `1` |
| `cache` | нет | путь к `tiles.sqlite3` по умолчанию для всех заданий |
| `providersDir` | нет | каталог provider YAML по умолчанию |
| `jobs` | да | непустой массив заданий |

У каждого задания есть `type`, `id` (уникальный в файле), `provider`,
`bbox` (`[west, south, east, north]`) и `zoom`. `zoom` можно задать
числом (`12`), парой (`[10, 12]`) или строкой (`"10-12"`, `"10..12"`).
Пути `cache`, `providersDir` и `output` относительно batch-файла;
абсолютные пути используются как есть.

### download

| Поле | По умолчанию | Значение |
|---|---|---|
| `maxTiles` | `2000000` | предохранитель от мировой загрузки |
| `limitMb` | `2048` | лимит кэша после задания; `0` отключает вытеснение |
| `cache` | из файла | переопределить кэш |
| `providersDir` | из файла | переопределить каталог провайдеров |

Скачивание разрешено только для провайдеров с `offline_allowed: true`.
Уже закэшированные тайлы пропускаются, поэтому повторный запуск докачивает
только отсутствующее.

### pack

| Поле | По умолчанию | Значение |
|---|---|---|
| `output` | обязательно | `.mbtiles` или `.pmtiles` |
| `name` | имя провайдера и зумы | метаданные пака |
| `license` | нет | лицензия в метаданных и манифесте |
| `cache` | из файла | переопределить кэш |
| `providersDir` | из файла | переопределить каталог провайдеров |

Пак создаётся вместе с подписанным `*.manifest.json` (SHA-256 + Ed25519).

## Идемпотентность

- `download` перед каждой загрузкой проверяет кэш; повторный запуск не
  качает уже сохранённые тайлы.
- `pack`, у которого выходной файл уже существует и манифест проходит
  проверку, получает статус `skipped`; файл не перезаписывается.
- Если выходной файл существует, но манифест отсутствует или повреждён,
  задание завершается ошибкой. Удалите пак и манифест, чтобы пересобрать
  его с новыми параметрами.
- Дубликаты `id` и неизвестная версия формата отклоняются до запуска.

## Отчёт

```json
{
  "file": "/home/user/jobs.json",
  "total": 2,
  "completed": 1,
  "skipped": 1,
  "failed": 0,
  "notRun": 0,
  "seconds": 4.2,
  "jobs": [
    {
      "index": 1,
      "id": "sf-usgs",
      "type": "download",
      "status": "completed",
      "download": {
        "provider": "usgs",
        "minZoom": 12,
        "maxZoom": 14,
        "tiles": 120,
        "downloaded": 20,
        "skipped": 100,
        "failed": 0,
        "bytes": 204800,
        "seconds": 3.9,
        "cache": "/home/user/state/tiles.sqlite3",
        "dryRun": false
      }
    },
    {
      "index": 2,
      "id": "sf-pack",
      "type": "pack",
      "status": "skipped",
      "reason": "out/san-francisco.mbtiles уже существует и подпись манифеста верна"
    }
  ]
}
```

Статусы: `completed`, `skipped`, `failed`, `notRun`. Ошибки отдельных
тайлов не прерывают скачивание; задание получает `failed`, если
`download.failed > 0`.

## JSON для остальных команд

`--json` — глобальный флаг CLI:

```bash
mappa-cli providers --json
mappa-cli stats --json
mappa-cli doctor --json
mappa-cli download --provider usgs --bbox=-122.5,37.7,-122.4,37.8 \
  --zoom 12-14 --json
mappa-cli pack --provider usgs --bbox=-122.5,37.7,-122.4,37.8 \
  --zoom 12-14 --output sf.mbtiles --json
```

`providers --json` отдаёт безопасную сводку (id, name, kind, zooms,
format, offlineAllowed, attribution) без URL, headers и auth, чтобы
не печатать ключи пользовательских источников.

У `serve` машинный интерфейс — REST; `--json` для него отклоняется.
