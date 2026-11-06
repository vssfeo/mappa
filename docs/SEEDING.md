# Постоянное сидирование каталога

Пак в каталоге живёт, пока кто-то сидирует его торрент. Для одного
пака достаточно user-сервиса systemd.

## Раскладка

```
~/Archive/mappa-catalog/
  bin/mappa-seed
  denver.torrent
  denver-usgs-z12-14.mbtiles
  denver-usgs-z12-14.mbtiles.manifest.json
```

`mappa-seed` — небольшой сидер на librqbit (Apache-2.0). В поставку
Mappa он не входит; это отдельный инструмент. Он принимает путь к
`.torrent` и каталог с данными, слушает TCP 51413 и сидирует.

## Установка

```bash
cp deploy/mappa-seed.service.example ~/.config/systemd/user/mappa-seed.service
systemctl --user daemon-reload
systemctl --user enable --now mappa-seed.service
loginctl enable-linger "$USER"
```

`enable-linger` нужен, чтобы сервис жил после выхода из сессии.

## Проверка

```bash
systemctl --user status mappa-seed.service
ss -ltnp | grep 51413
```

Скачать пак по magnet из каталога и сверить SHA256 с манифестом.

## Ограничения

- Один сидер — одна точка отказа. Для надёжности нужны второй сидер,
  публичный трекер или встроенный `mappa-cli seed`.
- Порт 51413 должен быть доступен из интернета для DHT/NAT; иначе
  локальная сеть или проброс порта.
- Каталог не проверяет, жив ли сидер.
