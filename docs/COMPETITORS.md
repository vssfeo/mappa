# Mappa — конкурентный анализ и бэклог функций

**Дата:** 2026-10-25 (обновлено после 1.4.0; первая версия — 2026-10-23)  
**Метод:** desk research по публичной документации SAS.Planet, QGIS,
Global Mapper, ExpertGPS, Garmin BaseCamp, Google Earth, MapTiler,
Mapbox Studio, Felt, Kepler.gl, Cesium, ArcGIS Earth, QGroundControl,
Mission Planner, UgCS, CalTopo, Avenza и полевых приложений. Код и
ассеты конкурентов не использовались. Цены — публичные страницы
вендоров на 2026-10-25.

Документ дополняет [ROADMAP.md](ROADMAP.md): конкретные задачи с
критериями приёмки — в §17 «Конкретные задачи 1.x».

---

## 1. Главные выводы

1. **Паритет с ядром SAS.Planet закрыт.** Свои XYZ/TMS, WMS GetMap,
   WMTS с GetCapabilities, заголовки и ключи, rate limit, кэш по
   источникам, coverage map, полигонная маска, паки MBTiles/PMTiles
   с SHA-256 и Ed25519, CLI, tile-server по LAN. Догоняющий этап
   закончен — дальше имеет смысл тратить силы на отличия, а не на
   копирование каталога из сотен пресетов.
2. **Остались дыры в глубине, а не в ширине.** CRS без полного
   EPSG/PROJ и датум-гридов; вектор без выражений и сложных стилей;
   нет геореференсинга сканов, viewshed/LOS, terrain following.
   Именно там QGIS и Global Mapper выигрывают у нас вчистую.
3. **Полевой сценарий закрыт вчерне.** GPS/NMEA/gpsd, запись трека,
   профиль высоты и скорости, маршруты, изохроны, полевой режим,
   крупный UI. Чего нет — мобильного приложения и командной
   синхронизации; этот сегмент забирает CalTopo.
4. **Миссии и телеметрия — пустая ниша.** QGC и Mission Planner
   бесплатны и сильны, UgCS продаёт планирование. Вход для нас — не
   «ещё одна карта», а AGL-профиль по DEM, геозоны и корректный
   экспорт `.plan`: это ровно то, чего у планировщиков нет в удобном
   виде.
5. **Уникальная комбинация: Linux + файл-пак + CLI + LAN-раздача +
   DEM + поле.** Ни один конкурент не совмещает это в одном нативном
   приложении. Это позиционирование, а не список функций.
6. **Цена.** Бесплатно для частников, 30–50 тыс. ₽/год за организацию.
   Наши прямые конкуренты по цене — SAS (0 ₽) и CalTopo (от $500/год
   за 10 человек), а не QGIS-аналитика и не MapTiler.
7. **Главный дефицит — доверие.** Нет релиза, ни одного внешнего
   кейса, тесты только свои. Для полевого софта это важнее любой
   следующей функции.

---

## 2. Инвентарь по доменам

### 2.1 Источники, проекции, датумы

- **SAS.Planet:** сотни XYZ-пресетов, custom URL, скрипты,
  Web Mercator/4326, overview.
- **QGIS:** ~7000 CRS, on-the-fly reprojection, datum transforms,
  WMS/WMTS/WFS/WCS.
- **Global Mapper / ExpertGPS:** 12 000+ geodetic definitions, UTM,
  State Plane, смена датума, сетки.
- **Mappa сейчас:** семь встроенных подложек; свои XYZ/TMS, WMS
  GetMap, WMTS с разбором GetCapabilities, заголовки Bearer/Basic/
  X-Api-Key, rate limit, офлайн-флаг, кэш по источникам, hot-reload.
  Координаты: WGS84 DD/DMS/UTM/MGRS, СК-42/МСК (EPSG:284xx и proj4),
  сетка, сближение меридианов, магнитное склонение WMM2025.
- **Осталось:** каталог пресетов источников, WFS/WCS, WMS-T, полный
  PROJ с датум-гридами (сейчас proj4rs и пресеты).

### 2.2 Кэш, паки, экспорт

- **SAS.Planet:** распакованный и упакованный кэш, coverage map,
  генерация нижних зумов, MBTiles, RMaps/OruxMaps, JNX, RMP, KMZ,
  GeoTIFF/ECW/JPEG/PNG + `.map/.kml/.tab`.
- **MapTiler Desktop:** offline tiling, GeoTIFF/PDF/MrSID/ECW,
  MBTiles/GeoPackage, Linux deb/AppImage, batch.
- **Felt:** MBTiles, GeoPackage, FlatGeobuf, GeoTIFF, Shapefile, DXF,
  Excel, URL, Google Sheets.
- **Mappa сейчас:** SQLite WAL, LRU и лимит диска, Cache Doctor,
  coverage map, кэш по источникам, возобновляемая очередь с ETA,
  экспорт MBTiles/PMTiles с манифестом SHA-256 и Ed25519,
  PNG + `.pgw`, GeoTIFF + `.tfw`, COG с overview-пирамидой,
  PDF с сеткой/легендой, KMZ, импорт MBTiles/PMTiles.
- **Осталось:** RMaps/OruxMaps/JNX/RMP, ECW/MrSID, DXF/Excel, импорт
  папки XYZ, автообновление и реестр паков с подписями.

### 2.3 Слои, вектор, стили, 3D

- **SAS.Planet:** base + overlay, прозрачность, KML, overview,
  fullscreen, coverage layer.
- **QGIS:** неограниченные слои, blend modes, labels, temporal,
  attribute table, symbology, 3D views, point clouds.
- **MapTiler/Mapbox:** style JSON, expressions, terrain, hillshade,
  contours, 3D buildings, globe.
- **Felt/Kepler:** группы слоёв, фильтры, popups, heatmap/H3, SQL.
- **Mappa сейчас:** порядок наложения подложек, своих источников,
  векторных слоёв и паков (drag-and-drop), прозрачность; векторные
  слои с цветом/толщиной/заливкой/прозрачностью, панель атрибутов,
  snapping, редактирование вершин, вставка/удаление; DEM-hillshade,
  3D-рельеф, горизонтали.
- **Осталось:** группы слоёв и blend modes, выражения и подписи как
  в MapLibre style, 3D buildings, temporal, COG-оверлей, векторные
  тайлы из своих данных.

### 2.4 Метки, аннотации, измерения

- **SAS.Planet:** метки с иконкой/именем/описанием, GPX/KML/PLT.
- **BaseCamp/ExpertGPS:** библиотеки waypoints/routes/tracks, символы,
  geocaches, фото.
- **QGIS:** атрибуты, формы, фильтры, layouts.
- **Felt:** pins/polygons/text, комментарии, multiplayer, формы,
  geotagged photos.
- **Mappa сейчас:** метки с папками, иконками, цветами, поиском и
  фильтром; массовый импорт/экспорт CSV/GeoJSON/GPX/KML; DD/DMS/UTM/
  MGRS/СК-42; линии, полигоны, круги, правка вершин; площадь и
  периметр; линейка с азимутами; fly-to по координатам.
- **Осталось:** фото/аудио-заметки, полевые формы, шаблоны меток,
  совместное редактирование, произвольные CRS для аннотаций.

### 2.5 Треки, маршруты, поле

- **SAS.Planet:** GPX/KML/PLT, запись трека, навигация, GPS-эмулятор.
- **OsmAnd / Locus / OruxMaps / BRouter:** офлайн turn-by-turn,
  профили auto/bike/foot/horse/ski, перестроение без сети, графики
  speed/elevation, коррекция высот по DEM, FIT/TCX/IGC.
- **Gaia / CalTopo / Locus:** погода, давление, солнце/луна, лавины,
  пожары, live tracking, backtrack, геозоны.
- **Mappa сейчас:** позиция, курс, скорость, высота; запись и playback
  трека с графиком; GPS/GeoClue, NMEA-имитатор, внешний NMEA TCP,
  gpsd; профиль высоты/скорости GPX; офлайн-маршруты по линиям и
  off-route alerts; OSRM/BRouter, изохроны, скачивание коридора;
  полевой режим с удержанием экрана.
- **Осталось:** прямой serial и BLE/ANT+, свой дорожный граф с
  профилями, голосовое ведение, FIT/TCX/IGC, погода и safety.

### 2.6 Погода, безопасность, доступность

- **Gaia/CalTopo/Locus/Trail Sense:** прогноз, тренд давления,
  sun/moon, лавинные и пожарные слои, live tracking, backtrack.
- **OsmAnd/Organic:** accessibility-плагин, TalkBack.
- **Mappa сейчас:** контраст, клавиатурная навигация, focus trap,
  подписи и `aria-live`, `prefers-reduced-motion`, крупный полевой
  режим, пять языков.
- **Осталось:** погода и офлайн-альманах солнца/луны, backtrack,
  proximity/геозоны, live tracking, отдельный screen-reader проход.

### 2.7 Рельеф, 3D, анализ

- **QGIS/Global Mapper:** DEM, hillshade, contours, slope/aspect, 3D,
  профили, viewshed, LOS, volume, watershed, LiDAR.
- **Cesium/ArcGIS Earth:** 3D Tiles, point clouds, viewshed,
  3D-измерения.
- **Mappa сейчас:** `.hgt`, `.asc`, GeoTIFF/COG напрямую, hillshade,
  3D-рельеф, slope/aspect, горизонтали, профиль высот по DEM,
  min AGL по профилю линии, высота/уклон/экспозиция под курсором.
- **Осталось:** viewshed/LOS + Fresnel, terrain following для миссий,
  3D buildings, LiDAR/3D Tiles — после 1.0.

### 2.8 Миссии, роботы, телеметрия

- **QGC/Mission Planner:** waypoint-миссии, altitude modes, survey,
  corridor, geofence, rally, MAVLink, terrain following.
- **UgCS/CalTopo:** SAR-паттерны, DEM, multi-node, погода.
- **DJI:** geometric routes, KMZ/WPML, FlightHub.
- **Mappa сейчас:** ничего. Это следующий крупный функциональный
  блок и главный вход в дроновый сегмент.

### 2.9 Геореференсинг и растровая обработка

- **QGIS Georeferencer:** GCP, linear/Helmert/poly/TPS, RMSE,
  ресемплеры, GeoTIFF/COG/world file.
- **MapWarper:** публичные WMS/WMTS, collaborative GCP.
- **Global Mapper:** rectification, mosaic, batch, LiDAR.
- **Mappa сейчас:** пишет GeoTIFF/COG из тайлов, но не умеет
  привязывать чужие растры. Сканы и старые карты — только через QGIS.
- **Осталось:** GCP-геореференсинг (GDAL warp или свой affine/TPS),
  RMSE-контроль, выход в COG; это P1-дифференциатор.

### 2.10 Поиск, геокодинг, исторические данные

- **QGIS/MapTiler/Felt:** geocoding, Nominatim/Photon, offline index.
- **Google Earth:** historical imagery, time slider.
- **Mappa сейчас:** офлайн-кэш `geocode.json`, поиск через
  Photon/Nominatim с отключением в настройках, переход по координатам,
  команды палитры.
- **Осталось:** полный офлайн-дамп Nominatim/Photon, исторические
  снимки и таймлайн, погодные слои.

### 2.11 Коллаборация, автоматизация, публикация

- **Felt:** real-time multiplayer, комментарии, роли, embeds.
- **QGIS:** layouts/atlas, `qgis_process`, Python.
- **Martin/TileServer GL:** tile server, styles, WMTS.
- **Mappa сейчас:** `mappa serve` (тайлы из кэша и паков, MapLibre
  style, REST `/api/status|providers|packs|jobs`, CORS, токен,
  LAN-адреса, QR), CLI `download/pack/doctor/stats/batch/serve`,
  batch JSON с идемпотентностью, проект `.mappa` с автосохранением.
- **Осталось:** постановка заданий через REST (сейчас read-only),
  self-hosted sync для команд, плагины/MCP, Python-скрипты.

---

## 3. Оценка и позиционирование

Оценки — по состоянию на 2026-10-25, шкала 1–5, где 5 — лучший в
мире продукт в этом критерии.

| Критерий | Mappa | Лучший | Комментарий |
|---|---|---|---|
| Офлайн-паки и раздача | 4,5 | SAS/QGIS 3 | Один файл, подпись, CLI, LAN+QR — уникальная комбинация |
| Источники и кэш | 3 | SAS 5 | 7 подложек + свои XYZ/WMS/WMTS; у SAS сотни пресетов |
| Координаты и СК | 4 | QGIS 5 | СК-42/МСК, UTM/MGRS, сетка, WMM; нет полного PROJ |
| Вектор | 3 | QGIS 5 | Импорт SHP/GPKG/KML/GPX, стили, атрибуты; нет выражений |
| Геореференсинг | 4 | QGIS/Global Mapper 5 | GCP, аффинка/Гельмерт/полином/TPS, RMSE, COG; нет пакетной обработки и показа COG слоем |
| Вектор | 3 | QGIS 5 | Импорт SHP/GPKG/KML/GPX, стили, атрибуты; нет выражений |
| Рельеф и радиолинки | 4,5 | Global Mapper 5 | DEM, горизонтали, профиль, min AGL, LOS + зона Френеля, viewshed; нет terrain following |
| GNSS и поле | 3,5 | CalTopo 4,5 | NMEA/gpsd, треки, полевой режим; нет мобильного |
| Маршруты | 3 | OSRM/GraphHopper 5 | Свой граф по линиям + OSRM/BRouter; нет графа в паке |
| Миссии и телеметрия | 3 | QGC 5 | QGC `.plan`, KML/KMZ, геозона-круг, «змейка»-съёмка; нет телеметрии и геозон-полигонов |
| Производительность | 4 | — | 60 fps на 1440p, окно 70 мс, карта 0,83 с |
| Зрелость и доверие | 2 | QGIS 5 | четыре релиза за день, 60+ коммитов, 222+123 теста; внешних пользователей нет |
| Экосистема | 2 | QGIS 5 | CLI и REST есть; плагинов и Python нет |

### Сегментные выводы

- **Против SAS.Planet.** Лучше по архитектуре (Linux, GPU, паки,
  CLI, DEM, GPS, полевой режим), хуже по каталогу источников,
  обходу чужих форматов и аудитории. Формулировка «SAS для Linux с
  паками» точна, но уже тесна.
- **Против QGIS.** Проигрываем по анализу, стилям, плагинам и
  форматам. Не конкурируем; выигрываем там, где QGIS неудобен:
  пак одним кликом, LAN-раздача, CLI-сборка, слабое железо.
- **Против Global Mapper.** Проигрываем по лидару, геореференсингу,
  печати и анализу; он и стоит на порядок дороже. Наша ниша — поле,
  а не камеральный анализ.
- **Против CalTopo.** У них коллаборация, live tracking, SAR-воркфлоу
  и мобильные клиенты; Teams стоит от $500/год за 10 человек и от
  $2000/год для первых респондентов
  ([caltopo.com/about/teams](https://caltopo.com/about/teams)).
  У нас офлайн-файлы, Linux и CLI — это другой покупатель.
- **Против мобильных (Avenza, Gaia, Locus).** Телефон в кармане и
  магазины карт ([планы Avenza](https://store.avenza.com/pages/compare-plans)).
  Конкурировать на телефоне нечем; нужен компаньон, а не второй
  клиент с нуля.
- **Против MapTiler.** Другой рынок: они продают тайлы и стили по
  подписке ($30/мес во Flex, [maptiler.com/cloud/pricing](https://www.maptiler.com/cloud/pricing/)),
  мы — инструмент, который эти тайлы качает и хранит.
- **Ценовой ориентир.** Global Mapper — коммерческая perpetual-
  лицензия в тысячи долларов ([Blue Marble](https://www.bluemarblegeo.com/purchase/?active=avenza-maps));
  QGIS, SAS.Planet, QGC — 0 ₽. Наш честный ценник сегодня —
  бесплатно для частников и 30–50 тыс. ₽/год за организацию, с
  ростом только после полевых кейсов.

### Где выигрываем

Один сценарий, которого нет ни у кого: **Linux-ноутбук в поле без
сети + паки, собранные на сервере + раздача команде по LAN + CLI в
скриптах**, плюс российские СК «из коробки», геореференсинг сканов,
радиолинк с зоной Френеля и экспорт миссий в QGC. По отдельности всё
это есть у кого-то; вместе и нативно на Linux — ни у кого.

### Где проигрываем

1. **Телеметрия и живая карта:** QGC и CalTopo показывают борт в
   реальном времени, у нас только экспорт.
2. **Мобильность:** телефона нет ни в каком виде.
3. **Командная работа:** нет синхронизации, ролей и live tracking.
4. **Глубина вектора и плагины:** QGIS недосягаем, и догонять его
   бессмысленно.
5. **Доверие:** четыре релиза за вечер не заменяют десять полевых
   кейсов.

### План атаки: полевой C2

Не «сделать всё как у всех», а занять пустой стык: **пак + рельеф +
радиолинк + миссия + телеметрия + раздача по LAN на одном ноутбуке
без интернета**. Три удара:

1. **Телеметрия и живой борт.** MAVLink v2 по UDP, затем ROS2/MQTT;
   позиция, курс, высота, трек на карте, запись в GPX. Это то, чего
   нет у CalTopo и SAS, и то, что QGC не умеет в офлайне с паками.
2. **Командная синхронизация.** Self-hosted сервер: проект, метки,
   треки, паки; LWW-разрешение конфликтов, работа в air-gapped сети.
   Прямой конкурент CalTopo Teams за $500–2000/год.
3. **Мобильный компаньон.** Не второй GIS, а PWA/Android: открыть
   пак по QR, записать трек, отправить на ноутбук. Закрывает
   единственный крупный пробел без переписывания продукта.

Порядок: телеметрия → sync → компаньон. Всё остальное (вектор,
полиномы, печать) — только по запросам платящих пользователей.

---

## 4. Приоритетный бэклог

Полные задачи с критериями приёмки и оценкой — в
[ROADMAP.md §17](ROADMAP.md). Здесь только порядок и логика.

- **P0 (до релиза 1.0):** релизные артефакты (deb + AppImage, тег,
  CHANGELOG), CI на GitHub, 10 внешних тестеров, crash reporting
  opt-in, холодный старт и двухчасовой прогон на утечки, импорт кэша
  SAS.Planet (best-effort).
- **P1 (1.x, отличия):** геореференсинг сканов, viewshed/LOS +
  Fresnel, планирование миссий с экспортом QGC/DJI, офлайн дорожный
  граф с профилями, мобильный компаньон через LAN, self-hosted sync
  для команд, REST-постановка заданий и MCP.
- **P2 (после 1.x):** LiDAR/3D Tiles, фотограмметрия, multiplayer,
  плагины/WASM, JNX/RMP после юридической проверки.

**Не делаем:** свой SfM, полноценный мобильный GIS, тайлы Google и
Yandex, поддержку сотен пресетов ради количества, reverse-engineered
форматы без юридической проверки.

---

## 5. Лицензии и правовые ограничения

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

---

## 6. Источники (ключевые)

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

**Цены и тарифы (проверено 2026-10-25)**
- https://www.maptiler.com/cloud/pricing/
- https://caltopo.com/about/teams
- https://store.avenza.com/pages/compare-plans
- https://www.bluemarblegeo.com/purchase/?active=avenza-maps
