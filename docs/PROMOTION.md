# Продвижение

**Дата:** 2026-10-25  
**Задача:** превратить релиз в первых пользователей, а не в звёзды.

## Позиционирование

RU: «Офлайн-рабочая станция для поля, дронов и SAR на Linux: собрал
паки — привязал скан — посчитал радиолинк — отправил миссию — видишь
борт — раздал команде по LAN».

EN: «Linux-first offline map workstation: packs, DEM, radio links,
mission export and MAVLink telemetry — one file, no cloud».

Не сравнивать себя с QGIS. Сравнивать с SAS.Planet (Windows) и
CalTopo (подписка, облако): у нас Linux, офлайн и один файл.

## Кому и где

| Аудитория | Где | Что публиковать |
|---|---|---|
| Геодезисты, картографы РФ | Telegram-каналы по ГИС/геодезии, форум ГИС-Ассоциации, VK-группы | СК-42/МСК, геореференсинг сканов, паки |
| SAR и поле | профильные чаты, r/searchandrescue | офлайн, печать, трек, радиолинк |
| Дроны | PX4/ArduPilot форумы, ROS Discourse, r/drones | QGC `.plan`, AGL, MAVLink |
| Linux/FOSS | r/linux, r/rust, r/Flatpak, Hacker News, Lobsters, Mastodon | Rust/Tauri, 82 МБ AppImage, ARM64 |
| Arch/Debian | r/archlinux, r/debian, AUR, DistroWatch | репозиторий, установка одной командой |
| SBC/роботы | Armbian forum, Rock Pi/NanoPi чаты | ARM64, `mappa serve`, LAN |

## Материалы, без которых не идти

1. **90-секундное видео:** пустой экран → демо-пак → скачал район →
   собрал MBTiles → открыл в QGIS → раздал по QR. Без слов, подписи.
2. **GIF 8–10 секунд** для README и постов: панорамирование, слои,
   полевой режим.
3. **6 скриншотов:** карта, паки, DEM/радиолинк, геореференсинг,
   миссия, полевой режим.
4. **Одна команда установки** в каждом посте.
5. **Ссылка на `/releases/latest`**, не на конкретный тег.

## Тексты

### Telegram / VK (короткий)

> Mappa 1.5 — офлайн-карты для Linux. Собрал район в один файл-пак,
> открыл без сети, посчитал радиолинк по DEM, привязал скан карты,
> выгрузил миссию в QGC и принял телеметрию по MAVLink.
> Rust + Tauri, `.deb` 8 МБ, AppImage 82 МБ, ARM64.
> Демо-пак внутри. Скачать: github.com/vssfeo/mappa/releases/latest
> Нужны тестеры и злые замечания — пишите в issues.

### Habr (план статьи)

1. Проблема: SAS.Planet только Windows, QGIS тяжёл в поле.
2. Архитектура: Rust + Tauri + MapLibre, один бинарь, паки.
3. Три инженерные истории: Меркатор и геореференсинг, зона Френеля,
   парсер MAVLink с CRC.
4. Цифры: 227 тестов, старт 70 мс, 60 fps на 1440p.
5. Что не получилось и что дальше.
6. Призыв: тестеры, issues, Linux-пакеты.

### Show HN

> Show HN: Mappa – offline map workstation for Linux (Rust/Tauri)
>
> SAS.Planet is Windows-only, QGIS is heavy in the field. Mappa packs a
> region into one MBTiles/PMTiles file, reads DEM, computes radio LOS
> with the Fresnel zone, georeferences scans to COG, exports QGC
> missions and receives MAVLink telemetry. Single binary, CLI, LAN tile
> server. Apache-2.0.

### r/gis / r/rust

Коротко: что умеет, чем отличается от SAS/QGIS, ссылка на релиз,
просьба о замечаниях. Без «revolutionary» и без сравнений с QGIS в
плоском ключе.

## Календарь (3 недели)

**Неделя 0.** Topics/description (сделано), скриншоты, видео, 5
тестеров, английский блок README, AUR + APT-репозиторий.

**Неделя 1.** Habr + 3–4 Telegram-канала + VK. Отвечать на каждый
комментарий в течение дня. Собирать замечания в issues.

**Неделя 2.** r/gis, r/rust, r/linux, Show HN. К этому моменту должны
быть 10 отзывов и три кейса.

**Неделя 3.** DistroWatch, It's FOSS, OMG! Ubuntu, LinuxLinks,
AlternativeTo. Вертикали: PX4, ROS, Armbian. Зеркала Codeberg/GitVerse.

## Метрики

- скачивания релиза (ассеты GitHub);
- клоны и просмотры (Insights → Traffic);
- внешние issues и их качество;
- 10 тестеров дошли до первого пака;
- 3 кейса «работало в поле»;
- звёзды — следствие, не цель.

## Чего не делать

- Product Hunt и платная реклама — не та аудитория, нет бюджета.
- Спам по чатам и массовые рассылки.
- Заявлять «замена QGIS» — это неправда и вызывает отторжение.
- Публиковать военную тематику и названия заказчиков.
- Обещать мобильное приложение, которого нет.
- Молчать про лицензии тайлов: OSM/Esri нельзя массово качать, для
  офлайна — USGS, NASA, свой сервер.

## Риски

- GitHub-аккаунт может быть ограничен: к моменту пиара нужны зеркала
  и bundle-бэкап.
- Публичный код может быть скопирован: ставка на скорость и сервис,
  а не на секретность.
- Один негативный отзыв про потерю данных в поле стоит дороже десяти
  релизов: автосохранение и crash reports уже есть, но полевых кейсов
  пока нет.
