# Пакетирование и репозитории

**Дата:** 2026-10-25  
**Цель:** чтобы `apt install mappa`, `yay -S mappa` и Flatpak работали без
ручной сборки, а обновления приходили сами.

## Куда целиться

| Формат | Кому | Труд | Риск | Приоритет |
|---|---|---|---|---|
| APT-репозиторий на GitHub Pages | Ubuntu/Debian | 1 день | подпись ключом, лимиты Pages | **P0** |
| AUR | Arch/Manjaro | 2 часа | нет | **P0** |
| Flatpak (свой репозиторий) | все дистрибутивы | 2–3 дня | песочница, WebKitGTK | P1 |
| Flathub | все | 1–2 недели ревью | аккаунт, требования | P1 |
| Snap Store | Ubuntu | 1–2 дня | ревью, аккаунт | P2 |
| PPA (Launchpad) | Ubuntu | 1 день + ревью | аккаунт, sanctions | P2 |
| COPR (Fedora) / OBS (openSUSE) | RPM-дистрибутивы | 1–2 дня | аккаунт | P2 |
| Nixpkgs | NixOS | PR | ревью | P2 |
| Debian/Fedora main | все | месяцы | спонсор, политика | P3 |

Сейчас уже есть `.deb`, AppImage и GitHub Releases — это база. Всё
остальное добавляет удобство обновления, а не новые возможности.

## APT-репозиторий (P0)

Скрипт собирает статический репозиторий из готовых `.deb`:

```bash
make release                         # соберёт dist/release/*.deb
MAPPA_GPG_PASSPHRASE=... scripts/build-apt-repo.sh dist/apt
# без пароля: подпишет ключом из keyring, иначе предупредит
```

Структура:

```
dist/apt/
  pool/main/m/mappa/Mappa_1.5.0_amd64.deb
  dists/stable/main/binary-amd64/Packages{,.gz}
  dists/stable/Release  InRelease  Release.gpg
```

Публикация на GitHub Pages:

```bash
git worktree add /tmp/mappa-apt gh-pages
cp -r dist/apt/* /tmp/mappa-apt/
cd /tmp/mappa-apt && git add -A && git commit -m "apt: 1.5.0" && git push
gh api -X POST repos/vssfeo/mappa/pages \
  -f 'source[branch]=gh-pages' -f 'source[path]=/' -f build_type=legacy
```

URL репозитория: `https://vssfeo.github.io/mappa/`.

Клиент:

```bash
sudo install -d -m 0755 /etc/apt/keyrings
sudo curl -fsSL https://vssfeo.github.io/mappa/mappa-release.asc \
  -o /etc/apt/keyrings/mappa.asc
echo 'deb [signed-by=/etc/apt/keyrings/mappa.asc] https://vssfeo.github.io/mappa/ stable main' \
  | sudo tee /etc/apt/sources.list.d/mappa.list
sudo apt update && sudo apt install mappa
```

Публичный ключ нужно положить в корень репозитория
(`cp docs/keys/mappa-release.asc dist/apt/`). Подпись `Release` —
обязательна: `apt` откажется от неподписанного источника без
`[trusted=yes]`, а это плохая практика.

Обновление: новый тег → `make release` → пересобрать `dist/apt` →
закоммитить в `gh-pages`. Версию в `Release` менять не нужно, apt сам
увидит новую версию в `Packages`.

## AUR (P0)

`packaging/aur/PKGBUILD` собирает из исходников тега. Публикация:

```bash
cd packaging/aur
makepkg --printsrcinfo > .SRCINFO
git clone ssh://aur@aur.archlinux.org/mappa.git /tmp/aur-mappa
cp PKGBUILD .SRCINFO /tmp/aur-mappa/
cd /tmp/aur-mappa && git add -A && git commit -m "1.5.0" && git push
```

Требования AUR: пакет собирается из исходников, без бинарных
вложений, `sha256sums` для тарбола (сейчас `SKIP` — заменить на реальный
хеш GitHub-архива перед публикацией), лицензия Apache-2.0.

## Flatpak

Манифест — `packaging/flatpak/dev.mappa.desktop.yml`, метаданные —
`dev.mappa.desktop.metainfo.xml`. Локальная сборка:

```bash
flatpak install flathub org.flatpak.Builder org.gnome.Platform//46 org.gnome.Sdk//46
flatpak run org.flatpak.Builder --force-clean build-dir \
  packaging/flatpak/dev.mappa.desktop.yml
flatpak build-export repo build-dir
flatpak --user remote-add --no-gpg-verify mappa repo
flatpak --user install mappa dev.mappa.desktop
```

Что проверить до Flathub:

- WebKitGTK 4.1 есть в runtime `org.gnome.Platform//46`; если нет —
  поднять версию runtime или собрать WebKit модулем (тяжело).
- Сеть: приложению нужен доступ к провайдерам и LAN — `--share=network`.
- Файлы: паки лежат в `~/Downloads` и `~/.local/share` — нужен
  `--filesystem=home` или портал документов.
- AppData: скриншоты 16:9, иконка 256×256, релизы, OARS.
- Сборка без сети: `npm ci` и `cargo` тянут зависимости — Flathub
  требует `--share=network` только на этапе сборки, источники должны
  быть зафиксированы (Cargo.lock, package-lock.json).

## Snap

`snapcraft.yaml` с `base: core24`, `extensions: [gnome]` и плагином
`nil` (сборка через `cargo`/`npm`). Store требует аккаунт и ревью;
для поля и офлайна Snap менее удобен из-за строгой песочницы и
автообновлений.

## PPA, COPR, OBS

- **PPA:** нужен аккаунт Launchpad, GPG-ключ, source package
  (`debian/` с `control`, `rules`, `changelog`), `dput`. Сборка идёт на
  серверах Ubuntu; WebKitGTK 4.1 есть в 24.04.
- **COPR:** `copr-cli`, spec-файл, сборка из SRPM; аудитория Fedora.
- **OBS:** `osc`, spec + deb-трансформер, собирает и `.rpm`, и `.deb`,
  удобен для openSUSE.

Все три требуют аккаунтов, которые могут быть недоступны из-за
региональных ограничений. Поэтому P0 — собственный APT-репозиторий на
GitHub Pages и AUR: они не зависят от модерации.

## Nix

Пакет в `nixpkgs` — PR с `rustPlatform.buildRustPackage`, фиксацией
`cargoHash` и `npmDepsHash`, `webkitgtk_4_1`, `gtk3`. После мержа
появится `nix-shell -p mappa`.

## Подпись и доверие

- Релизные артефакты уже подписываются `SHA256SUMS.asc` (ключ
  `B7A7 AA55 … 5A14`).
- Для APT подписывается `Release` → `InRelease`; клиент получает ключ
  из `docs/keys/mappa-release.asc`.
- Приватный ключ — только в keyring сборочной машины, никогда в
  репозитории и CI без секрета.

## Ограничения и риски

- GitHub Pages может быть недоступен при ограничениях аккаунта; держите
  копию репозитория на VPS/зеркале и переключайтесь одной строкой в
  `sources.list`.
- Flathub/Snap/Launchpad могут отказать в аккаунте; не строить на них
  основной канал.
- APT-репозиторий на Pages имеет лимиты трафика (мягкие); для сотен
  установок лучше VPS или объектное хранилище.
- AppImage — 82 МБ; для медленных каналов лучше `.deb`.

## Чек-лист релиза с пакетами

1. Тег и GitHub Release (уже автоматизировано).
2. `make release` → `.deb` + AppImage + checksums.
3. `scripts/build-apt-repo.sh` → подпись → `gh-pages`.
4. Обновить AUR (`PKGBUILD`, `.SRCINFO`).
5. Проверить `apt update && apt install mappa` на чистой VM.
6. Обновить AppData и скриншоты, если менялся интерфейс.
