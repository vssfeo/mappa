# Демо-видео

**Файл:** [media/mappa-demo.mp4](media/mappa-demo.mp4)  
**Длина:** 2:52 · **Кадр:** 1920×1080, 30 fps · **Кодек:** H.264 + AAC · **Размер:** ~7 МБ  
**Озвучка:** английская, синтезированная · **Субтитры:** вшитые плашки

## Почему Full HD, а не 2K

Видео снято с живым интерфейсом в браузере при layout 1600×900 и
отрендерено в 1920×1080. Апскейл в 2560×1440 не добавляет деталей,
только размывает текст. Если нужен именно 2K-мастер, его надо
переснимать с нативным 1440p-рендером; для чтения интерфейса
Full HD достаточно.

## Сценарий по сценам

| № | Время | На экране | Английская озвучка | Примечание |
|---|---|---|---|---|
| 1 | 0:00–0:15 | Карта Ирландии, панорама и зум, заголовок | Mappa is a Linux-first workstation for offline maps. It is built with Rust, Tauri and MapLibre, ships as a single binary, and keeps working when the network does not. | Живая запись |
| 2 | 0:15–0:30 | Смена подложки на Esri, приближение | Pan and zoom a GPU-rendered map, switch between satellite, topographic and street basemaps, or connect your own XYZ, WMS and WMTS sources. | Живая запись |
| 3 | 0:30–0:46 | Панель Layers: активная подложка, порядок слоёв, прозрачность | The layer stack works like a photo editor: basemaps at the bottom, your own sources, vector layers and offline packs above them. Drag to reorder, fade with opacity, hide with the eye. | Стоп-кадр панели |
| 4 | 0:46–1:03 | Нативное окно: Ирландия, hillshade, панель с паком `Ireland demo` | For the field, download a region and pack it into one MBTiles or PMTiles file. The pack contains every tile, so the map opens without a network, and the same file can be shared with the team. | Нативный стоп-кадр |
| 5 | 1:03–1:16 | Рисование линии по трём точкам, панель Objects, затем измерение | Draw lines, polygons and circles, measure distance and area, and keep everything in the project as objects with names, folders and descriptions. | Живая запись |
| 6 | 1:16–1:30 | Крупный план рельефа: hillshade и горизонтали | Load a DEM — SRTM, ASCII grid or a GeoTIFF — and get hillshade, contour lines, terrain profiles and minimum clearance for a route. | Нативный стоп-кадр |
| 7 | 1:30–1:44 | Панель Radio link and viewshed: точки A/B, высоты, частота, Fresnel | For radio planning, pick two points, set the antenna heights and frequency, and Mappa computes line of sight, the first Fresnel zone and a viewshed over the terrain. | Стоп-кадр панели |
| 8 | 1:44–2:01 | Панель Scan georeferencing | Scanned paper maps can be georeferenced with control points: affine, Helmert, polynomial or thin-plate spline, then exported as a GeoTIFF or COG that opens in QGIS. | Стоп-кадр панели |
| 9 | 2:01–2:15 | Панель Mission from markers: geofence, survey grid, QGC/KML/KMZ | Markers become a mission: takeoff, waypoints, return to launch, a geofence and a survey grid, exported as a QGroundControl plan, KML or KMZ. | Стоп-кадр панели |
| 10 | 2:15–2:31 | Панель MAVLink telemetry: порт, состояние, трек, GPX | Mappa receives MAVLink v1 and v2 telemetry over UDP, verifies the CRC, shows position, heading and altitude, records the track and exports it as GPX. | Стоп-кадр панели |
| 11 | 2:31–2:42 | Полевой режим: крупные элементы, высокий контраст | Field mode enlarges every control, raises contrast and keeps the screen awake on a tablet or a small laptop. | Стоп-кадр |
| 12 | 2:42–2:52 | Финальная карточка: Apache-2.0, ссылка на GitHub | Mappa is open source under Apache 2.0. Build it, test it in the field, and tell us what breaks. | Титры |

## Как это собрано

- Живые сцены сняты Playwright в Chromium на том же React-интерфейсе:
  карта, подложки, рисование, полевой режим. Запись 1920×1080.
- Панели, которые в живой записи вели себя нестабильно из-за
  автофокуса, сняты отдельными стоп-кадрами и вставлены в монтаж.
- Кадры 4 и 6 — нативное приложение: композитор GNOME не дал записать
  X11-окно (`Session creation inhibited`), поэтому вставлены
  полноэкранные снимки с паком и DEM.
- Озвучка: по одному mp3 на сцену, длительность каждой сцены =
  длительность фразы + 2,2 с паузы; дорожки расставлены по таймлайну
  через `adelay`, сведены `amix`.
- Плашки субтитров, титул и финальная карточка — PNG с прозрачностью,
  наложены через `overlay` с `enable='between(t,…)'`.
- Мастер: `ffmpeg -c:v libx264 -crf 21 -pix_fmt yuv420p -c:a aac`.

## Что улучшить в следующей версии

- Снять отдельный ролик про паки и раздачу по QR: скачал район →
  собрал MBTiles → открыл в QGIS → отдал команде.
- Записать живой голос и заменить дорожку, тайминги уже зафиксированы.
- Добавить `.srt` для YouTube и версию 1440p, если понадобится.
