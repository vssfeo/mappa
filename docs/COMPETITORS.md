# Mappa — конкурентный анализ и бэклог функций

**Дата:** 2026-10-23  
**Метод:** desk research по публичной документации SAS.Planet, QGIS, Global Mapper,
ExpertGPS, Garmin BaseCamp, Google Earth, MapTiler, Mapbox Studio, Felt,
Kepler.gl, Cesium, ArcGIS Earth, QGroundControl, Mission Planner, UgCS,
CalTopo, Avenza и полевых приложений. Код и ассеты конкурентов не
использовались; выводы — только перечень функций и UX-паттернов.

Документ дополняет [ROADMAP.md](ROADMAP.md). Приоритеты: **P0** — без этого
пользователи SAS.Planet не перейдут и не закрыт базовый GIS-workflow;
**P1** — сильный дифференциатор; **P2** — ниша/после 1.0.

---

## 1. Главные выводы

1. **SAS.Planet — это в первую очередь движок источников и кэша.** Сотни
   XYZ-пресетов, произвольный URL, WMS, coverage map и экспорт в чужие
   форматы. Сейчас у Mappa пять встроенных источников и нет UI для
   добавления своих — это главный разрыв.
2. **Координаты и датумы — ежедневный workflow.** SAS ограничен Web
   Mercator/4326, но QGIS, Global Mapper и полевые приложения дают
   EPSG, UTM/MGRS, СК-42/МСК, сетки и пересчёт датумов. Для РФ и роботов
   это критично; UTM-формата маркеров недостаточно.
3. **Linux-native + офлайн-паки + очередь + CLI — уже преимущество.**
   Ни один из конкурентов не совмещает это в одном нативном приложении.
   Нужно не копировать SAS, а закрыть его слабые места: вектор, 3D,
   аналитика, проекты, современный UX.
4. **Полевой сценарий требует треков, GPS и высот.** Линейка и метки есть,
   но без записи трека, импорта GPX-маршрутов, профиля высот и офлайн-
   навигации приложение остаётся просмотрщиком.
5. **Экспорт — главный офлайн-деливерабл.** Пользователи SAS ценят
   склейку в GeoTIFF/JPEG + world file, KMZ, MBTiles и печать PDF.
   У Mappa пока только MBTiles/PMTiles и CSV/GeoJSON/GPX/KML меток.
6. **Вектор и 3D — то, чем можно обогнать SAS.** MapLibre уже в стеке:
   terrain, hillshade, fill-extrusion, GeoJSON-слои и style expressions
   дают премиум-ощущение без смены архитектуры.
7. **Лицензии и ToS — часть архитектуры.** OSM/Google запрещают bulk
   pre-fetch; PROJ/GDAL/MapLibre/PMTiles разрешают bundling. JNX/RMP
   reverse-engineered — риск, не ставить в P0.

---

## 2. Инвентарь по доменам

### 2.1 Источники, проекции, датумы

- **SAS.Planet:** десятки/сотни XYZ-пресетов, custom URL и скрипты,
  Web Mercator/4326, метки, KML, overview.
- **QGIS:** ~7000 CRS, on-the-fly reprojection, datum transforms,
  custom CRS, WMS/WMTS/WFS/WCS.
- **Global Mapper / ExpertGPS:** 12 000+ geodetic definitions, UTM,
  State Plane, смена датума, сетки.
- **Полевые приложения:** DD/DMS/UTM/MGRS, выбор формата отображения,
  иногда пользовательские сетки.
- **Чего нет у Mappa:** UI-каталог источников, WMTS и WMS
  GetCapabilities, auth query/basic, MGRS, сетка координат, сближение
  меридианов и магнитное склонение. Свои XYZ/TMS и WMS GetMap,
  headers/API-ключи, EPSG/датумы и СК-42/МСК уже есть.

### 2.2 Кэш, паки, экспорт

- **SAS.Planet:** распакованный и упакованный кэш, coverage map,
  генерация нижних зумов, MBTiles, RMaps/OruxMaps, JNX, RMP, KMZ,
  GeoTIFF/ECW/JPEG/PNG + `.map/.kml/.tab`.
- **MapTiler Desktop:** offline tiling, GeoTIFF/PDF/JPEG/PNG/MrSID/ECW,
  MBTiles/GeoPackage, Linux deb/AppImage, batch.
- **Felt:** MBTiles, GeoPackage, FlatGeobuf, GeoTIFF, Shapefile, DXF,
  Excel, URL, Google Sheets.
- **У Mappa есть:** SQLite WAL cache, MBTiles/PMTiles export/import,
  resumable queue, LRU, Cache Doctor, транскодинг PNG/JPEG.
- **Чего нет:** coverage map, менеджер кэша по источникам, GeoTIFF/COG
  + world file, KMZ, PDF/print, GeoPackage, SHP/DXF, RMaps/OruxMaps,
  импорт папки XYZ, подпись/манифест пака.

### 2.3 Слои, вектор, стили, 3D

- **SAS.Planet:** base + overlay, прозрачность, KML, Wikimapia,
  Panoramio, overview map, fullscreen, coverage layer.
- **QGIS:** неограниченные слои, blend modes, labels, temporal,
  attribute table, symbology, 3D views, point clouds.
- **MapTiler/Mapbox:** style JSON, expressions, terrain, hillshade,
  contours, 3D buildings, globe, atmosphere, lighting.
- **Felt/Kepler:** layer groups, filters, popups, legends, heatmap/H3,
  time playback, SQL, split-screen.
- **Mappa:** пять растровых подложек + паки, порядок не управляется,
  вектора, стилей и 3D нет.
- **Нужно:** layer manager (порядок, группы, opacity, blend), импорт
  KML/KMZ/SHP/GPX/GeoJSON как слоёв, attribute table, рисование и
  редактирование point/line/polygon, snapping, style expressions,
  terrain/hillshade/3D buildings.

### 2.4 Метки, аннотации, измерения

- **SAS.Planet:** метки с иконкой/именем/описанием, GPX/KML/PLT,
  расстояние и площадь.
- **BaseCamp/ExpertGPS:** библиотеки waypoints/routes/tracks, символы,
  geocaches, фото, комментарии.
- **QGIS:** атрибуты, формы, фильтры, layouts.
- **Felt:** pins/polygons/arrows/text, комментарии, real-time multiplayer,
  field forms и geotagged photos.
- **Mappa уже умеет:** маркеры (имя/описание/drag/список/fly-to),
  массовый импорт-экспорт CSV/GeoJSON/GPX/KML, DD/DMS/UTM, линейку с
  азимутами и сегментами, площадь/периметр, переход по координатам.
- **Чего нет:** папки, иконки, цвета, шаблоны, фото/аудио, attribute
  table, рисование линий/полигонов, комментарии, совместное редактирование,
  произвольные CRS, магнитное склонение, эллипсоид на выбор.

### 2.5 Треки, маршруты, поле

- **SAS.Planet:** GPX/KML/PLT, запись трека, навигация, GPS-эмулятор.
- **BaseCamp:** Track Draw с профилем, playback, via points.
- **OsmAnd / Locus / Organic / OruxMaps / BRouter:** офлайн turn-by-turn
  для auto/bike/foot/horse/ski/boat, off-road/beeline, профили высот,
  перестроение без сети (у Komoot офлайн-перестроения нет).
- **OruxMaps / Locus / TwoNav:** запись трека, pause/auto-pause,
  графики speed/elevation/incline, коррекция высот по DEM, редактор
  трека, экспорт FIT/TCX/IGC.
- **Locus / OruxMaps / BCN:** папки waypoints, иконки, кастомные формы,
  geocaching-инструменты, вложения и фото.
- **Gaia / CalTopo / Locus:** погода, давление, солнце/луна, лавины,
  пожары, live tracking, backtrack, proximity/geofence-алерты.
- **AlpineQuest / OruxMaps / TwoNav:** самый широкий импорт-экспорт
  (GPX/KML/KMZ/GeoJSON/CSV/SHP/TCX/FIT/IGC/OZI/LOC).
- **Датчики:** BLE/ANT+ HR/cadence/power, барометр, внешний GNSS,
  NMEA/gpsd, AIS, OBD-II; у OsmAnd есть accessibility-плагин.
- **Mappa:** запись и playback трека, GPS/GeoClue, NMEA-имитация,
  внешний NMEA TCP, gpsd, профиль высоты/скорости; офлайн-маршруты по
  загруженным линиям и off-route alerts. Нет прямого serial, готового
  дорожного графа, профилей car/foot/bike, датчиков и полевых форм.
- **Нужно:** OSRM/BRouter по готовому графу, route-scoped download,
  turn-by-turn, полевой режим, формы, фото и геотеггинг.

### 2.6 Погода, безопасность, доступность

- **Gaia/CalTopo/Locus/Trail Sense:** прогноз, тренд давления,
  sun/moon, лавинные и пожарные слои, live tracking, Lifeline,
  backtrack, beacons.
- **OsmAnd/Organic:** accessibility-плагин, TalkBack, wheelchair-POI.
- **Mappa:** только часы/координаты; нет погоды, солнца/луны, safety-
  инструментов и accessibility-прохода.
- **Нужно (P1):** офлайн sun/moon и давление, backtrack, proximity/
  geofence, погодный слой по API, клавиатурная и screen-reader
  доступность, крупные цели в полевом режиме.

### 2.7 Рельеф, 3D, анализ

- **QGIS/Global Mapper:** DEM, hillshade, contours, slope/aspect, 3D,
  профили, viewshed, LOS, volume, watershed, LiDAR.
- **MapTiler/Mapbox:** terrain-RGB, hillshade с азимутом солнца,
  contours, 3D buildings, exaggeration, atmosphere.
- **Cesium/ArcGIS Earth:** globe, 3D Tiles, point clouds, 4D, viewshed,
  3D-измерения.
- **Mission-планировщики:** DEM для AGL, terrain following, corridor
  scan, geofence, SAR-паттерны.
- **Mappa:** локальный DEM `.hgt`/`.asc` и GeoTIFF/COG напрямую,
  hillshade, 3D terrain, slope/aspect, горизонтали, профиль высот по DEM
  и min AGL по профилю линии; нет viewshed и terrain following.
- **Нужно:** LOS/viewshed v1, terrain following, 3D buildings,
  3D Tiles/LiDAR — позже.

### 2.8 Миссии, роботы, телеметрия

- **QGC/Mission Planner:** waypoint-миссии, altitude modes, survey,
  corridor, geofence, rally, MAVLink, terrain following.
- **UgCS/CalTopo:** SAR-паттерны, DEM, multi-node, погода.
- **DJI:** geometric routes, KMZ/WPML, FlightHub.
- **Mappa:** нет планирования, геозон, экспорта миссий, телеметрии.
- **Нужно:** редактор waypoint/полигонов/коридоров, геозоны, altitude
  modes, экспорт GPX/KML/QGC `.plan`/MAVLink, read-only MAVLink/ROS2/MQTT
  адаптеры, телеметрия на карте, SAR-паттерны.

### 2.9 Геореференсинг и растровая обработка

- **QGIS Georeferencer:** GCP, linear/Helmert/poly 1–3/projective/TPS,
  RMSE, ресемплеры, GeoTIFF/COG/world file.
- **MapWarper:** публичные WMS/WMTS, collaborative GCP.
- **Global Mapper:** rectification, mosaic, batch, LiDAR.
- **SAS.Planet:** склейка тайлов, world file, KMZ, пирамида.
- **Mappa:** нет.
- **Нужно:** склейка района в GeoTIFF/COG + world file, GCP-геореференсинг
  сканов (GDAL warp), RAMS/ECW — только при наличии надёжного writer.

### 2.10 Поиск, геокодинг, исторические данные

- **QGIS/MapTiler/Felt:** geocoding, Nominatim/Photon, offline index,
  admin boundaries, URL/ArcGIS services.
- **Google Earth:** historical imagery, time slider, Street View.
- **Marble:** Wikipedia, погода, облака, день/ночь, землетрясения.
- **SAS.Planet:** слабый поиск, зато Wikimapia/Panoramio.
- **Mappa:** только координаты и статические команды.
- **Нужно:** офлайн-геокодер (Nominatim/Photon), online fallback,
  исторические снимки/таймлайн, погодные и справочные слои (P1/P2).

### 2.11 Коллаборация, автоматизация, публикация

- **Felt:** real-time multiplayer, комментарии, роли, embeds, PNG/PDF,
  field app, MCP/SQL API.
- **QGIS:** layouts/atlas, `qgis_process`, Python.
- **Martin/TileServer GL:** tile server, styles/fonts/sprites, WMTS.
- **Mappa:** CLI download/pack/doctor, нет tile-server, проектов,
  совместной работы, API/плагинов.
- **Нужно:** проект `.mappa` (SQLite + JSON + PMTiles), локальный
  tile-server для роботов/планшетов, batch JSON jobs, self-hosted sync
  для SAR, MCP/плагины — после 1.0.

---

## 3. Приоритетный бэклог

### P0 — перейти от «просмотрщика» к рабочей станции

| # | Функция | Зачем | Зависимости / заметки |
|---|---|---|---|
| 1 | Менеджер источников: custom XYZ/TMS/WMS/WMTS, headers/auth, GetCapabilities, policy-флаги, hot-reload, каталог | Ядро SAS.Planet | Схема провайдера уже есть; нужен UI и WMS-парсер |
| 2 | CRS-движок: EPSG/PROJ, UTM/MGRS, СК-42 ГК, МСК, сетка, сближение, declination | РФ, SAR, роботы | PROJ (MIT) или proj4rs; `proj.db` ~10 МБ; показывать точность |
| 3 | Векторные слои: KML/KMZ/GPX/GeoJSON/SHP/GeoPackage, стили, attribute table, рисование point/line/polygon, snapping | QGIS-lite и полевые данные | MapLibre GeoJSON; `geozero`/`shapefile` для SHP; лимиты памяти |
| 4 | Папки/иконки/цвета/поиск меток; шаблоны (GPX/KML/CSV/GeoJSON уже есть) | Управление POI | Модель маркера расширить; SQLite при >20k |
| 5 | DEM/terrain: SRTM/Copernicus, hillshade, contours, профиль, min AGL, slope, 3D terrain | Поле и миссии | raster-dem в MapLibre, terrain-RGB, локальный кэш DEM |
| 6 | GPS и треки: позиция/курс, запись, playback, GPX-маршруты, off-route alerts, полевой режим | Полевой сценарий | Android/iOS позже |
| 7 | Экспорт: GeoTIFF/COG + world file, PNG/PDF с сеткой/легендой/масштабом, KMZ | Главный офлайн-деливерабл | GDAL (MIT) или Rust-писатели; streaming mosaic |
| 8 | Проект `.mappa`: слои, метки, измерения, вид, настройки, паки | Рабочие области | SQLite + JSON manifest; версионирование |
| 9 | Download engine 2.0: полигон/маска, диапазон зумов, мультиисточник, оценка размера, coverage map, целостность | Главная привычка SAS и полевой минимум | SQLite-агрегаты, bbox/полигон-слой, per-source лимиты |
| 10 | Офлайн routing: BRouter/GraphHopper, профили foot/bike/car/4x4, route-scoped download, turn-by-turn | Поле без сети и роботы | Отдельный граф-пакет; ODbL-атрибуция |

### P1 — дифференциаторы

- Геореференсинг сканов: GCP, affine/Helmert/poly/TPS, RMSE, GeoTIFF/COG.
- Сетка координат overlay, MGRS/USNG, номенклатура листов, сближение.
- Viewshed/LOS + Fresnel для радиолинков (30 м DEM, Rust + rayon).
- Mission planning: waypoint/полигон/коридор/геозона, altitude modes,
  экспорт QGC `.plan`/MAVLink/DJI KMZ.
- Телеметрия read-only: MAVLink, ROS2 `/odom`/`/path`, MQTT; replay.
- Офлайн-геокодер Nominatim/Photon + online fallback.
- Routing OSRM/Valhalla/BRouter, изохроны, turn-by-turn, route-scoped
  download.
- SAR-паттерны, полевые формы, фото/аудио-заметки, geotagging.
- Локальный tile-server и раздача паков по LAN/QR.
- Исторические снимки/таймлайн, погода, солнце/луна, приливы.
- Safety: backtrack, proximity/geofence-алерты, live tracking.
- Прямой serial-порт, барометр, BLE-датчики.
- Accessibility: screen reader, крупные цели, reduced motion.
- Coordinate extras: MGRS/USNG, Maidenhead, Plus Codes.
- Слои avalanche/fire/parcels/public land (где позволяет лицензия).
- SHP/DXF/GeoPackage/Excel импорт-экспорт; RMaps/OruxMaps.
- CLI batch JSON jobs, `mappa serve`, REST API.
- 3D buildings, COG overlay, vector tiles из импортированных данных.
- Self-hosted sync для SAR/команд (LWW/CRDT, air-gapped).

### P2 — после 1.0

- LiDAR LAS/LAZ, point clouds, 3D Tiles, volume/cut-fill, watershed.
- Structure/facade/vertical scans, multi-vehicle, ADS-B.
- Photogrammetry-интеграция (ODM/Metashape), не свой SfM.
- Real-time multiplayer, комментарии, роли.
- Plugin API/WASM, MCP-ассистент, Python scripting.
- Mobile companion/PWA, синхронизация с телефоном.
- JNX/RMP и прочие reverse-engineered форматы — только после
  юридической проверки.

---

## 4. Лицензии и правовые ограничения

- **Можно безопасно встраивать:** MapLibre (BSD-3), Tauri (MIT/Apache-2),
  PROJ (MIT), GDAL (MIT/X11), SQLite (public domain), PMTiles (BSD-3/CC0),
  MBTiles spec (CC BY 3.0), OSRM (BSD), Valhalla (MIT), GeographicLib (MIT).
- **GPL:** SAS.Planet с 2020 под GPLv3, QGIS GPLv2+, QGC/Mission Planner
  GPLv3. Код не копировать; использовать как поведенческий референс,
  а для геообработки — GDAL/PROJ напрямую.
- **Проприетарные:** Global Mapper, UgCS, DJI, Pix4D, Metashape, Avenza,
  TwoNav. Только публичные форматы и функции, без reverse engineering.
- **Тайлы:** OSM tile policy запрещает bulk/offline; Google запрещает
  pre-fetch/cache; OpenTopoMap — scraping. USGS public domain. Каждый
  источник должен иметь `offline_allowed`, attribution и предупреждение.
- **Датумы:** 7-param СК-42→WGS84 даёт ~5–10 м; официальные grid-файлы
  точнее. Показывать метод и точность, не подменять датум молча.
- **МСК:** не один CRS; у региона свой central meridian, false easting,
  scale/rotation. Нужны пресеты и custom TM + affine/7-param.

---

## 5. Источники (ключевые)

**SAS.Planet / desktop GIS**
- https://github.com/sasgis/sas.planet.src
- http://www.sasgis.org/wikisasiya/doku.php/экспорт
- https://qgis.org/en/site/about/features.html
- https://docs.qgis.org/latest/en/docs/user_manual/working_with_projections/working_with_projections.html
- https://docs.qgis.org/3.40/en/docs/user_manual/working_with_raster/georeferencer.html
- https://www.bluemarblegeo.com/global-mapper/
- https://www.expertgps.com/
- https://www.garmin.com/en-GB/blog/introducing-basecamp-garmins-outdoor-planning-companion-1/
- https://support.google.com/earth/answer/40901
- https://marble.kde.org/features.php

**Modern map tools**
- https://docs.maptiler.com/guides/map-design/terrain/hillshading/
- https://www.maptiler.com/news/2021/03/maptiler-desktop-11-with-enhanced-ux/
- https://docs.mapbox.com/help/tutorials/create-a-custom-style/
- https://cesium.com/platform/cesiumjs/
- https://www.esri.com/en-us/arcgis/products/arcgis-earth/overview
- https://help.felt.com/analysis-and-dashboards/spatial-analysis
- https://docs.kepler.gl/docs/user-guides/c-types-of-layers
- https://maplibre.org/martin/llms-full.txt
- https://tileserver.readthedocs.io/en/latest/

**Offline / field apps**
- https://osmand.net/docs/user/plugins/
- https://osmand.net/docs/user/map/configure-map-menu/
- https://organicmaps.app/
- https://www.locusmap.app/
- https://docs.locusmap.app/fr/doku.php/manual:user_guide:tools:location
- https://www.alpinequest.net/en/
- https://gurumaps.app/
- https://help.gaiagps.com/hc/en-us/articles/360001168547-Search-for-Coordinates-and-Create-Waypoints-from-Coordinates-in-the-Android-app
- https://training.caltopo.com/all_users/tools/measure
- https://store.avenza.com/pages/pro-features
- https://github.com/abrensch/brouter
- https://github.com/kylecorry31/Trail-Sense

**Mission / field**
- https://docs.qgroundcontrol.com/master/en/qgc-user-guide/plan_view/plan_view.html
- https://ardupilot.org/planner/docs/mission-planner-flight-plan.html
- https://ardupilot.org/copter/docs/terrain-following.html
- https://shop.ugcs.com/pages/ugcs-license-types-pricing
- https://caltopo.com/rescue
- https://training.caltopo.com/all_users/import-export
- https://support.avenzamaps.com/hc/en-us/articles/5051364161428-Importing-map-features
- https://www.twonav.com/en/software/app
- https://www.oruxmaps.org/cs/en/?view=article&id=2:useful-links&catid=2

**Спецификации и лицензии**
- https://github.com/protomaps/PMTiles
- https://github.com/mapbox/mbtiles-spec
- https://proj.org/
- https://gdal.org/license.html
- https://operations.osmfoundation.org/policies/tiles/
- https://developers.google.com/maps/documentation/tile/policies
- https://opentopomap.org/credits
