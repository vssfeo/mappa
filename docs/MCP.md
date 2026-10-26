# MCP-сервер

`mappa-cli mcp` запускает Model Context Protocol сервер по stdio:
JSON-RPC 2.0, протокол `2024-11-05`. Предназначен для редакторов и
агентов, которые умеют подключать MCP-серверы.

## Подключение

```json
{
  "mcpServers": {
    "mappa": {
      "command": "/usr/bin/mappa-cli",
      "args": ["mcp"]
    }
  }
}
```

Сервер ничего не печатает в stdout, кроме JSON-RPC; логи идут в stderr.

## Инструменты

| Инструмент | Аргументы | Что делает |
|---|---|---|
| `list_providers` | — | список встроенных провайдеров, зуммов и `offlineAllowed` |
| `download` | `provider`, `bbox`, `zoom`, `cache?` | качает район в общий кэш |
| `pack` | `provider`, `bbox`, `zoom`, `output`, `name?`, `license?`, `cache?` | экспорт в MBTiles/PMTiles |
| `import_sas` | `source`, `output`, `layer?`, `name?` | импорт кэша SAS.Planet |

`bbox` — строка `west,south,east,north`; `zoom` — `10`, `10-13` или
`10..13`.

Пример вызова:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"download","arguments":{
   "provider":"usgs","bbox":"-9.8,52.9,-9.4,53.3","zoom":"10-11"}}}
```

Ответ — `content[0].text` с JSON-отчётом; ошибка — `isError: true`.

## Проверка вручную

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | mappa-cli mcp
```

## Ограничения

- Инструменты выполняются синхронно в одном процессе; долгий `download`
  держит соединение.
- Нет отмены и прогресса: для длинных задач используйте REST `POST /api/jobs`.
- Сеть и кэш те же, что у CLI; токены провайдеров читаются из настроек.

## Связанное

- `POST /api/jobs` в `docs/API.md` — асинхронная очередь с idempotency.
- `mappa-cli download/pack/import-sas` — те же операции из терминала.
