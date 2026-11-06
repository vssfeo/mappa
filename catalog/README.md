# Mappa pack catalog

Static catalog of Mappa packs. It stores metadata only; the tiles are
transferred by BitTorrent. Clients read `catalog.json` with a plain HTTP GET.

## Add a pack

1. Create the pack in Mappa and use «Поделиться паком» → «Создать торрент».
2. Press «Скопировать запись каталога».
3. Open a pull request that appends the entry to `packs` and updates
   `updatedAt`.

Open the issues with the `catalog:` title prefix; the `Catalog issue`
workflow validates the JSON, appends the entry and opens a pull request
automatically. CI also validates `catalog.json` with
`scripts/catalog-check.mjs`.

The entry must keep `id` unique, `infoHash` matching the magnet, a valid
`bbox` (west, south, east, north), `zoom` (min, max), `bytes`, `license`
and `publisher`. See `schema.json`.
