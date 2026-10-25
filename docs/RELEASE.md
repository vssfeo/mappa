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

Релизный ключ (ed25519, действует до 2028-10-24):

```
B7A7 AA55 0705 C563 6D3A  9B20 4019 72C5 D5A0 5A14
Mappa release <release@example.invalid>
```

Публичная часть лежит в [docs/keys/mappa-release.asc](keys/mappa-release.asc).
Проверка артефактов:

```bash
gpg --import docs/keys/mappa-release.asc
cd dist/release
gpg --verify SHA256SUMS.asc SHA256SUMS
sha256sum -c SHA256SUMS
```

`scripts/release.sh` подписывает `SHA256SUMS` автоматически, если в
keyring есть секретный ключ; `MAPPA_GPG_KEY=<key-id>` выбирает
конкретный ключ, если их несколько. Приватный ключ никогда не попадает
в репозиторий — только в keyring машины, где собирается релиз.

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

## Публикация и зеркала

Проект публикуется как **открытый** репозиторий: Apache-2.0 это
позволяет, а закрытый репозиторий на GitHub недоступен владельцу
из-за ограничений для региона.

Канонический источник — локальный bare-репозиторий и bundle:

```
~/Projects AI/git-backups/mappa.git
~/Projects AI/git-backups/mappa-all-20261025.bundle
```

Они обновляются после каждого этапа и не зависят ни от одного хостинга.

Публичный GitHub (создать пустой репозиторий `mappa`, без README):

```bash
git remote add github https://github.com/vssfeo/mappa.git
git push -u github main
git push github v1.0.0        # запускает release.yml
```

Токен нужен с правом `contents: write` на этот репозиторий; хранить его
только в credential helper, не в remote URL и не в файлах проекта.

Зеркала (по одному не ограничиваться):

```bash
git remote add codeberg https://codeberg.org/<user>/mappa.git
git remote add gitverse https://gitverse.ru/<user>/mappa.git
git push --all <remote> && git push --tags <remote>
```

Что публикуется: код, docs, демо-пак, CHANGELOG, артефакты релиза.
Что не публикуется: приватный GPG-ключ, токены, данные заказчиков,
полевые треки и выписки, персональные данные.

Риск: аккаунт на GitHub может быть ограничен в любой момент, публичный
репозиторий — снят. Поэтому bundle и локальный bare обязательны, а
зеркало стоит поднять до первого релиза, а не после.

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
