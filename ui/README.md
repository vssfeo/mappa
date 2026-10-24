# Mappa UI

React 19 + TypeScript + Vite + MapLibre GL JS.

## Запуск

```bash
npm install
npm run dev -- --host 127.0.0.1 --port 4173
```

## Проверки

```bash
npm run lint
npm run build
```

Smoke (нужен запущенный dev-сервер):

```bash
npm run smoke
```

## Что внутри

- `src/App.tsx` — layout, команды, горячие клавиши.
- `src/MapCanvas.tsx` — MapLibre, растровые слои, view events.
- `src/providers.ts` — подложки Phase 0.
- `src/DownloadSheet.tsx` — оценка тайлов/размера/времени и bbox.
- `src/CommandPalette.tsx` — `Ctrl+K`.
- `src/store.ts` — Zustand: тема, провайдер, слои, панели, toast.
- `src/index.css`, `src/App.css` — дизайн-токены и компоненты.

## Ограничения Phase 0

- Тайлы грузятся напрямую, дискового кэша нет.
- Очередь скачивания не реализована; `В очередь` disabled.
- Tauri shell ещё не подключён — см. `../docs/STATUS.md`.
