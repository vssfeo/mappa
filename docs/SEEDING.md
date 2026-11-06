# Постоянное сидирование каталога

Пак в каталоге живёт, пока кто-то сидирует его торрент. В CLI есть
опциональная команда `seed` (feature `seed`, librqbit).

## Сборка

```bash
cargo build --release -p mappa-cli --features seed
mkdir -p ~/Archive/mappa-catalog/bin
cp target/release/mappa-cli ~/Archive/mappa-catalog/bin/
```

Обычная сборка `mappa-cli` без feature не тянет librqbit и не растёт.

## Раскладка

```
~/Archive/mappa-catalog/
  bin/mappa-cli
  denver.torrent
  denver-usgs-z12-14.mbtiles
  denver-usgs-z12-14.mbtiles.manifest.json
```

## Запуск

```bash
mappa-cli seed \
  --torrent ~/Archive/mappa-catalog/denver.torrent \
  --data ~/Archive/mappa-catalog \
  --port 51413
```

`--data` — каталог с файлом пака; `--port` — TCP/uTP для входящих пиров.

## Systemd

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
  публичный трекер или UPnP/проброс порта.
- Порт 51413 должен быть доступен из интернета для DHT/NAT; иначе
  локальная сеть или проброс порта.
- Каталог не проверяет, жив ли сидер.
