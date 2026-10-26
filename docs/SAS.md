# Импорт кэша SAS.Planet

`mappa-cli import-sas` переносит тайловый кэш SAS.Planet в MBTiles,
который открывается в Mappa, QGIS и MapLibre.

## Формат кэша

Поддерживается раскладка «слой / z / x / y.ext»:

```
Cache/
  Google/10/512/340.png
  Google/10/513/340.png
  Google/11/1024/680.png
  Bing/5/1/2.png
```

Слой — каталог перед `z`; расширения: `png`, `jpg`, `jpeg`, `webp`.
Другие файлы пропускаются.

## Запуск

```bash
mappa-cli import-sas --source ~/.local/share/SAS.Planet/Cache \
  --output google.mbtiles --layer Google

mappa-cli import-sas --source Cache --output pack.mbtiles --json
```

Без `--layer` берётся слой с наибольшим числом тайлов. `--name` задаёт
имя пака. Существующий `--output` не перезаписывается.

## Что попадает в пак

- `name`, `format`, `bounds`, `minzoom`, `maxzoom`;
- атрибуция «Imported from SAS.Planet cache»;
- тайлы выбранного слоя в схеме XYZ.

Если в слое смешаны PNG и JPEG, берётся преобладающий формат; остальные
тайлы пропускаются и считаются в `skipped`. Это осознанное ограничение:
MBTiles хранит один формат. Для смешанного кэша импортируйте слой
дважды с разными `--output` или предварительно приведите тайлы к одному
формату.

## Проверка

```bash
mappa-cli import-sas --source Cache --output test.mbtiles --json | jq
mappa-cli serve --pack test.mbtiles
```

Покрытие и зуммы видны в `--json`; пак открывается в панели «Слои».
