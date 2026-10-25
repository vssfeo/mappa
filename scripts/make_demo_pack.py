#!/usr/bin/env python3
"""Builds the synthetic demo pack shipped with Mappa.

The tiles are drawn procedurally (no third-party imagery), so the pack is
small, licence-free and works offline on the first run.  Re-run after changing
the style:

    python3 scripts/make_demo_pack.py assets/demo/demo.mbtiles

Requires Pillow only.
"""

from __future__ import annotations

import argparse
import io
import math
import sqlite3
from pathlib import Path

from PIL import Image

# South coast of Crimea, around Yalta and Ai-Petri.
WEST, SOUTH, EAST, NORTH = 33.94, 44.34, 34.32, 44.62
MIN_ZOOM, MAX_ZOOM = 10, 13
TILE = 256
NAME = "Yalta demo"


def lon_to_x(lon: float, zoom: int) -> float:
    return (lon + 180.0) / 360.0 * (1 << zoom)


def lat_to_y(lat: float, zoom: int) -> float:
    radians = math.radians(lat)
    return (
        (1.0 - math.asinh(math.tan(radians)) / math.pi) / 2.0 * (1 << zoom)
    )


def x_to_lon(x: float, zoom: int) -> float:
    return x / (1 << zoom) * 360.0 - 180.0


def y_to_lat(y: float, zoom: int) -> float:
    n = math.pi - 2.0 * math.pi * y / (1 << zoom)
    return math.degrees(math.atan(math.sinh(n)))


def coastline(lon: float) -> float:
    """Latitude of the shore; the sea lies to the south of it."""
    u = lon - 34.0
    return 44.43 + 0.014 * math.sin(u * 28.0) + 0.006 * math.sin(u * 71.0 + 1.3)


def height(lon: float, lat: float) -> float:
    """Synthetic elevation in metres; the sea floor is negative."""
    u = (lon - 34.10) * 42.0
    v = (lat - 44.48) * 42.0
    land = (
        210.0
        + 180.0 * math.sin(u * 0.80) * math.cos(v * 0.70)
        + 95.0 * math.sin(u * 1.90 + v * 1.40)
        + 38.0 * math.sin(u * 3.60 - v * 2.70)
        + 14.0 * math.sin(u * 6.10 + v * 4.60)
    )
    ridge = max(0.0, min(1.0, (lat - 44.43) / 0.09))
    ridge = ridge * ridge * (3.0 - 2.0 * ridge)
    land += 620.0 * ridge
    coast = coastline(lon)
    if lat < coast:
        return -max(0.0, (coast - lat) * 90000.0)
    return max(0.0, land)


def metres_per_pixel(lat: float, zoom: int) -> float:
    return 156_543.03392 * math.cos(math.radians(lat)) / (1 << zoom)


LAND = (
    (8.0, (217, 200, 160)),
    (90.0, (134, 160, 106)),
    (260.0, (111, 143, 87)),
    (460.0, (125, 138, 78)),
    (700.0, (142, 132, 104)),
    (950.0, (162, 154, 134)),
    (1250.0, (186, 181, 170)),
    (1600.0, (230, 228, 222)),
)
SEA_SHALLOW = (90, 160, 180)
SEA_DEEP = (16, 58, 88)


def lerp(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))  # type: ignore[return-value]


def land_color(h: float) -> tuple[int, int, int]:
    previous = LAND[0]
    for limit, color in LAND[1:]:
        if h <= limit:
            span = limit - previous[0]
            t = 0.0 if span <= 0 else (h - previous[0]) / span
            return lerp(previous[1], color, max(0.0, min(1.0, t)))
        previous = (limit, color)
    return LAND[-1][1]


def contour_interval(zoom: int) -> float:
    return {10: 500.0, 11: 250.0, 12: 100.0, 13: 50.0}.get(zoom, 100.0)


def render_tile(zoom: int, x: int, y: int) -> Image.Image:
    interval = contour_interval(zoom)
    # Height grid with a one-pixel apron so gradients stay continuous across
    # tile borders.
    size = TILE + 2
    grid = [[0.0] * size for _ in range(size)]
    for row in range(size):
        lat = y_to_lat(y + (row - 0.5) / TILE, zoom)
        for column in range(size):
            lon = x_to_lon(x + (column - 0.5) / TILE, zoom)
            grid[row][column] = height(lon, lat)

    pixels = bytearray(TILE * TILE * 3)
    offset = 0
    for row in range(TILE):
        lat = y_to_lat(y + (row + 0.5) / TILE, zoom)
        metres = metres_per_pixel(lat, zoom)
        for column in range(TILE):
            h = grid[row + 1][column + 1]
            slope_x = (grid[row + 1][column + 2] - grid[row + 1][column]) / (2.0 * metres)
            slope_y = (grid[row][column + 1] - grid[row + 2][column + 1]) / (2.0 * metres)
            if h < 0.0:
                depth = min(1.0, -h / 900.0)
                color = lerp(SEA_SHALLOW, SEA_DEEP, depth**0.7)
                if -h < 60.0:
                    color = lerp(color, (222, 232, 226), (60.0 + h) / 60.0)
            else:
                color = land_color(h)
                if h < 6.0 and lat < coastline(lon) + 0.012:
                    color = lerp((222, 205, 165), color, h / 6.0)
                slope = math.hypot(slope_x, slope_y)
                contour_width = max(0.0035, slope * metres * 1.15 / interval)
                band = (h % interval) / interval
                if h > interval * 0.5 and band < contour_width:
                    index_line = interval * 5.0
                    factor = 0.7 if (h % index_line) < index_line * contour_width * 1.5 else 0.84
                    color = tuple(int(c * factor) for c in color)  # type: ignore[assignment]
                # Vertical exaggeration keeps the relief readable at map scale.
                light = 0.96 - 2.4 * slope_x - 1.8 * slope_y
                light = max(0.58, min(1.24, light))
                color = tuple(min(255, int(c * light)) for c in color)  # type: ignore[assignment]
            pixels[offset] = color[0]
            pixels[offset + 1] = color[1]
            pixels[offset + 2] = color[2]
            offset += 3
    image = Image.frombytes("RGB", (TILE, TILE), bytes(pixels))
    return image.quantize(colors=96, method=Image.Quantize.MEDIANCUT)


def tiles(zoom: int):
    x0 = int(math.floor(lon_to_x(WEST, zoom)))
    x1 = int(math.floor(lon_to_x(EAST, zoom)))
    y0 = int(math.floor(lat_to_y(NORTH, zoom)))
    y1 = int(math.floor(lat_to_y(SOUTH, zoom)))
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            yield x, y


def build(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    database = sqlite3.connect(path)
    database.executescript(
        """
        CREATE TABLE metadata (name TEXT, value TEXT);
        CREATE TABLE tiles (
            zoom_level INTEGER,
            tile_column INTEGER,
            tile_row INTEGER,
            tile_data BLOB
        );
        CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);
        """
    )
    metadata = {
        "name": NAME,
        "description": "Synthetic demo map generated by Mappa",
        "format": "png",
        "type": "basemap",
        "version": "1",
        "minzoom": str(MIN_ZOOM),
        "maxzoom": str(MAX_ZOOM),
        "bounds": f"{WEST},{SOUTH},{EAST},{NORTH}",
        "attribution": "Demo map generated by Mappa",
    }
    database.executemany(
        "INSERT INTO metadata (name, value) VALUES (?, ?)", metadata.items()
    )
    total = 0
    size = 0
    for zoom in range(MIN_ZOOM, MAX_ZOOM + 1):
        count = 0
        for x, y in tiles(zoom):
            image = render_tile(zoom, x, y)
            buffer = io.BytesIO()
            image.save(buffer, format="PNG", optimize=True)
            data = buffer.getvalue()
            database.execute(
                "INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)",
                (zoom, x, (1 << zoom) - 1 - y, data),
            )
            count += 1
            total += 1
            size += len(data)
        print(f"z{zoom}: {count} tiles")
    database.commit()
    database.execute("VACUUM")
    database.close()
    print(f"{total} tiles, {size / 1024:.0f} KiB of PNG, {path.stat().st_size / 1024:.0f} KiB file")


def preview(zoom: int, output: Path) -> None:
    x0 = int(math.floor(lon_to_x(WEST, zoom)))
    x1 = int(math.floor(lon_to_x(EAST, zoom)))
    y0 = int(math.floor(lat_to_y(NORTH, zoom)))
    y1 = int(math.floor(lat_to_y(SOUTH, zoom)))
    width = (x1 - x0 + 1) * TILE
    height_px = (y1 - y0 + 1) * TILE
    canvas = Image.new("RGB", (width, height_px), (11, 15, 20))
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            tile = render_tile(zoom, x, y).convert("RGB")
            canvas.paste(tile, ((x - x0) * TILE, (y - y0) * TILE))
    canvas.save(output, optimize=True)
    print(f"preview {width}x{height_px} -> {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("output", nargs="?", default="assets/demo/demo.mbtiles")
    parser.add_argument("--preview", help="write a PNG mosaic instead of a pack")
    parser.add_argument("--zoom", type=int, default=11)
    arguments = parser.parse_args()
    if arguments.preview:
        preview(arguments.zoom, Path(arguments.preview))
    else:
        build(Path(arguments.output))
