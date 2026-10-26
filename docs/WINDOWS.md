# Windows

**Статус:** бета, установщик без подписи. Собран и проверен в CI
(`windows-latest`): установка `/S`, запуск приложения и старт WebView2.

## Установка

1. Скачайте `Mappa_<версия>_x64-setup.exe` из последнего релиза.
2. SmartScreen покажет предупреждение: подписи Authenticode нет.
   «Подробнее» → «Выполнить в любом случае».
3. Установка для текущего пользователя, без прав администратора.
4. Нужен WebView2 Runtime; на Windows 10/11 он обычно уже есть, иначе
   установщик предложит загрузить его.

## Что проверить в первую очередь

- открытие карты и переключение подложек;
- импорт MBTiles/PMTiles и DEM;
- `Ctrl+K`, горячие клавиши, файловые диалоги;
- `mappa serve` и предупреждение брандмауэра Windows;
- полевой режим (экран не гаснет через `SetThreadExecutionState`);
- пути с кириллицей и пробелами.

## Ограничения

- **Нет подписи кода.** SmartScreen и антивирусы могут ругаться.
- Нет ARM64-сборки Windows.
- Нет MSI (только NSIS), нет автоматического обновления.
- GPX/MAVLink/UDP, sync и mobile-трекер не проходили полевой тест на
  Windows — проверяйте на своей машине.
- `systemd-inhibit` заменён на `SetThreadExecutionState`, но поведение
  на реальном ноутбуке не измерялось.

## Сборка

На Windows с Rust, Node 24, WebView2 и NSIS:

```powershell
npm ci --prefix ui
cargo build --release -p mappa-cli
.\ui\node_modules\.bin\tauri build --bundles nsis
```

Артефакт: `target/release/bundle/nsis/Mappa_<версия>_x64-setup.exe`.

Кросс-компиляция из Linux не поддерживается: Tauri и NSIS требуют MSVC,
WebView2 и Windows SDK. Используйте `windows-latest` в CI.

## CI

- `.github/workflows/ci.yml`, job `windows`: check CLI, tests, check app,
  сборка NSIS, установка и smoke-запуск.
- `.github/workflows/release.yml`, job `windows`: собирает установщик на
  тег и прикладывает его к релизу вместе с `SHA256SUMS-windows.txt`.
