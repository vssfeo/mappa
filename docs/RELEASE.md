# Релиз

**Версия:** 1.0.0  
**Дата:** 2026-10-25

## Где живёт версия

| Файл | Поле |
|---|---|
| `Cargo.toml` | `workspace.package.version` |
| `src-tauri/Cargo.toml` | `package.version` |
| `src-tauri/tauri.conf.json` | `version` — попадает в имя `.deb`/AppImage и в «О программе» |
| `ui/package.json` | `version` |

Менять все четыре одновременно, иначе имя артефакта и «О программе»
разойдутся. После изменения — запись в [CHANGELOG.md](../CHANGELOG.md).

## Сборка релиза

```bash
make release            # make check + deb + AppImage + SHA256SUMS + manifest
scripts/release.sh --skip-check   # если check уже прогоняли
```

Результат — `dist/release/`:

| Файл | Что это |
|---|---|
| `Mappa_1.0.0_amd64.deb` | Debian-пакет, бинарник в `/usr/bin/mappa` |
| `Mappa_1.0.0_amd64.AppImage` | Один файл, без установки |
| `SHA256SUMS` | Контрольные суммы |
| `SHA256SUMS.asc` | Отсоединённая GPG-подпись (если есть ключ) |
| `manifest.json` | Версия, коммит, дата, размеры и хеши |

### Подпись

Без ключа скрипт печатает инструкцию. Один раз:

```bash
gpg --quick-generate-key "Mappa release <release@example.invalid>" ed25519 sign 2y
gpg --export --armor <key-id> > mappa-release.asc   # публичный ключ для проверки
```

Дальше `scripts/release.sh` подписывает `SHA256SUMS` автоматически;
`MAPPA_GPG_KEY=<key-id>` выбирает конкретный ключ, если их несколько.

## Проверка артефактов

```bash
cd dist/release
sha256sum -c SHA256SUMS
gpg --verify SHA256SUMS.asc SHA256SUMS

sudo dpkg -i Mappa_1.0.0_amd64.deb
mappa
# или без установки:
./Mappa_1.0.0_amd64.AppImage --appimage-extract-and-run
```

AppImage требует FUSE 2; без него используйте
`--appimage-extract-and-run`. На Ubuntu 24.04 FUSE 2 не предустановлен —
это ограничение AppImage, не приложения.

AppImage самодостаточный: внутри WebKitGTK, JavaScriptCore и GTK, поэтому
он весит 88,9 МиБ и не зависит от системного WebKit. `.deb` — 7,7 МиБ и
использует системные библиотеки; для Ubuntu 24.04 он предпочтительнее.

## Тег и публикация

```bash
git tag -a v1.0.0 -m "Mappa 1.0.0"
git push origin main v1.0.0
```

После подключения GitHub тег запускает
`.github/workflows/release.yml`: сборка `.deb` и AppImage на
`ubuntu-24.04`, проверка содержимого пакета, загрузка артефактов и
создание GitHub Release с `SHA256SUMS` и `manifest.json`.

Без remote релиз остаётся локальным: артефакты в `dist/release/`
и тег в локальном `origin`.

## Чек-лист 1.0.0

- [x] `make check` — 198 Rust-тестов, 113 UI-тестов, clippy, fmt.
- [x] `make smoke` — EN/DE/RU, полевой режим, онбординг.
- [x] `make deb-check` — `.deb` 7,74 МиБ, launcher на месте.
- [x] AppImage собран (88,9 МиБ) и запускается: окно за 131 мс после распаковки.
- [ ] `SHA256SUMS` подписаны релизным ключом.
- [x] Тег `v1.0.0` создан и запушен в локальный `origin`.
- [ ] CI на GitHub зелёный (amd64 + ARM64).
- [ ] 10 внешних тестеров, 95% сессий без падений.
- [ ] Видео 90 секунд для релизной страницы.

## Известные ограничения релиза

- `repository` в `Cargo.toml` — `https://example.invalid/mappa`, пока
  нет публичного remote.
- PPA/Flatpak/autoupdate не настроены.
- Репозиторий не подписан для `apt` — установка только через `dpkg -i`.
